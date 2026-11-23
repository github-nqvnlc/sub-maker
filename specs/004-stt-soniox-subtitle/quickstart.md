# Quickstart: Kiểm thử Tính năng STT Soniox Tạo Phụ Đề

**Quy ước dữ liệu thử**: Sử dụng tệp âm thanh ngắn $\le 10$ giây (`tests/fixtures/sample-10s.mp3`) để kiểm thử nhanh và tiết kiệm chi phí/thời gian.

---

## 0. Chuẩn bị môi trường

```bash
# 1. Chạy migration tạo bảng stt_jobs
npm run db:migrate

# 2. Kiểm tra type và i18n
npm run typecheck && npx tsx scripts/check-i18n.ts
```

---

## 1. Kiểm thử trích xuất âm thanh từ Video (FFmpeg)

Chạy kịch bản kiểm thử FFmpeg trích xuất âm thanh từ video sang MP3 16kHz mono:

```bash
npx vitest run tests/unit/media-extract.test.ts
```
- **Kỳ vọng**: 
  - Tệp video mẫu (.mp4) 5 giây được tách thành MP3 dung lượng nhỏ (< 100 KB).
  - Tệp video không có tiếng được phát hiện sớm và báo lỗi `NO_AUDIO_STREAM`.

---

## 2. Kiểm thử Thuật toán Subtitle Chunking (Tokens $\rightarrow$ .srt / .txt / .md)

Chạy kịch bản kiểm thử thuật toán gom nhóm tokens:

```bash
npx vitest run tests/unit/stt-chunker.test.ts
```
- **Kỳ vọng**:
  - Các tokens liên tiếp được ngắt đúng theo dấu chấm, phẩy hoặc khoảng lặng ≥ 380 ms; mỗi cue ≤ 75 ký tự.
  - Số thứ tự và mốc thời gian SRT định dạng chuẩn (`00:00:00,000 --> 00:00:03,500`).
  - Định dạng `.txt` ngắt dòng câu tự nhiên.
  - Định dạng `.md` hiển thị đúng tiền tố người nói khi bật `enableDiarization`.

---

## 3. Kiểm thử Tích hợp STT Job với Mock Provider

Chạy kịch bản kiểm thử toàn bộ luồng tiến trình STT nền qua `pg-boss`:

```bash
npx vitest run tests/integration/stt-create-job.test.ts tests/integration/stt-limits.test.ts tests/integration/stt-isolation.test.ts tests/integration/stt-usage.test.ts tests/integration/stt-progress-recovery.test.ts tests/integration/stt-retry-resume.test.ts tests/integration/stt-deletion.test.ts
```
- **Kỳ vọng**:
  - Job được đưa vào hàng đợi `transcribe-media`.
  - Worker bóc tách audio, gọi Mock Soniox Client (mô phỏng upload, polling completed, trả tokens).
  - Kết quả được lưu thành bản ghi trong `subtitle_files` và `subtitle_cues`.
  - File xuất hiện trong Project và có thể gọi `GET /api/files/{id}`.
  - File và bản phiên âm trên Soniox (mock) đã được xóa sau khi job kết thúc.

---

## 4. Kiểm thử Giao diện Người dùng (Manual / E2E)

1. Mở trang chi tiết một Project (`/projects/[projectId]`).
2. Trong khung upload bên phải, bấm nút **"Tạo phụ đề từ Audio/Video"**.
3. Chọn tệp `sample-10s.mp3` hoặc `sample-video-5s.mp4`.
4. Quan sát thanh tiến trình cập nhật từng bước: *Trích xuất âm thanh $\rightarrow$ Gửi Soniox $\rightarrow$ Đang phiên âm $\rightarrow$ Tạo phụ đề $\rightarrow$ Hoàn tất*.
5. Kiểm tra danh sách kịch bản (khung màu đỏ bên trái) tự động xuất hiện tệp phụ đề mới.
6. Bấm nút **"Xem trước"** để kiểm tra nội dung và mốc thời gian của từng cue.

---

## 5. Kiểm tra thủ công hiệu năng và độ chính xác (SC-001, SC-002)

Hai tiêu chí này phụ thuộc Soniox thật nên không đưa vào kiểm thử tự động:

- **SC-002**: Dùng một video 10 phút với token Soniox thật. Ghi lại thời gian bước trích xuất (mục tiêu < 5 giây) và tổng thời gian từ lúc tạo job đến `completed` (mục tiêu < 45 giây).
- **SC-001**: Mở file `.srt` kết quả cùng video trong trình phát, kiểm tra ngẫu nhiên 10 cue: mốc bắt đầu lệch so với lời nói không quá 200 ms.
