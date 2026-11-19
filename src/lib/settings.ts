import { inArray } from 'drizzle-orm';
import { getDb, type Db } from './db';
import { systemSettings } from './db/schema';
import { SETTING_DEFAULTS, type SettingKey, type Settings } from './settings-defaults';

export { SETTING_DEFAULTS };
export type { SettingKey, Settings };

const KEYS = Object.keys(SETTING_DEFAULTS) as SettingKey[];

/** Đọc cài đặt hệ thống, thiếu khóa thì dùng mặc định. Dùng chung cho API và worker. */
export async function getSettings(db: Db = getDb()): Promise<Settings> {
  const rows = await db.select().from(systemSettings).where(inArray(systemSettings.key, KEYS));
  const out: Settings = { ...SETTING_DEFAULTS };
  for (const row of rows) {
    const k = row.key as SettingKey;
    if (typeof row.value === 'number' && Number.isFinite(row.value)) out[k] = row.value;
  }
  return out;
}

/** Cập nhật nhiều cài đặt (đã được kiểm tra ở lớp API). */
export async function updateSettings(patch: Partial<Settings>, updatedBy: string | null, db: Db = getDb()): Promise<Settings> {
  for (const [key, value] of Object.entries(patch)) {
    if (!KEYS.includes(key as SettingKey) || typeof value !== 'number') continue;
    await db
      .insert(systemSettings)
      .values({ key, value, updatedBy })
      .onConflictDoUpdate({ target: systemSettings.key, set: { value, updatedBy, updatedAt: new Date() } });
  }
  return getSettings(db);
}
