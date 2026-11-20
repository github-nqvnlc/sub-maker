import { describe, expect, it } from 'vitest';
import { buildReadingUnits, endsSentence, type ReadingCue } from '@/lib/parsing/reading-units';

const mk = (rows: Array<[string, number, number, boolean?]>): ReadingCue[] =>
  rows.map(([text, startMs, endMs, speakable = true], idx) => ({ idx, n: idx + 1, startMs, endMs, text, speakable }));
const OPTS = { merge: true, maxChars: 400, maxGapMs: 1000 };

describe('endsSentence', () => {
  it.each([
    ['Hết câu.', true],
    ['Thật không?', true],
    ['Ôi!', true],
    ['Còn nữa…', true],
    ['Ông mở đầu:', true],
    ['Anh nói "ổn rồi."', true],
    ['Một tương lai mở, dựa trên luật lệ,', false],
    ['không có dấu', false],
  ])('%s → %s', (text, want) => expect(endsSentence(text)).toBe(want));
});

describe('buildReadingUnits', () => {
  it('merge=false: mỗi cue speakable một đơn vị', () => {
    const cues = mk([['A.', 0, 1000], ['B,', 1100, 2000], ['C.', 2100, 3000]]);
    const u = buildReadingUnits(cues, { ...OPTS, merge: false });
    expect(u.map((x) => x.text)).toEqual(['A.', 'B,', 'C.']);
    expect(u.map((x) => x.idx)).toEqual([0, 1, 2]);
  });

  it('merge=true: gom các cue cho đến cue kết thúc bằng dấu kết câu', () => {
    const cues = mk([
      ['Tập nói về một tương lai', 27370, 29000],
      ['mở, dựa trên luật lệ,', 29100, 30807],
      ['công nghệ và thị trường.', 30887, 32450],
      ['Ông mở đầu:', 70000, 71000],
      ['chúng ta đang ở trong một thế giới.', 71100, 74000],
    ]);
    const u = buildReadingUnits(cues, OPTS);
    expect(u).toHaveLength(3);
    expect(u[0]).toMatchObject({
      text: 'Tập nói về một tương lai mở, dựa trên luật lệ, công nghệ và thị trường.',
      cueFrom: 0,
      cueTo: 2,
      startMs: 27370,
      slotEndMs: 32450,
    });
    expect(u[1]!.text).toBe('Ông mở đầu:'); // dấu hai chấm đóng nhóm
    expect(u[2]!.text).toBe('chúng ta đang ở trong một thế giới.');
  });

  it('cắt nhóm khi khoảng nghỉ giữa hai cue vượt maxGapMs', () => {
    const cues = mk([['Câu dở dang,', 0, 1000], ['phần sau.', 3000, 4000]]);
    expect(buildReadingUnits(cues, OPTS)).toHaveLength(2);
    expect(buildReadingUnits(cues, { ...OPTS, maxGapMs: 2500 })).toHaveLength(1);
  });

  it('cắt nhóm khi vượt maxChars', () => {
    const cues = mk([['a'.repeat(30) + ',', 0, 1000], ['b'.repeat(30) + ',', 1100, 2000], ['c'.repeat(30) + '.', 2100, 3000]]);
    const u = buildReadingUnits(cues, { ...OPTS, maxChars: 70 });
    expect(u.map((x) => x.cues.length)).toEqual([2, 1]);
    expect(u.every((x) => x.chars <= 70)).toBe(true);
  });

  it('cue không đọc được ngắt nhóm và không thuộc đơn vị nào', () => {
    const cues = mk([['Mở đầu,', 0, 1000], ['', 1100, 2000, false], ['kết thúc.', 2100, 3000]]);
    const u = buildReadingUnits(cues, OPTS);
    expect(u.map((x) => x.text)).toEqual(['Mở đầu,', 'kết thúc.']);
    expect(u.map((x) => [x.cueFrom, x.cueTo])).toEqual([[0, 0], [2, 2]]);
  });

  it('một cue quá dài tách theo mệnh đề, thời gian chia theo tỷ lệ ký tự trên cả khe', () => {
    const text = 'Phần một của câu rất dài, phần hai của câu rất dài, phần ba của câu rất dài.';
    const u = buildReadingUnits(mk([[text, 1000, 7000]]), { ...OPTS, maxChars: 30 });
    expect(u.length).toBeGreaterThan(1);
    expect(u.every((x) => x.chars <= 30 && x.split)).toBe(true);
    expect(u[0]!.startMs).toBe(1000);
    expect(u[u.length - 1]!.slotEndMs).toBe(7000);
    for (let i = 1; i < u.length; i++) expect(u[i]!.startMs).toBe(u[i - 1]!.slotEndMs); // liền nhau, không chồng
  });

  it('mọi cue speakable được phủ đúng một lần, theo thứ tự, kết quả xác định', () => {
    const rows: Array<[string, number, number]> = [];
    for (let i = 0; i < 50; i++) rows.push([i % 3 === 2 ? `Câu ${i}.` : `Mảnh ${i},`, i * 1000, i * 1000 + 800]);
    const cues = mk(rows);
    const a = buildReadingUnits(cues, OPTS);
    const b = buildReadingUnits(cues, OPTS);
    expect(a).toEqual(b);
    const covered = a.flatMap((u) => u.cues.map((c) => c.idx));
    expect(covered).toEqual(cues.map((c) => c.idx));
    for (let i = 1; i < a.length; i++) expect(a[i]!.startMs).toBeGreaterThan(a[i - 1]!.startMs);
  });
});
