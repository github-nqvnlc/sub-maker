# Việc chờ người dùng (spec 006, sau MVP T001–T092)

| Việc | Vì sao cần | Cách làm |
| --- | --- | --- |
| Gửi đường dẫn một video tiếng Anh hoặc Nhật khoảng 3 phút (T041) | Chưa gọi Soniox thật lần nào: cấu trúc token, `translation_status`, giới hạn từ điển mới làm theo tài liệu. Ước tính dưới 0,02 USD | Chạy `npx tsx scripts/soniox-check.ts <video> --co-phi` (dùng `SPIKE_SONIOX_KEY` trong `.env`), rồi ghi kết quả vào research.md R5 |
| Cho biết token GitHub trong địa chỉ remote `origin` đã thu hồi chưa | Token nằm trong cấu hình git; phải hỏi trước bước push ở T143 | Trả lời đã thu hồi hay chưa; nên thu hồi và đặt lại remote không kèm token |
| Xem tận mắt trên video thật (FR-038, SC-009) | Chất lượng hình và chữ chỉ so được bằng mắt | Xuất một video thật, đặt khung nguồn và thành phẩm cạnh nhau ở kích thước gốc |
| Mở `.srt` và `.vtt` đã tải bằng một trình phát (VLC, trình dựng phim) | Kiểm thử mới đọc bằng ffprobe | Tải ba kiểu nội dung, mở cùng video, xem chữ và mốc |
| Đo thời gian xuất trên máy triển khai (SC-010) | Mới đo bằng nguồn giả trong ảnh worker (research R1) | 10 phút 1080p phải xong trong 20 phút |
| Quyết có làm tiếp T093–T143 | Phạm vi đã đồng ý dừng ở MVP | Nhắn tiếp tục khi muốn |
