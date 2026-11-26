import { z } from 'zod';
import { readJson, route, validation } from '@/lib/api/errors';
import { requireAdmin } from '@/lib/auth/guards';
import { getSettings, updateSettings } from '@/lib/settings';

export const dynamic = 'force-dynamic';

const MB = 1024 * 1024;
const GB = 1024 * MB;
/** Giới hạn hợp lý để một giá trị nhập sai không làm hỏng hệ thống; âm/0/không nguyên → 422. */
const patchSchema = z
  .object({
    maxFileBytes: z.number().int().min(1024).max(50 * MB),
    userQuotaBytes: z.number().int().min(MB).max(1024 * 1024 * MB),
    maxConcurrentJobs: z.number().int().min(1).max(50),
    maxJobsPerUser: z.number().int().min(1).max(50),
    maxSttJobsPerUser: z.number().int().min(1).max(20),
    maxOverlayJobsPerUser: z.number().int().min(1).max(20),
    maxConcurrentOverlayJobs: z.number().int().min(1).max(10),
    overlayMaxMinutes: z.number().int().min(1).max(180),
    overlayMaxMinutesTransparent: z.number().int().min(1).max(60),
    segmentConcurrency: z.number().int().min(1).max(16),
    timingMaxSlipMs: z.number().int().min(100).max(2000),
    timingMaxCompressPct: z.number().int().min(100).max(150),
    timingPartMinutes: z.number().int().min(1).max(30),
    timingMergeGapMs: z.number().int().min(200).max(3000),
    rpmFptMarketplace: z.number().int().min(0).max(600),
    rpmShopaikeyOpenai: z.number().int().min(0).max(600),
    rpmShopaikeyMinimax: z.number().int().min(0).max(600),
    userVideoQuotaBytes: z.number().int().min(GB).max(1024 * GB),
    videoSystemCapBytes: z.number().int().min(GB).max(10 * 1024 * GB),
    videoMaxBytes: z.number().int().min(100 * MB).max(10 * GB),
    /** trần trên còn bị kiểm chéo với videoProviderMaxMinutes */
    videoMaxMinutes: z.number().int().min(1).max(1000),
    videoMaxJobsPerUser: z.number().int().min(1).max(10),
    maxConcurrentVideoRenders: z.number().int().min(1).max(4),
    maxConcurrentVideoTranslations: z.number().int().min(1).max(10),
    videoSourceRetainHours: z.number().int().min(1).max(720),
    videoIdleRetainDays: z.number().int().min(1).max(90),
    videoOutputRetainDays: z.number().int().min(1).max(90),
    videoProviderMaxMinutes: z.number().int().min(1).max(1000),
    videoGlossaryMaxPairs: z.number().int().min(1).max(1000),
    videoGlossaryMaxChars: z.number().int().min(500).max(10_000),
  })
  .partial()
  .strict();

export const GET = route(async (request: Request) => {
  await requireAdmin(request);
  return Response.json(await getSettings());
});

/** Cập nhật cài đặt; có hiệu lực ngay (đọc lại mỗi lần kiểm tra ở API/worker). */
export const PUT = route(async (request: Request) => {
  const admin = await requireAdmin(request);
  const patch = patchSchema.parse(await readJson(request));
  if (patch.videoMaxMinutes !== undefined || patch.videoProviderMaxMinutes !== undefined) {
    const current = await getSettings();
    const merged = { ...current, ...patch };
    if (merged.videoMaxMinutes > merged.videoProviderMaxMinutes) {
      // form gửi mọi ô: gắn lỗi vào ô vừa được đổi
      const field = merged.videoMaxMinutes !== current.videoMaxMinutes ? 'videoMaxMinutes' : 'videoProviderMaxMinutes';
      throw validation({ [field]: 'Thời lượng video tối đa không được vượt giới hạn của nhà cung cấp' });
    }
  }
  return Response.json(await updateSettings(patch, admin.id));
});
