import { describe, expect, it } from 'vitest';
import { applyOps, cueIndexAt, edgeBounds, insertAfterOp, mergeOps, nudgeOp, setEdgeOp, splitOps, type CueOp } from '@/lib/video/cue-ops';
import type { Cue } from '@/lib/video/types';

/** Lô thao tác sửa cue (spec 006, T055; contracts/subtitle-pipeline.md §3; FR-023, FR-024). */

const DURATION = 20_000;

const cue = (id: string, startMs: number, endMs: number, over: Partial<Cue> = {}): Cue => ({
  id,
  startMs,
  endMs,
  timing: 'measured',
  sourceText: `source ${id}`,
  targetText: `đích ${id}`,
  sourceLang: 'en',
  speaker: '1',
  flags: {},
  ...over,
});

const base = (): Cue[] => [cue('a', 1000, 3000), cue('b', 3500, 5000), cue('c', 5000, 8000)];

function ok(cues: readonly Cue[], ops: readonly CueOp[], durationMs = DURATION) {
  const r = applyOps(cues, ops, durationMs);
  if (!r.ok) throw new Error(`bị từ chối: ${r.violation.id} ${r.violation.reason}`);
  return r;
}
const rejected = (cues: readonly Cue[], ops: readonly CueOp[], durationMs = DURATION) => {
  const r = applyOps(cues, ops, durationMs);
  if (r.ok) throw new Error('đáng lẽ bị từ chối');
  return r.violation;
};
const byId = (cues: readonly Cue[], id: string) => cues.find((c) => c.id === id)!;

