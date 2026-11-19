import { describe, expect, it } from 'vitest';
import { parseRange } from '@/lib/storage/proxy';
import { assertKeyOwnedBy, storageKeys } from '@/lib/storage/keys';

describe('parseRange', () => {
  it('không có header hoặc không hiểu → null (trả toàn bộ)', () => {
    expect(parseRange(undefined, 1000)).toBeNull();
    expect(parseRange('', 1000)).toBeNull();
    expect(parseRange('items=0-1', 1000)).toBeNull();
    expect(parseRange('bytes=-', 1000)).toBeNull();
  });

  it('bytes=start-end', () => {
    expect(parseRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=500-999', 1000)).toEqual({ start: 500, end: 999 });
  });

  it('bytes=start- (đến hết) và end vượt quá kích thước bị cắt', () => {
    expect(parseRange('bytes=900-', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange('bytes=900-5000', 1000)).toEqual({ start: 900, end: 999 });
  });

  it('suffix: n byte cuối', () => {
    expect(parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange('bytes=-5000', 1000)).toEqual({ start: 0, end: 999 });
    expect(parseRange('bytes=-0', 1000)).toBe('unsatisfiable');
  });

  it('không thỏa mãn → unsatisfiable (416)', () => {
    expect(parseRange('bytes=1000-1100', 1000)).toBe('unsatisfiable');
    expect(parseRange('bytes=500-100', 1000)).toBe('unsatisfiable');
  });
});

describe('storageKeys', () => {
  it('mọi khóa nằm dưới users/{id}/', () => {
    const uid = '11111111-1111-1111-1111-111111111111';
    for (const k of [
      storageKeys.subtitleOriginal(uid, 'f1'),
      storageKeys.audioCache(uid, 'abc'),
      storageKeys.voice(uid, 'v1'),
      storageKeys.avatar(uid),
    ]) {
      expect(k.startsWith(storageKeys.userPrefix(uid))).toBe(true);
      expect(() => assertKeyOwnedBy(k, uid)).not.toThrow();
    }
  });

  it('từ chối khóa của người khác hoặc có ..', () => {
    const a = '11111111-1111-1111-1111-111111111111';
    const b = '22222222-2222-2222-2222-222222222222';
    expect(() => assertKeyOwnedBy(storageKeys.avatar(b), a)).toThrow();
    expect(() => assertKeyOwnedBy(`users/${a}/../${b}/avatar`, a)).toThrow();
  });
});
