# Việc cần người dùng / môi trường triển khai thực hiện (Spec 006 — Dịch Video)

Các mục dưới đây không thể chạy hoàn toàn tự động trên máy dev hiện tại (thiếu tệp mẫu thật, trình duyệt macOS/iOS, phần mềm dựng phim thương mại, hoặc liên quan đến tài khoản bên ngoài / môi trường production) và cần được xác nhận thủ công theo [quickstart.md](./quickstart.md) §8.

## 1. Gọi thử Soniox thật một lần (T041, có phí ước tính < 0,02 USD)

- **Lý do chưa chạy**: chưa có tệp video mẫu ~3 phút (tiếng Anh hoặc tiếng Nhật). Khóa `SPIKE_SONIOX_KEY` đã có sẵn trong `.env` (không in ra màn hình).
- **Việc cần làm**:
  1. Cung cấp đường dẫn một tệp video ngắn (~3 phút, có lời nói tiếng Anh hoặc Nhật, ưu tiên có đoạn nói nhanh và từ chuyên ngành).
  2. Chạy một lần kiểm chứng Soniox `stt-async-v6` với cấu hình dịch một chiều + từ điển.
  3. Đối chiếu trên kết quả JSON thô của Soniox: thứ tự cụm token gốc/dịch, hành vi `translation_status: none` ở chế độ một chiều khi câu đã thuộc ngôn ngữ đích, giới hạn từ điển thực tế (mặc định 200 cặp / 8.000 ký tự), và cập nhật kết quả vào [research.md](./research.md) §R5.

## 2. Kiểm tra tách âm thanh trên trình duyệt Firefox và Safari (T129, US9)

- **Đã kiểm tự động**: Chromium (Playwright) và Microsoft Edge (`msedge.exe`) trên Windows đã đạt cả 5 định dạng nhanh (`.mp4`, `.m4v`, `.mov`, `.mkv` Opus/AAC, `.webm`), fallback máy chủ cho `.avi`/`.flv`, và giữ/dời đúng mốc bắt đầu lệch `-itsoffset 1,5s` (chi tiết trong [research.md](./research.md) §R8).
- **Cần kiểm tay**:
  1. Mở một Project có quyền Dịch Video trên **Firefox** (Windows/macOS) và **Safari** (macOS/iOS).
  2. Tải thử các tệp `.mp4`, `.m4v`, `.mov`, `.mkv`, `.webm` và tệp có offset luồng tiếng khác 0.
  3. Ghi kết quả vào bảng trong [research.md](./research.md) §R8; nếu định dạng nào không đạt hoặc sai mốc trên Firefox/Safari thì bổ sung vào nhánh loại trừ để tự chuyển về luồng máy chủ trong `src/lib/video/extract-audio-core.ts`.

## 3. Kiểm thử tải 10 GB và điều khoản Cloudflare trên đường hầm thật (SC-001, SC-014)

- **Điều khoản Cloudflare**: đọc và xác nhận điều khoản sử dụng (ToS) của gói Cloudflare / Cloudflare Tunnel đang dùng đối với truyền tải tệp video dung lượng lớn (tối đa 10 GB/tệp) qua proxy HTTP.
- **Thử tải 10 GB thật**: trên môi trường chạy sau Cloudflare Tunnel thật:
  1. Tải lên một video 8–10 GB; kiểm tra chia phần 16 MB không vướng giới hạn 100 MB của proxy, giữ ổn định bộ nhớ máy chủ (giới hạn 8 phần đồng thời = 128 MB, quá trả `429 Retry-After`).
  2. Tạm dừng / ngắt mạng giữa chừng rồi nối lại; đóng trình duyệt và chọn lại đúng tệp để kiểm tra tiếp tục không tải lại phần đã xong.
  3. Đo thời gian tải và tốc độ thực tế để xác nhận `SC-001` trên băng thông người dùng.

## 4. Kiểm chứng chất lượng phụ đề, âm thanh, hình ảnh và trình biên tập 20.000 cue (SC-002..SC-005, FR-038)

- **Chất lượng dịch và căn mốc (`SC-002..SC-004`)**: thử trên video thật dài 30–180 phút (thời lượng đo được với `probeVideo`, kiểm tra tỉ lệ cue bám ranh giới cụm thật `≥ 80%`, thử cả trường hợp VFR, video có cờ xoay, HDR, nhiều luồng tiếng).
- **Chất lượng phát và tệp tải về (`FR-038`)**: đã kiểm khách quan trong ảnh worker (`SSIM All = 0,999432`, `PSNR trung bình = 53,90 dB` ở vùng không có chữ trên video mẫu, chi tiết ở [research.md](./research.md) §R16); cần mở video quay thật đã xuất `.mp4` và tệp phụ đề `.srt`/`.vtt` bằng trình phát độc lập (VLC, MPV, QuickTime, điện thoại) để soi cạnh nhau ở 20 thời điểm, nghe tiếng đồng bộ, so màu SDR sau tonemap HDR và độ nét chữ.
- **Kịch bản cực đại 20.000 cue**: mở trình biên tập trên video 180 phút (~20.000 cue) trên trình duyệt đích để xác nhận cuộn ảo hóa (`@tanstack/react-virtual`) và gõ/sửa/tìm-thay không giật.

## 5. Kiểm tra lớp phụ đề riêng trong phần mềm dựng phim thương mại (US10, T134)

- Đã kiểm tự động `.mp4` phông xanh `#00FF00` (H.264, `yuv420p`) và `.mov` nền trong suốt (ProRes 4444, `yuva444p*`) đúng kích thước nguồn, đúng thời lượng, không có luồng tiếng (`video-render.test.ts` + `video-export.spec.ts`).
- **Cần kiểm tay**: xuất cả hai định dạng và đặt đè lên video gốc trên timeline của **Adobe Premiere Pro**, **DaVinci Resolve**, **After Effects** và **CapCut**; kiểm tra độ khớp khung hình/mốc thời gian, mức sạch khi key phông xanh `.mp4` và kênh alpha khi dùng `.mov` có bóng mờ / karaoke.

## 6. Triển khai production và bảo mật trước khi push (docs/operations.md & T143)

- Đặt `videoSystemCapBytes` thấp hơn ít nhất 20–30 GB so với dung lượng trống thực của ổ MinIO, và bảo đảm `/tmp` của container `worker` có ≥ `2,2×` kích thước video tối đa (~22–25 GB cho video 10 GB) (xem [docs/operations.md](../../docs/operations.md) §12).
- Thực hiện danh sách kiểm tra trong [docs/operations.md](../../docs/operations.md) §3 (SSE qua tunnel) và §7 (bảo mật production, sao lưu/khôi phục).
- **Quan trọng (`T143`)**: xác nhận đã **thu hồi (revoke) GitHub token nằm trong remote `origin`** trước khi push các commit từ `main`.
