import { describe, expect, it } from 'vitest';
import { applyTiming } from '@/lib/overlay/timing';
import type { AppliedCue, WordSpan } from '@/lib/overlay/types';
import { activeWordIndex, splitWords, WORD_TIMING, wordSpans, wordWeight } from '@/lib/overlay/words';
import { parseSrtCues } from '@/lib/parsing/srt';
import { sampleSrt } from './helpers';

/** Mốc từng từ ước lượng (spec 005, FR-024, FR-025, overlay-engine §3, T068). */
const cueOf = (text: string, startMs = 1000, readEndMs = 4000) => ({ text, startMs, readEndMs });
const texts = (s: WordSpan[]) => s.map((x) => x.text);

/** Mọi bất biến của FR-025; trả lý do sai đầu tiên. */
function violation(c: Pick<AppliedCue, 'text' | 'startMs' | 'readEndMs'>, spans: WordSpan[]): string | null {
  if (texts(spans).join(' ') !== c.text.normalize('NFC').trim().split(/\s+/u).join(' ')) return 'nối lại không ra đúng chữ';
  if (spans.length === 0) return null;
  if (spans[0]!.startMs !== c.startMs) return 'từ đầu không bắt đầu đúng lúc khoảng đọc bắt đầu';
  if (spans.at(-1)!.endMs > c.readEndMs) return 'từ cuối vượt khoảng đọc';
  for (let i = 0; i < spans.length; i++) {
    const s = spans[i]!;
    if (!Number.isInteger(s.startMs) || !Number.isInteger(s.endMs)) return 'mốc không phải số nguyên';
    if (s.endMs < s.startMs) return 'từ có độ dài âm';
    if (i > 0 && s.startMs < spans[i - 1]!.endMs) return 'hai từ chồng lấn';
  }
  return null;
}

describe('bộ mẫu 244 cue', () => {
  const file = parseSrtCues(sampleSrt()).cues;
  const total = Math.max(...file.map((c) => c.endMs)) + 1000;
  const { cues } = applyTiming({ fileCues: file.map((c) => ({ startMs: c.startMs, endMs: c.endMs, text: c.text, speakable: true })), source: 'uploaded', voiceTimeline: null, voiceDurationMs: total });

  it('mọi cue thỏa mọi bất biến', () => {
    expect(cues.length).toBe(244);
    const bad = cues.map((c) => [c.i + 1, violation(c, wordSpans(c))] as const).filter(([, v]) => v !== null);
    expect(bad).toEqual([]);
  });

  it('mọi từ trong cue đủ dài đều có thời lượng dương', () => {
    for (const c of cues) {
      const spans = wordSpans(c);
      if (c.readEndMs - c.startMs < spans.length * 50) continue;
      for (const s of spans) expect(s.endMs - s.startMs, `cue ${c.i + 1}: ${s.text}`).toBeGreaterThan(0);
    }
  });

  it('cùng đầu vào cho cùng kết quả', () => {
    for (const c of cues.slice(0, 50)) expect(wordSpans(c)).toEqual(wordSpans({ ...c }));
  });

  it('quãng nghỉ không vượt 25% khoảng đọc', () => {
    for (const c of cues) {
      const spans = wordSpans(c);
      const gap = spans.slice(1).reduce((n, s, i) => n + (s.startMs - spans[i]!.endMs), 0);
      expect(gap).toBeLessThanOrEqual((c.readEndMs - c.startMs) * WORD_TIMING.maxPauseShare + spans.length);
    }
  });
});

