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
  /** Video overlay thành phẩm (spec 005), tính vào hạn mức; khóa cố định theo id tiến trình */
  overlayVideo: (userId: string, jobId: string, ext: string) => `users/${userId}/overlay/video/${jobId}.${ext}`,
  /** Âm thanh tải lên cho overlay sau khi chuẩn hóa MP3, tính vào hạn mức */
  overlayAudio: (userId: string, audioId: string) => `users/${userId}/overlay/audio/${audioId}.mp3`,
  /** Tệp âm thanh gốc chờ chuẩn hóa: KHÔNG tính vào hạn mức */
  overlayAudioTemp: (userId: string, audioId: string, ext: string) => `users/${userId}/overlay-tmp/${audioId}/source.${ext}`,
  overlayTempPrefix: (userId: string) => `users/${userId}/overlay-tmp/`,
  /** Dịch video (spec 006, data-model §5). Dưới `video/`: tính vào hạn mức video. */
  videoPrefix: (userId: string) => `users/${userId}/video/`,
  videoJobPrefix: (userId: string, jobId: string) => `users/${userId}/video/${jobId}/`,
  videoSource: (userId: string, jobId: string, ext: string) => `users/${userId}/video/${jobId}/source.${ext}`,
  videoExport: (userId: string, jobId: string, exportId: string, ext: string) => `users/${userId}/video/${jobId}/exports/${exportId}.${ext}`,
  /** Dưới `video-tmp/`: tệp hệ thống dẫn xuất, không tính hạn mức người dùng (chỉ trần hệ thống). */
  videoTempPrefix: (userId: string) => `users/${userId}/video-tmp/`,
  videoJobTempPrefix: (userId: string, jobId: string) => `users/${userId}/video-tmp/${jobId}/`,
  /** MP3 16 kHz tách từ video, dùng để gửi dịch và để nghe khi chưa phát được hình */
  videoAudio: (userId: string, jobId: string) => `users/${userId}/video-tmp/${jobId}/audio.mp3`,
  /** âm thanh do trình duyệt gửi (luồng nhanh), xóa sau khi chuyển MP3 */
  videoClientAudio: (userId: string, jobId: string, ext: string) => `users/${userId}/video-tmp/${jobId}/audio-client.${ext}`,
  videoPreview: (userId: string, jobId: string) => `users/${userId}/video-tmp/${jobId}/preview.mp4`,
  /** token thô của nhà cung cấp theo lượt dịch */
  videoTranscript: (userId: string, jobId: string, run: number) => `users/${userId}/video-tmp/${jobId}/transcript-${run}.json`,
} as const;

/** Chặn khóa thoát khỏi vùng của User (phòng thủ chiều sâu). */
export function assertKeyOwnedBy(key: string, userId: string): void {
  if (!key.startsWith(storageKeys.userPrefix(userId)) || key.includes('..')) {
    throw new Error('Khóa đối tượng không thuộc về người dùng');
  }
}
