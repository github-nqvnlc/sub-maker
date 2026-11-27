import { overlaySceneStyle, type OverlayConfig, type SceneStyle } from './config';
import { fontString } from './fonts';
import { splitWords } from './words';

/**
 * Xếp chữ của một câu (FR-014, FR-015; overlay-engine §4). `measure` do môi trường cung cấp và luôn đo ở CỠ XUẤT RA nên cách xuống
 * dòng không phụ thuộc kích thước khung xem trước.
 */

export type Measure = (text: string, font: string) => number;

/** Một mẩu chữ vẽ liền; thường là một từ, trừ khi từ dài hơn cả dòng nên bị ngắt. */
export type Segment = { text: string; word: number; x: number; width: number };
export type Line = { segments: Segment[]; x: number; width: number; baseline: number };

export type CueLayout = {
  fontSize: number;
  font: string;
  lineHeight: number;
  lines: Line[];
  /** khối chữ kể cả phần đệm của hộp nền, không kể viền và bóng */
  box: { x: number; y: number; width: number; height: number };
  /** phần vượt ra ngoài khối do viền và bóng */
  bleed: number;
  center: { x: number; y: number };
  wordCount: number;
  shrunk: boolean;
  /** dòng thứ hai của cue song ngữ: nằm trên khối chính, trong cùng hộp */
  secondary?: { font: string; fontSize: number; lineHeight: number; lines: Line[]; wordCount: number };
};

const LINE_HEIGHT = 1.3;
/** vị trí đường chân chữ so với giữa dòng, theo cỡ chữ */
const BASELINE = 0.35;
const BOX_PAD_X = 0.35;
const BOX_PAD_Y = 0.2;
/** khoảng cách giữa dòng thứ hai và khối chính, theo cỡ chữ của khối chính */
const SECONDARY_GAP = 0.1;
/** độ lệch xuống của bóng, theo cỡ chữ */
export const SHADOW_DROP = 0.05;

type SegmenterCtor = new (locale?: string, opts?: { granularity: 'grapheme' }) => { segment(text: string): Iterable<{ segment: string }> };

/** Tách theo cụm ký tự hiển thị (không tách dấu khỏi chữ). */
export function graphemes(text: string): string[] {
  const s = text.normalize('NFC');
  const Segmenter = (Intl as unknown as { Segmenter?: SegmenterCtor }).Segmenter;
  if (!Segmenter) return [...s];
  return Array.from(new Segmenter('vi', { granularity: 'grapheme' }).segment(s), (x) => x.segment);
}

type Piece = { text: string; word: number; width: number; x: number };
type Wrapped = { pieces: Piece[]; width: number };

/** Ngắt một từ dài hơn cả dòng theo cụm ký tự. */
function breakWord(word: string, index: number, max: number, width: (t: string) => number): Piece[] {
  const out: Piece[] = [];
  let cur = '';
  const push = () => out.push({ text: cur, word: index, width: width(cur), x: 0 });
  for (const g of graphemes(word)) {
    if (cur && width(cur + g) > max) {
      push();
      cur = g;
    } else cur += g;
  }
  if (cur) push();
  return out;
}

/** `first` là chỉ số của từ đầu tiên trong cả câu (câu có ngắt dòng bắt buộc được xếp từng đoạn). */
function wrap(words: readonly string[], max: number, width: (t: string) => number, first: number): Wrapped[] {
  const space = width(' ');
  const lines: Wrapped[] = [];
  let cur: Wrapped = { pieces: [], width: 0 };
  const flush = () => {
    if (cur.pieces.length > 0) lines.push(cur);
    cur = { pieces: [], width: 0 };
  };
  words.forEach((word, at) => {
    const index = first + at;
    const w = width(word);
    if (w > max) {
      for (const p of breakWord(word, index, max, width)) {
        flush();
        cur = { pieces: [p], width: p.width };
      }
      return;
    }
    let x = cur.pieces.length > 0 ? cur.width + space : 0;
    if (x + w > max) {
      flush();
      x = 0;
    }
    cur.pieces.push({ text: word, word: index, width: w, x });
    cur.width = x + w;
  });
  flush();
  return lines;
}

const scaleLines = (lines: readonly Line[], k: number): Line[] =>
  lines.map((line) => ({
    x: line.x * k,
    width: line.width * k,
    baseline: line.baseline * k,
    segments: line.segments.map((s) => ({ ...s, x: s.x * k, width: s.width * k })),
  }));

/** Đổi bố cục tính trên khung chuẩn ra khung đích: nhân mọi tọa độ với `k`. */
function scaleLayout(l: CueLayout, k: number, fontOf: (size: number) => string): CueLayout {
  const sub = l.secondary;
  return {
    ...l,
    font: fontOf(l.fontSize * k),
    fontSize: l.fontSize * k,
    lineHeight: l.lineHeight * k,
    lines: scaleLines(l.lines, k),
    ...(sub ? { secondary: { ...sub, font: fontOf(sub.fontSize * k), fontSize: sub.fontSize * k, lineHeight: sub.lineHeight * k, lines: scaleLines(sub.lines, k) } } : {}),
    box: { x: l.box.x * k, y: l.box.y * k, width: l.box.width * k, height: l.box.height * k },
    bleed: l.bleed * k,
    center: { x: l.center.x * k, y: l.center.y * k },
  };
}

