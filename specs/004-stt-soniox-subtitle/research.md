# Nghiên cứu kỹ thuật (Phase 0): Chuyển đổi giọng nói từ Audio/Video thành Phụ đề (Soniox STT)

**Ngày**: 2026-11-23 | **Spec**: [spec.md](./spec.md)

Các quyết định dưới đây dựa trên khảo sát tài liệu chính thức của **Soniox Speech-to-Text API** (`https://docs.soniox.com/stt/get-started`), kiến trúc hiện có của `sub-maker` (FFmpeg, pg-boss, Drizzle ORM, MinIO) và các nguyên tắc trong Hiến pháp dự án.

---

## R1. Kiến trúc gọi Soniox STT REST API

- **Khảo sát**: Soniox cung cấp 2 phương thức:
  1. *Real-time WebSocket Streaming*: Dành cho micro thu âm trực tiếp hoặc live stream.
  2. *Async Batch Transcription*: Dành cho tệp audio/video ghi sẵn thông qua REST API (`https://api.soniox.com/v1`).
- **Quyết định**: Sử dụng **Async Batch Transcription REST API** vì người dùng tải lên tệp media hoàn chỉnh, không phải thu âm thời gian thực.
- **Quy trình tương tác**:
  1. `POST /v1/files`: Gửi audio nén dạng `multipart/form-data`, nhận `file_id`.
  2. `POST /v1/transcriptions`: Khởi tạo job phiên âm với payload:
     ```json
     {
       "file_id": "file_uuid",
       "model": "stt-async-v6",
       "enable_language_identification": true,
       "enable_speaker_diarization": true
     }
     ```
  3. `GET /v1/transcriptions/{id}`: Polling trạng thái (`queued` $\rightarrow$ `processing` $\rightarrow$ `completed` | `failed`). Tần suất polling 2 giây/lần với exponential backoff khi tải nặng.
  4. `GET /v1/transcriptions/{id}/transcript`: Khi status `completed`, nhận JSON chứa `text` và mảng `tokens`.
- **Lý do**: Đơn giản, độ ổn định cao, không phụ thuộc kết nối socket kéo dài, dễ tích hợp với Background Worker `pg-boss`.


### R1b. Kiểm chứng tài liệu Soniox (2026-11-23, T014)

Đã đọc trang tham chiếu API chính thức (docs.soniox.com/api-reference/stt/…), rồi **gọi thử bằng token thật ngày 2026-11-23** (biến `SPIKE_SONIOX_KEY` trong `.env`, chạy `SonioxSttClient` của dự án). Kết quả:

- `GET /v1/models`: OK (~1,1 giây); có `stt-async-v6`, `stt-rt-v6`, `stt-async-v5`, `stt-rt-v5` cùng các bản cũ/alias.
- Âm sin 10 giây (`tests/fixtures/sample-10s.mp3`): upload → phiên âm `completed` sau ~2,5 giây, `audio_duration_ms = 10000`, transcript **rỗng** (0 token) → worker sẽ báo `NO_SPEECH_DETECTED` đúng như thiết kế.
- Câu tiếng Anh 6,6 giây (giọng đọc Windows): `completed`, `audio_duration_ms = 6558`, 23 token; bộ gom tạo 4 cue `.srt` hợp lệ khớp lời nói.
- `DELETE` transcription và file: OK; xóa lại transcription đã xóa trả 404 và client coi là thành công.
- Khác tài liệu: các trường tùy chọn của token (`language`, `is_audio_event`, `translation_status`) có thể là **`null`** thay vì vắng mặt (code đã xử lý được); phản hồi transcription có thêm `enable_audio_event_detection`. Chưa gặp trạng thái `error`/`failed` thật.

