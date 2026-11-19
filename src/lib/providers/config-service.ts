import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db';
import { aiProviderConfigs } from '../db/schema';
import { HttpError } from '../api/errors';
import { env } from '../env';
import { decryptSecret, encryptSecret, secretHint } from '../security/crypto';
import { createSafeFetch, resolveSafeTarget, SsrfError } from '../security/safe-fetch';
import { providerTypeSchema } from '../schemas/common';
import { getCatalog } from './catalog';
import { getProvider } from './index';
import type { CallContext, PollingOptions, ProviderType, TestResult } from './types';

/**
 * Quản lý cấu hình nhà cung cấp AI (FR-041..045, data-model.md → ai_provider_configs).
 * - Khóa API luôn mã hóa; chỉ `apiKeyHint` ra ngoài.
 * - `baseUrl` phải qua kiểm tra SSRF ngay lúc lưu và lúc gọi.
 * - Cấu hình riêng chỉ dùng được khi User thuộc danh sách (`can_use_custom_ai`).
 */

type Row = typeof aiProviderConfigs.$inferSelect;
export type ConfigScope = 'global' | 'user';

export type AiConfigDto = {
  scope: ConfigScope;
  type: ProviderType;
  name: string;
  baseUrl: string;
  apiKeyHint: string;
  defaultModel: string | null;
  defaultVoice: string | null;
  defaultSpeed: number | null;
  maxCharsPerRequest: number;
  pricePerMillionChars: number | null;
  enabled: boolean;
  disabledReason: 'owner_removed_from_list' | 'admin_disabled' | null;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
};

export function toDto(row: Row): AiConfigDto {
  return {
    scope: row.scope,
    type: row.type,
    name: row.name,
    baseUrl: row.baseUrl,
    apiKeyHint: row.apiKeyHint,
    defaultModel: row.defaultModel,
    defaultVoice: row.defaultVoice,
    defaultSpeed: row.defaultSpeed,
    maxCharsPerRequest: row.maxCharsPerRequest,
    pricePerMillionChars: row.pricePerMillionChars,
    enabled: row.enabled,
    disabledReason: row.disabledReason,
    lastTestAt: row.lastTestAt?.toISOString() ?? null,
    lastTestOk: row.lastTestOk,
  };
}

