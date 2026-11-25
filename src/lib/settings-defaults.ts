/** Giá trị mặc định của cài đặt hệ thống (data-model.md → system_settings). */
export const SETTING_DEFAULTS = {
  /** 2 MB */
  maxFileBytes: 2_097_152,
  /** 500 MB mỗi User */
  userQuotaBytes: 524_288_000,
  maxConcurrentJobs: 3,
  maxJobsPerUser: 2,
  /** Số STT job đang chờ/đang chạy tối đa mỗi User (spec 004, FR-017) */
  maxSttJobsPerUser: 2,
  /** Video overlay (spec 005): tiến trình xuất đang hoạt động tối đa mỗi User (FR-040) */
  maxOverlayJobsPerUser: 2,
  /** Video overlay: tiến trình xuất chạy cùng lúc toàn hệ thống, tách khỏi voice và STT (FR-041) */
  maxConcurrentOverlayJobs: 1,
  /** Video overlay: thời lượng tối đa (phút) với phông màu (FR-006) */
  overlayMaxMinutes: 60,
  /** Video overlay: thời lượng tối đa (phút) với nền trong suốt (FR-006) */
  overlayMaxMinutesTransparent: 10,
  segmentConcurrency: 3,
  /** Voice khớp mốc (spec 003): độ trễ tối đa so với mốc phụ đề (ms) */
  timingMaxSlipMs: 500,
  /** hệ số nén tối đa theo phần trăm (125 = 1,25×) */
  timingMaxCompressPct: 125,
  /** cửa sổ chia phần (phút phụ đề) */
  timingPartMinutes: 10,
  /** khoảng nghỉ tối đa giữa hai cue vẫn ghép chung một câu (ms) */
  timingMergeGapMs: 1000,
  /** Giới hạn yêu cầu/phút ghi đè catalog theo nhà cung cấp; 0 = dùng giá trị mặc định của catalog */
  rpmFptMarketplace: 0,
  rpmShopaikeyOpenai: 0,
  rpmShopaikeyMinimax: 0,
} as const;

export type SettingKey = keyof typeof SETTING_DEFAULTS;
export type Settings = { [K in SettingKey]: number };