describe('applyOps', () => {
  it('sửa chữ: chuẩn NFC, giữ mốc và kiểu mốc, không đụng danh sách vào', () => {
    const before = base();
    const snapshot = structuredClone(before);
    const r = ok(before, [{ type: 'update', id: 'b', patch: { targetText: 'Xin chào' } }]);
    expect(byId(r.cues, 'b').targetText).toBe('Xin chào'.normalize('NFC'));
    expect(byId(r.cues, 'b')).toMatchObject({ startMs: 3500, endMs: 5000, timing: 'measured' });
    expect(r.changed.map((c) => c.id)).toEqual(['b']);
    expect(r.removed).toEqual([]);
    expect(before).toEqual(snapshot);
  });

  it('sửa mốc đặt timing = manual', () => {
    const r = ok(base(), [{ type: 'update', id: 'a', patch: { startMs: 900 } }]);
    expect(byId(r.cues, 'a').timing).toBe('manual');
  });

  it('sửa câu dịch bỏ cờ chưa dịch; tính lại cờ đọc nhanh theo chữ và mốc', () => {
    const list = [cue('u', 0, 1000, { targetText: '', flags: { untranslated: true, review: true } })];
    const r = ok(list, [{ type: 'update', id: 'u', patch: { targetText: 'ngắn' } }]);
    expect(byId(r.cues, 'u').flags).toEqual({});
    const long = ok(r.cues, [{ type: 'update', id: 'u', patch: { targetText: 'một câu rất dài không thể đọc kịp trong một giây' } }]);
    expect(byId(long.cues, 'u').flags).toEqual({ fast: true });
    const slower = ok(long.cues, [{ type: 'update', id: 'u', patch: { endMs: 8000 } }]);
    expect(byId(slower.cues, 'u').flags).toEqual({});
  });

  it('sửa không đổi gì thì không tính là thay đổi', () => {
    const r = ok(base(), [{ type: 'update', id: 'a', patch: { startMs: 1000, targetText: 'đích a' } }]);
    expect(r.changed).toEqual([]);
    expect(r.inverse).toEqual([]);
  });

  it('lô nghịch đảo đưa mọi thứ về đúng như cũ, kể cả kiểu mốc và cờ', () => {
    const before = [cue('a', 1000, 3000, { flags: { untranslated: true }, targetText: '' }), cue('b', 3500, 5000, { timing: 'estimated' }), cue('c', 5000, 8000)];
    const ops: CueOp[] = [
      { type: 'update', id: 'a', patch: { targetText: 'mới', startMs: 500 } },
      { type: 'update', id: 'b', patch: { endMs: 4800 } },
      { type: 'delete', id: 'c' },
      { type: 'insert', cue: cue('d', 6000, 7000) },
    ];
    const r = ok(before, ops);
    expect(r.cues.map((c) => c.id)).toEqual(['a', 'b', 'd']);
    expect(r.removed).toEqual(['c']);
    const back = ok(r.cues, r.inverse);
    expect(back.cues).toEqual(before);
    // làm lại: nghịch đảo của nghịch đảo cho đúng kết quả
    expect(ok(back.cues, back.inverse).cues).toEqual(r.cues);
  });

  it('tất cả hoặc không: một thao tác sai thì cả lô bị từ chối, nêu đúng cue', () => {
    const before = base();
    expect(rejected(before, [{ type: 'update', id: 'a', patch: { targetText: 'ổn' } }, { type: 'update', id: 'khong-co', patch: { targetText: 'x' } }])).toEqual({ id: 'khong-co', reason: 'missing' });
    expect(rejected(before, [{ type: 'delete', id: 'khong-co' }]).reason).toBe('missing');
    expect(rejected(before, [{ type: 'insert', cue: cue('a', 9000, 9500) }])).toEqual({ id: 'a', reason: 'duplicate' });
    expect(before).toEqual(base());
  });

  it.each([
    ['kết thúc trước bắt đầu + 100 ms', { startMs: 1000, endMs: 1099 }, 'too_short'],
    ['mốc âm', { startMs: -1 }, 'range'],
    ['mốc không nguyên', { startMs: 1000.5 }, 'range'],
    ['vượt thời lượng', { endMs: DURATION + 1 }, 'past_end'],
    ['chữ quá dài', { targetText: 'a'.repeat(2001) }, 'text'],
    ['chữ có ký tự NUL', { sourceText: 'a\u0000b' }, 'text'],
  ])('từ chối %s', (_name, patch, reason) => {
    const list = [cue('a', 1000, 3000)];
    expect(rejected(list, [{ type: 'update', id: 'a', patch }])).toEqual({ id: 'a', reason });
  });

  it('chấp nhận đúng biên: 100 ms, đúng thời lượng, 2.000 ký tự, hai cue chạm nhau', () => {
    ok(
      [cue('a', 0, 500), cue('b', 600, 900)],
      [
        { type: 'update', id: 'a', patch: { endMs: 600, targetText: 'a'.repeat(2000) } },
        { type: 'update', id: 'b', patch: { startMs: DURATION - 100, endMs: DURATION } },
      ],
    );
  });

  it('từ chối chồng mốc, kể cả khi cue chen vào giữa; chỉ xét trạng thái cuối của lô', () => {
    expect(rejected(base(), [{ type: 'update', id: 'a', patch: { endMs: 3600 } }])).toEqual({ id: 'a', reason: 'overlap' });
    expect(rejected(base(), [{ type: 'insert', cue: cue('x', 4000, 4200) }])).toEqual({ id: 'x', reason: 'overlap' });
    // đẩy b rồi mới đẩy a: bước giữa chồng nhau nhưng kết quả hợp lệ
    ok(base(), [
      { type: 'update', id: 'a', patch: { endMs: 4000 } },
      { type: 'update', id: 'b', patch: { startMs: 4000 } },
    ]);
  });

  it('dữ liệu cũ không hợp lệ ở cue không đụng tới thì không chặn việc sửa cue khác', () => {
    const list = [cue('hong', 0, 50), cue('a', 1000, 3000)];
    ok(list, [{ type: 'update', id: 'a', patch: { targetText: 'sửa' } }]);
  });

  it('không quá 20.000 cue', () => {
    const many = Array.from({ length: 20_000 }, (_, i) => cue(`n${i}`, i * 200, i * 200 + 150));
    expect(rejected(many, [{ type: 'insert', cue: cue('thua', 4_000_000, 4_000_500) }], 5_000_000).reason).toBe('too_many');
  });

  it('kết quả luôn sắp theo mốc bắt đầu', () => {
    const r = ok(base(), [{ type: 'insert', cue: cue('dau', 0, 500) }]);
    expect(r.cues.map((c) => c.id)).toEqual(['dau', 'a', 'b', 'c']);
  });
});