const paragraphsOf = (text: string): string[][] => text.split('\n').map(splitWords).filter((p) => p.length > 0);
const countWords = (paragraphs: readonly string[][]): number => paragraphs.reduce((n, p) => n + p.length, 0);

/**
 * `\n` trong câu là ngắt dòng bắt buộc. Bố cục luôn tính trên khung chuẩn (nên cách xuống dòng không phụ thuộc kích thước vẽ ra) rồi
 * mới nhân hệ số `k` của kiểu cảnh. `secondaryText` (cue song ngữ) xếp phía trên khối chính; cả cụm co cùng tỉ lệ cho vừa khung và
 * đặt theo tâm của cụm.
 */
export function layoutCue(text: string, input: OverlayConfig | SceneStyle, measure: Measure, secondaryText?: string): CueLayout {
  const c: SceneStyle = 'frame' in input ? input : overlaySceneStyle(input);
  const { width: W, height: H } = c.frame;
  const paragraphs = paragraphsOf(text);
  const wordCount = countWords(paragraphs);
  const second = c.secondary && secondaryText ? paragraphsOf(secondaryText) : [];
  const stroke = c.stroke.enabled ? c.stroke.width : 0;
  const blur = c.shadow.enabled ? c.shadow.blur : 0;

  /** Xếp một khối chữ ở cỡ `size` trong bề rộng `avail`. */
  const block = (source: readonly string[][], size: number, avail: number) => {
    const font = fontString(c.font.family, c.font.weight, size);
    const cache = new Map<string, number>();
    const width = (t: string) => {
      let v = cache.get(t);
      if (v === undefined) {
        v = measure(t, font);
        cache.set(t, v);
      }
      return v;
    };
    let first = 0;
    const lines = source.flatMap((words) => {
      const wrapped = wrap(words, avail, width, first);
      first += words.length;
      return wrapped;
    });
    const lineHeight = size * LINE_HEIGHT;
    return { size, font, lines, lineHeight, height: lines.length * lineHeight };
  };

  const attempt = (size: number) => {
    const padX = c.box.enabled ? Math.round(size * BOX_PAD_X) : 0;
    const padY = c.box.enabled ? Math.round(size * BOX_PAD_Y) : 0;
    const drop = c.shadow.enabled ? (c.shadow.distance ?? Math.round(size * SHADOW_DROP)) : 0;
    const bleed = Math.ceil(stroke + blur + drop);
    const avail = Math.max(1, Math.min((W * c.maxWidthPct) / 100, W - 2 * (padX + bleed)));
    const main = block(paragraphs, size, avail);
    // dòng thứ hai co cùng tỉ lệ với khối chính
    const sub = second.length > 0 ? block(second, Math.max(1, Math.round((c.secondary!.size * size) / c.font.size)), avail) : null;
    const gap = sub && main.lines.length > 0 ? size * SECONDARY_GAP : 0;
    const textHeight = (sub ? sub.height + gap : 0) + main.height;
    const fits = textHeight + 2 * (padY + bleed) <= H && [...main.lines, ...(sub?.lines ?? [])].every((l) => l.width <= avail + 0.01);
    return { size, padX, padY, bleed, avail, main, sub, gap, textHeight, fits };
  };

  // Thu nhỏ riêng câu này tới cỡ lớn nhất vừa khung, không có mức sàn (FR-015)
  let a = attempt(c.font.size);
  if (!a.fits) {
    let lo = 1;
    let hi = c.font.size - 1;
    let best = attempt(1);
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const t = attempt(mid);
      if (t.fits) {
        best = t;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    a = best;
  }

  const blockW = [...a.main.lines, ...(a.sub?.lines ?? [])].reduce((m, l) => Math.max(m, l.width), 0);
  const left = (W - a.avail) / 2;
  const lineX = (w: number) => (c.align === 'left' ? left : c.align === 'right' ? left + a.avail - w : (W - w) / 2);

  const half = a.textHeight / 2 + a.padY + a.bleed;
  const cy = half * 2 >= H ? H / 2 : Math.min(Math.max((H * c.position.y) / 100, half), H - half);
  const top = cy - a.textHeight / 2;

  const place = (b: ReturnType<typeof block>, from: number): Line[] =>
    b.lines.map((l, k) => {
      const x = lineX(l.width);
      return {
        x,
        width: l.width,
        baseline: from + k * b.lineHeight + b.lineHeight / 2 + b.size * BASELINE,
        segments: l.pieces.map((p) => ({ text: p.text, word: p.word, x: x + p.x, width: p.width })),
      };
    });
  const lines = place(a.main, top + (a.sub ? a.sub.height + a.gap : 0));

  const boxX = lineX(blockW) - a.padX;
  const layout: CueLayout = {
    fontSize: a.size,
    font: a.main.font,
    lineHeight: a.main.lineHeight,
    lines,
    ...(a.sub ? { secondary: { font: a.sub.font, fontSize: a.sub.size, lineHeight: a.sub.lineHeight, lines: place(a.sub, top), wordCount: countWords(second) } } : {}),
    box: { x: boxX, y: top - a.padY, width: blockW + 2 * a.padX, height: a.textHeight + 2 * a.padY },
    bleed: a.bleed,
    center: { x: boxX + a.padX + blockW / 2, y: cy },
    wordCount,
    shrunk: a.size < c.font.size,
  };
  return c.k === 1 ? layout : scaleLayout(layout, c.k, (size) => fontString(c.font.family, c.font.weight, size));
}
