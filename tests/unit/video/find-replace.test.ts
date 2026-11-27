import { describe, expect, it } from 'vitest';
import { applyOps } from '@/lib/video/cue-ops';
import { defaultMatchDiacritics, findInCues, matchVariants, replaceOps, type FindOptions } from '@/lib/video/find-replace';
import type { Cue } from '@/lib/video/types';

/** Tìm và thay trong phụ đề (spec 006, T109; FR-025, SC-006; contracts/subtitle-pipeline.md §4). */

let seq = 0;
const cue = (targetText: string, sourceText = ''): Cue => {
  const n = seq++;
  return { id: `c${n}`, startMs: n * 1000, endMs: n * 1000 + 800, timing: 'measured', sourceText, targetText, sourceLang: 'en', speaker: null, flags: {} };
};
const options = (query: string, over: Partial<FindOptions> = {}): FindOptions => ({ query, column: 'target', caseSensitive: false, wholeWord: false, matchDiacritics: defaultMatchDiacritics(query), ...over });
const forms = (cues: Cue[], query: string, over: Partial<FindOptions> = {}) => findInCues(cues, options(query, over)).map((m) => m.matched);

describe('dấu tiếng Việt', () => {
  const cues = [cue('Bạn bán bàn ban đêm. BẠN ơi'), cue('Đường đi, duong di')];

  it('từ tìm không dấu khớp cả chữ có dấu; từ tìm có dấu khớp đúng dấu', () => {
    expect(defaultMatchDiacritics('ban')).toBe(false);
    expect(defaultMatchDiacritics('bạn')).toBe(true);
    expect(defaultMatchDiacritics('đ')).toBe(true);
    expect(forms(cues, 'ban')).toEqual(['Bạn', 'bán', 'bàn', 'ban', 'BẠN']);
    expect(forms(cues, 'bạn')).toEqual(['Bạn', 'BẠN']);
  });

  it('`đ` được coi là `d` khi không khớp dấu; có tùy chọn khớp đúng dấu', () => {
    expect(forms(cues, 'duong')).toEqual(['Đường', 'duong']);
    expect(forms(cues, 'duong', { matchDiacritics: true })).toEqual(['duong']);
    expect(forms(cues, 'đường')).toEqual(['Đường']);
    expect(forms(cues, 'ban', { matchDiacritics: true })).toEqual(['ban']);
    expect(forms(cues, 'bạn', { matchDiacritics: false })).toEqual(['Bạn', 'bán', 'bàn', 'ban', 'BẠN']);
  });

  it('vị trí tính trên chuỗi NFC, kể cả khi chuỗi lưu hoặc từ tìm ở dạng tổ hợp', () => {
    const list = [cue('xin chào bạn')];
    const [m] = findInCues(list, options('chao'));
    expect(m).toMatchObject({ cueId: list[0]!.id, start: 4, end: 8, matched: 'chào' });
    expect(forms(list, 'bạn')).toEqual(['bạn']);
  });

  it('không cắt giữa ký tự: chữ nền kèm dấu rời được lấy cả cụm khi không khớp dấu, và không khớp khi khớp đúng dấu', () => {
    // "x̣" không có dạng dựng sẵn nên NFC vẫn giữ dấu rời
    const list = [cue('ax̣b ax')];
    expect(forms(list, 'ax')).toEqual(['ax̣', 'ax']);
    expect(forms(list, 'ax', { matchDiacritics: true })).toEqual(['ax']);
  });
});

