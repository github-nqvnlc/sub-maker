import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '../env';

/**
 * Mã hóa khóa API nhà cung cấp bằng AES-256-GCM (Nguyên tắc II).
 * Định dạng lưu: [version(1)][iv(12)][authTag(16)][ciphertext].
 */
const VERSION = 1;
const IV_LEN = 12;
const TAG_LEN = 16;

function masterKey(): Buffer {
  const key = Buffer.from(env().APP_ENCRYPTION_KEY, 'base64');
  if (key.length !== 32) throw new Error('APP_ENCRYPTION_KEY phải là 32 byte mã hóa base64');
  return key;
}

export function encryptSecret(plain: string, key: Buffer = masterKey()): Buffer {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([VERSION]), iv, tag, enc]);
}

export function decryptSecret(blob: Buffer, key: Buffer = masterKey()): string {
  if (blob.length < 1 + IV_LEN + TAG_LEN || blob[0] !== VERSION) {
    throw new Error('Dữ liệu mã hóa không hợp lệ');
  }
  const iv = blob.subarray(1, 1 + IV_LEN);
  const tag = blob.subarray(1 + IV_LEN, 1 + IV_LEN + TAG_LEN);
  const data = blob.subarray(1 + IV_LEN + TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  // Sai khóa hoặc dữ liệu bị sửa → final() ném lỗi xác thực
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

/** Gợi ý hiển thị: chỉ vài ký tự cuối (khóa ngắn thì che hoàn toàn). */
export function secretHint(secret: string): string {
  const s = secret.trim();
  if (s.length < 10) return '••••';
  return `…${s.slice(-4)}`;
}
