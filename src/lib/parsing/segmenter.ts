import { charLen, hasSpeakable } from './normalize';

/**
 * Tách câu tiếng Việt và gộp thành đoạn ≤ maxChars (research R6).
 * Ranh giới highlight là ĐOẠN (một hoặc vài câu liền nhau trong cùng một đoạn văn bản gốc).
 */

export const DEFAULT_MAX_SEGMENT_CHARS = 400;
export const MIN_SEGMENT_CHARS = 3; // FPT Speech yêu cầu tối thiểu 3 ký tự

// Từ viết tắt thường gặp kết thúc bằng dấu chấm nhưng KHÔNG phải hết câu
const ABBREVIATIONS = new Set(
  ['TP', 'Tp', 'TS', 'GS', 'PGS', 'ThS', 'BS', 'KS', 'CN', 'Mr', 'Mrs', 'Ms', 'Dr', 'Prof', 'St', 'Nxb', 'TT', 'Q', 'P', 'tr', 'vd', 'VD', 'tp', 'ts', 'gs', 'ông', 'bà'].map((s) => s.toLowerCase()),
);

function endsWithAbbreviation(sentence: string): boolean {
  const m = /([\p{L}]+)\.\s*$/u.exec(sentence);
  if (!m) return false;
  const word = m[1]!;
  // "v.v." / "vv."
  if (/\bv\.v\.\s*$/i.test(sentence)) return false;
  return word.length <= 4 && ABBREVIATIONS.has(word.toLowerCase());
}

const sentenceSegmenter = new Intl.Segmenter('vi', { granularity: 'sentence' });

export function splitSentences(paragraph: string): string[] {
  const raw = [...sentenceSegmenter.segment(paragraph)].map((s) => s.segment.trim()).filter(Boolean);
  const out: string[] = [];
  for (const s of raw) {
    const prev = out[out.length - 1];
    // Gộp với câu trước nếu câu trước kết thúc bằng từ viết tắt ("TP." + "Hồ Chí Minh")
    if (prev !== undefined && endsWithAbbreviation(prev)) out[out.length - 1] = `${prev} ${s}`;
    else out.push(s);
  }
  return out;
}

/** Cắt một câu quá dài theo mệnh đề (, ; :) rồi theo từ, mỗi mảnh ≤ maxChars. */
export function splitLongSentence(sentence: string, maxChars: number): string[] {
  if (charLen(sentence) <= maxChars) return [sentence];
  const parts = sentence.split(/(?<=[,;:，；：])\s+/u);
  const chunks: string[] = [];
  let cur = '';
  const push = () => {
    if (cur) chunks.push(cur);
    cur = '';
  };
  const addWord = (w: string) => {
    if (charLen(cur) + (cur ? 1 : 0) + charLen(w) <= maxChars) cur = cur ? `${cur} ${w}` : w;
    else {
      push();
      cur = w;
    }
  };
  for (const part of parts) {
    if (charLen(part) <= maxChars) {
      if (charLen(cur) + (cur ? 1 : 0) + charLen(part) <= maxChars) cur = cur ? `${cur} ${part}` : part;
      else {
        push();
        cur = part;
      }
    } else {
      push();
      // mệnh đề vẫn quá dài → cắt theo từ; từ dài hơn maxChars thì cắt cứng
      for (const w of part.split(/\s+/)) {
        if (charLen(w) <= maxChars) addWord(w);
        else {
          push();
          const chars = [...w];
          for (let i = 0; i < chars.length; i += maxChars) chunks.push(chars.slice(i, i + maxChars).join(''));
        }
      }
      push();
    }
  }
  push();
  return chunks;
}

/**
 * Gộp các câu của MỘT đoạn văn thành các đoạn nói ≤ maxChars. Không bao giờ gộp xuyên đoạn văn
 * (giữ nhịp nghỉ tự nhiên giữa các dòng/đoạn của kịch bản).
 */
export function segmentParagraph(paragraph: string, maxChars: number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const sentence of splitSentences(paragraph)) {
    for (const piece of splitLongSentence(sentence, maxChars)) {
      if (cur && charLen(cur) + 1 + charLen(piece) <= maxChars) cur = `${cur} ${piece}`;
      else {
        if (cur) out.push(cur);
        cur = piece;
      }
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Đoạn quá ngắn (< 3 ký tự) gộp vào đoạn kề; đoạn không có chữ/số bị bỏ. */
export function fixTinySegments(segments: string[]): string[] {
  const kept = segments.filter(hasSpeakable);
  const out: string[] = [];
  let carry = '';
  for (const s of kept) {
    const text = carry ? `${carry} ${s}` : s;
    carry = '';
    if (charLen(text) < MIN_SEGMENT_CHARS) {
      carry = text; // đợi gộp với đoạn kế tiếp
    } else {
      out.push(text);
    }
  }
  if (carry) {
    if (out.length > 0) out[out.length - 1] = `${out[out.length - 1]} ${carry}`;
    else out.push(carry);
  }
  return out;
}

export function buildSegments(paragraphs: string[], maxChars = DEFAULT_MAX_SEGMENT_CHARS): string[] {
  const all: string[] = [];
  for (const p of paragraphs) all.push(...segmentParagraph(p, maxChars));
  return fixTinySegments(all);
}