describe('ca biên', () => {
  it('một từ chiếm trọn khoảng đọc', () => {
    expect(wordSpans(cueOf('Chào'))).toEqual([{ text: 'Chào', startMs: 1000, endMs: 4000 }]);
  });

  it('chữ rỗng hoặc chỉ có khoảng trắng không có từ nào', () => {
    expect(wordSpans(cueOf(''))).toEqual([]);
    expect(wordSpans(cueOf('  \n '))).toEqual([]);
  });

  it('nhiều dòng và nhiều khoảng trắng: từ tách theo mọi khoảng trắng', () => {
    expect(texts(wordSpans(cueOf('Xin  chào\n các\tbạn')))).toEqual(['Xin', 'chào', 'các', 'bạn']);
    expect(violation(cueOf('Xin  chào\n các\tbạn'), wordSpans(cueOf('Xin  chào\n các\tbạn')))).toBeNull();
  });

  it('chữ tách dấu (NFD) cho cùng mốc với chữ dựng sẵn', () => {
    const nfc = 'Nguyễn Trường Tộ, người Nghệ An.';
    expect(wordSpans(cueOf(nfc.normalize('NFD')))).toEqual(wordSpans(cueOf(nfc)));
  });

  it('số dài được đọc lâu hơn chữ ngắn; ký hiệu đứng riêng rất ngắn', () => {
    expect(wordWeight('2026')).toBeGreaterThan(wordWeight('năm'));
    expect(wordWeight('–')).toBe(WORD_TIMING.symbolOnly);
    expect(wordWeight('18/11')).toBe(16);
    const [year, dash, word] = wordSpans(cueOf('2026 – năm'));
    const len = (s: WordSpan | undefined) => s!.endMs - s!.startMs;
    expect(len(year)).toBeGreaterThan(len(word));
    expect(len(dash)).toBeLessThan(len(word));
  });

  it('có quãng nghỉ sau dấu câu: dấu chấm dài hơn dấu phẩy; không nghỉ sau từ cuối', () => {
    const gapAfter = (text: string, i: number) => {
      const s = wordSpans(cueOf(text));
      return s[i + 1]!.startMs - s[i]!.endMs;
    };
    expect(gapAfter('Một hai. Ba bốn năm sáu', 1)).toBeGreaterThan(gapAfter('Một hai, ba bốn năm sáu', 1));
    expect(gapAfter('Một hai, ba bốn năm sáu', 1)).toBeGreaterThan(0);
    expect(gapAfter('Một hai ba', 0)).toBe(0);
    expect(gapAfter('Ông nói: “Đi thôi.” Rồi đi.', 1)).toBeGreaterThan(0);
    expect(wordSpans(cueOf('Một hai.')).at(-1)!.endMs).toBe(4000);
  });

  it('khoảng đọc ngắn hơn số từ: vẫn đúng thứ tự, không chồng lấn, không vượt', () => {
    const text = Array.from({ length: 40 }, (_, i) => `từ${i}`).join(' ');
    for (const dur of [0, 1, 10, 34, 39]) {
      const c = cueOf(text, 500, 500 + dur);
      expect(violation(c, wordSpans(c))).toBeNull();
    }
  });

  it('câu toàn dấu câu không gây chia cho 0', () => {
    const c = cueOf('… – !');
    expect(violation(c, wordSpans(c))).toBeNull();
    expect(wordSpans(c)).toHaveLength(3);
  });

  it('splitWords giữ dấu câu dính với từ', () => {
    expect(splitWords('Ông nói: “Không!”')).toEqual(['Ông', 'nói:', '“Không!”']);
  });
});

describe('từ đang đọc', () => {
  const c = cueOf('Một hai, ba bốn');
  const spans = wordSpans(c);

  it('giữ từ trước qua quãng nghỉ; trước câu và sau khoảng đọc thì không từ nào', () => {
    expect(activeWordIndex(spans, c.startMs - 1, c.readEndMs)).toBe(-1);
    expect(activeWordIndex(spans, c.startMs, c.readEndMs)).toBe(0);
    const pause = spans[1]!.endMs + 1;
    expect(pause).toBeLessThan(spans[2]!.startMs);
    expect(activeWordIndex(spans, pause, c.readEndMs)).toBe(1);
    expect(activeWordIndex(spans, c.readEndMs - 1, c.readEndMs)).toBe(3);
    expect(activeWordIndex(spans, c.readEndMs, c.readEndMs)).toBe(-1);
  });

  it('không bao giờ lùi', () => {
    let prev = -1;
    for (let t = c.startMs; t < c.readEndMs; t += 5) {
      const i = activeWordIndex(spans, t, c.readEndMs);
      expect(i).toBeGreaterThanOrEqual(prev);
      prev = i;
    }
    expect(prev).toBe(3);
  });
});
