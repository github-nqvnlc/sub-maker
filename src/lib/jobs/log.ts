import { getDb } from '../db';
import { jobLogs } from '../db/schema';
import { redactDeep, redactSecrets } from '../security/redact';

/** Ghi log phía web (không phụ thuộc thư mục worker); cùng quy tắc làm sạch khóa như worker. */
export async function appendLogSafe(
  jobId: string,
  level: 'info' | 'warn' | 'error',
  code: string,
  message: string,
  meta?: Record<string, unknown>,
): Promise<void> {
  await getDb()
    .insert(jobLogs)
    .values({ jobId, level, code, message: redactSecrets(message), meta: meta ? redactDeep(meta) : null });
}