describe('chỉnh mốc ±100/±500 ms (kẹp theo cue liền kề)', () => {
  const list = base();
  it('giới hạn của từng mép', () => {
    expect(edgeBounds(list, 1, 'start', DURATION)).toEqual({ min: 3000, max: 4900 });
    expect(edgeBounds(list, 1, 'end', DURATION)).toEqual({ min: 3600, max: 5000 });
    expect(edgeBounds(list, 0, 'start', DURATION)).toEqual({ min: 0, max: 2900 });
    expect(edgeBounds(list, 2, 'end', DURATION)).toEqual({ min: 5100, max: DURATION });
  });

  it('dịch trong khoảng thì đổi đúng; vượt thì kẹp; đã chạm biên thì không có thao tác', () => {
    expect(nudgeOp(list, 'b', 'start', -100, DURATION)).toEqual({ type: 'update', id: 'b', patch: { startMs: 3400 } });
    expect(nudgeOp(list, 'b', 'start', -500, DURATION)).toEqual({ type: 'update', id: 'b', patch: { startMs: 3000 } });
    expect(nudgeOp(list, 'b', 'start', 5000, DURATION)).toEqual({ type: 'update', id: 'b', patch: { startMs: 4900 } });
    expect(nudgeOp(list, 'b', 'end', 100, DURATION)).toBeNull();
    expect(nudgeOp(list, 'b', 'end', -5000, DURATION)).toEqual({ type: 'update', id: 'b', patch: { endMs: 3600 } });
    expect(nudgeOp(list, 'c', 'end', 100_000, DURATION)).toEqual({ type: 'update', id: 'c', patch: { endMs: DURATION } });
    expect(setEdgeOp(list, 'a', 'start', -50, DURATION)).toEqual({ type: 'update', id: 'a', patch: { startMs: 0 } });
    expect(setEdgeOp(list, 'a', 'start', 1234.6, DURATION)).toEqual({ type: 'update', id: 'a', patch: { startMs: 1235 } });
    expect(setEdgeOp(list, 'a', 'start', Number.NaN, DURATION)).toBeNull();
    expect(setEdgeOp(list, 'khong-co', 'start', 10, DURATION)).toBeNull();
  });
});

