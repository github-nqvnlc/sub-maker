import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_CUE_WARNINGS, parseSrtCues, parseTimeMs } from '@/lib/parsing/srt';

const cue = (n: number, a: string, b: string, ...text: string[]) => [String(n), `${a} --> ${b}`, ...text, ''].join('\n');

describe('parseTimeMs', () => {
  it('nhận hh:mm:ss,mmm, hh:mm:ss.mmm và mm:ss', () => {
    expect(parseTimeMs('00:00:04,675')).toBe(4675);
    expect(parseTimeMs('01:02:03.500')).toBe(3_723_500);
    expect(parseTimeMs('02:03')).toBe(123_000);
    expect(parseTimeMs('00:00:01,5')).toBe(1500); // phần lẻ 1 chữ số = 500 ms
  });
});

describe('parseSrtCues — tệp mẫu 10 giây', () => {
  const text = fs.readFileSync(path.resolve(process.cwd(), 'tests/fixtures/sample-10s.srt'), 'utf8');
  const r = parseSrtCues(text);

  it('cho đúng 3 cue, không có số thứ tự hay mốc trong chữ đọc', () => {
    expect(r.cues).toHaveLength(3);
    expect(r.cues.map((c) => c.text)).toEqual([
      'Bạn đã nghe hai bài phát biểu ở Thẩm Quyến ngày 18 tháng 11.',
      'Nhưng Tập Cận Bình không nhắc đến Nga một lần nào.',
      'Không Putin.',
    ]);
    for (const c of r.cues) expect(c.text).not.toMatch(/-->|^\d+$/);
    expect(r.cues.map((c) => [c.startMs, c.endMs])).toEqual([
      [300, 4675],
      [5005, 8442],
      [8772, 9772],
    ]);
    expect(r.cues.map((c) => c.idx)).toEqual([0, 1, 2]);
    expect(r.cues.map((c) => c.n)).toEqual([1, 2, 3]);
    expect(r.warnings).toEqual([]);
  });

  it('số ký tự tính phí bằng đúng số ký tự chữ đọc', () => {
    const total = r.cues.reduce((n, c) => n + c.charCount, 0);
    expect(total).toBe(r.cues.reduce((n, c) => n + [...c.text].length, 0));
    expect(r.cues.map((c) => c.charCount)).toEqual([60, 50, 12]);
    expect(total).toBe(122);
  });
});

describe('parseSrtCues — làm sạch', () => {
  it('bỏ thẻ <i>, {\\an8}, [hh:mm:ss] và nối các dòng của cue; NFC', () => {
    const t = [cue(1, '00:00:01,000', '00:00:02,000', '<i>Xin chào</i>', '{\\an8}các bạn'), cue(2, '00:00:03,000', '00:00:04,000', '[00:05] Dòng hai.')].join('\n');
    expect(parseSrtCues(t).cues.map((c) => c.text)).toEqual(['Xin chào các bạn', 'Dòng hai.']);
    const decomposed = 'Tiếng Việt'.normalize('NFD');
    expect(parseSrtCues(cue(1, '00:00:00,000', '00:00:01,000', decomposed)).cues[0]!.text).toBe('Tiếng Việt');
  });

  it('chấp nhận CRLF và mốc dùng dấu chấm', () => {
    const t = cue(1, '00:00:01.000', '00:00:02.000', 'Một').replace(/\n/g, '\r\n');
    const r = parseSrtCues(t);
    expect(r.cues).toHaveLength(1);
    expect(r.cues[0]).toMatchObject({ startMs: 1000, endMs: 2000, text: 'Một' });
  });

  it('cue không có dòng trống ngăn cách vẫn tách đúng', () => {
    const t = ['1', '00:00:01,000 --> 00:00:02,000', 'A', '2', '00:00:03,000 --> 00:00:04,000', 'B'].join('\n');
    expect(parseSrtCues(t).cues.map((c) => c.text)).toEqual(['A', 'B']);
  });
});

describe('parseSrtCues — cảnh báo và chuẩn hóa', () => {
  it('BAD_RANGE: mốc kết thúc ≤ mốc bắt đầu → bỏ cue', () => {
    const t = [cue(1, '00:00:05,000', '00:00:04,000', 'Ngược'), cue(2, '00:00:06,000', '00:00:06,000', 'Bằng'), cue(3, '00:00:07,000', '00:00:08,000', 'Tốt')].join('\n');
    const r = parseSrtCues(t);
    expect(r.cues.map((c) => c.text)).toEqual(['Tốt']);
    expect(r.warnings).toEqual([
      { cue: 1, code: 'BAD_RANGE' },
      { cue: 2, code: 'BAD_RANGE' },
    ]);
  });

  it('OUT_OF_ORDER: sắp lại theo mốc bắt đầu và đánh lại idx', () => {
    const t = [cue(1, '00:00:05,000', '00:00:06,000', 'Hai'), cue(2, '00:00:01,000', '00:00:02,000', 'Một')].join('\n');
    const r = parseSrtCues(t);
    expect(r.cues.map((c) => c.text)).toEqual(['Một', 'Hai']);
    expect(r.cues.map((c) => c.idx)).toEqual([0, 1]);
    expect(r.warnings).toContainEqual({ cue: 2, code: 'OUT_OF_ORDER' });
  });

  it('OVERLAP: khe bị giới hạn bởi mốc bắt đầu của cue sau', () => {
    const t = [cue(1, '00:00:01,000', '00:00:05,000', 'Dài'), cue(2, '00:00:03,000', '00:00:04,000', 'Sau')].join('\n');
    const r = parseSrtCues(t);
    expect(r.cues[0]).toMatchObject({ startMs: 1000, endMs: 3000 });
    expect(r.warnings).toContainEqual({ cue: 1, code: 'OVERLAP' });
  });

  it('NO_SPEECH: ♪, [Music], (cười) → giữ khe nhưng không đọc, charCount = 0', () => {
    const t = [cue(1, '00:00:01,000', '00:00:02,000', '♪'), cue(2, '00:00:03,000', '00:00:04,000', '[Music]'), cue(3, '00:00:05,000', '00:00:06,000', '(cười)'), cue(4, '00:00:07,000', '00:00:08,000', 'Có chữ')].join('\n');
    const r = parseSrtCues(t);
    expect(r.cues.map((c) => [c.speakable, c.text, c.charCount])).toEqual([
      [false, '', 0],
      [false, '', 0],
      [false, '', 0],
      [true, 'Có chữ', 6],
    ]);
    expect(r.warnings.filter((w) => w.code === 'NO_SPEECH').map((w) => w.cue)).toEqual([1, 2, 3]);
  });

  it(`chỉ giữ tối đa ${MAX_CUE_WARNINGS} cảnh báo nhưng warningCount đếm đủ`, () => {
    const n = MAX_CUE_WARNINGS + 50;
    const t = Array.from({ length: n }, (_, i) => cue(i + 1, `00:00:${String(Math.floor(i / 10)).padStart(2, '0')},${String((i % 10) * 100).padStart(3, '0')}`, `00:00:${String(Math.floor(i / 10)).padStart(2, '0')},${String((i % 10) * 100 + 50).padStart(3, '0')}`, '♪')).join('\n');
    const r = parseSrtCues(t);
    expect(r.warnings).toHaveLength(MAX_CUE_WARNINGS);
    expect(r.warningCount).toBe(n);
  });

  it('tệp không có mốc → không có cue', () => {
    expect(parseSrtCues('Chỉ là văn bản\nkhông có mốc').cues).toEqual([]);
  });
});
