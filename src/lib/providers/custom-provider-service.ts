import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { HttpError, notFound } from '../api/errors';
import { getDb } from '../db';
import { customAiProviders, jobLogs, users, voiceJobs } from '../db/schema';
import { vi } from '../i18n/vi';
import { isUuid } from '../projects/access';
import { decryptSecret, encryptSecret, secretHint } from '../security/crypto';
import { createSafeFetch } from '../security/safe-fetch';
import { getProvider } from './index';
import { allowInsecure, assertSafeBaseUrl } from './config-service';
import type { TestResult } from './types';

/**
 * Nhà cung cấp chuẩn OpenAI do Administrator tạo (spec 004, US5, FR-012..014, FR-022).
 * - Phạm vi: `public` (mọi User), `restricted` (User trong `assigned_user_ids`), `private` (chỉ Administrator).
 * - Khóa API mã hóa; chỉ `apiKeyHint` ra ngoài; User thường không thấy cả khóa che.
 * - Xóa/tắt: voice job chưa bắt đầu (`queued`/`interrupted`) chuyển `failed`; job đang chạy không bị động tới.
 */

type Row = typeof customAiProviders.$inferSelect;
export type AccessMode = Row['accessMode'];
export type Viewer = { id: string; role: 'admin' | 'user' };

export const customProviderInputSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    baseUrl: z.string().trim().min(1).max(500),
    /** Để trống khi sửa = giữ khóa cũ. Bắt buộc khi tạo mới. */
    apiKey: z.string().trim().max(500).optional(),
    models: z.array(z.string().trim().min(1).max(100)).max(100).default([]),
    defaultModel: z.string().trim().max(100).nullable().optional(),
    defaultVoice: z.string().trim().max(100).nullable().optional(),
    accessMode: z.enum(['public', 'restricted', 'private']).default('private'),
    assignedUserIds: z.array(z.string().uuid()).max(1000).default([]),
    enabled: z.boolean().optional(),
    pricePerMillionChars: z.number().finite().min(0).max(1_000_000).nullable().optional(),
  })
  .strict();
export type CustomProviderInput = z.infer<typeof customProviderInputSchema>;

export type CustomProviderAdminDto = {
  id: string;
  name: string;
  baseUrl: string;
  apiKeyHint: string;
  models: string[];
  defaultModel: string | null;
  defaultVoice: string | null;
  accessMode: AccessMode;
  assignedUserIds: string[];
  enabled: boolean;
  pricePerMillionChars: number | null;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastTestMessage: string | null;
};

/** Thông tin User thấy khi chọn nhà cung cấp tạo voice: không có khóa, địa chỉ hay danh sách User. */
export type CustomProviderUserDto = { id: string; name: string; models: string[]; defaultModel: string | null; defaultVoice: string | null };

export function toAdminDto(r: Row): CustomProviderAdminDto {
  return {
    id: r.id,
    name: r.name,
    baseUrl: r.baseUrl,
    apiKeyHint: r.apiKeyHint,
    models: r.models,
    defaultModel: r.defaultModel,
    defaultVoice: r.defaultVoice,
    accessMode: r.accessMode,
    assignedUserIds: r.assignedUserIds,
    enabled: r.enabled,
    pricePerMillionChars: r.pricePerMillionChars,
    lastTestAt: r.lastTestAt?.toISOString() ?? null,
    lastTestOk: r.lastTestOk,
    lastTestMessage: r.lastTestMessage,
  };
}

export const toUserDto = (r: Row): CustomProviderUserDto => ({ id: r.id, name: r.name, models: r.models, defaultModel: r.defaultModel, defaultVoice: r.defaultVoice });

/** User có được dùng provider này không (không xét `enabled`). */
export function hasAccess(viewer: Viewer, r: Pick<Row, 'accessMode' | 'assignedUserIds'>): boolean {
  if (viewer.role === 'admin') return true;
  if (r.accessMode === 'public') return true;
  if (r.accessMode === 'restricted') return r.assignedUserIds.includes(viewer.id);
  return false;
}

function normalize(input: CustomProviderInput) {
  const models = [...new Set(input.models.map((m) => m.trim()).filter(Boolean))];
  const assigned = input.accessMode === 'restricted' ? [...new Set(input.assignedUserIds)] : [];
  return { models, assigned };
}

