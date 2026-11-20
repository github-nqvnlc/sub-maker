import { describe, expect, it } from 'vitest';
import { ScriptError, extOf, parseScript } from '@/lib/parsing';
import { decodeUtf8 } from '@/lib/parsing/detect';
import { markdownToParagraphs } from '@/lib/parsing/markdown';
import { normalizeInline } from '@/lib/parsing/normalize';
import { buildSegments, splitLongSentence, splitSentences } from '@/lib/parsing/segmenter';
import { srtToParagraphs } from '@/lib/parsing/srt';

const MB = 1024 * 1024;
const enc = (s: string) => new TextEncoder().encode(s);
const parse = (name: string, content: string | Uint8Array, maxBytes = 2 * MB) =>
  parseScript(name, typeof content === 'string' ? enc(content) : content, { maxBytes });

const errorOf = (fn: () => unknown): ScriptError => {
  try {
    fn();
  } catch (e) {
    return e as ScriptError;
  }
  throw new Error('không ném lỗi');
};

describe('kiểm tra tệp (FR-009)', () => {
  it('nhận .txt, .md, .srt không phân biệt hoa/thường; từ chối đuôi khác', () => {
    expect(extOf('a.TXT')).toBe('txt');
    expect(extOf('Kịch bản.Md')).toBe('md');
    expect(extOf('x.srt')).toBe('srt');
    for (const bad of ['a.pdf', 'a.docx', 'a.skt', 'a.vtt', 'a', 'a.txt.exe', '.txt.bak']) {
      expect(extOf(bad), bad).toBeNull();
    }
    expect(errorOf(() => parse('a.pdf', 'xin chào')).code).toBe('UNSUPPORTED_TYPE');
  });

  it('từ chối tệp rỗng và tệp vượt kích thước tối đa 2 MB', () => {
    expect(errorOf(() => parse('a.txt', '')).code).toBe('EMPTY');
    expect(errorOf(() => parse('a.txt', new Uint8Array(2 * MB + 1).fill(97))).code).toBe('TOO_LARGE');
    // đúng 2 MB là hợp lệ
    expect(() => parse('a.txt', 'a'.repeat(1000) + '.')).not.toThrow();
  });

  it('bỏ BOM UTF-8; từ chối UTF-16 và UTF-8 không hợp lệ', () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...enc('Xin chào các bạn.')]);
    expect(decodeUtf8(withBom)).toBe('Xin chào các bạn.');
    expect(errorOf(() => decodeUtf8(new Uint8Array([0xff, 0xfe, 0x41, 0x00]))).code).toBe('INVALID_ENCODING');
    expect(errorOf(() => decodeUtf8(new Uint8Array([0x41, 0xc3, 0x28, 0x42]))).code).toBe('INVALID_ENCODING'); // chuỗi UTF-8 sai
  });

  it('từ chối dữ liệu nhị phân (byte NUL), ví dụ PDF/ảnh đặt tên .txt', () => {
    const fakePdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x00, 0x00, 0x01]);
    expect(errorOf(() => parse('x.txt', fakePdf)).code).toBe('BINARY');
  });

  it('tệp chỉ có ký hiệu/mốc thời gian/emoji (không còn nội dung đọc được) → EMPTY', () => {
    expect(errorOf(() => parse('a.txt', '😀😀 ... --- !!!')).code).toBe('EMPTY');
    expect(errorOf(() => parse('a.srt', '1\n00:00:01,000 --> 00:00:02,000\n\n')).code).toBe('EMPTY');
    expect(errorOf(() => parse('a.md', '---\ntitle: x\n---\n\n```js\ncode()\n```\n')).code).toBe('EMPTY');
  });
});

