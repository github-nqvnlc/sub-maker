import { describe, expect, it } from 'vitest';
import { fmtBytes, fmtDuration } from '@/lib/format';

describe('định dạng dung lượng và thời lượng', () => {
  it.each([
    [0, '0 B'],
    [1023, '1023 B'],
    [1024, '1.0 KB'],
    [1024 * 1024 - 1, '1024.0 KB'],
    [1024 * 1024, '1.0 MB'],
    [500 * 1024 * 1024, '500.0 MB'],
    [1024 ** 3 - 1, '1024.0 MB'],
    // video lớn hiển thị theo GB (spec 006; 1 GB = 1.024 MB)
    [1024 ** 3, '1.0 GB'],
    [30 * 1024 ** 3, '30.0 GB'],
    [10.25 * 1024 ** 3, '10.3 GB'],
  ])('%d → %s', (bytes, text) => {
    expect(fmtBytes(bytes)).toBe(text);
  });

  it('thời lượng', () => {
    expect(fmtDuration(65_000)).toBe('1:05');
    expect(fmtDuration(3_661_000)).toBe('1:01:01');
  });
});
