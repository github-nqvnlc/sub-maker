import { z } from 'zod';
import { HttpError, validation } from '../api/errors';
import { uploadScript } from '../projects/files';
import { contentDisposition } from '../storage/proxy';
import { loadCues } from './cues';
import { getOwnedVideoJob } from './service';
import { buildSubtitleFile, SUBTITLE_CONTENTS, SUBTITLE_FORMATS, subtitleFileName, type SubtitleContent, type SubtitleFormat } from './subtitle-files';

/** Tải tệp phụ đề và lưu thành kịch bản của Project (spec 006, FR-039, FR-040). Không cần quyền Dịch Video: dữ liệu đã có. */

const MIME: Record<SubtitleFormat, string> = { srt: 'application/x-subrip; charset=utf-8', vtt: 'text/vtt; charset=utf-8' };

async function fileOf(ownerId: string, jobId: string, format: SubtitleFormat, content: SubtitleContent) {
  const job = await getOwnedVideoJob(ownerId, jobId);
  const cues = await loadCues(job.id);
  const text = buildSubtitleFile(cues, format, content);
  if (!cues.length || !text.includes('-->')) throw new HttpError(422, 'VIDEO_NO_CUES');
  return { job, text, name: subtitleFileName(job.originalFileName, cues, job.direction, content, format) };
}

export async function downloadSubtitles(ownerId: string, jobId: string, query: URLSearchParams): Promise<Response> {
  await getOwnedVideoJob(ownerId, jobId);
  const format = query.get('format') ?? 'srt';
  const content = query.get('content') ?? 'target';
  if (!(SUBTITLE_FORMATS as readonly string[]).includes(format)) throw validation({ format: 'Định dạng phụ đề không hợp lệ' });
  if (!(SUBTITLE_CONTENTS as readonly string[]).includes(content)) throw validation({ content: 'Nội dung phụ đề không hợp lệ' });
  const file = await fileOf(ownerId, jobId, format as SubtitleFormat, content as SubtitleContent);
  return new Response(file.text, {
    headers: {
      'content-type': MIME[format as SubtitleFormat],
      'content-disposition': contentDisposition(file.name),
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

export const toScriptSchema = z.object({ content: z.enum(SUBTITLE_CONTENTS).default('target') }).strict();

/** Lưu `.srt` thành kịch bản của Project: cùng giới hạn dung lượng và hạn mức như tải kịch bản lên. */
export async function saveAsScript(ownerId: string, jobId: string, raw: unknown) {
  await getOwnedVideoJob(ownerId, jobId);
  const { content } = toScriptSchema.parse(raw);
  const file = await fileOf(ownerId, jobId, 'srt', content);
  return uploadScript(ownerId, file.job.projectId, { name: file.name, bytes: new TextEncoder().encode(file.text) });
}