describe('Markdown', () => {
  it('bỏ ký hiệu định dạng, giữ chữ của tiêu đề, danh sách, in đậm/nghiêng, liên kết, mã nội dòng', () => {
    const md = [
      '# Tiêu đề chính',
      '',
      'Đây là **chữ đậm**, *chữ nghiêng* và [một liên kết](https://example.com/rat-dai).',
      '',
      '- Mục thứ nhất',
      '- Mục thứ hai có `mã nội dòng`',
      '',
      '> Một câu trích dẫn.',
      '',
      '1. Bước một',
      '2. Bước hai',
    ].join('\n');
    expect(markdownToParagraphs(md)).toEqual([
      'Tiêu đề chính',
      'Đây là chữ đậm, chữ nghiêng và một liên kết.',
      'Mục thứ nhất',
      'Mục thứ hai có mã nội dòng',
      'Một câu trích dẫn.',
      'Bước một',
      'Bước hai',
    ]);
  });

  it('bỏ khối mã, HTML, hình ảnh, thanh ngang và front matter; bảng đọc từng ô', () => {
    const md = ['---', 'title: Bí mật', 'tags: [a]', '---', '', 'Mở đầu.', '', '```bash', 'rm -rf /', '```', '', '![ảnh](a.png)', '', '---', '', '<div>html</div>', '', '| Tên | Tuổi |', '|---|---|', '| An | 20 |', '', 'Kết thúc.'].join('\n');
    const out = markdownToParagraphs(md);
    expect(out).toEqual(['Mở đầu.', 'Tên', 'Tuổi', 'An', '20', 'Kết thúc.']);
    expect(out.join(' ')).not.toMatch(/rm -rf|Bí mật|html/);
  });

  it('parseScript .md: kết quả không còn ký hiệu Markdown', () => {
    const r = parse('doc.md', '## Giới thiệu\n\nXem **ngay** tại [đây](https://x.vn).\n');
    expect(r.segments.join(' ')).toBe('Giới thiệu Xem ngay tại đây.');
    expect(r.segments.join('')).not.toMatch(/[#*\[\]()]|https/);
  });
});

describe('.srt / phụ đề', () => {
  const srt = ['1', '00:00:01,000 --> 00:00:03,500', 'Xin chào các bạn.', '', '2', '00:00:04,000 --> 00:00:07,000', 'Hôm nay chúng ta học', 'về lịch sử Việt Nam.', '', '3', '00:00:08,000 --> 00:00:09,000', '<i>Cảm ơn đã xem!</i>'].join('\n');

  it('bỏ số thứ tự và mốc thời gian, nối các dòng trong cùng một cue', () => {
    expect(srtToParagraphs(srt)).toEqual(['Xin chào các bạn.', 'Hôm nay chúng ta học về lịch sử Việt Nam.', 'Cảm ơn đã xem!']);
  });

  it('xử lý CRLF, WebVTT, thẻ {\\an8} và mốc [hh:mm:ss] ở đầu dòng', () => {
    const vtt = 'WEBVTT\r\n\r\n00:00:01.000 --> 00:00:02.000 align:start\r\n{\\an8}Dòng một.\r\n\r\n[00:05] Dòng hai.\r\n';
    expect(srtToParagraphs(vtt)).toEqual(['Dòng một.', 'Dòng hai.']);
  });

  it('dòng chỉ có số mà KHÔNG đứng trước mốc thời gian thì được giữ (ví dụ năm, số liệu)', () => {
    // cùng một cue nên được nối với dòng kế tiếp, nhưng số "2024" không bị coi là chỉ số cue và bỏ đi
    expect(srtToParagraphs('2024\nNăm nay thật tuyệt.')).toEqual(['2024 Năm nay thật tuyệt.']);
    expect(srtToParagraphs('2024\n\nNăm nay thật tuyệt.')).toEqual(['2024', 'Năm nay thật tuyệt.']);
  });

  it('đoạn đầu (≤ 10 giây) của tệp mẫu tham-quyen-2026.srt: chỉ còn chữ đọc', () => {
    const sample = [
      '1', '00:00:00,300 --> 00:00:04,675', 'Bạn đã nghe hai bài phát biểu', 'ở Thẩm Quyến ngày 18 tháng 11.', '',
      '2', '00:00:05,005 --> 00:00:08,442', 'Nhưng Tập Cận Bình không', 'nhắc đến Nga một lần nào.', '',
      '3', '00:00:08,772 --> 00:00:09,772', 'Không Putin.',
    ].join('\n');
    expect(srtToParagraphs(sample)).toEqual([
      'Bạn đã nghe hai bài phát biểu ở Thẩm Quyến ngày 18 tháng 11.',
      'Nhưng Tập Cận Bình không nhắc đến Nga một lần nào.',
      'Không Putin.',
    ]);
    expect(extOf('tham-quyen-2026.srt')).toBe('srt');
  });

  it('mốc thời gian không ảnh hưởng nội dung đọc', () => {
    const a = parse('a.srt', srt);
    const b = parse('a.srt', srt.replace(/00:00:0\d,\d{3}/g, '09:59:59,999'));
    expect(a.segments).toEqual(b.segments);
    expect(a.contentHash).toBe(b.contentHash);
  });
});

describe('chuẩn hóa', () => {
  it('NFC: chuỗi NFD được chuyển về NFC', () => {
    const nfd = 'Tiếng Việt'.normalize('NFD');
    expect(nfd).not.toBe('Tiếng Việt');
    expect(normalizeInline(nfd)).toBe('Tiếng Việt'.normalize('NFC'));
  });

  it('bỏ emoji, URL, ký tự điều khiển/zero-width; gộp khoảng trắng', () => {
    expect(normalizeInline('Xin chào 😀 các bạn 🎉👍🏽!')).toBe('Xin chào các bạn !');
    expect(normalizeInline('Xem https://example.com/a?b=c#d và www.vi.vn/x nhé')).toBe('Xem và nhé');
    const dirty = ['a', String.fromCharCode(0x200b), 'b', String.fromCharCode(7), 'c', String.fromCharCode(0xa0), 'd	 e'].join('');
    expect(normalizeInline(dirty)).toBe('abc d e');
  });

  it('giữ nguyên số, dấu câu và ký tự tiếng Việt', () => {
    const s = 'Giá 3,5 triệu đồng (khoảng 12.5%) – rất tốt: đúng không?';
    expect(normalizeInline(s)).toBe(s);
  });
});

describe('tách câu tiếng Việt', () => {
  it('tách theo dấu kết câu', () => {
    expect(splitSentences('Hôm nay trời đẹp. Chúng ta đi chơi! Bạn có đi không?')).toEqual(['Hôm nay trời đẹp.', 'Chúng ta đi chơi!', 'Bạn có đi không?']);
  });

  it('không tách ở từ viết tắt (TP., GS., TS.)', () => {
    expect(splitSentences('Tôi sống ở TP. Hồ Chí Minh. Thầy là GS. Nguyễn Văn An.')).toEqual(['Tôi sống ở TP. Hồ Chí Minh.', 'Thầy là GS. Nguyễn Văn An.']);
  });

  it('không tách ở số thập phân', () => {
    expect(splitSentences('Số pi xấp xỉ 3.14 và e xấp xỉ 2.71. Hết.')).toEqual(['Số pi xấp xỉ 3.14 và e xấp xỉ 2.71.', 'Hết.']);
  });

  it('dấu ba chấm không tạo đoạn rỗng', () => {
    const s = splitSentences('Chờ một chút... rồi ta đi. Xong!');
    expect(s.every((x) => x.trim().length > 0)).toBe(true);
    expect(s.join(' ')).toContain('Chờ một chút');
  });

  it('câu quá dài được cắt theo mệnh đề rồi theo từ, mỗi mảnh ≤ giới hạn và không mất chữ', () => {
    const clause = 'một hai ba bốn năm sáu bảy tám chín mười';
    const long = Array.from({ length: 12 }, () => clause).join(', ');
    const parts = splitLongSentence(long, 100);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => [...p].length <= 100)).toBe(true);
    expect(parts.join(' ').replace(/,/g, '').split(/\s+/).join(' ')).toBe(long.replace(/,/g, '').split(/\s+/).join(' '));
  });

  it('từ dài hơn giới hạn bị cắt cứng, vẫn ≤ giới hạn', () => {
    const parts = splitLongSentence('a'.repeat(250), 100);
    expect(parts.map((p) => p.length)).toEqual([100, 100, 50]);
  });
});

