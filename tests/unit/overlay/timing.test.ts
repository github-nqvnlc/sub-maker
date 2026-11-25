import { describe, expect, it } from 'vitest';
import { buildReadingUnits } from '@/lib/parsing/reading-units';
import { parseSrtCues } from '@/lib/parsing/srt';
import { activeCueIndex, applyTiming, type FileCue, type TimingInput, type VoiceEntry } from '@/lib/overlay/timing';
import { sampleSrt } from './helpers';

const c = (startMs: number, endMs: number, text: string, speakable = true): FileCue => ({ startMs, endMs, text, speakable });
const v = (startMs: number, endMs: number, text: string, failed = false): VoiceEntry => ({ startMs, endMs, text, ...(failed ? { failed } : {}) });
const codes = (r: { warnings: { code: string }[] }) => r.warnings.map((w) => w.code);
const run = (over: Partial<TimingInput>) => applyTiming({ fileCues: [], source: 'timed', voiceTimeline: null, voiceDurationMs: 10_000, ...over });

function checkInvariants(r: ReturnType<typeof applyTiming>, voiceMs: number) {
  r.cues.forEach((q, i) => {
    expect(q.i).toBe(i);
    expect(q.startMs).toBeGreaterThanOrEqual(0);
    expect(q.endMs).toBeGreaterThan(q.startMs);
    expect(q.endMs).toBeLessThanOrEqual(voiceMs);
    expect(q.readEndMs).toBeGreaterThan(q.startMs);
    expect(q.readEndMs).toBeLessThanOrEqual(q.endMs);
    if (i > 0) {
      expect(q.startMs).toBeGreaterThanOrEqual(r.cues[i - 1]!.endMs);
      expect(q.startMs).toBeGreaterThan(r.cues[i - 1]!.startMs);
    }
  });
}

describe('applyTiming: mốc của voice', () => {
  it('dùng mốc đọc thật của voice; ẩn tại mốc muộn hơn giữa đọc xong và kết thúc trong tệp', () => {
    const r = run({
      fileCues: [c(1000, 3000, 'Một hai.'), c(4000, 5000, 'Ba bốn.')],
      voiceTimeline: [v(1200, 2500, 'Một hai.'), v(4300, 5600, 'Ba bốn.')],
      voiceDurationMs: 6000,
    });
    expect(r.cues).toMatchObject([
      { startMs: 1200, readEndMs: 2500, endMs: 3000, origin: 'voice' },
      { startMs: 4300, readEndMs: 5600, endMs: 5600, origin: 'voice' },
    ]);
    expect(codes(r)).toEqual([]);
  });

  it('cue ghép câu: mốc trong câu chia theo ký tự, hai cue liền nhau chạm nhau', () => {
    const r = run({
      fileCues: [c(0, 1000, 'abcd'), c(1000, 2000, 'efgh ijkl')],
      voiceTimeline: [v(0, 1200, 'abcd efgh ijkl')],
      voiceDurationMs: 2000,
    });
    expect(r.cues[0]).toMatchObject({ startMs: 0, readEndMs: 400 });
    expect(r.cues[1]).toMatchObject({ startMs: 400, readEndMs: 1200, endMs: 2000 });
    // cue đầu ẩn khi cue sau hiện dù tệp ghi tới 1000
    expect(r.cues[0]!.endMs).toBe(400);
  });

  it('câu bị tách thành nhiều đơn vị vẫn dùng mốc voice, không kéo cả tệp về mốc tệp', () => {
    const r = run({
      fileCues: [c(0, 2000, 'aaaa bbbb'), c(3000, 4000, 'cccc')],
      voiceTimeline: [v(100, 900, 'aaaa'), v(1000, 1900, 'bbbb'), v(3200, 3900, 'cccc')],
      voiceDurationMs: 4000,
    });
    expect(r.cues[0]).toMatchObject({ startMs: 100, readEndMs: 1900, origin: 'voice' });
    expect(r.cues[1]).toMatchObject({ startMs: 3200, origin: 'voice' });
    expect(codes(r)).toEqual([]);
  });

  it('mục failed: chỉ cue chạm mục lỗi dùng mốc tệp', () => {
    const r = run({
      fileCues: [c(0, 1000, 'aa'), c(1500, 2500, 'bb'), c(3000, 4000, 'cc')],
      voiceTimeline: [v(100, 900, 'aa'), v(1500, 2500, 'bb', true), v(3300, 3900, 'cc')],
      voiceDurationMs: 4000,
    });
    expect(r.cues.map((q) => q.origin)).toEqual(['voice', 'file', 'voice']);
    expect(r.cues[1]).toMatchObject({ startMs: 1500, endMs: 2500 });
    expect(r.cues[2]!.startMs).toBe(3300);
  });

  it('chuỗi chữ không bằng nhau: cả tệp dùng mốc tệp kèm cảnh báo', () => {
    const r = run({ fileCues: [c(0, 1000, 'aa'), c(1000, 2000, 'bb')], voiceTimeline: [v(100, 900, 'aa'), v(1200, 1900, 'khác')], voiceDurationMs: 2000 });
    expect(r.cues.every((q) => q.origin === 'file')).toBe(true);
    expect(codes(r)).toEqual(['TIMELINE_FALLBACK']);
  });

  it('khác dạng Unicode và khoảng trắng vẫn ghép được', () => {
    const text = 'Tiếng Việt';
    const r = run({ fileCues: [c(0, 1000, text.normalize('NFD'))], voiceTimeline: [v(50, 900, 'Tiếng   Việt')], voiceDurationMs: 1000 });
    expect(r.cues[0]).toMatchObject({ startMs: 50, origin: 'voice', text });
  });

  it('kẹp thứ tự khi mốc voice trễ hơn mốc tệp đứng sau; mỗi cue hiện ít nhất một khung', () => {
    const r = run({
      fileCues: [c(0, 1000, 'aa'), c(1000, 1200, 'bb'), c(1200, 1300, 'cc')],
      voiceTimeline: [v(1150, 1600, 'aa'), v(1000, 1200, 'bb', true), v(1200, 1300, 'cc', true)],
      voiceDurationMs: 5000,
    });
    expect(r.cues.map((q) => q.startMs)).toEqual([1150, 1184, 1218]);
    for (const q of r.cues) expect(q.endMs - q.startMs).toBeGreaterThanOrEqual(34);
    checkInvariants(r, 5000);
  });

  it('phụ đề mẫu 244 cue: ghép khớp với đơn vị đọc ở mọi giới hạn ký tự (kể cả câu bị tách)', () => {
    const cues = parseSrtCues(sampleSrt()).cues;
    for (const maxChars of [400, 60, 30]) {
      const units = buildReadingUnits(cues, { merge: true, maxChars, maxGapMs: 1000 });
      const timeline = units.map((u) => v(u.startMs + 120, Math.max(u.startMs + 160, u.slotEndMs), u.text));
      const total = Math.max(...cues.map((q) => q.endMs)) + 500;
      const r = run({ fileCues: cues, voiceTimeline: timeline, voiceDurationMs: total });
      expect(codes(r)).not.toContain('TIMELINE_FALLBACK');
      expect(r.cues.length).toBe(cues.filter((q) => q.speakable).length);
      expect(r.cues.every((q) => q.origin === 'voice')).toBe(true);
      checkInvariants(r, total);
    }
  });
});

