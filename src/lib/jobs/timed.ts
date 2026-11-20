import { asc, eq } from 'drizzle-orm';
import { getDb, type Db } from '../db';
import { subtitleCues } from '../db/schema';
import type { TimingParams, TimingSettings } from '../db/schema/jobs';
import type { PlaceParams } from '../audio/placement';
import { buildReadingUnits, type ReadingCue, type ReadingUnit } from '../parsing/reading-units';
import type { Settings } from '../settings';

/**
 * Chế độ khớp mốc thời gian phụ đề (spec 003): dựng danh sách đơn vị đọc xác định từ cue + thiết lập `timing`
 * của job, dùng chung cho tạo job, ước tính, worker và sửa thiết lập (nên tiếp tục job không cần lưu lại đơn vị).
 */

/** Giới hạn ký tự của một đơn vị đọc (cùng mặc định với chế độ "Đọc liên tục"; không vượt giới hạn nhà cung cấp). */
export const TIMED_MAX_CHARS = 400;
/** Khoảng cách tối thiểu giữa hai đơn vị liền nhau khi đặt mốc (ms). */
export const TIMED_MIN_GAP_MS = 60;

export type TimingChoice = { mode: 'timed' | 'continuous'; mergeCues?: boolean };

/** Chốt tham số từ cài đặt hệ thống lúc tạo job để kết quả tái lập được. */
export function timingParamsFromSettings(s: Settings): TimingParams {
  return {
    maxSlipMs: s.timingMaxSlipMs,
    maxCompressPct: s.timingMaxCompressPct,
    mergeGapMs: s.timingMergeGapMs,
    partMinutes: s.timingPartMinutes,
  };
}

export function buildTimingSettings(choice: TimingChoice | undefined, s: Settings): TimingSettings | undefined {
  if (!choice || choice.mode !== 'timed') return undefined;
  return { mode: 'timed', mergeCues: choice.mergeCues ?? true, params: timingParamsFromSettings(s) };
}

export const placeParamsOf = (p: TimingParams): PlaceParams => ({
  maxSlipMs: p.maxSlipMs,
  maxCompress: p.maxCompressPct / 100,
  minGapMs: TIMED_MIN_GAP_MS,
});

export async function loadFileCues(fileId: string, db: Db = getDb()): Promise<ReadingCue[]> {
  const rows = await db
    .select({
      idx: subtitleCues.idx,
      n: subtitleCues.n,
      startMs: subtitleCues.startMs,
      endMs: subtitleCues.endMs,
      text: subtitleCues.text,
      speakable: subtitleCues.speakable,
    })
    .from(subtitleCues)
    .where(eq(subtitleCues.subtitleFileId, fileId))
    .orderBy(asc(subtitleCues.idx));
  return rows;
}

export function unitsForTiming(
  cues: readonly ReadingCue[],
  timing: Pick<TimingSettings, 'mergeCues' | 'params'>,
  maxChars: number = TIMED_MAX_CHARS,
): ReadingUnit[] {
  return buildReadingUnits(cues, { merge: timing.mergeCues, maxChars, maxGapMs: timing.params.mergeGapMs });
}

/** Chữ giữa hai mốc của đơn vị bị loại khi `timing` đổi: hai cấu hình khác nhau ⇒ danh sách đơn vị phải dựng lại. */
export const timingChanged = (a: TimingSettings | undefined, b: TimingSettings | undefined): boolean =>
  (a?.mode ?? 'continuous') !== (b?.mode ?? 'continuous') || (a?.mergeCues ?? true) !== (b?.mergeCues ?? true);
