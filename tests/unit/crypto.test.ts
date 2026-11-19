import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, secretHint } from '@/lib/security/crypto';

const key = randomBytes(32);

describe('crypto (AES-256-GCM)', () => {
  it('mã hóa rồi giải mã trả đúng chuỗi gốc (kể cả Unicode)', () => {
    const secret = 'sk-test-1234567890-Điều-bí-mật';
    expect(decryptSecret(encryptSecret(secret, key), key)).toBe(secret);
  });

  it('bản mã không chứa chuỗi gốc', () => {
    const blob = encryptSecret('sk-very-secret-value', key);
    expect(blob.toString('utf8')).not.toContain('very-secret');
  });

  it('mỗi lần mã hóa dùng nonce khác nhau', () => {
    const a = encryptSecret('cùng một khóa', key);
    const b = encryptSecret('cùng một khóa', key);
    expect(a.equals(b)).toBe(false);
  });

  it('sai khóa chủ bị từ chối', () => {
    const blob = encryptSecret('abc-secret-key-xyz', key);
    expect(() => decryptSecret(blob, randomBytes(32))).toThrow();
  });

  it('dữ liệu bị sửa đổi bị từ chối (xác thực GCM)', () => {
    const blob = Buffer.from(encryptSecret('abc-secret-key-xyz', key));
    blob[blob.length - 1] = blob[blob.length - 1]! ^ 0xff;
    expect(() => decryptSecret(blob, key)).toThrow();
  });

  it('dữ liệu quá ngắn hoặc sai phiên bản bị từ chối', () => {
    expect(() => decryptSecret(Buffer.from([1, 2, 3]), key)).toThrow(/không hợp lệ/);
    const blob = Buffer.from(encryptSecret('x-secret-value-123', key));
    blob[0] = 9;
    expect(() => decryptSecret(blob, key)).toThrow(/không hợp lệ/);
  });

  it('secretHint chỉ lộ vài ký tự cuối, khóa ngắn che hoàn toàn', () => {
    expect(secretHint('sk-abcdefghijklmn1234')).toBe('…1234');
    expect(secretHint('short')).toBe('••••');
  });
});