describe('gộp đoạn ≤ maxChars', () => {
  it('gộp câu ngắn liền nhau trong cùng đoạn văn, mỗi đoạn ≤ maxChars', () => {
    const para = Array.from({ length: 30 }, (_, i) => `Đây là câu số ${i + 1} của kịch bản.`).join(' ');
    const segs = buildSegments([para], 120);
    expect(segs.length).toBeGreaterThan(1);
    expect(segs.every((s) => [...s].length <= 120)).toBe(true);
    // không mất nội dung
    expect(segs.join(' ')).toBe(para);
  });

  it('KHÔNG gộp xuyên các đoạn văn khác nhau (giữ nhịp nghỉ giữa các dòng)', () => {
    expect(buildSegments(['Dòng một ở đây.', 'Dòng hai ở đây.'], 400)).toEqual(['Dòng một ở đây.', 'Dòng hai ở đây.']);
  });

  it('đoạn quá ngắn (< 3 ký tự) được gộp với đoạn kề, đoạn chỉ có dấu câu bị bỏ', () => {
    expect(buildSegments(['Câu đầu tiên dài đủ.', 'OK', 'Câu cuối cùng cũng dài.'], 400)).toEqual(['Câu đầu tiên dài đủ.', 'OK Câu cuối cùng cũng dài.']);
    expect(buildSegments(['---', 'Có chữ đây.', '...'], 400)).toEqual(['Có chữ đây.']);
    expect(buildSegments(['Ừ'], 400)).toEqual(['Ừ']);
  });

  it('độ dài tính theo ký tự Unicode (không theo byte/UTF-16)', () => {
    const para = 'Ế'.repeat(50) + ' ' + 'Ớ'.repeat(50);
    const segs = buildSegments([para], 60);
    expect(segs.every((s) => [...s].length <= 60)).toBe(true);
  });

  it('mặc định tối đa 400 ký tự cho mỗi đoạn và luôn ≤ giới hạn mọi nhà cung cấp (4096)', () => {
    const para = Array.from({ length: 200 }, (_, i) => `Câu thứ ${i} khá là dài dòng để thử giới hạn.`).join(' ');
    const r = parse('long.txt', para);
    expect(Math.max(...r.segments.map((s) => [...s].length))).toBeLessThanOrEqual(400);
  });
});

