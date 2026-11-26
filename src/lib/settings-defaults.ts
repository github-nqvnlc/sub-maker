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
  /** Dịch video (spec 006): hạn mức video riêng mỗi User, 30 GB (1 GB–1 TB) */
  userVideoQuotaBytes: 32_212_254_720,
  /** trần dung lượng video toàn hệ thống, gồm bản xem trước, 100 GB (research R12) */
  videoSystemCapBytes: 107_374_182_400,
  /** dung lượng tối đa mỗi video nguồn, 10 GB */
  videoMaxBytes: 10_737_418_240,
  /** thời lượng tối đa mỗi video (phút), không quá giới hạn của nhà cung cấp */
  videoMaxMinutes: 180,
  /** số việc dịch video đang chạy tối đa mỗi User (FR-008) */
  videoMaxJobsPerUser: 1,
  /** số bản xuất video chạy cùng lúc toàn hệ thống (FR-052) */
  maxConcurrentVideoRenders: 1,
  /** số lượt dịch chạy cùng lúc toàn hệ thống (FR-052) */
  maxConcurrentVideoTranslations: 2,
  /** giữ video nguồn sau lần xuất thành công gần nhất (giờ) */
  videoSourceRetainHours: 48,
  /** giữ video nguồn chưa xuất lần nào khi không hoạt động (ngày) */
  videoIdleRetainDays: 7,
  /** giữ video thành phẩm và lớp phụ đề sau khi tạo (ngày) */
  videoOutputRetainDays: 7,
  /** giới hạn thời lượng mỗi tệp của nhà cung cấp (phút) */
  videoProviderMaxMinutes: 300,
  /** từ điển thuật ngữ: số cặp tối đa và tổng ký tự (giới hạn ngữ cảnh của nhà cung cấp) */
  videoGlossaryMaxPairs: 200,
  videoGlossaryMaxChars: 8000,
} as const;

export type SettingKey = keyof typeof SETTING_DEFAULTS;
export type Settings = { [K in SettingKey]: number };
