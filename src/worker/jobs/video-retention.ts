import type { PgBoss } from 'pg-boss';
import { runVideoRetention } from '../../lib/video/retention';
import { QUEUES, type VideoRetentionPayload } from '../queues';
import { sweepExpiredVideoUploads } from '../sweeper';

/** Lịch dọn dữ liệu video hết hạn, mỗi 10 phút (spec 006, FR-054, SC-013: trễ tối đa 10 phút). */
const CRON = '*/10 * * * *';

export async function registerVideoRetention(boss: PgBoss): Promise<void> {
  await boss.work<VideoRetentionPayload>(QUEUES.videoRetention, { localConcurrency: 1 }, async () => {
    await sweepExpiredVideoUploads();
    const r = await runVideoRetention();
    if (r.sources.length + r.exports.length > 0) console.log(`[video-retention] đã xóa ${r.sources.length} video nguồn, ${r.exports.length} thành phẩm hết hạn`);
  });
  await boss.schedule(QUEUES.videoRetention, CRON, {});
}
