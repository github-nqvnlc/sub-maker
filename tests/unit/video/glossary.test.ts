import { describe, expect, it } from 'vitest';
import { GLOSSARY_TERM_MAX, glossaryChars, parseGlossaryLines, validateGlossary, type GlossaryLimits } from '@/lib/video/glossary';
import type { GlossaryPair } from '@/lib/video/types';

/** Từ điển thuật ngữ (spec 006, T103; FR-019, FR-020; contracts/subtitle-pipeline.md §5). Giới hạn luôn truyền vào, lấy từ cài đặt. */

const LIMITS: GlossaryLimits = { maxPairs: 200, maxChars: 8000 };
const pair = (source: string, target: string, keep = false): GlossaryPair => ({ source, target, keep });

describe('dán hàng loạt', () => {
  it('`->` ưu tiên hơn dấu phẩy; tách tại dấu đầu tiên; khoảng trắng hai đầu bị bỏ', () => {
    const r = parseGlossaryLines('a, b -> c\n x -> y, z \nhello,xin chào\nm,n,o\np -> q -> r', [], LIMITS);
    expect(r.errors).toEqual([]);
    expect(r.added).toEqual([pair('a, b', 'c'), pair('x', 'y, z'), pair('hello', 'xin chào'), pair('m', 'n,o'), pair('p', 'q -> r')]);
  });

  it('hai vế giống nhau là giữ nguyên không dịch; chữ được chuẩn hóa NFC; dòng trống bỏ qua', () => {
    const r = parseGlossaryLines('Soniox -> Soniox\r\n\r\ncafé -> café\n', [], LIMITS);
    expect(r.errors).toEqual([]);
    expect(r.added).toEqual([pair('Soniox', 'Soniox', true), pair('café', 'café', true)]);
  });

  it('lỗi theo từng dòng (đếm cả dòng trống); dòng hợp lệ vẫn được thêm', () => {
    const long = 'x'.repeat(GLOSSARY_TERM_MAX + 1);
    const r = parseGlossaryLines(['ok -> tốt', '', 'thiếu vế', '-> trống', 'trống ->', `${long} -> a`, `a -> ${long}`, 'fine,ổn'].join('\n'), [], LIMITS);
    expect(r.added).toEqual([pair('ok', 'tốt'), pair('fine', 'ổn')]);
    expect(r.errors).toEqual([
      { line: 3, reason: 'missing' },
      { line: 4, reason: 'missing' },
      { line: 5, reason: 'missing' },
      { line: 6, reason: 'too_long' },
      { line: 7, reason: 'too_long' },
    ]);
  });

  it('đúng 100 ký tự thì nhận', () => {
    const edge = 'ạ'.repeat(GLOSSARY_TERM_MAX);
    expect(parseGlossaryLines(`${edge} -> ${edge}`, [], LIMITS).errors).toEqual([]);
  });

  it('trùng từ gốc (không phân biệt hoa thường, kể cả dạng tổ hợp) với từ điển đang có hoặc với dòng trước', () => {
    const r = parseGlossaryLines('SONIOX -> khác\nTea -> trà\ntea -> chè\nCafé -> quán', [pair('Soniox', 'Soniox', true), pair('café', 'cà phê')], LIMITS);
    expect(r.added).toEqual([pair('Tea', 'trà')]);
    expect(r.errors).toEqual([
      { line: 1, reason: 'duplicate' },
      { line: 3, reason: 'duplicate' },
      { line: 4, reason: 'duplicate' },
    ]);
  });

  it('giới hạn số cặp và tổng ký tự lấy từ tham số', () => {
    const three = 'a -> 1\nb -> 2\nc -> 3';
    expect(parseGlossaryLines(three, [], { maxPairs: 2, maxChars: 100 })).toMatchObject({ added: [pair('a', '1'), pair('b', '2')], errors: [{ line: 3, reason: 'limit' }] });
    expect(parseGlossaryLines(three, [], { maxPairs: 3, maxChars: 100 }).errors).toEqual([]);
    // đã có một cặp 2 ký tự: còn chỗ cho đúng một cặp 2 ký tự
    expect(parseGlossaryLines(three, [pair('z', '9')], { maxPairs: 10, maxChars: 4 })).toMatchObject({ added: [pair('a', '1')], errors: [{ line: 2, reason: 'limit' }, { line: 3, reason: 'limit' }] });
  });

  it('đếm ký tự là tổng hai vế theo điểm mã', () => {
    expect(glossaryChars([pair('ab', 'cd'), pair('😀', 'ê')])).toBe(6);
  });
});

describe('kiểm từ điển ở máy chủ', () => {
  it('chuẩn hóa: cắt khoảng trắng, NFC, "giữ nguyên" đặt bản dịch bằng từ gốc', () => {
    const r = validateGlossary([{ source: '  OpenAI ', target: '', keep: true }, { source: 'tea', target: ' trà ', keep: false }, { source: 'Go', target: 'Go', keep: false }], LIMITS);
    expect(r).toEqual({ ok: true, pairs: [pair('OpenAI', 'OpenAI', true), pair('tea', 'trà'), pair('Go', 'Go', true)] });
  });

  it('thiếu vế, quá dài, trùng: nêu thứ tự cặp (từ 1)', () => {
    const r = validateGlossary([pair('a', 'b'), pair(' ', 'c'), pair('d', ''), pair('A', 'e'), pair('x'.repeat(101), 'y'), pair('xuống\ndòng', 'z')], LIMITS);
    expect(r).toEqual({
      ok: false,
      code: 'GLOSSARY_INVALID',
      errors: [
        { line: 2, reason: 'missing' },
        { line: 3, reason: 'missing' },
        { line: 4, reason: 'duplicate' },
        { line: 5, reason: 'too_long' },
        { line: 6, reason: 'missing' },
      ],
    });
  });

  it('vượt số cặp hoặc tổng ký tự theo giới hạn truyền vào', () => {
    const two = [pair('aa', 'bb'), pair('cc', 'dd')];
    expect(validateGlossary(two, { maxPairs: 1, maxChars: 100 })).toEqual({ ok: false, code: 'GLOSSARY_TOO_LARGE', errors: [] });
    expect(validateGlossary(two, { maxPairs: 2, maxChars: 7 })).toEqual({ ok: false, code: 'GLOSSARY_TOO_LARGE', errors: [] });
    expect(validateGlossary(two, { maxPairs: 2, maxChars: 8 }).ok).toBe(true);
  });
});
