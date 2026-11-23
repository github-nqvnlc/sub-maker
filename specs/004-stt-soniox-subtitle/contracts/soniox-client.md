# Hợp đồng giao tiếp: Soniox STT Client (Mockable Interface)

Tài liệu này định nghĩa interface và hợp đồng dữ liệu cho `SonioxSttClient`. Điều này cho phép chạy kiểm thử tự động (unit, integration) bằng **Mock Client** mà không cần gọi đến Soniox API thật (tuân thủ Nguyên tắc V trong Hiến pháp dự án).

---

## 1. Types & Data Structures

```typescript
export interface SonioxToken {
  text: string;
  start_ms: number;
  end_ms: number;
  confidence: number;
  speaker?: string;
}

export interface SonioxTranscriptResponse {
  id: string;
  text: string;
  tokens: SonioxToken[];
}

export type SonioxJobStatus = 'queued' | 'processing' | 'completed' | 'failed';

export interface SonioxJobStatusResponse {
  id: string;
  status: SonioxJobStatus;
  progress_percent?: number;
  error_message?: string;
}

export interface StartTranscriptionOptions {
  model?: string;                    // Mặc định: 'stt-async-v6'
  enableLanguageIdentification?: boolean; // Mặc định: true
  enableSpeakerDiarization?: boolean;     // Mặc định: false
  language?: string;                      // 'auto' hoặc mã ngôn ngữ cụ thể
}

export interface ISonioxClient {
  /** Upload buffer audio (đã trích xuất MP3/WAV) lên Soniox, trả về file_id */
  uploadAudioFile(buffer: Buffer, fileName: string): Promise<{ fileId: string }>;

  /** Khởi tạo tiến trình phiên âm bất đồng bộ */
  startTranscription(fileId: string, options?: StartTranscriptionOptions): Promise<{ transcriptionId: string }>;

  /** Kiểm tra trạng thái hiện tại của job */
  getTranscriptionStatus(transcriptionId: string): Promise<SonioxJobStatusResponse>;

  /** Lấy kết quả transcript và mảng tokens khi status = 'completed' */
  getTranscript(transcriptionId: string): Promise<SonioxTranscriptResponse>;

  /** Xóa bản phiên âm trên Soniox (DELETE /v1/transcriptions/{id}); 404 coi như đã xóa */
  deleteTranscription(transcriptionId: string): Promise<void>;

  /** Xóa file audio đã upload trên Soniox (DELETE /v1/files/{id}); 404 coi như đã xóa */
  deleteFile(fileId: string): Promise<void>;

  /** Kiểm tra API Key (dùng cho nút "Kiểm tra kết nối") */
  testConnection(): Promise<{ ok: boolean; latencyMs: number; models?: string[]; message?: string }>;
}
```

> Hai endpoint xóa chưa được kiểm chứng: thử thật cùng bước kiểm chứng của T014 trước khi dựa vào.

### Dọn dữ liệu trên Soniox (FR-021)

- Job `completed` hoặc `failed`: sau khi đã lấy transcript (hoặc khi dừng vì lỗi), gọi `deleteTranscription` rồi `deleteFile` với các id đã lưu trong `stt_jobs`.
- Xóa Project hoặc User khi job còn id trên Soniox: lấy `soniox_file_id`, `soniox_transcription_id` trước khi xóa trong DB rồi gọi hai hàm trên.
- Lỗi khi xóa trên Soniox không làm job thất bại: ghi một dòng `warn` vào `stt_job_logs` (nếu job còn) và log máy chủ không chứa khóa, rồi bỏ qua.

---

## 2. Xử lý lỗi & Phân loại mã lỗi

| Mã lỗi Soniox / Trạng thái | Phân loại | Hành vi hệ thống |
| :--- | :--- | :--- |
| **401 Unauthorized** | Lỗi vĩnh viễn (Permanent) | Báo lỗi cấu hình API Key, không retry. |
| **429 Rate Limit Exceeded** | Lỗi tạm thời (Transient) | Tự động thử lại với Exponential Backoff. |
| **5xx Server Error** | Lỗi tạm thời (Transient) | Tự động thử lại tối đa 3 lần. |
| **Audio Corrupted / Unreadable** | Lỗi vĩnh viễn (Permanent) | Đánh dấu job `failed`, thông báo tệp âm thanh hỏng. |
| **No Speech Detected** (transcript rỗng) | Lỗi vĩnh viễn | Đánh dấu job `failed` với mã `NO_SPEECH_DETECTED`, thông báo "Không phát hiện giọng nói rõ ràng trong tệp media"; không tạo file phụ đề. |
| **Model real-time (`stt-rt-*`)** | Lỗi cấu hình (vĩnh viễn) | Không gọi Soniox; báo Admin chọn model async. |

---

## 3. Mock Soniox Client cho Kiểm thử Tự động

Mock client được cài đặt trong `tests/mocks/soniox-mock.ts`:
- Giả lập tải lên file và trả về `fake_file_id`.
- Ghi lại các lần gọi `deleteTranscription`/`deleteFile` để test kiểm tra dữ liệu trên Soniox đã được dọn.
- Cấu hình được để trả lỗi 429, 401 hoặc transcript rỗng.
- Giả lập polling trạng thái: lần 1 `queued`, lần 2 `processing`, lần 3 `completed`.
- Trả về danh sách `tokens` mẫu tiếng Việt (kèm mốc thời gian chuẩn xác $\le 10$ giây theo quy ước kiểm thử).
