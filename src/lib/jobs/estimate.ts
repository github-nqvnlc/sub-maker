import { and, asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db';
import { audioCache, segments } from '../db/schema';
import type { subtitleFiles, projects } from '../db/schema';
import type { InferSelectModel } from 'drizzle-orm';
import { conflict, validation } from '../api/errors';
import type { AuthUser } from '../auth/guards';
import { resolveConfigForJob } from '../providers/config-service';
import { getCatalog, resolveSettings } from '../providers/catalog';
import { getOwnedFile, getOwnedProject } from '../projects/access';
import { getSettings, type Settings } from '../settings';
import { requestsPerMinute } from '../providers/rate-limit';
import { contentHash } from '../audio/cache-key';
import { ttsProviderTypeSchema, type TtsProviderType } from '../schemas/common';
import { buildTimingSettings, loadFileCues, TIMED_MAX_CHARS, unitsForTiming, type TimingChoice } from './timed';

/**
 * Ước tính TRƯỚC khi tạo voice (spec 003, FR-008, FR-013): không gọi nhà cung cấp, không ghi usage.
 * - Đơn vị đã có trong cache của CHÍNH người dùng (cùng nhà cung cấp/model/giọng/tốc độ) không phải gọi và không tính phí;
 *   các đơn vị trùng văn bản trong cùng tệp chỉ gọi một lần.
 * - Tiền chỉ có khi cấu hình AI sẽ dùng đã có `pricePerMillionChars` (Nguyên tắc IV: không bịa số).
 */

export const estimateBodySchema = z
  .object({
    providerType: ttsProviderTypeSchema.optional(),
    model: z.string().trim().max(100).nullable().optional(),
    voice: z.string().trim().max(100).nullable().optional(),
    speed: z.number().finite().nullable().optional(),
    language: z.string().trim().max(10).optional(),
    /** Custom Provider sẽ dùng (spec 004) */
    customProviderId: z.string().uuid().nullable().optional(),
    timing: z
      .object({ mode: z.enum(['timed', 'continuous']), mergeCues: z.boolean().optional() })
      .strict()
      .optional(),
  })
  .strict();
export type EstimateBody = z.infer<typeof estimateBodySchema>;

export type Estimate = {
  cues: number;
  units: number;
  /** ký tự đọc thực (sau khi bỏ số thứ tự và mốc), cộng cả đơn vị đã có cache */
  chars: number;
  /** ký tự phải trả phí = ký tự của các đơn vị duy nhất chưa có cache */
  billableChars: number;
  cachedUnits: number;
  requests: number;
  audioMs: number;
  outputBytes: number;
  quotaOk: boolean;
  needBytes?: number;
  etaMs: number;
  priceConfigured: boolean;
  price: number | null;
};

/** Tốc độ đọc trung bình đo thật với FPT (15,5 ký tự/s) và của phụ đề mẫu (14,0): dùng 14,5 cho ước tính. */
export const CHARS_PER_SECOND = 14.5;
/** MP3 128 kbps = 16 KB/s; cache WAV 24 kHz 16-bit mono = 48 KB/s. */
const MP3_BYTES_PER_SEC = 16_000;
const WAV_BYTES_PER_SEC = 48_000;
const HASH_QUERY_CHUNK = 1000;

type FileRow = InferSelectModel<typeof subtitleFiles>;
type ProjectRow = InferSelectModel<typeof projects>;

export type EstimateContext = {
  user: Pick<AuthUser, 'id' | 'storageUsedBytes'>;
  file: FileRow;
  project: Pick<ProjectRow, 'providerType'>;
  settings: { model: string | null; voice: string; speed: number | null };
  pricePerMillionChars: number | null;
  timing?: TimingChoice;
  systemSettings: Settings;
};

/**
 * Thời gian xử lý ước tính: bị chặn bởi giới hạn yêu cầu/phút của nhà cung cấp khi có (research R5), ngược lại theo số lượt song song
 * (mỗi lượt ~2 giây). Lấy lớn hơn của hai cách để không hứa nhanh hơn thực tế.
 */
export function estimateEtaMs(requests: number, providerType: Parameters<typeof requestsPerMinute>[0], s: Settings): number {
  if (requests <= 0) return 0;
  const byConcurrency = Math.ceil(requests / Math.max(1, s.segmentConcurrency)) * 2000;
  const rpm = requestsPerMinute(providerType, s);
  const byRate = rpm > 0 ? Math.ceil(requests / rpm) * 60_000 : 0;
  return Math.max(byConcurrency, byRate);
}

/** Tính ước tính từ ngữ cảnh đã giải quyết (dùng chung cho API ước tính và kiểm tra hạn mức khi tạo job). */
export async function computeEstimate(c: EstimateContext): Promise<Estimate> {
  const db = getDb();
  const timed = c.timing?.mode === 'timed';
  let texts: string[];
  let cueCount = 0;
  if (timed) {
    const cues = await loadFileCues(c.file.id, db);
    cueCount = cues.length;
    const cat = getCatalog(c.project.providerType);
    const timing = buildTimingSettings(c.timing, c.systemSettings)!;
    texts = unitsForTiming(cues, timing, Math.min(cat.maxCharsPerRequest, TIMED_MAX_CHARS)).map((u) => u.text);
  } else {
    const rows = await db.select({ text: segments.text }).from(segments).where(eq(segments.subtitleFileId, c.file.id)).orderBy(asc(segments.idx));
    texts = rows.map((r) => r.text);
  }

  const hashOf = (text: string) =>
    contentHash({ userId: c.user.id, providerType: c.project.providerType as TtsProviderType, model: c.settings.model, voice: c.settings.voice, speed: c.settings.speed, text });
  const unique = new Map<string, number>(); // hash → số ký tự
  let chars = 0;
  for (const t of texts) {
    const n = [...t].length;
    chars += n;
    unique.set(hashOf(t), n);
  }
  const hashes = [...unique.keys()];
  const cached = new Set<string>();
  for (let i = 0; i < hashes.length; i += HASH_QUERY_CHUNK) {
    const rows = await db
      .select({ h: audioCache.contentHash })
      .from(audioCache)
      .where(and(eq(audioCache.ownerId, c.user.id), inArray(audioCache.contentHash, hashes.slice(i, i + HASH_QUERY_CHUNK))));
    for (const r of rows) cached.add(r.h);
  }
  let billableChars = 0;
  let requests = 0;
  for (const [h, n] of unique) {
    if (cached.has(h)) continue;
    billableChars += n;
    requests += 1;
  }

  const audioMs = timed && c.file.durationMs != null ? c.file.durationMs : Math.round((chars / CHARS_PER_SECOND) * 1000);
  const cacheSeconds = billableChars / CHARS_PER_SECOND;
  const outputBytes = Math.ceil((audioMs / 1000) * MP3_BYTES_PER_SEC + cacheSeconds * WAV_BYTES_PER_SEC);
  const need = c.user.storageUsedBytes + outputBytes - c.systemSettings.userQuotaBytes;
  const quotaOk = need <= 0;

  const priceConfigured = c.pricePerMillionChars != null;
  return {
    cues: cueCount,
    units: texts.length,
    chars,
    billableChars,
    cachedUnits: unique.size - requests,
    requests,
    audioMs,
    outputBytes,
    quotaOk,
    ...(quotaOk ? {} : { needBytes: need }),
    etaMs: estimateEtaMs(requests, c.project.providerType, c.systemSettings),
    priceConfigured,
    price: priceConfigured ? (billableChars / 1_000_000) * c.pricePerMillionChars! : null,
  };
}

/** Ước tính cho một tệp của người dùng: dùng đúng cấu hình AI mà job sẽ dùng (riêng nếu đủ điều kiện, ngược lại chung). */
export async function estimateFile(user: AuthUser, fileId: string, body: EstimateBody): Promise<Estimate> {
  const file = await getOwnedFile(user.id, fileId);
  const project = await getOwnedProject(user.id, file.projectId);
  const effProviderType = (body.providerType ?? (project.providerType as TtsProviderType) ?? 'fpt_marketplace') as TtsProviderType;
  if (body.timing?.mode === 'timed' && !file.hasTimecodes) throw conflict('NO_TIMECODES');

  const resolved = await resolveConfigForJob(user, effProviderType, { customProviderId: body.customProviderId });
  const parsed = resolveSettings(effProviderType, {
    model: body.model,
    voice: body.voice,
    speed: body.speed,
    defaults: { model: resolved.row.defaultModel, voice: resolved.row.defaultVoice, speed: resolved.row.defaultSpeed },
  });
  if (!parsed.ok) throw validation(parsed.fields);

  return computeEstimate({
    user,
    file,
    project: { providerType: effProviderType },
    settings: { model: parsed.value.model, voice: parsed.value.voice, speed: parsed.value.speed },
    pricePerMillionChars: resolved.row.pricePerMillionChars,
    timing: body.timing,
    systemSettings: await getSettings(),
  });
}
