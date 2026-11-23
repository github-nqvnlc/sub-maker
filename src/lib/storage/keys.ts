/**
 * Khóa đối tượng MinIO. Mọi đối tượng nằm dưới `users/{userId}/` để xóa User = xóa theo tiền tố (R5, R17).
 * Bucket riêng tư; file chỉ được phát qua proxy có kiểm tra quyền.
 */
export const storageKeys = {
  userPrefix: (userId: string) => `users/${userId}/`,
  subtitleOriginal: (userId: string, fileId: string) => `users/${userId}/subtitles/${fileId}/original`,
  subtitlePrefix: (userId: string, fileId: string) => `users/${userId}/subtitles/${fileId}/`,
  audioCache: (userId: string, hash: string) => `users/${userId}/cache/${hash}.wav`,
  voice: (userId: string, voiceId: string) => `users/${userId}/voices/${voiceId}.mp3`,
  avatar: (userId: string) => `users/${userId}/avatar`,
  /** File media tạm của STT job (spec 004): nằm dưới tiền tố User để xóa User cũng xóa file này */
  sttTemp: (userId: string, jobId: string, ext: string) => `users/${userId}/stt-tmp/${jobId}/source.${ext}`,
} as const;

/** Chặn khóa thoát khỏi vùng của User (phòng thủ chiều sâu). */
export function assertKeyOwnedBy(key: string, userId: string): void {
  if (!key.startsWith(storageKeys.userPrefix(userId)) || key.includes('..')) {
    throw new Error('Khóa đối tượng không thuộc về người dùng');
  }
}
