/**
 * Kịch bản .skt: coi là văn bản thuần, có thể kèm cấu trúc phụ đề (số thứ tự + dòng mốc thời gian).
 * Mốc thời gian bị BỎ QUA; thời lượng thật lấy từ audio sinh ra (spec, Assumptions).
 * Mỗi "cue" (các dòng chữ giữa hai dòng trống) thành MỘT đoạn.
 */

const TIMECODE = /^\s*(?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?\s*-->\s*(?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?.*$/;
const CUE_INDEX = /^\s*\d{1,6}\s*$/;
const BRACKET_TIME = /^\s*\[\s*(?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?\s*\]\s*/;

function cleanLine(line: string): string {
  return line
    .replace(BRACKET_TIME, '') // [00:01:05] ở đầu dòng
    .replace(/<[^>\n]{1,80}>/g, '') // <i>, <font color=...>, <c.colorE5E5E5>
    .replace(/\{\\?[^}\n]{1,80}\}/g, '') // {\an8}, {italic}
    .trim();
}

export function sktToParagraphs(text: string): string[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const paragraphs: string[] = [];
  let cue: string[] = [];

  const flush = () => {
    const joined = cue.join(' ').replace(/\s+/g, ' ').trim();
    if (joined) paragraphs.push(joined);
    cue = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const trimmed = raw.trim();
    if (trimmed === '' ) {
      flush();
      continue;
    }
    if (/^WEBVTT\b/i.test(trimmed) && paragraphs.length === 0 && cue.length === 0) continue;
    if (TIMECODE.test(raw)) continue;
    // Dòng chỉ có số là chỉ số cue khi dòng kế tiếp là mốc thời gian
    if (CUE_INDEX.test(raw) && i + 1 < lines.length && TIMECODE.test(lines[i + 1]!)) {
      flush();
      continue;
    }
    const cleaned = cleanLine(raw);
    if (cleaned) cue.push(cleaned);
  }
  flush();
  return paragraphs;
}