describe('gộp, tách, thêm', () => {
  it('gộp: từ mốc đầu tới mốc cuối, nối chữ hai cột bằng khoảng trắng; hoàn tác được', () => {
    const list = base();
    const ops = mergeOps(list, 'a')!;
    const r = ok(list, ops);
    expect(r.cues.map((c) => c.id)).toEqual(['a', 'c']);
    expect(byId(r.cues, 'a')).toMatchObject({ startMs: 1000, endMs: 5000, sourceText: 'source a source b', targetText: 'đích a đích b', timing: 'manual' });
    expect(ok(r.cues, r.inverse).cues).toEqual(list);
    expect(mergeOps(list, 'c')).toBeNull(); // không còn cue sau
  });

  it('gộp bỏ vế rỗng, không để khoảng trắng thừa', () => {
    const list = [cue('a', 0, 1000, { targetText: '' }), cue('b', 1000, 2000)];
    expect(byId(ok(list, mergeOps(list, 'a')!).cues, 'a').targetText).toBe('đích b');
  });

  it('tách tại con trỏ chữ: mốc tách theo trọng số chữ, cột còn lại chia tại ranh giới từ tương ứng', () => {
    const list = [cue('a', 1000, 5000, { sourceText: 'one two three four', targetText: 'một hai ba bốn' })];
    const ops = splitOps(list, 'a', 'moi', { column: 'target', offset: 'một hai'.length })!;
    const r = ok(list, ops);
    const [first, second] = r.cues;
    expect(first).toMatchObject({ id: 'a', startMs: 1000, targetText: 'một hai', timing: 'manual' });
    expect(second).toMatchObject({ id: 'moi', endMs: 5000, targetText: 'ba bốn', timing: 'manual', sourceLang: 'en', speaker: '1' });
    expect(first!.endMs).toBe(second!.startMs);
    expect(first!.endMs).toBeGreaterThan(2000);
    expect(first!.endMs).toBeLessThan(4000);
    expect(`${first!.sourceText} ${second!.sourceText}`).toBe('one two three four');
    expect(first!.sourceText).not.toBe('');
    expect(second!.sourceText).not.toBe('');
    expect(ok(r.cues, r.inverse).cues).toEqual(list);
  });

  it('tách khi không có con trỏ (hoặc con trỏ ở đầu, cuối): chia ở giữa', () => {
    const list = [cue('a', 0, 2000, { sourceText: 'one two three four', targetText: 'một hai ba bốn' })];
    for (const caret of [undefined, { column: 'target' as const, offset: 0 }, { column: 'source' as const, offset: 999 }]) {
      const r = ok(list, splitOps(list, 'a', 'moi', caret)!);
      expect(r.cues[0]!.targetText).toBe('một hai');
      expect(r.cues[1]!.targetText).toBe('ba bốn');
      expect(r.cues[1]!.startMs).toBeGreaterThan(500);
    }
  });

  it('tách chữ viết liền theo ký tự', () => {
    const list = [cue('a', 0, 2000, { sourceText: '今日はいい天気です', targetText: '' })];
    const r = ok(list, splitOps(list, 'a', 'moi', { column: 'source', offset: 3 })!);
    expect(r.cues.map((c) => c.sourceText)).toEqual(['今日は', 'いい天気です']);
  });

  it('tách luôn để mỗi phần ≥ 100 ms; cue ngắn hơn 200 ms không tách được', () => {
    const short = [cue('a', 0, 200, { targetText: 'a bbbbbbbbbbbbbbbbbbbbbbbb' })];
    const r = ok(short, splitOps(short, 'a', 'moi', { column: 'target', offset: 1 })!);
    expect(r.cues.map((c) => c.endMs - c.startMs)).toEqual([100, 100]);
    expect(splitOps([cue('a', 0, 199)], 'a', 'moi')).toBeNull();
  });

  it('thêm cue vào khoảng trống sau cue đã chọn; không đủ chỗ thì không thêm', () => {
    const list = base();
    const op = insertAfterOp(list, 'a', 'moi', DURATION)!;
    expect(op).toMatchObject({ type: 'insert', cue: { id: 'moi', startMs: 3000, endMs: 3500, sourceText: '', targetText: '', timing: 'manual', flags: {} } });
    ok(list, [op]);
    expect(insertAfterOp(list, 'b', 'moi', DURATION)).toBeNull(); // b chạm c
    expect(insertAfterOp(list, 'c', 'moi', DURATION)).toMatchObject({ cue: { startMs: 8000, endMs: 10_000 } });
    expect(insertAfterOp(list, null, 'moi', DURATION)).toMatchObject({ cue: { startMs: 0, endMs: 1000 } });
    expect(insertAfterOp([], null, 'moi', 1500)).toMatchObject({ cue: { startMs: 0, endMs: 1500 } });
    expect(insertAfterOp(list, 'khong-co', 'moi', DURATION)).toBeNull();
  });
});

describe('cueIndexAt', () => {
  const list = base();
  it('trả cue đang hiện tại một thời điểm, -1 khi rơi vào khoảng trống', () => {
    expect(cueIndexAt(list, 0)).toBe(-1);
    expect(cueIndexAt(list, 1000)).toBe(0);
    expect(cueIndexAt(list, 2999)).toBe(0);
    expect(cueIndexAt(list, 3000)).toBe(-1);
    expect(cueIndexAt(list, 5000)).toBe(2);
    expect(cueIndexAt(list, 9000)).toBe(-1);
    expect(cueIndexAt([], 0)).toBe(-1);
  });
});
