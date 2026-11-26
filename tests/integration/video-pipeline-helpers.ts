import { asc, eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { usageRecords, videoCues, videoJobLogs } from '@/lib/db/schema';
import { runVideoPrepare, type VideoPrepareOptions } from '@/worker/jobs/video-prepare';
import { runVideoTranslate, type VideoTranslateOptions } from '@/worker/jobs/video-translate';
import type { TestUser } from './helpers';
import { uploadVideo } from './video-api';
import { makeTestVideo, type TestVideoOptions } from './video-media';

/** Chạy pipeline dịch video trong kiểm thử (spec 006): thử lại ngắn, nhịp tim dày. */
const SHORT = { maxAttempts: 4, baseMs: 5, maxMs: 20 };
export const FAST_PREPARE: VideoPrepareOptions = { retry: SHORT, heartbeatMs: 100 };
export const FAST_TRANSLATE: VideoTranslateOptions = { providerRetry: SHORT, retry: SHORT, heartbeatMs: 100, pollMs: 5, maxPollMs: 10, admissionPollMs: 20 };

let cached: Promise<Buffer> | null = null;
/** Video 6 giây dùng chung (tạo một lần). */
export const sampleVideo = (): Promise<Buffer> => (cached ??= makeTestVideo({ seconds: 6 }));

export async function uploadedJob(user: TestUser, projectId: string, over: { video?: TestVideoOptions | Buffer; fileName?: string; direction?: 'to_vi' | 'vi_to_en' } = {}) {
  const bytes = over.video === undefined ? await sampleVideo() : Buffer.isBuffer(over.video) ? over.video : await makeTestVideo(over.video);
  return uploadVideo(user, projectId, bytes, { fileName: over.fileName ?? 'phim.mp4', direction: over.direction ?? 'to_vi' });
}

export async function runPipeline(jobId: string, prepare: VideoPrepareOptions = {}, translate: VideoTranslateOptions = {}): Promise<void> {
  await runVideoPrepare(jobId, { ...FAST_PREPARE, ...prepare });
  await runVideoTranslate(jobId, { ...FAST_TRANSLATE, ...translate });
}

export const videoUsage = (jobId: string) => getDb().select().from(usageRecords).where(eq(usageRecords.videoJobId, jobId)).orderBy(asc(usageRecords.id));
export const cuesOf = (jobId: string) => getDb().select().from(videoCues).where(eq(videoCues.jobId, jobId)).orderBy(asc(videoCues.startMs));
export const videoLogKeys = async (jobId: string) =>
  (await getDb().select().from(videoJobLogs).where(eq(videoJobLogs.jobId, jobId)).orderBy(asc(videoJobLogs.id))).map((l) => l.messageKey);
