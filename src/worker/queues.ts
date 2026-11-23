import { PgBoss } from 'pg-boss';

/** Tên hàng đợi và dữ liệu công việc (data-model.md, research R3). */
export const QUEUES = {
  generateVoice: 'generate-voice',
  deleteUser: 'delete-user',
  reconcileStorage: 'reconcile-storage',
  transcribeMedia: 'transcribe-media',
} as const;

export type GenerateVoicePayload = { jobId: string };
export type DeleteUserPayload = { userId: string };
export type ReconcileStoragePayload = Record<string, never>;
export type TranscribeMediaPayload = { jobId: string };

type Role = 'web' | 'worker';

type Holder = { boss?: PgBoss; role?: Role; url?: string; starting?: Promise<PgBoss> };
const g = globalThis as unknown as { __submakerBoss?: Holder };
const holder: Holder = (g.__submakerBoss ??= {});

/**
 * Tạo/khởi động pg-boss dùng chung theo tiến trình.
 * - `web`: chỉ gửi việc (không giám sát, không lịch), để worker là bên duy nhất bảo trì hàng đợi.
 * - `worker`: giám sát và xử lý việc.
 */
export async function getBoss(role: Role = 'web'): Promise<PgBoss> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Thiếu biến môi trường DATABASE_URL');
  if (holder.boss && holder.url === url) return holder.boss;
  if (holder.starting && holder.url === url) return holder.starting;

  holder.url = url;
  holder.role = role;
  holder.starting = (async () => {
    const boss = new PgBoss({
      connectionString: url,
      supervise: role === 'worker',
      schedule: role === 'worker',
      migrate: true,
    });
    boss.on('error', (err) => console.error('[pg-boss] lỗi:', err instanceof Error ? err.message : err));
    await boss.start();
    await ensureQueues(boss);
    holder.boss = boss;
    return boss;
  })();
  try {
    return await holder.starting;
  } finally {
    holder.starting = undefined;
  }
}

export async function stopBoss(): Promise<void> {
  if (holder.boss) {
    await holder.boss.stop({ graceful: true, timeout: 30_000 });
    holder.boss = undefined;
  }
}

/**
 * Cấu hình hàng đợi. Việc tạo voice KHÔNG dùng retry tự động của pg-boss: việc thử lại/tiếp tục
 * do `sweeper` và logic nghiệp vụ điều khiển để giữ phần đã xong (Nguyên tắc III).
 */
export async function ensureQueues(boss: PgBoss): Promise<void> {
  await boss.createQueue(QUEUES.generateVoice, {
    retryLimit: 0,
    // Một job tạo voice có thể rất dài; hết hạn rất xa, việc phát hiện worker chết do sweeper (heartbeat_at) đảm nhiệm.
    expireInSeconds: 24 * 3600,
    deleteAfterSeconds: 3 * 24 * 3600,
  });
  await boss.createQueue(QUEUES.deleteUser, {
    retryLimit: 20,
    retryDelay: 30,
    retryBackoff: true,
    expireInSeconds: 3600,
    deleteAfterSeconds: 3 * 24 * 3600,
  });
  // STT (spec 004): như tạo voice, không dùng retry tự động; thử lại/tiếp tục do worker + sweeper điều khiển.
  await boss.createQueue(QUEUES.transcribeMedia, {
    retryLimit: 0,
    expireInSeconds: 6 * 3600,
    deleteAfterSeconds: 3 * 24 * 3600,
  });
  await boss.createQueue(QUEUES.reconcileStorage, {
    retryLimit: 1,
    expireInSeconds: 3600,
    deleteAfterSeconds: 24 * 3600,
  });
}

export async function enqueueGenerateVoice(jobId: string): Promise<string | null> {
  const boss = await getBoss('web');
  return boss.send(QUEUES.generateVoice, { jobId } satisfies GenerateVoicePayload);
}

export async function enqueueDeleteUser(userId: string): Promise<string | null> {
  const boss = await getBoss('web');
  // singletonKey: tránh tạo nhiều việc xóa trùng cho cùng một User
  return boss.send(QUEUES.deleteUser, { userId } satisfies DeleteUserPayload, { singletonKey: `delete-user:${userId}` });
}

export async function enqueueTranscribeMedia(jobId: string): Promise<string | null> {
  const boss = await getBoss('web');
  return boss.send(QUEUES.transcribeMedia, { jobId } satisfies TranscribeMediaPayload);
}