export const aiConfigInputSchema = z
  .object({
    type: providerTypeSchema,
    name: z.string().trim().min(1).max(100).optional(),
    baseUrl: z.string().trim().min(1).max(500),
    /** Để trống khi sửa = giữ khóa cũ. Bắt buộc khi tạo mới. */
    apiKey: z.string().trim().max(500).optional(),
    defaultModel: z.string().trim().max(100).nullable().optional(),
    defaultVoice: z.string().trim().max(100).nullable().optional(),
    defaultSpeed: z.number().finite().nullable().optional(),
    maxCharsPerRequest: z.number().int().min(1).max(100_000).optional(),
    pricePerMillionChars: z.number().finite().min(0).max(1_000_000).nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
export type AiConfigInput = z.infer<typeof aiConfigInputSchema>;

const allowInsecure = () => env().ALLOW_INSECURE_PROVIDER_URLS;

/** Kiểm tra `baseUrl` bằng đúng quy tắc safeFetch (https, không địa chỉ nội bộ) ngay lúc lưu. */
async function assertSafeBaseUrl(baseUrl: string): Promise<void> {
  try {
    await resolveSafeTarget(baseUrl, { allowInsecure: allowInsecure() });
  } catch (e) {
    if (e instanceof SsrfError) {
      throw new HttpError(422, 'VALIDATION', undefined, { baseUrl: 'Địa chỉ gốc không hợp lệ hoặc không được phép (cần https, không trỏ về mạng nội bộ).' });
    }
    throw e;
  }
}

function validateDefaults(type: ProviderType, input: AiConfigInput): void {
  const cat = getCatalog(type);
  const fields: Record<string, string> = {};
  const model = input.defaultModel ? cat.models.find((m) => m.id === input.defaultModel) : undefined;
  if (input.defaultModel && !model) fields.defaultModel = 'Model không được hỗ trợ cho nhà cung cấp này';
  if (input.defaultVoice) {
    const pool = model ? model.voices : cat.models.flatMap((m) => m.voices);
    if (!pool.some((v) => v.id === input.defaultVoice)) fields.defaultVoice = 'Giọng đọc không có trong danh mục';
  }
  if (input.defaultSpeed != null && (input.defaultSpeed < cat.speed.min || input.defaultSpeed > cat.speed.max)) {
    fields.defaultSpeed = `Tốc độ phải từ ${cat.speed.min} đến ${cat.speed.max}`;
  }
  if (input.maxCharsPerRequest != null && input.maxCharsPerRequest > cat.maxCharsPerRequest) {
    fields.maxCharsPerRequest = `Tối đa ${cat.maxCharsPerRequest} ký tự mỗi yêu cầu`;
  }
  if (Object.keys(fields).length) throw new HttpError(422, 'VALIDATION', undefined, fields);
}

function whereScope(scope: ConfigScope, ownerUserId: string | null, type?: ProviderType) {
  const base = scope === 'global' ? and(eq(aiProviderConfigs.scope, 'global'), isNull(aiProviderConfigs.ownerUserId)) : and(eq(aiProviderConfigs.scope, 'user'), eq(aiProviderConfigs.ownerUserId, ownerUserId!));
  return type ? and(base, eq(aiProviderConfigs.type, type)) : base;
}

export async function listConfigs(scope: ConfigScope, ownerUserId: string | null): Promise<AiConfigDto[]> {
  const rows = await getDb().select().from(aiProviderConfigs).where(whereScope(scope, ownerUserId)).orderBy(desc(aiProviderConfigs.createdAt));
  return rows.map(toDto);
}

export async function getConfigRow(scope: ConfigScope, ownerUserId: string | null, type: ProviderType): Promise<Row | null> {
  const [row] = await getDb().select().from(aiProviderConfigs).where(whereScope(scope, ownerUserId, type)).limit(1);
  return row ?? null;
}

/** Tạo/sửa cấu hình theo (scope, owner, type). `apiKey` trống khi sửa = giữ khóa cũ. */
export async function upsertConfig(scope: ConfigScope, ownerUserId: string | null, input: AiConfigInput): Promise<AiConfigDto> {
  const cat = getCatalog(input.type);
  const existing = await getConfigRow(scope, ownerUserId, input.type);
  if (!existing && !input.apiKey) {
    throw new HttpError(422, 'VALIDATION', undefined, { apiKey: 'Cần nhập khóa API khi tạo cấu hình' });
  }
  await assertSafeBaseUrl(input.baseUrl);
  validateDefaults(input.type, input);

  // Cấu hình riêng bị vô hiệu vì User từng bị gỡ khỏi danh sách: User chỉ lưu được khi đã được thêm lại,
  // nên lưu lại nghĩa là bật lại (trừ khi chủ động chỉ định `enabled`).
  const reenable = existing?.disabledReason === 'owner_removed_from_list';
  const enabled = input.enabled ?? (reenable ? true : (existing?.enabled ?? true));
  const values = {
    name: input.name ?? existing?.name ?? cat.label,
    baseUrl: input.baseUrl.replace(/\/+$/, ''),
    defaultModel: input.defaultModel === undefined ? (existing?.defaultModel ?? null) : input.defaultModel,
    defaultVoice: input.defaultVoice === undefined ? (existing?.defaultVoice ?? null) : input.defaultVoice,
    defaultSpeed: input.defaultSpeed === undefined ? (existing?.defaultSpeed ?? null) : input.defaultSpeed,
    maxCharsPerRequest: input.maxCharsPerRequest ?? existing?.maxCharsPerRequest ?? cat.maxCharsPerRequest,
    pricePerMillionChars: input.pricePerMillionChars === undefined ? (existing?.pricePerMillionChars ?? null) : input.pricePerMillionChars,
    enabled,
    // Bật lại thì xóa lý do vô hiệu; tắt thủ công bởi Administrator ghi nhận lý do
    disabledReason: enabled ? null : scope === 'global' ? ('admin_disabled' as const) : (existing?.disabledReason ?? null),
    ...(input.apiKey ? { apiKeyEnc: encryptSecret(input.apiKey), apiKeyHint: secretHint(input.apiKey) } : {}),
    updatedAt: new Date(),
  };

  const db = getDb();
  if (existing) {
    const [row] = await db
      .update(aiProviderConfigs)
      // đổi khóa/địa chỉ thì kết quả kiểm tra kết nối cũ không còn đúng
      .set({ ...values, ...(input.apiKey || existing.baseUrl !== values.baseUrl ? { lastTestAt: null, lastTestOk: null, lastTestMessage: null } : {}) })
      .where(eq(aiProviderConfigs.id, existing.id))
      .returning();
    return toDto(row!);
  }
  const [row] = await db
    .insert(aiProviderConfigs)
    .values({
      scope,
      ownerUserId: scope === 'user' ? ownerUserId : null,
      type: input.type,
      apiKeyEnc: encryptSecret(input.apiKey!),
      apiKeyHint: secretHint(input.apiKey!),
      ...values,
    })
    .returning();
  return toDto(row!);
}

export async function deleteConfig(scope: ConfigScope, ownerUserId: string | null, type: ProviderType): Promise<boolean> {
  const res = await getDb().delete(aiProviderConfigs).where(whereScope(scope, ownerUserId, type)).returning({ id: aiProviderConfigs.id });
  return res.length > 0;
}

/** FR-044: gỡ User khỏi danh sách → cấu hình riêng bị vô hiệu (giữ lại, không xóa). */
export async function disablePersonalConfigs(userId: string): Promise<number> {
  const res = await getDb()
    .update(aiProviderConfigs)
    .set({ enabled: false, disabledReason: 'owner_removed_from_list', updatedAt: new Date() })
    .where(and(eq(aiProviderConfigs.scope, 'user'), eq(aiProviderConfigs.ownerUserId, userId), eq(aiProviderConfigs.enabled, true)))
    .returning({ id: aiProviderConfigs.id });
  return res.length;
}

// ---- Gọi nhà cung cấp --------------------------------------------------------------------------

export function buildCallContext(row: Row, opts: { signal?: AbortSignal; polling?: PollingOptions } = {}): CallContext {
  return {
    config: { baseUrl: row.baseUrl, apiKey: decryptSecret(row.apiKeyEnc) },
    signal: opts.signal,
    fetch: createSafeFetch({ allowInsecure: allowInsecure() }),
    polling: opts.polling,
  };
}

export async function testConfig(scope: ConfigScope, ownerUserId: string | null, type: ProviderType, opts: { polling?: PollingOptions } = {}): Promise<TestResult> {
  const row = await getConfigRow(scope, ownerUserId, type);
  if (!row) throw new HttpError(404, 'NOT_FOUND');
  const result = await getProvider(type).testConnection(buildCallContext(row, { polling: opts.polling }));
  await getDb()
    .update(aiProviderConfigs)
    .set({ lastTestAt: new Date(), lastTestOk: result.ok, lastTestMessage: result.message })
    .where(eq(aiProviderConfigs.id, row.id));
  return result;
}

// ---- Chọn cấu hình lúc bắt đầu job -------------------------------------------------------------

export type ResolvedConfig = { row: Row; scope: ConfigScope };

/**
 * Chọn cấu hình cho job (data-model.md):
 * User thuộc danh sách có cấu hình riêng `enabled` → dùng riêng; ngược lại dùng cấu hình chung `enabled`;
 * không có → 409 PROVIDER_NOT_CONFIGURED. Cấu hình riêng LỖI không bao giờ tự rơi về cấu hình chung
 * (việc đó do worker bảo đảm: nó chỉ gọi hàm này một lần lúc bắt đầu).
 */
export async function resolveConfigForJob(user: { id: string; canUseCustomAi: boolean }, type: ProviderType): Promise<ResolvedConfig> {
  if (user.canUseCustomAi) {
    const personal = await getConfigRow('user', user.id, type);
    if (personal && personal.enabled) return { row: personal, scope: 'user' };
  }
  const global = await getConfigRow('global', null, type);
  if (global && global.enabled) return { row: global, scope: 'global' };
  throw new HttpError(409, 'PROVIDER_NOT_CONFIGURED');
}

/** Cho giao diện: nhà cung cấp nào khả dụng với User này và có đang dùng cấu hình riêng không. */
export async function availabilityFor(user: { id: string; canUseCustomAi: boolean }): Promise<Record<ProviderType, { available: boolean; usingOwnConfig: boolean }>> {
  const rows = await getDb()
    .select({ scope: aiProviderConfigs.scope, owner: aiProviderConfigs.ownerUserId, type: aiProviderConfigs.type, enabled: aiProviderConfigs.enabled })
    .from(aiProviderConfigs)
    .where(sql`${aiProviderConfigs.enabled} = true and (${aiProviderConfigs.scope} = 'global' or ${aiProviderConfigs.ownerUserId} = ${user.id})`);
  const out = {} as Record<ProviderType, { available: boolean; usingOwnConfig: boolean }>;
  for (const type of ['fpt_marketplace', 'shopaikey_openai', 'shopaikey_minimax'] as const) {
    const own = user.canUseCustomAi && rows.some((r) => r.scope === 'user' && r.type === type);
    const global = rows.some((r) => r.scope === 'global' && r.type === type);
    out[type] = { available: own || global, usingOwnConfig: own };
  }
  return out;
}
