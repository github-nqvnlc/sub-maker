import { asc, eq } from 'drizzle-orm';
import { getDb } from '../db';
import { segments } from '../db/schema';
import { getOwnedVoice } from '../projects/access';
import { voiceDto } from '../projects/dto';

/**
 * Chi tiết voice: thông tin + từng đoạn gồm VĂN BẢN và mốc thời gian chính xác để đồng bộ highlight (FR-016, FR-027).
 * Mốc thời gian lưu trong `voices.timeline` (tính theo số mẫu PCM lúc ghép); văn bản lấy từ các đoạn của file nguồn.
 */
export async function getVoiceDetail(ownerId: string, voiceId: string) {
  const voice = await getOwnedVoice(ownerId, voiceId);
  const rows = await getDb()
    .select({ idx: segments.idx, text: segments.text })
    .from(segments)
    .where(eq(segments.subtitleFileId, voice.subtitleFileId))
    .orderBy(asc(segments.idx));
  const textByIdx = new Map(rows.map((r) => [r.idx, r.text]));
  return {
    ...voiceDto(voice),
    projectId: voice.projectId,
    jobId: voice.jobId,
    fileId: voice.subtitleFileId,
    // Voice khớp mốc (spec 003): văn bản đơn vị nằm ngay trong timeline; kèm mốc nội bộ từng cue để bôi theo cue
    segments: voice.timeline.map((t) => ({
      idx: t.idx,
      text: t.text ?? textByIdx.get(t.idx) ?? '',
      startMs: t.startMs,
      endMs: t.endMs,
      ...(t.cues ? { cues: t.cues } : {}),
      ...(t.slipMs !== undefined ? { slipMs: t.slipMs } : {}),
      ...(t.compress !== undefined ? { compress: t.compress } : {}),
      ...(t.overflow ? { overflow: true } : {}),
      ...(t.failed ? { failed: true } : {}),
    })),
  };
}
