import { getDb, type Db } from '../lib/db';
import { jobLogs } from '../lib/db/schema';
import { redactDeep, redactSecrets } from '../lib/security/redact';

export type LogLevel = 'info' | 'warn' | 'error';

/**
 * Ghi một dòng log tiến trình. Mọi chuỗi đều được làm sạch (không lộ khóa API / URL có khóa).
 * `secrets` là các khóa đang dùng, được che theo giá trị chính xác kể cả khi không khớp mẫu nào.
 */
export async function appendLog(
  jobId: string,
  level: LogLevel,
  code: string,
  message: string,
  meta?: Record<string, unknown>,
  secrets: readonly string[] = [],
  db: Db = getDb(),
): Promise<number> {
  const [row] = await db
    .insert(jobLogs)
    .values({
      jobId,
      level,
      code,
      message: redactSecrets(message, secrets),
      meta: meta ? redactDeep(meta, secrets) : null,
    })
    .returning({ id: jobLogs.id });
  return row!.id;
}
