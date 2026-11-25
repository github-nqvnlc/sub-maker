import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat, statfs } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { getDb, type Db } from '../../lib/db';
import { overlayAudios } from '../../lib/db/schema';
import { sleep } from '../../lib/providers/adapters/shared';
import { getSettings } from '../../lib/settings';
import { deleteObject, downloadObjectToFile, headObject, putObjectStream } from '../../lib/storage/client';
import { storageKeys } from '../../lib/storage/keys';
import { QuotaExceededError, reserveBytes } from '../../lib/storage/quota';
import { backoffMs, type RetryPolicy } from '../pipeline/synthesize-segment';
import { QUEUES, type PrepareOverlayAudioPayload } from '../queues';
import { childEnv } from '../render/spawn-render';
import type { OverlayErrorCode } from './render-overlay';

/**
 * Chuẩn hóa tệp âm thanh tải lên (spec 005, US5, research R10): đo thời lượng, chuyển MP3 192 kbps có thẻ Xing (tua chính xác trong
 * trình duyệt), ghi đối tượng vào khóa cố định rồi MỘT giao dịch trừ hạn mức và chuyển `ready` (research R11).
 * Không tin nội dung tệp: ép bộ tách theo đuôi và chỉ cho đọc tệp trên đĩa.
 */

/** Gián đoạn quá số lần này thì báo lỗi thay vì chạy mãi. */
export const MAX_AUDIO_INTERRUPTIONS = 3;
/** Nhịp tim quá hạn này được coi là worker đã chết (khớp sweeper). */
const STALE_MS = 30_000;
const DEMUXER = { mp3: 'mp3', wav: 'wav', m4a: 'mov' } as const;
const RETRY: RetryPolicy = { maxAttempts: 4, baseMs: 2000, maxMs: 30_000 };
const TOOL_TIMEOUT_MS = 10 * 60_000;
/** MP3 có vài chục mili giây đệm ở hai đầu: tệp dài đúng bằng giới hạn không bị từ chối vì phần đệm này. */
const DURATION_TOLERANCE_MS = 500;

export type PrepareAudioOptions = {
  retry?: Partial<RetryPolicy>;
  heartbeatMs?: number;
  staleMs?: number;
  freeBytes?: (dir: string) => Promise<number>;
  putObject?: typeof putObjectStream;
};

class AudioFailure extends Error {
  constructor(
    public readonly code: OverlayErrorCode,
    public readonly detail = '',
  ) {
    super(code);
    this.name = 'AudioFailure';
  }
}
/** Bản ghi đã bị xóa hoặc lượt chạy khác đã nhận lại. */
class AudioGone extends Error {}

/** Chạy ffmpeg/ffprobe với môi trường tối thiểu (không có bí mật). Mã thoát khác 0 → `null`. */
function runTool(cmd: string, args: string[], signal: AbortSignal): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, env: childEnv() });
    const out: Buffer[] = [];
    const kill = () => void child.kill('SIGKILL');
    const timer = setTimeout(kill, TOOL_TIMEOUT_MS);
    signal.addEventListener('abort', kill, { once: true });
    if (signal.aborted) kill();
    const done = (fn: () => void) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', kill);
      fn();
    };
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.on('error', (e) => done(() => reject(new AudioFailure('INTERNAL', e.message))));
    child.on('close', (code) => done(() => resolve(code === 0 ? Buffer.concat(out) : null)));
  });
}

const FFMPEG = () => process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = () => process.env.FFPROBE_PATH || 'ffprobe';