export type AssignedUser = { id: string; email: string; displayName: string };

/** Danh sách cho Administrator, kèm email/tên của User được chỉ định (để hiển thị trong bộ chọn). */
export async function listCustomProvidersAdmin(): Promise<Array<CustomProviderAdminDto & { assignedUsers: AssignedUser[] }>> {
  const rows = await getDb().select().from(customAiProviders).orderBy(customAiProviders.name);
  const ids = [...new Set(rows.flatMap((r) => r.assignedUserIds))];
  const found = ids.length
    ? await getDb().select({ id: users.id, email: users.email, displayName: users.name }).from(users).where(inArray(users.id, ids))
    : [];
  const byId = new Map(found.map((u) => [u.id, u]));
  return rows.map((r) => ({ ...toAdminDto(r), assignedUsers: r.assignedUserIds.map((id) => byId.get(id)).filter((u): u is AssignedUser => !!u) }));
}

async function getRow(id: string): Promise<Row> {
  if (!isUuid(id)) throw notFound();
  const [row] = await getDb().select().from(customAiProviders).where(eq(customAiProviders.id, id)).limit(1);
  if (!row) throw notFound();
  return row;
}

/** Provider đang bật mà User được dùng (để chọn khi tạo voice). */
export async function listCustomProvidersForUser(viewer: Viewer): Promise<CustomProviderUserDto[]> {
  const rows = await getDb()
    .select()
    .from(customAiProviders)
    .where(
      viewer.role === 'admin'
        ? eq(customAiProviders.enabled, true)
        : and(
            eq(customAiProviders.enabled, true),
            sql`(${customAiProviders.accessMode} = 'public' or (${customAiProviders.accessMode} = 'restricted' and ${customAiProviders.assignedUserIds} @> to_jsonb(${viewer.id}::text)))`,
          ),
    )
    .orderBy(customAiProviders.name);
  return rows.map(toUserDto);
}

export class CustomProviderUnavailable extends HttpError {
  constructor(public readonly reason: 'CUSTOM_PROVIDER_UNAVAILABLE' | 'CUSTOM_PROVIDER_FORBIDDEN') {
    super(404, reason);
  }
}

/**
 * Provider mà User được dùng NGAY BÂY GIỜ (kiểm tra ở máy chủ lúc tạo job và lúc worker nhận job, FR-022).
 * Không tồn tại/đang tắt → CUSTOM_PROVIDER_UNAVAILABLE; mất quyền → CUSTOM_PROVIDER_FORBIDDEN.
 */
export async function getUsableCustomProvider(viewer: Viewer, id: string | null | undefined): Promise<Row> {
  if (!id || !isUuid(id)) throw new CustomProviderUnavailable('CUSTOM_PROVIDER_UNAVAILABLE');
  const [row] = await getDb().select().from(customAiProviders).where(eq(customAiProviders.id, id)).limit(1);
  if (!row || !row.enabled) throw new CustomProviderUnavailable('CUSTOM_PROVIDER_UNAVAILABLE');
  if (!hasAccess(viewer, row)) throw new CustomProviderUnavailable('CUSTOM_PROVIDER_FORBIDDEN');
  return row;
}

export async function createCustomProvider(input: CustomProviderInput): Promise<CustomProviderAdminDto> {
  if (!input.apiKey) throw new HttpError(422, 'VALIDATION', undefined, { apiKey: 'Cần nhập khóa API khi tạo cấu hình' });
  const baseUrl = input.baseUrl.replace(/\/+$/, '');
  await assertSafeBaseUrl(baseUrl);
  const { models, assigned } = normalize(input);
  const [row] = await getDb()
    .insert(customAiProviders)
    .values({
      name: input.name,
      baseUrl,
      apiKeyEnc: encryptSecret(input.apiKey),
      apiKeyHint: secretHint(input.apiKey),
      models,
      defaultModel: input.defaultModel ?? null,
      defaultVoice: input.defaultVoice ?? null,
      accessMode: input.accessMode,
      assignedUserIds: assigned,
      enabled: input.enabled ?? true,
      pricePerMillionChars: input.pricePerMillionChars ?? null,
    })
    .returning();
  return toAdminDto(row!);
}

