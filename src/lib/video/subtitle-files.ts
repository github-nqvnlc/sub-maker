import { cueDisplayText } from './style';
import { TARGET_LANGUAGE, type Cue, type Direction } from './types';

/** Tệp phụ đề tải về: `.srt` và `.vtt` (spec 006, contracts/subtitle-pipeline.md §6; FR-039). Hàm thuần. */

export const SUBTITLE_FORMATS = ['srt', 'vtt'] as const;
export type SubtitleFormat = (typeof SUBTITLE_FORMATS)[number];
export const SUBTITLE_CONTENTS = ['target', 'source', 'bilingual'] as const;
export type SubtitleContent = (typeof SUBTITLE_CONTENTS)[number];

type TimedText = Pick<Cue, 'startMs' | 'endMs' | 'sourceText' | 'targetText'>;

function timecode(ms: number, comma: string): string {
  const two = (n: number) => String(n).padStart(2, '0');
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor(ms / 60_000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  return `${two(h)}:${two(m)}:${two(s)}${comma}${String(ms % 1000).padStart(3, '0')}`;
}

/** Bỏ dòng trống và chuỗi `-->` để chữ không phá cấu trúc tệp. */
const lines = (text: string): string[] =>
  text
    .normalize('NFC')
    .replaceAll('-->', '→')
    .split(/\r\n?|\n/)
    .map((l) => l.trim())
    .filter(Boolean);

const escapeVtt = (s: string): string => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** Các dòng chữ của một cue theo nội dung đã chọn; bản dịch dùng cùng chữ như khung xem trước và thành phẩm. */
function textOf(cue: TimedText, content: SubtitleContent): string[] {
  if (content === 'bilingual') return [...lines(cue.sourceText), ...lines(cue.targetText)];
  return lines(content === 'source' ? cue.sourceText : cueDisplayText(cue, 'target'));
}

export function buildSubtitleFile(cues: readonly TimedText[], format: SubtitleFormat, content: SubtitleContent = 'target'): string {
  const blocks: string[] = [];
  for (const cue of cues) {
    let text = textOf(cue, content);
    if (text.length === 0) continue;
    if (format === 'vtt') text = text.map(escapeVtt);
    const mark = format === 'srt' ? ',' : '.';
    blocks.push(`${blocks.length + 1}\n${timecode(cue.startMs, mark)} --> ${timecode(cue.endMs, mark)}\n${text.join('\n')}`);
  }
  const body = blocks.length > 0 ? `${blocks.join('\n\n')}\n` : '';
  return format === 'srt' ? body : body ? `WEBVTT\n\n${body}` : 'WEBVTT\n';
}

/** Ngôn ngữ gốc chiếm nhiều cue nhất; "Việt → Anh" luôn là tiếng Việt. */
function sourceLanguage(cues: ReadonlyArray<Pick<Cue, 'sourceLang'>>, direction: Direction): string {
  if (direction === 'vi_to_en') return 'vi';
  const count = new Map<string, number>();
  for (const c of cues) if (c.sourceLang && /^[a-z]{2,3}$/i.test(c.sourceLang)) count.set(c.sourceLang.toLowerCase(), (count.get(c.sourceLang.toLowerCase()) ?? 0) + 1);
  return [...count].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'src';
}

/** Tên video bỏ đuôi + ngôn ngữ của nội dung + đuôi tệp. */
export function subtitleFileName(videoName: string, cues: ReadonlyArray<Pick<Cue, 'sourceLang'>>, direction: Direction, content: SubtitleContent, format: SubtitleFormat): string {
  const base = videoName.replace(/\.[A-Za-z0-9]{1,5}$/, '') || 'phu-de';
  const target = TARGET_LANGUAGE[direction];
  const language = content === 'target' ? target : content === 'source' ? sourceLanguage(cues, direction) : `${sourceLanguage(cues, direction)}-${target}`;
  return `${base}.${language}.${format}`;
}
