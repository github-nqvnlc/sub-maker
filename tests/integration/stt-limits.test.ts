import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/lib/db';
import { sttProviderConfigs } from '@/lib/db/schema';
import { ffmpegAvailable } from '@/lib/audio/ffmpeg';
import { updateSettings } from '@/lib/settings';
import { runTranscribeMedia } from '@/worker/jobs/transcribe-media';
import { stopBoss } from '@/worker/queues';
import { startSonioxMock, type SonioxMock } from '../mocks/soniox-mock';
import { clearRateLimits, createAdmin, createUser, resetDb, type TestUser } from './helpers';
import { newProject } from './voice-helpers';
import { createSttJobApi, FAST_STT, postMedia, putSonioxConfig, sttJobRow } from './stt-helpers';

const run = promisify(execFile);
const hasFfmpeg = await ffmpegAvailable();
let mock: SonioxMock;
let admin: TestUser;
let user: TestUser;

beforeAll(async () => {
  mock = await startSonioxMock();
  await resetDb();
  admin = await createAdmin();
});
afterAll(async () => {
  await mock.close();
  await stopBoss();
});
beforeEach(async () => {
  await clearRateLimits();
  mock.reset();
  await getDb().delete(sttProviderConfigs);
  await putSonioxConfig(admin, mock);
  user = await createUser();
});

describe('giới hạn STT (spec 004, FR-001, FR-017)', () => {
  it('audio > 100 MB → 413 MEDIA_TOO_LARGE', async () => {
    const projectId = await newProject(user);
    const res = await postMedia(user, projectId, { bytes: new Uint8Array(100 * 1024 * 1024 + 1), name: 'big.mp3' });
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('MEDIA_TOO_LARGE');
  });

  it('vượt maxSttJobsPerUser job đang chờ/chạy → 429 STT_TOO_MANY_JOBS', async () => {
    await updateSettings({ maxSttJobsPerUser: 2 }, null);
    const projectId = await newProject(user);
    await createSttJobApi(user, projectId);
    await createSttJobApi(user, projectId);
    const res = await postMedia(user, projectId, { bytes: new Uint8Array(2048), name: 'c.mp3' });
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('STT_TOO_MANY_JOBS');
    // User khác không bị ảnh hưởng
    const other = await createUser();
    await createSttJobApi(other, await newProject(other));
  });

  it.skipIf(!hasFfmpeg)('tệp > 60 phút: job failed MEDIA_TOO_LONG, không gọi Soniox', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'long-'));
    try {
      const file = path.join(dir, 'long.mp3');
      await run(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=8000:cl=mono', '-t', '3660', '-b:a', '8k', '-y', file]);
      const projectId = await newProject(user);
      const res = await postMedia(user, projectId, { bytes: await readFile(file), name: 'long.mp3' });
      expect(res.status).toBe(201);
      const { id } = (await res.json()) as { id: string };
      await runTranscribeMedia(id, FAST_STT);
      const row = (await sttJobRow(id))!;
      expect(row).toMatchObject({ status: 'failed', errorCode: 'MEDIA_TOO_LONG' });
      expect(mock.requests).toHaveLength(0);
      expect(row.tempStorageKey).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
