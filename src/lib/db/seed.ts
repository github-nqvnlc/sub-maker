import { sql } from 'drizzle-orm';
import type { Db } from './index';
import { systemSettings } from './schema';
import { SETTING_DEFAULTS } from '../settings-defaults';

/** Chỉ thêm khóa còn thiếu, không ghi đè giá trị Administrator đã chỉnh. */
export async function seedSystemSettings(db: Db): Promise<void> {
  for (const [key, value] of Object.entries(SETTING_DEFAULTS)) {
    await db
      .insert(systemSettings)
      .values({ key, value })
      .onConflictDoNothing({ target: systemSettings.key });
  }
  await db.execute(sql`select 1`);
}