async function probe(file: string, demuxer: string, signal: AbortSignal): Promise<{ durationMs: number | null; hasAudio: boolean } | null> {
  const out = await runTool(FFPROBE(), ['-v', 'error', '-f', demuxer, '-protocol_whitelist', 'file', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', file], signal);
  if (!out) return null;
  try {
    const j = JSON.parse(out.toString('utf8')) as { format?: { duration?: string }; streams?: Array<{ codec_type?: string }> };
    const d = Number(j.format?.duration);
    return { durationMs: Number.isFinite(d) && d > 0 ? Math.round(d * 1000) : null, hasAudio: (j.streams ?? []).some((s) => s.codec_type === 'audio') };
  } catch {
    return null;
  }
}

const defaultFreeBytes = async (dir: string): Promise<number> => {
  const s = await statfs(dir);
  return Number(s.bavail) * Number(s.bsize);
};

type Row = typeof overlayAudios.$inferSelect;

/** Nhận việc: chỉ khi chưa ai chạy hoặc lượt trước đã mất nhịp tim (tính một lần gián đoạn). */
async function claim(audioId: string, staleMs: number): Promise<Row | null> {
  const [row] = await getDb()
    .update(overlayAudios)
    .set({
      heartbeatAt: sql`now()`,
      interruptions: sql`case when ${overlayAudios.heartbeatAt} is null then ${overlayAudios.interruptions} else ${overlayAudios.interruptions} + 1 end`,
    })
    .where(
      and(
        eq(overlayAudios.id, audioId),
        eq(overlayAudios.status, 'processing'),
        sql`(${overlayAudios.heartbeatAt} is null or ${overlayAudios.heartbeatAt} < now() - (${staleMs} * interval '1 millisecond'))`,
      ),
    )
    .returning();
  return row ?? null;
}

export async function runPrepareOverlayAudio(audioId: string, opts: PrepareAudioOptions = {}): Promise<void> {
  const db = getDb();
  const row = await claim(audioId, opts.staleMs ?? STALE_MS);
  if (!row) return; // đã xóa, đã xong, hoặc worker khác đang chạy

  const retry: RetryPolicy = { ...RETRY, ...opts.retry };
  const key = storageKeys.overlayAudio(row.ownerId, row.id);
  const tempKey = row.tempStorageKey;
  const abort = new AbortController();
  let gone = false;
  let finished = false;
  /** Chỉ tác động khi bản ghi vẫn thuộc LƯỢT CHẠY này (`interruptions` tăng mỗi lần nhận lại). */
  const mine = and(eq(overlayAudios.id, audioId), eq(overlayAudios.status, 'processing'), eq(overlayAudios.interruptions, row.interruptions));

  const beat = async () => {
    if (finished) return;
    const r = await db.update(overlayAudios).set({ heartbeatAt: sql`now()` }).where(mine).returning({ id: overlayAudios.id });
    if (r.length === 0 && !finished) {
      gone = true;
      abort.abort();
    }
  };
  const hb = setInterval(() => void beat().catch(() => undefined), opts.heartbeatMs ?? 2000);
  hb.unref?.();
  const checkpoint = () => {
    if (gone) throw new AudioGone();
  };

  const prepareOnce = async (): Promise<void> => {
    if (!tempKey) throw new AudioFailure('AUDIO_UNREADABLE');
    const ext = /\.([a-z0-9]+)$/.exec(tempKey)?.[1] as keyof typeof DEMUXER;
    const dir = await mkdtemp(path.join(os.tmpdir(), `submaker-overlay-${process.pid}-`));
    try {
      const src = path.join(dir, `source.${ext}`);
      const out = path.join(dir, 'out.mp3');
      let size: number;
      try {
        const head = await headObject(tempKey);
        if (!head) throw new AudioFailure('AUDIO_UNREADABLE');
        size = head.size;
      } catch (e) {
        throw e instanceof AudioFailure ? e : new AudioFailure('STORAGE_UNAVAILABLE', e instanceof Error ? e.message : '');
      }
      if ((await (opts.freeBytes ?? defaultFreeBytes)(dir)) < size * 2 + 64 * 1024 * 1024) throw new AudioFailure('DISK_FULL');
      try {
        await downloadObjectToFile(tempKey, src);
      } catch (e) {
        throw new AudioFailure('STORAGE_UNAVAILABLE', e instanceof Error ? e.message : '');
      }
      checkpoint();

      const { overlayMaxMinutes } = await getSettings();
      const maxMs = overlayMaxMinutes * 60_000;
      const info = await probe(src, DEMUXER[ext], abort.signal);
      checkpoint();
      if (!info?.hasAudio) throw new AudioFailure('AUDIO_UNREADABLE');
      if (info.durationMs !== null && info.durationMs > maxMs + DURATION_TOLERANCE_MS) throw new AudioFailure('AUDIO_TOO_LONG');

      // `-t` chặn tệp khai sai thời lượng; thời lượng thật đo trên MP3 đã ghi
      const ok = await runTool(
        FFMPEG(),
        ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', DEMUXER[ext], '-protocol_whitelist', 'file', '-i', src, '-map', '0:a:0', '-vn', '-sn', '-dn', '-map_metadata', '-1', '-ac', '2', '-ar', '44100', '-codec:a', 'libmp3lame', '-b:a', '192k', '-write_xing', '1', '-t', String(maxMs / 1000 + 2), '-y', out],
        abort.signal,
      );
      checkpoint();
      const made = ok ? await probe(out, 'mp3', abort.signal) : null;
      checkpoint();
      if (!made?.hasAudio || !made.durationMs) throw new AudioFailure('AUDIO_UNREADABLE');
      if (made.durationMs > maxMs + DURATION_TOLERANCE_MS) throw new AudioFailure('AUDIO_TOO_LONG');
      const durationMs = Math.min(made.durationMs, maxMs);
      const bytes = (await stat(out)).size;

      try {
        await (opts.putObject ?? putObjectStream)(key, createReadStream(out), bytes, 'audio/mpeg');
      } catch (e) {
        throw new AudioFailure('STORAGE_UNAVAILABLE', e instanceof Error ? e.message : '');
      }
      checkpoint();
      try {
        finished = await db.transaction(async (tx) => {
          const r = await tx
            .update(overlayAudios)
            .set({ status: 'ready', storageKey: key, sizeBytes: bytes, durationMs, errorCode: null, tempStorageKey: null })
            .where(mine)
            .returning({ id: overlayAudios.id });
          if (r.length === 0) return false;
          await reserveBytes(row.ownerId, bytes, { db: tx as unknown as Db });
          return true;
        });
      } catch (e) {
        if (e instanceof QuotaExceededError) throw new AudioFailure('QUOTA_EXCEEDED');
        throw e;
      }
      if (!finished) throw new AudioGone();
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  };

  try {
    if (row.interruptions > MAX_AUDIO_INTERRUPTIONS) throw new AudioFailure('INTERNAL', 'gián đoạn quá nhiều lần');
    for (let attempt = 1; ; attempt++) {
      try {
        await prepareOnce();
        break;
      } catch (e) {
        if (e instanceof AudioGone) throw e;
        const f = e instanceof AudioFailure ? e : new AudioFailure('INTERNAL', e instanceof Error ? e.message : '');
        if (f.detail) console.error(`[prepare-overlay-audio] ${audioId} ${f.code}: ${f.detail}`);
        if (f.code !== 'STORAGE_UNAVAILABLE' || attempt >= retry.maxAttempts) throw f;
        await sleep(backoffMs(attempt, retry), abort.signal).catch(() => undefined);
        checkpoint();
      }
    }
    if (tempKey) await deleteObject(tempKey).catch(() => undefined);
  } catch (e) {
    const [cur] = await db.select({ status: overlayAudios.status, interruptions: overlayAudios.interruptions }).from(overlayAudios).where(eq(overlayAudios.id, audioId));
    // lượt chạy khác đang giữ hoặc đã hoàn tất: không đụng vào dữ liệu của lượt đó
    if (cur && (cur.status === 'ready' || (cur.status === 'processing' && cur.interruptions !== row.interruptions))) return;
    await deleteObject(key).catch(() => undefined);
    if (tempKey) await deleteObject(tempKey).catch(() => undefined);
    if (!cur) return; // tệp, Project hoặc User đã bị xóa
    const code: OverlayErrorCode = e instanceof AudioFailure ? e.code : 'INTERNAL';
    if (!(e instanceof AudioFailure) && !(e instanceof AudioGone)) console.error('[prepare-overlay-audio] lỗi không mong đợi:', e instanceof Error ? e.message : e);
    await db.update(overlayAudios).set({ status: 'failed', errorCode: code, tempStorageKey: null }).where(mine);
  } finally {
    finished = true;
    clearInterval(hb);
  }
}

export async function registerPrepareOverlayAudio(boss: PgBoss): Promise<void> {
  await boss.work<PrepareOverlayAudioPayload>(QUEUES.prepareOverlayAudio, { localConcurrency: 2 }, async (jobs) => {
    for (const j of jobs) await runPrepareOverlayAudio(j.data.audioId);
  });
}