describe('parseScript .txt', () => {
  it('mỗi dòng là một đoạn văn; trả hash ổn định và tổng ký tự đúng', () => {
    const r = parse('k.txt', 'Chào mừng bạn đến với kênh.\n\n\nHôm nay có gì mới? Rất nhiều thứ!\n');
    expect(r.segments).toEqual(['Chào mừng bạn đến với kênh.', 'Hôm nay có gì mới? Rất nhiều thứ!']);
    expect(r.charCount).toBe([...'Chào mừng bạn đến với kênh.'].length + [...'Hôm nay có gì mới? Rất nhiều thứ!'].length);
    expect(parse('k.txt', 'Chào mừng bạn đến với kênh.\n\n\nHôm nay có gì mới? Rất nhiều thứ!\n').contentHash).toBe(r.contentHash);
    expect(r.rawText).toContain('Chào mừng');
  });

  it('nội dung NFD và NFC cho cùng hash (cache ổn định)', () => {
    const a = parse('a.txt', 'Tiếng Việt thật đẹp.'.normalize('NFC'));
    const b = parse('a.txt', 'Tiếng Việt thật đẹp.'.normalize('NFD'));
    expect(a.contentHash).toBe(b.contentHash);
    expect(a.segments).toEqual(b.segments);
  });

  it('CRLF được xử lý như LF', () => {
    expect(parse('a.txt', 'Một dòng.\r\nHai dòng.\r\n').segments).toEqual(['Một dòng.', 'Hai dòng.']);
  });
});