describe('applyTiming: mốc của tệp và cảnh báo', () => {
  const fileCues = [c(0, 1000, 'aa'), c(2000, 3000, 'bb')];
  it('bốn loại nguồn và cảnh báo của từng loại', () => {
    const timeline = [v(500, 900, 'aa'), v(2500, 2900, 'bb')];
    const base = { fileCues, voiceTimeline: timeline, voiceDurationMs: 3000 };
    expect(codes(run({ ...base, source: 'timed' }))).toEqual([]);
    expect(codes(run({ ...base, source: 'continuous' }))).toEqual(['NOT_TIMED_VOICE']);
    expect(codes(run({ ...base, source: 'otherFile' }))).toEqual(['OTHER_FILE']);
    expect(codes(run({ ...base, source: 'uploaded' }))).toEqual([]);
    // chỉ 'timed' dùng mốc voice
    for (const source of ['continuous', 'otherFile', 'uploaded'] as const) expect(run({ ...base, source }).cues[0]!.startMs).toBe(0);
  });

  it('voice ngắn hơn phụ đề: bỏ cue sau hết voice, cắt cue đang hiện, nêu số lượng', () => {
    const r = run({ fileCues: [c(0, 1000, 'a'), c(2000, 4000, 'b'), c(5000, 6000, 'c')], source: 'uploaded', voiceDurationMs: 3000 });
    expect(r.cues.map((q) => [q.startMs, q.endMs])).toEqual([
      [0, 1000],
      [2000, 3000],
    ]);
    expect(r.warnings).toEqual([{ code: 'LENGTH_MISMATCH', params: { diffMs: -3000, droppedCues: 1, cutCues: 1 } }]);
    checkInvariants(r, 3000);
  });

  it('voice dài hơn phụ đề quá 2 giây thì cảnh báo; đúng 2 giây thì không', () => {
    expect(codes(run({ fileCues, source: 'uploaded', voiceDurationMs: 5000 }))).toEqual([]);
    expect(codes(run({ fileCues, source: 'uploaded', voiceDurationMs: 5001 }))).toEqual(['LENGTH_MISMATCH']);
  });

  it('cue không có chữ bị bỏ; chỉ số liền mạch', () => {
    const r = run({ fileCues: [c(0, 500, '', false), c(600, 900, 'x'), c(1000, 1500, '  '), c(1600, 2000, 'y')], source: 'uploaded', voiceDurationMs: 2000 });
    expect(r.cues.map((q) => [q.i, q.text])).toEqual([
      [0, 'x'],
      [1, 'y'],
    ]);
  });

  it('không có cue nào vẫn không lỗi', () => {
    expect(run({ fileCues: [], source: 'timed', voiceTimeline: [], voiceDurationMs: 1000 }).cues).toEqual([]);
  });
});

describe('activeCueIndex', () => {
  const r = run({ fileCues: [c(1000, 2000, 'a'), c(3000, 4000, 'b')], source: 'uploaded', voiceDurationMs: 4000 });
  it.each([
    [0, -1],
    [999, -1],
    [1000, 0],
    [1999, 0],
    [2000, -1],
    [3500, 1],
    [4000, -1],
  ])('tại %i ms → %i', (t, want) => expect(activeCueIndex(r.cues, t)).toBe(want));
});
