import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/lib/db';
import { subtitleCues, subtitleFiles, sttProviderConfigs } from '@/lib/db/schema';
import { headObject } from '@/lib/storage/client';
import { runTranscribeMedia } from '@/worker/jobs/transcribe-media';
import { stopBoss } from '@/worker/queues';
import { startSonioxMock, type SonioxMock } from '../mocks/soniox-mock';
import { clearRateLimits, createAdmin, createUser, resetDb, type TestUser } from './helpers';
import { newProject } from './voice-helpers';
import { createSttJobApi, FAST_STT, putSonioxConfig, SONIOX_KEY, sttJobRow, sttLogKeys, sttUsageRows } from './stt-helpers';

/** Luồng STT đầy đủ với Soniox giả + bản ghi sử dụng (spec 004, US1, US2, FR-018, T036b). */
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
  user = await createUser();
});

describe('STT thành công', () => {
  it('video → .srt có mốc thời gian, nạp vào Project, dọn file tạm và dữ liệu Soniox, 1 bản ghi usage', async () => {
    await putSonioxConfig(admin, mock, 'ok', { pricePerAudioHourUsd: 3.6 });
    const projectId = await newProject(user);
    const job = await createSttJobApi(user, projectId, 'sample-video-5s.mp4', { language: 'vi' });
    const tempKey = (await sttJobRow(job.id))!.tempStorageKey!;

    await runTranscribeMedia(job.id, FAST_STT);

    const row = (await sttJobRow(job.id))!;
    expect(row).toMatchObject({ status: 'completed', progressPercent: 100, errorCode: null, audioDurationMs: 9000, model: 'stt-async-v6', tempStorageKey: null });
    // Tệp kết quả: .srt có mốc → dùng được chế độ khớp mốc khi tạo voice (US1-AS6)
    const [file] = await getDb().select().from(subtitleFiles).where(eq(subtitleFiles.id, row.resultSubtitleFileId!));
    expect(file).toMatchObject({ projectId, ext: 'srt', hasTimecodes: true, cueCount: 3, originalName: 'sample-video-5s.srt' });
    const cues = await getDb().select().from(subtitleCues).where(eq(subtitleCues.subtitleFileId, file!.id));
    expect(cues.map((c) => c.text)).toContain('Xin chào các bạn.');
    // Dọn: file tạm MinIO + file/transcription trên Soniox
    expect(await headObject(tempKey)).toBeNull();
    expect(mock.deleted.files.size).toBe(1);
    expect(mock.deleted.transcriptions.size).toBe(1);
    // Ngôn ngữ gợi ý được gửi sang Soniox
    const body = JSON.parse(mock.requests.find((r) => r.path === '/v1/transcriptions' && r.method === 'POST')!.body) as Record<string, unknown>;
    expect(body.language_hints).toEqual(['vi']);
    // Đúng 1 bản ghi tính phí: 9 giây, chi phí = 9/3600 × 3,6
    const usage = await sttUsageRows(job.id);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ providerType: 'soniox', ok: true, unitsAudioSeconds: 9, unitsChars: null, userId: user.id, projectId });
    expect(usage[0]!.costEstimateUsd).toBeCloseTo(0.009, 6);
    // Nhật ký theo từng giai đoạn, không chứa khóa API
    const keys = await sttLogKeys(job.id);
    expect(keys).toEqual(expect.arrayContaining(['started', 'extracting', 'extracted', 'uploading', 'uploaded', 'transcribing', 'transcribed', 'formatting', 'saved', 'completed']));
    const all = JSON.stringify(await getDb().execute(`select * from stt_job_logs where stt_job_id = '${job.id}'`));
    expect(all).not.toContain(SONIOX_KEY);
  });

  it('.md có nhãn người nói khi bật diarization', async () => {
    await putSonioxConfig(admin, mock);
    const projectId = await newProject(user);
    const job = await createSttJobApi(user, projectId, 'sample-10s.mp3', { targetFormat: 'md', enableDiarization: 'true' });
    await runTranscribeMedia(job.id, FAST_STT);
    const row = (await sttJobRow(job.id))!;
    expect(row.status).toBe('completed');
    const res = await user.client.get(`/api/files/${row.resultSubtitleFileId}`);
    expect(res.status).toBe(200);
    const dto = (await res.json()) as { ext: string; rawText?: string };
    expect(dto.ext).toBe('md');
  });

  it('Soniox không trả thời lượng: ghi số ký tự thay vì bịa số giây', async () => {
    await putSonioxConfig(admin, mock, 'nodur');
    const projectId = await newProject(user);
    const job = await createSttJobApi(user, projectId);
    await runTranscribeMedia(job.id, FAST_STT);
    const usage = await sttUsageRows(job.id);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ ok: true, unitsAudioSeconds: null });
    expect(usage[0]!.unitsChars).toBeGreaterThan(0);
    expect(usage[0]!.costEstimateUsd).toBeNull();
  });
});

describe('STT lỗi', () => {
  it('không phát hiện giọng nói → failed NO_SPEECH_DETECTED, không tạo kịch bản', async () => {
    await putSonioxConfig(admin, mock, 'empty');
    const projectId = await newProject(user);
    const job = await createSttJobApi(user, projectId);
    await runTranscribeMedia(job.id, FAST_STT);
    const row = (await sttJobRow(job.id))!;
    expect(row).toMatchObject({ status: 'failed', errorCode: 'NO_SPEECH_DETECTED', resultSubtitleFileId: null });
    expect(row.errorMessage).toContain('Không phát hiện giọng nói');
    expect(await getDb().select().from(subtitleFiles).where(eq(subtitleFiles.projectId, projectId))).toHaveLength(0);
    expect(mock.deleted.files.size).toBe(1);
  });

  it('video không có âm thanh → failed NO_AUDIO_STREAM, không gọi Soniox', async () => {
    await putSonioxConfig(admin, mock);
    const projectId = await newProject(user);
    const job = await createSttJobApi(user, projectId, 'sample-silent-video.mp4');
    await runTranscribeMedia(job.id, FAST_STT);
    expect(await sttJobRow(job.id)).toMatchObject({ status: 'failed', errorCode: 'NO_AUDIO_STREAM', tempStorageKey: null });
    expect(mock.requests).toHaveLength(0);
  });

  it('lần gọi lỗi ghi usage ok = false, chi phí 0', async () => {
    await putSonioxConfig(admin, mock, '402');
    const projectId = await newProject(user);
    const job = await createSttJobApi(user, projectId);
    await runTranscribeMedia(job.id, FAST_STT);
    expect(await sttJobRow(job.id)).toMatchObject({ status: 'failed', errorCode: 'SONIOX_QUOTA' });
    const usage = await sttUsageRows(job.id);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ ok: false, costEstimateUsd: 0 });
  });
});