- Xác thực: header `Authorization: Bearer <SONIOX_API_KEY>` cho MỌI lệnh gọi (kể cả GET/DELETE).
- `POST /v1/files` (multipart, trường `file`) → 201 `{ id, filename, size, created_at }`.
- `POST /v1/transcriptions` nhận `model` (bắt buộc), `file_id`, `language_hints` (mảng; bỏ trống = tự nhận diện), `enable_speaker_diarization`, `enable_language_identification`, `client_reference_id`. Lỗi: 400, 401, **402 (hết số dư/ngân sách → coi là vĩnh viễn)**, 429, 500.
- `GET /v1/transcriptions/{id}`: `status` ∈ `queued | processing | completed | error` (trang Errors lại ghi `failed` → client chấp nhận cả hai); có `audio_duration_ms` (chỉ khi đã bắt đầu xử lý), `error_type`, `error_message`.
- `GET /v1/transcriptions/{id}/transcript` (chỉ khi completed): `{ id, text, tokens[] }`; token gồm `text, start_ms, end_ms, confidence` và tùy chọn `speaker`, `language`, `is_audio_event`, `translation_status`. **Token là mảnh dưới-từ** (ví dụ "Hel", "lo"): bộ gom cue ghép từ theo khoảng trắng đầu token, không nối bằng dấu cách.
- `DELETE /v1/transcriptions/{id}`: không xóa được bản đang `processing`; không xóa file. File phải giữ tới khi transcription `completed`/`error` (xóa sớm làm transcription lỗi `file_not_found`). `DELETE /v1/files/{id}` riêng.
- `GET /v1/models` → `{ models: [{ id, … }] }` (dùng cho "Kiểm tra kết nối").
- Model hiện hành: `stt-async-v6`, `stt-rt-v6` (active); `stt-async-v5`, `stt-rt-v5` (deprecated, gỡ 2026-12-15, sau đó tự chuyển sang v6).
- Định dạng âm thanh nhận: aac, aiff, amr, asf, flac, mp3, ogg, wav, webm, m4a, mp4.

---

## R2. Tối ưu hóa Media & Bóc tách âm thanh qua FFmpeg

- **Vấn đề**: File video người dùng tải lên (.mp4, .mov, .mkv) có kích thước rất lớn (hàng trăm MB đến GB). Gửi cả file video lên Soniox sẽ:
  - Gây nghẽn mạng và tốn nhiều phút upload.
  - Tốn hạn mức lưu trữ tạm của hệ thống và Soniox.
  - Nguy cơ timeout request HTTP.
- **Quyết định**:
  - Tận dụng `runFfmpeg` đã có sẵn tại `src/lib/audio/ffmpeg.ts`.
  - Nếu tệp tải lên là video (hoặc audio nặng): Tự động trích xuất chỉ luồng âm thanh sang định dạng **MP3 Mono 16 kHz** (`-vn -acodec libmp3lame -q:a 4 -ac 1 -ar 16000`).
  - Tốc độ xử lý của FFmpeg: ~1–3 giây cho file video 10 phút.
  - Kích thước giảm hơn **95%** (ví dụ video 200MB giảm còn 5–8MB).
- **Trường hợp video không có tiếng**: FFmpeg trả về luồng rỗng hoặc thông báo không có audio stream $\rightarrow$ Hệ thống phát hiện sớm và báo lỗi người dùng `NO_AUDIO_STREAM_FOUND`.

---

## R3. Thuật toán gom nhóm từ thành Cues phụ đề chuẩn (.srt Chunking Engine)

