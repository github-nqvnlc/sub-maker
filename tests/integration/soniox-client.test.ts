import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ProviderError } from '@/lib/providers/errors';
import { SonioxSttClient } from '@/lib/providers/adapters/soniox';
import { createSafeFetch } from '@/lib/security/safe-fetch';
import { startSonioxMock, type SonioxMock } from '../mocks/soniox-mock';

/** Client Soniox gọi máy chủ giả (spec 004, T031, contracts/soniox-client.md). */
let mock: SonioxMock;
const KEY = 'sk-soniox-client-test';
const client = (scenario = 'ok') => new SonioxSttClient({ config: { baseUrl: mock.baseUrl(scenario), apiKey: KEY }, fetch: createSafeFetch({ allowInsecure: true }) });

beforeAll(async () => {
  mock = await startSonioxMock();
});
afterAll(async () => {
  await mock.close();
});
beforeEach(() => mock.reset());

describe('SonioxSttClient', () => {
  it('upload → tạo transcription (language_hints, model async) → poll → transcript → xóa', async () => {
    const c = client();
    const { fileId } = await c.uploadAudioFile(new Uint8Array([1, 2, 3, 4]), 'a.mp3');
    const { transcriptionId } = await c.startTranscription(fileId, { model: 'stt-async-v6', languageHints: ['vi'], enableSpeakerDiarization: true });
    const created = JSON.parse(mock.requests.find((r) => r.path === '/v1/transcriptions')!.body) as Record<string, unknown>;
    expect(created).toMatchObject({ model: 'stt-async-v6', file_id: fileId, language_hints: ['vi'], enable_speaker_diarization: true });
    const t = await c.getTranscription(transcriptionId);
    expect(t).toMatchObject({ status: 'completed', audio_duration_ms: 9000 });
    const tr = await c.getTranscript(transcriptionId);
    expect(tr.tokens.length).toBeGreaterThan(5);
    expect(tr.tokens[0]).toHaveProperty('start_ms');
    await c.deleteTranscription(transcriptionId);
    await c.deleteFile(fileId);
    expect(mock.deleted.files.has(fileId)).toBe(true);
    expect(mock.deleted.transcriptions.has(transcriptionId)).toBe(true);
    // Khóa chỉ nằm trong header, không bao giờ trên URL
    expect(mock.requests.every((r) => r.auth === `Bearer ${KEY}` && !r.path.includes(KEY))).toBe(true);
  });

  it('tự nhận diện ngôn ngữ: không gửi language_hints', async () => {
    const c = client();
    const { fileId } = await c.uploadAudioFile(new Uint8Array([1]), 'a.mp3');
    await c.startTranscription(fileId, { model: 'stt-async-v6' });
    const body = JSON.parse(mock.requests.find((r) => r.path === '/v1/transcriptions')!.body) as Record<string, unknown>;
    expect(body).not.toHaveProperty('language_hints');
  });

  it('model real-time bị từ chối trước khi gọi (FR-010)', async () => {
    await expect(client().startTranscription('x', { model: 'stt-rt-v6' })).rejects.toMatchObject({ kind: 'forbidden_model' });
    expect(mock.requests).toHaveLength(0);
  });

  it('phân loại lỗi: 401 → auth, 402 → quota, 429/5xx → transient', async () => {
    await expect(client('401').uploadAudioFile(new Uint8Array([1]), 'a.mp3')).rejects.toMatchObject({ kind: 'auth' });
    const ok = client('402');
    const { fileId } = await ok.uploadAudioFile(new Uint8Array([1]), 'a.mp3');
    await expect(ok.startTranscription(fileId, { model: 'stt-async-v6' })).rejects.toMatchObject({ kind: 'quota' });
    const e429 = await client('429-1').uploadAudioFile(new Uint8Array([1]), 'a.mp3').catch((e: unknown) => e);
    expect(e429).toBeInstanceOf(ProviderError);
    expect((e429 as ProviderError).retryable).toBe(true);
    const e5 = await client('5xx').getTranscription('x').catch((e: unknown) => e);
    expect((e5 as ProviderError).kind).toBe('transient');
  });

  it('xóa đối tượng không còn (404) coi như thành công', async () => {
    await expect(client().deleteTranscription('00000000-0000-4000-8000-000000000000')).resolves.toBeUndefined();
  });

  it('testConnection: GET /v1/models', async () => {
    expect(await client().testConnection()).toMatchObject({ ok: true });
    expect(await client('401').testConnection()).toMatchObject({ ok: false });
  });
});
