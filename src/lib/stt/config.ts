import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { HttpError } from '../api/errors';
import { getDb } from '../db';
import { sttProviderConfigs } from '../db/schema';
import { decryptSecret, encryptSecret, secretHint } from '../security/crypto';
import { createSafeFetch } from '../security/safe-fetch';
import { allowInsecure, assertSafeBaseUrl } from '../providers/config-service';
import { SonioxSttClient } from '../providers/adapters/soniox';
import { isRealtimeModel, SONIOX_DEFAULT_BASE_URL, SONIOX_DEFAULT_MODEL } from '../providers/adapters/soniox-types';
import type { TestResult } from '../providers/types';

/**
 * Cấu hình Soniox dùng chung (spec 004, FR-009/FR-010): MỘT token cho mọi model STT. Chỉ Administrator đọc/ghi.
 * Khóa API mã hóa AES-256-GCM; chỉ `apiKeyHint` ra ngoài (Nguyên tắc II).
 */

type Row = typeof sttProviderConfigs.$inferSelect;

export type SttConfigDto = {
  provider: 'soniox';
  baseUrl: string;
  apiKeyHint: string;
  defaultModel: string;
  enableDiarization: boolean;
  pricePerAudioHourUsd: number | null;
  enabled: boolean;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastTestMessage: string | null;
};

export function toSttConfigDto(row: Row): SttConfigDto {
  return {
    provider: 'soniox',
    baseUrl: row.baseUrl,
    apiKeyHint: row.apiKeyHint,
    defaultModel: row.defaultModel,
    enableDiarization: row.enableDiarization,
    pricePerAudioHourUsd: row.pricePerAudioHourUsd,
    enabled: row.enabled,
    lastTestAt: row.lastTestAt?.toISOString() ?? null,
    lastTestOk: row.lastTestOk,
    lastTestMessage: row.lastTestMessage,
  };
}

export const sttConfigInputSchema = z
  .object({
    baseUrl: z.string().trim().min(1).max(500).optional(),
    /** Để trống khi sửa = giữ khóa cũ. Bắt buộc khi tạo mới. */
    apiKey: z.string().trim().max(500).optional(),
    defaultModel: z.string().trim().min(1).max(32).optional(),
    enableDiarization: z.boolean().optional(),
    pricePerAudioHourUsd: z.number().finite().min(0).max(10_000).nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
export type SttConfigInput = z.infer<typeof sttConfigInputSchema>;

export async function getSttConfigRow(): Promise<Row | null> {
  const [row] = await getDb().select().from(sttProviderConfigs).where(eq(sttProviderConfigs.provider, 'soniox')).limit(1);
  return row ?? null;
}

export async function getSttConfig(): Promise<SttConfigDto | null> {
  const row = await getSttConfigRow();
  return row ? toSttConfigDto(row) : null;
}

export async function upsertSttConfig(input: SttConfigInput): Promise<SttConfigDto> {
  const existing = await getSttConfigRow();
  if (!existing && !input.apiKey) {
    throw new HttpError(422, 'VALIDATION', undefined, { apiKey: 'Cần nhập khóa API khi tạo cấu hình' });
  }
  // FR-010: model mặc định cho tạo phụ đề phải là model async
  if (input.defaultModel && isRealtimeModel(input.defaultModel)) {
    throw new HttpError(422, 'VALIDATION', undefined, { defaultModel: 'Model real-time không dùng được để tạo phụ đề. Hãy chọn model async.' });
  }
  const baseUrl = (input.baseUrl ?? existing?.baseUrl ?? SONIOX_DEFAULT_BASE_URL).replace(/\/+$/, '');
  await assertSafeBaseUrl(baseUrl);

  const values = {
    baseUrl,
    defaultModel: input.defaultModel ?? existing?.defaultModel ?? SONIOX_DEFAULT_MODEL,
    enableDiarization: input.enableDiarization ?? existing?.enableDiarization ?? false,
    pricePerAudioHourUsd: input.pricePerAudioHourUsd === undefined ? (existing?.pricePerAudioHourUsd ?? null) : input.pricePerAudioHourUsd,
    enabled: input.enabled ?? existing?.enabled ?? true,
    updatedAt: new Date(),
    ...(input.apiKey ? { apiKeyEnc: encryptSecret(input.apiKey), apiKeyHint: secretHint(input.apiKey) } : {}),
  };
  const db = getDb();
  if (existing) {
    const reset = input.apiKey || existing.baseUrl !== baseUrl ? { lastTestAt: null, lastTestOk: null, lastTestMessage: null } : {};
    const [row] = await db
      .update(sttProviderConfigs)
      .set({ ...values, ...reset })
      .where(eq(sttProviderConfigs.id, existing.id))
      .returning();
    return toSttConfigDto(row!);
  }
  const [row] = await db
    .insert(sttProviderConfigs)
    .values({ provider: 'soniox', apiKeyEnc: encryptSecret(input.apiKey!), apiKeyHint: secretHint(input.apiKey!), ...values })
    .returning();
  return toSttConfigDto(row!);
}

export async function deleteSttConfig(): Promise<boolean> {
  const res = await getDb().delete(sttProviderConfigs).where(eq(sttProviderConfigs.provider, 'soniox')).returning({ id: sttProviderConfigs.id });
  return res.length > 0;
}

/** Client Soniox từ cấu hình (khóa giải mã chỉ sống trong bộ nhớ). */
export function sonioxClientFor(row: Row, signal?: AbortSignal): { client: SonioxSttClient; apiKey: string } {
  const apiKey = decryptSecret(row.apiKeyEnc);
  const client = new SonioxSttClient({
    config: { baseUrl: row.baseUrl, apiKey },
    signal,
    // Upload audio và transcript dài: thời gian chờ rộng hơn TTS
    fetch: createSafeFetch({ allowInsecure: allowInsecure(), timeoutMs: 10 * 60_000 }),
  });
  return { client, apiKey };
}

export async function testSttConfig(): Promise<TestResult> {
  const row = await getSttConfigRow();
  if (!row) throw new HttpError(404, 'NOT_FOUND');
  const { client } = sonioxClientFor(row);
  const result = await client.testConnection();
  await getDb()
    .update(sttProviderConfigs)
    .set({ lastTestAt: new Date(), lastTestOk: result.ok, lastTestMessage: result.message })
    .where(eq(sttProviderConfigs.id, row.id));
  return { ok: result.ok, message: result.message, latencyMs: result.latencyMs };
}
