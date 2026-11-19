/** Giá trị mặc định của cài đặt hệ thống (data-model.md → system_settings). */
export const SETTING_DEFAULTS = {
  /** 2 MB */
  maxFileBytes: 2_097_152,
  /** 500 MB mỗi User */
  userQuotaBytes: 524_288_000,
  maxConcurrentJobs: 3,
  maxJobsPerUser: 2,
  segmentConcurrency: 3,
} as const;

export type SettingKey = keyof typeof SETTING_DEFAULTS;
export type Settings = { [K in SettingKey]: number };