- **Vấn đề**: Soniox trả về `tokens` ở mức từng từ kèm `start_ms` và `end_ms`. Nếu tạo cue cho mỗi từ, phụ đề sẽ hiển thị rời rạc, nhấp nháy liên tục không đọc kịp.
- **Quyết định**: Xây dựng hàm thuần `chunkTokensToSrt(tokens, options)` trong `src/lib/parsing/stt-chunker.ts`.
- **Quy tắc gom nhóm chuẩn mực**:
  1. **Độ dài ký tự**: Mỗi cue tối đa 75 ký tự (tương đương 1–2 dòng phụ đề trên video).
  2. **Thời lượng hiển thị**: Mỗi cue tối thiểu 1.2 giây (trừ trường hợp từ đệm rất ngắn), tối đa 5.5 giây.
  3. **Ngắt theo dấu câu**: Ngắt ngay khi token trước kết thúc bằng `.`, `!`, `?`, `...`, hoặc ngắt ưu tiên tại `,`, `;`, `:`.
  4. **Ngắt theo khoảng lặng (Silence Gap)**: Nếu `token[i].start_ms - token[i-1].end_ms >= 380 ms` (người nói tạm dừng hoặc lấy hơi) $\rightarrow$ Ngắt sang cue mới.
  5. **Ngắt theo người nói (Speaker)**: Nếu token có `speaker` khác với cue hiện tại $\rightarrow$ Ngắt cue mới để phân định rõ ràng.
- **Tính toán mốc thời gian**:
  - `cue.startMs = currentTokens[0].start_ms`
  - `cue.endMs = currentTokens[last].end_ms`
  - Định dạng thời gian SRT: `HH:MM:SS,mmm --> HH:MM:SS,mmm` (hàm `formatSrtTime` đã có sẵn).

---

## R4. Tích hợp tương thích hệ thống kịch bản Sub Maker

- **Quyết định**: Kết quả của tiến trình STT được tự động lưu trực tiếp bằng hàm `uploadScript` (trong `src/lib/projects/files.ts`) với tên tệp kịch bản được người dùng chỉ định hoặc suy ra từ tệp gốc (vd: `video-demo.srt`).
- **Lợi ích kiến trúc**:
  - Tận dụng 100% cơ chế lưu trữ MinIO (`subtitleOriginal`), lưu bảng `subtitle_files` và `subtitle_cues`.
  - Tự động nhận diện `hasTimecodes = true` cho file `.srt`.
  - Kịch bản xuất hiện ngay trên **Khung màu đỏ (Danh sách kịch bản)** mà không cần sửa đổi bảng phụ trợ nào.
  - Người dùng có thể bấm ngay **Tạo voice** để chuyển sang chế độ Voice khớp mốc phụ đề (Spec 003).

---

## R5. Tiến trình nền bền vững qua pg-boss (`stt_jobs`)

- **Theo Hiến pháp dự án (Nguyên tắc III)**: Tiến trình STT phải chạy ngầm, bền bỉ, chịu được tải lại trang.
- **Quyết định**:
  - Tạo hàng đợi pg-boss mới: `QUEUES.transcribeMedia = 'transcribe-media'`.
  - Bảng CSDL: `stt_jobs` lưu trạng thái, phần trăm tiến độ, thông tin file và lỗi nếu có.
  - Quá trình chạy gồm các bước rõ ràng:
    `queued` $\rightarrow$ `extracting` $\rightarrow$ `uploading` $\rightarrow$ `transcribing` $\rightarrow$ `formatting` $\rightarrow$ `completed`.
  - Client polling định kỳ qua `GET /api/stt/{jobId}` hoặc hook `useQuery` với refetch interval khi job còn active.

---

## R6. Quản lý Khóa API Soniox & Hạn mức Quota

- **Theo Hiến pháp dự án (Nguyên tắc II & IV)**:
  - Khóa API Soniox được quản lý trong bảng cấu hình AI (`ai_provider_configs` hoặc thêm loại nhà cung cấp STT).
  - Khóa được mã hóa bằng AES-256-GCM.
  - Hạn mức lưu trữ: Tệp media tạm **không** tính vào hạn mức của User (không gọi `reserveBytes`); nó chỉ bị chặn bởi giới hạn 500 MB video / 100 MB audio / 60 phút. Tệp media tạm trên MinIO và trên đĩa bị xóa khi job kết thúc (hoàn tất hoặc lỗi). Chỉ file kịch bản kết quả (qua `uploadScript`) mới tính vào hạn mức.
