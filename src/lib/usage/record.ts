import { getDb, type Db } from '../db';
import { usageRecords } from '../db/schema';
import type { ProviderType } from '../schemas/common';

/**
 * Ghi nhận mỗi lần GỌI THẬT nhà cung cấp (FR-040, FR-045). Lần dùng lại từ cache KHÔNG ghi.
 * - `unitsChars` = số ký tự Unicode thực gửi.
 * - `unitsTokens` chỉ điền khi nhà cung cấp trả về (TTS hiện không trả): không bịa số (Nguyên tắc IV).
 * - `costEstimateUsd` = ký tự × giá/1 triệu ký tự (cấu hình), hoặc NULL khi không có giá.
 * - `ok = false`: lần gọi lỗi (không tính phí) vẫn được ghi để chẩn đoán; thống kê chỉ cộng bản ghi `ok`.
 */
export type UsageInput = {
  userId: string;
  projectId: string;
  jobId: string;
  providerType: ProviderType;
  configScope: 'global' | 'user';
  model: string | null;
  voice: string | null;
  unitsChars: number;
  unitsTokens?: number | null;
  pricePerMillionChars: number | null;
  ok: boolean;
};

export function estimateCostUsd(chars: number, pricePerMillionChars: number | null): number | null {
  if (pricePerMillionChars == null || !Number.isFinite(pricePerMillionChars)) return null;
  return (chars * pricePerMillionChars) / 1_000_000;
}

export async function recordUsage(input: UsageInput, db: Db = getDb()): Promise<void> {
  await db.insert(usageRecords).values({
    userId: input.userId,
    projectId: input.projectId,
    jobId: input.jobId,
    providerType: input.providerType,
    configScope: input.configScope,
    model: input.model,
    voice: input.voice,
    unitsChars: input.unitsChars,
    unitsTokens: input.unitsTokens ?? null,
    // chỉ ước tính chi phí cho lần gọi thành công
    costEstimateUsd: input.ok ? estimateCostUsd(input.unitsChars, input.pricePerMillionChars) : null,
    ok: input.ok,
  });
}
