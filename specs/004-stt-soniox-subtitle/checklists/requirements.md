# Requirements Quality Checklist: STT Soniox Tạo Phụ Đề Từ Audio/Video

**Purpose**: Đánh giá chất lượng và mức độ hoàn thiện của đặc tả kỹ thuật tính năng STT Soniox  
**Created**: 2026-11-23  
**Feature**: [spec.md](../spec.md)

---

## 1. Tính đầy đủ của kịch bản người dùng (User Stories)

- [x] CHK001 Phân định rõ ràng độ ưu tiên (P1, P2, P3) theo từng luồng nghiệp vụ độc lập.
- [x] CHK002 Luồng P1 (Audio/Video -> Soniox -> .srt) có tiêu chí kiểm thử độc lập (Independent Test) rõ ràng.
- [x] CHK003 Luồng P2 (Định dạng .txt, .md, phân tách người nói) hỗ trợ các trường hợp mở rộng.
- [x] CHK004 Luồng P3 (Tiến trình nền bền vững qua pg-boss) đáp ứng Hiến pháp dự án (Principle III).

## 2. Xử lý các trường hợp biên & Ngoại lệ (Edge Cases)

- [x] CHK005 Đã định nghĩa phương án xử lý khi video không có luồng âm thanh.
- [x] CHK006 Đã định nghĩa phương án xử lý khi âm thanh quá nhỏ hoặc chỉ có tiếng ồn.
- [x] CHK007 Đã xử lý giới hạn dung lượng upload và dọn dẹp file media tạm.

## 3. Kiến trúc tích hợp Soniox & FFmpeg

- [x] CHK008 Có phương án trích xuất âm thanh nén 16kHz mono qua FFmpeg để tiết kiệm băng thông.
- [x] CHK009 Đặc tả rõ ràng các API Soniox cần gọi (`/v1/files`, `/v1/transcriptions`, `/transcript`).
- [x] CHK010 Định nghĩa thuật toán gom nhóm token Soniox thành câu phụ đề chuẩn (.srt chunking).

## 4. Tương thích hệ sinh thái Sub Maker

- [x] CHK011 File `.srt` tạo ra có cấu trúc tương thích hoàn toàn với bảng `subtitle_files` và `subtitle_cues`.
- [x] CHK012 Người dùng có thể chỉnh sửa ngay trên Script Editor (req-01) hoặc chuyển sang tạo Voice AI (TTS).
- [x] CHK013 Khóa Soniox API Key được lưu trữ mã hóa an toàn theo Hiến pháp dự án (Principle II).