/** Hủy voice job chưa bắt đầu đang dùng provider (khi xóa/tắt). Trả số job bị hủy. */
async function failPendingJobs(tx: Pick<ReturnType<typeof getDb>, 'update' | 'insert'>, providerId: string): Promise<number> {
  const failed = await tx
    .update(voiceJobs)
    .set({ status: 'failed', errorCode: 'CUSTOM_PROVIDER_UNAVAILABLE', errorMessage: vi.errors.CUSTOM_PROVIDER_UNAVAILABLE, finishedAt: new Date() })
    .where(and(eq(voiceJobs.customProviderId, providerId), inArray(voiceJobs.status, ['queued', 'interrupted'])))
    .returning({ id: voiceJobs.id });
  if (failed.length) {
    await tx.insert(jobLogs).values(
      failed.map((j) => ({ jobId: j.id, level: 'error' as const, code: 'JOB_FAILED', message: vi.errors.CUSTOM_PROVIDER_UNAVAILABLE })),
    );
  }
  return failed.length;
}

export async function updateCustomProvider(id: string, input: CustomProviderInput): Promise<CustomProviderAdminDto & { cancelledJobs: number }> {
  const existing = await getRow(id);
  const baseUrl = input.baseUrl.replace(/\/+$/, '');
  await assertSafeBaseUrl(baseUrl);
  const { models, assigned } = normalize(input);
  const enabled = input.enabled ?? existing.enabled;
  return getDb().transaction(async (tx) => {
    const [row] = await tx
      .update(customAiProviders)
      .set({
        name: input.name,
        baseUrl,
        models,
        defaultModel: input.defaultModel === undefined ? existing.defaultModel : input.defaultModel,
        defaultVoice: input.defaultVoice === undefined ? existing.defaultVoice : input.defaultVoice,
        accessMode: input.accessMode,
        assignedUserIds: assigned,
        enabled,
        pricePerMillionChars: input.pricePerMillionChars === undefined ? existing.pricePerMillionChars : input.pricePerMillionChars,
        updatedAt: new Date(),
        ...(input.apiKey ? { apiKeyEnc: encryptSecret(input.apiKey), apiKeyHint: secretHint(input.apiKey) } : {}),
        ...(input.apiKey || baseUrl !== existing.baseUrl ? { lastTestAt: null, lastTestOk: null, lastTestMessage: null } : {}),
      })
      .where(eq(customAiProviders.id, id))
      .returning();
    // Tắt provider: xử lý như xóa (US5-AS4)
    const cancelledJobs = existing.enabled && !enabled ? await failPendingJobs(tx, id) : 0;
    return { ...toAdminDto(row!), cancelledJobs };
  });
}

export async function countPendingJobs(id: string): Promise<number> {
  await getRow(id);
  const [r] = await getDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(voiceJobs)
    .where(and(eq(voiceJobs.customProviderId, id), inArray(voiceJobs.status, ['queued', 'interrupted'])));
  return r?.n ?? 0;
}

/** Xóa provider: hủy job chưa bắt đầu rồi xóa, trong một giao dịch. Job đang chạy hoàn tất với cấu hình đã nạp. */
export async function deleteCustomProvider(id: string): Promise<{ cancelledJobs: number }> {
  await getRow(id);
  return getDb().transaction(async (tx) => {
    const cancelledJobs = await failPendingJobs(tx, id);
    await tx.delete(customAiProviders).where(eq(customAiProviders.id, id));
    return { cancelledJobs };
  });
}

/** Ngữ cảnh gọi cho adapter openai_compatible (khóa giải mã chỉ sống trong bộ nhớ). */
export function customCallContext(row: Row, opts: { signal?: AbortSignal } = {}) {
  return {
    config: { baseUrl: row.baseUrl, apiKey: decryptSecret(row.apiKeyEnc) },
    signal: opts.signal,
    fetch: createSafeFetch({ allowInsecure: allowInsecure() }),
  };
}

export async function testCustomProvider(id: string): Promise<TestResult> {
  const row = await getRow(id);
  const result = await getProvider('openai_compatible').testConnection(customCallContext(row));
  await getDb()
    .update(customAiProviders)
    .set({ lastTestAt: new Date(), lastTestOk: result.ok, lastTestMessage: result.message })
    .where(eq(customAiProviders.id, id));
  return result;
}