describe('tùy chọn', () => {
  const cues = [cue('Tea tea TEAM steam, tea.'), cue('Chè', 'tea leaves')];

  it('phân biệt hoa thường', () => {
    expect(forms(cues, 'tea')).toHaveLength(5);
    expect(forms(cues, 'tea', { caseSensitive: true })).toEqual(['tea', 'tea', 'tea']);
    expect(forms(cues, 'Tea', { caseSensitive: true })).toEqual(['Tea']);
  });

  it('khớp cả từ đúng với tiếng Việt có dấu và chữ số', () => {
    expect(forms(cues, 'tea', { wholeWord: true })).toEqual(['Tea', 'tea', 'tea']);
    const vi = [cue('an anh ăn lan an2 2an "an" an,an')];
    expect(findInCues(vi, options('an', { wholeWord: true, matchDiacritics: true })).map((m) => m.start)).toEqual([0, 23, 27, 30]);
    expect(forms([cue('hoàn toàn')], 'hoà', { wholeWord: true })).toEqual([]);
  });

  it('chọn cột gốc hoặc cột dịch; từ tìm rỗng hoặc chỉ toàn dấu không khớp gì; các vị trí không chồng nhau', () => {
    expect(findInCues(cues, options('tea', { column: 'source' })).map((m) => m.cueId)).toEqual([cues[1]!.id]);
    expect(forms(cues, '')).toEqual([]);
    expect(forms(cues, '́', { matchDiacritics: false })).toEqual([]);
    expect(forms([cue('aaaa')], 'aa')).toEqual(['aa', 'aa']);
  });
});

describe('dạng khớp', () => {
  it('gom theo dạng khác dấu, không tính khác hoa thường', () => {
    const cues = [cue('Bạn bạn bán BÁN ban')];
    expect(matchVariants(findInCues(cues, options('ban')))).toEqual([
      { form: 'bạn', count: 2 },
      { form: 'bán', count: 2 },
      { form: 'ban', count: 1 },
    ]);
    expect(matchVariants(findInCues(cues, options('bạn')))).toEqual([{ form: 'bạn', count: 2 }]);
  });
});

describe('thay thế', () => {
  it('thay mọi vị trí trong một lô, hoàn tác bằng lô nghịch đảo', () => {
    const cues = [cue('ban ban', 'ban'), cue('không có'), cue('BAN')];
    const { ops, replaced } = replaceOps(cues, findInCues(cues, options('ban')), 'bạn', 'target');
    expect(replaced).toBe(3);
    expect(ops.map((o) => o.type === 'update' && [o.id, o.patch])).toEqual([
      [cues[0]!.id, { targetText: 'bạn bạn' }],
      [cues[2]!.id, { targetText: 'bạn' }],
    ]);
    const done = applyOps(cues, ops, 60_000);
    if (!done.ok) throw new Error('ops');
    expect(done.cues[0]).toMatchObject({ targetText: 'bạn bạn', sourceText: 'ban' });
    const undone = applyOps(done.cues, done.inverse, 60_000);
    expect(undone.ok && undone.cues.map((c) => c.targetText)).toEqual(['ban ban', 'không có', 'BAN']);
  });

  it('vị trí không còn khớp bị bỏ qua và không được đếm', () => {
    const cues = [cue('một hai một'), cue('một')];
    const matches = findInCues(cues, options('một'));
    const changed = [{ ...cues[0]!, targetText: 'một hai MỘT' }];
    const { ops, replaced } = replaceOps(changed, matches, '1', 'target');
    expect(replaced).toBe(1);
    expect(ops).toEqual([{ type: 'update', id: cues[0]!.id, patch: { targetText: '1 hai MỘT' } }]);
  });

  it('thay bằng chuỗi giống hệt thì không có thao tác', () => {
    const cues = [cue('abc')];
    expect(replaceOps(cues, findInCues(cues, options('b')), 'b', 'target')).toEqual({ ops: [], replaced: 0 });
  });

  it('3.000 cue: tìm và thay tất cả trong vòng 2 giây, đổi đúng mọi vị trí', () => {
    const cues = Array.from({ length: 3000 }, (_, i) => cue(`Câu số ${i}: bạn bè bán bàn, bạn nhé.`));
    const started = performance.now();
    const matches = findInCues(cues, options('ban'));
    const { ops, replaced } = replaceOps(cues, matches, 'tôi', 'target');
    const done = applyOps(cues, ops, 3_600_000);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(replaced).toBe(3000 * 4);
    expect(done.ok && findInCues(done.cues, options('ban'))).toEqual([]);
  });
});
