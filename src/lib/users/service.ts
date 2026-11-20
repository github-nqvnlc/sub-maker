import { eq } from 'drizzle-orm';
import { getDb } from '../db';
import { users } from '../db/schema';
import type { AuthUser } from '../auth/guards';
import { HttpError } from '../api/errors';
import { getSettings } from '../settings';
import { deleteObject, headObject, putObject } from '../storage/client';
import { storageKeys } from '../storage/keys';
import { releaseBytes, reserveBytes } from '../storage/quota';

export type MeDto = {
  id: string;
  email: string;
  displayName: string;
  bio: string | null;
  hasAvatar: boolean;
  role: 'admin' | 'user';
  canUseCustomAi: boolean;
  storageUsedBytes: number;
  storageQuotaBytes: number;
  locale: 'vi' | 'en';
  theme: 'light' | 'dark' | 'system';
};

export async function toMe(user: AuthUser): Promise<MeDto> {
  const { userQuotaBytes } = await getSettings();
  return {
    id: user.id,
    email: user.email,
    displayName: user.name,
    bio: user.bio,
    hasAvatar: !!user.avatarKey,
    role: user.role,
    canUseCustomAi: user.canUseCustomAi,
    storageUsedBytes: user.storageUsedBytes,
    storageQuotaBytes: userQuotaBytes,
    locale: user.locale,
    theme: user.theme,
  };
}

export async function updateProfile(
  userId: string,
  patch: { displayName?: string; bio?: string | null; locale?: 'vi' | 'en'; theme?: 'light' | 'dark' | 'system' },
): Promise<void> {
  const set: Partial<typeof users.$inferInsert> = { updatedAt: new Date() };
  if (patch.displayName !== undefined) set.name = patch.displayName;
  if (patch.bio !== undefined) set.bio = patch.bio === '' ? null : patch.bio;
  if (patch.locale !== undefined) set.locale = patch.locale;
  if (patch.theme !== undefined) set.theme = patch.theme;
  await getDb().update(users).set(set).where(eq(users.id, userId));
}

// ---- Avatar -----------------------------------------------------------------------------------

export const AVATAR_MAX_BYTES = 1024 * 1024;
export type AvatarMime = 'image/png' | 'image/jpeg' | 'image/webp';

/** Nhận diện bằng magic bytes (không tin Content-Type/đuôi tệp do client gửi). */
export function sniffImage(buf: Uint8Array): AvatarMime | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (
    buf.length >= 12 &&
    Buffer.from(buf.subarray(0, 4)).toString('ascii') === 'RIFF' &&
    Buffer.from(buf.subarray(8, 12)).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

export async function setAvatar(user: AuthUser, bytes: Uint8Array): Promise<void> {
  if (bytes.length === 0) throw new HttpError(422, 'VALIDATION', undefined, { file: 'Tệp ảnh rỗng' });
  if (bytes.length > AVATAR_MAX_BYTES) throw new HttpError(413, 'FILE_TOO_LARGE', undefined, { file: 'Ảnh đại diện tối đa 1 MB' });
  const mime = sniffImage(bytes);
  if (!mime) throw new HttpError(422, 'VALIDATION', undefined, { file: 'Chỉ chấp nhận ảnh PNG, JPEG hoặc WebP' });

  const key = storageKeys.avatar(user.id);
  const old = user.avatarKey ? await headObject(key) : null;
  // Chỉ tính chênh lệch so với ảnh cũ để thay ảnh không bị tính hai lần
  const delta = bytes.length - (old?.size ?? 0);
  if (delta > 0) await reserveBytes(user.id, delta);
  else if (delta < 0) await releaseBytes(user.id, -delta);

  try {
    await putObject(key, Buffer.from(bytes), mime);
  } catch (e) {
    if (delta > 0) await releaseBytes(user.id, delta);
    else if (delta < 0) await reserveBytes(user.id, -delta, { soft: true });
    throw e;
  }
  await getDb().update(users).set({ avatarKey: key, updatedAt: new Date() }).where(eq(users.id, user.id));
}

export async function removeAvatar(user: AuthUser): Promise<void> {
  if (!user.avatarKey) return;
  const old = await headObject(user.avatarKey);
  await deleteObject(user.avatarKey);
  if (old) await releaseBytes(user.id, old.size);
  await getDb().update(users).set({ avatarKey: null, updatedAt: new Date() }).where(eq(users.id, user.id));
}
