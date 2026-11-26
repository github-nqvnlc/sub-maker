# Ghi chú triển khai: spec 006

**Ngày**: 2026-11-26. Đọc tệp này **trước** khi chạy `/speckit-implement`. Đây là các quyết định người dùng đã đồng ý trong chat (trả lời "Đồng ý hết" cho 8 đề xuất và câu hỏi về token), kèm những điều đã kiểm về môi trường.

## Quyết định đã đồng ý

1. **Phiên mới**: triển khai chạy ở phiên mới để đỡ tốn quota; tiến độ lấy từ `tasks.md`.
2. **Phạm vi đợt này**: MVP **T001–T092**. Xong thì dừng, báo cáo, chờ người dùng kiểm rồi mới làm T093–T143.
3. **Commit**: commit cục bộ trên `main` sau mỗi phase, chỉ gồm tệp của việc đó. **Không push** cho tới T143. Ở T143 làm đúng hiến pháp (kiểm thử đạt mới push; còn task treo thì hỏi trước). Không tạo hay đổi nhánh.
4. **Cơ sở dữ liệu và Docker**: đổi cổng PostgreSQL dev từ 55432 sang **5439** trong `docker/compose.dev.yml` và `.env` (sửa cả `.env.example` và tài liệu còn nhắc 55432; commit riêng dạng `chore`). Được bật, tắt container của dự án và dựng ảnh worker (tải gói hệ thống và npm).
5. **Được tải và cài**: `mediabunny` và `@tanstack/react-virtual` (npm); phông Oswald, Open Sans và độ đậm 600 kèm giấy phép từ github.com/google/fonts. Thứ khác ngoài danh sách này thì hỏi.
6. **Gọi Soniox thật (T041)**: được gọi **một lần**, dùng `SPIKE_SONIOX_KEY` trong `.env` (đã có giá trị; không in ra), ước tính dưới 0,02 USD. **Chưa có video**: người dùng chưa gửi đường dẫn video khoảng 3 phút tiếng Anh hoặc Nhật. Chưa có thì đánh T041 `parked — chờ video`, làm tiếp theo tài liệu và hỏi lại khi bàn giao.
7. **Agent kiểm giao diện**: được dùng, mỗi loại trang một agent kiểm (khác người viết), gộp theo phase. Agent hiệu chỉnh (T045, T063) khác agent kiểm.
8. **Việc chỉ người dùng làm được** (phần mềm dựng phim, Safari, tải 10 GB qua đường hầm, điều khoản Cloudflare): ghi vào `user-tasks.md` và làm tiếp.
9. **Quota**: mức dùng vượt gói đang tắt, giữ nguyên. Khi hết quota thì chờ đặt lại rồi làm tiếp (mục dưới).

## Chờ quota và làm tiếp

Ngay đầu phiên triển khai:

- Tạo lịch trong phiên (`CronCreate`, `recurring: true`, mỗi giờ, ví dụ `17 * * * *`) với lời nhắc: "Tiếp tục triển khai spec 006: đọc `specs/006-video-translate-subtitle/implementation-notes.md`, làm tiếp từ task chưa đánh dấu trong `tasks.md`. Nếu đã xong T092 hoặc đang chờ người dùng trả lời thì xóa lịch này và không làm gì thêm."
- Gọi `request_keep_awake` (`session_idle`).
- Xóa lịch khi MVP xong hoặc khi dừng để hỏi.
- Đánh dấu `[X]` ngay sau mỗi task để lượt sau biết làm tiếp từ đâu; việc đang dở thì ghi một dòng dưới task đó.

Cơ chế làm tiếp sau khi chạm hạn mức **chưa được thử**. Người dùng đã được báo: ứng dụng phải mở, máy không ngủ, chế độ quyền không dừng lại hỏi; lịch mất nếu phiên bị đóng.

## Lịch đã đặt trong phiên triển khai (2026-11-26, 13:46 +07:00)

- Người dùng nhắn thêm: đặt lịch tự làm tiếp khi hạn mức đặt lại; người dùng **sẽ không nhắn gì** cho tới khi xong. Vì vậy không dừng để hỏi: việc cần người dùng thì `parked` kèm lý do, ghi lại và làm tiếp.
- `CronCreate` mỗi giờ phút 23: mã `a0bf97c3`. Một lần lúc 15:24 ngày 26/11 (sau khi hạn mức 5 giờ đặt lại lúc 15:20): mã `23941bc2`. Xong MVP thì xóa bằng `CronDelete`.
- `request_keep_awake` (`session_idle`) đã bật. Máy bàn, không pin, Windows đặt "không ngủ" khi cắm điện, nên sau khi lệnh giữ thức hết hiệu lực máy vẫn không tự ngủ.
- Hạn mức lúc đặt: 5 giờ đã dùng 47%, tuần đã dùng 38% (đặt lại 01:00 ngày 28/11).

## Hiện trạng đã kiểm (2026-11-26)

- `main` hơn `origin/main` 2 commit: `ea11110` (bỏ 2 ca kiểm thử MiniMax), `b449f7e` (tasks và sửa tài liệu). Tệp ghi chú này chưa commit, đi cùng commit đầu tiên.
- Windows giữ dải cổng 55335–55434 nên container `submaker-dev-postgres-1` không khởi động được ở 55432. MinIO dev (59000) chạy được. Kiểm cổng 5439 còn trống trước khi đổi; cấu hình cổng đổi thì container postgres dev được tạo lại, volume `submaker-dev_pgdata` giữ nguyên.
- `npm ls` không lỗi; ffmpeg máy dev 8.1.1, ảnh worker 5.1.9 (ảnh `submaker-worker:latest` có sẵn nhưng cũ, T003 dựng lại).
- Playwright có Chromium; chưa có Firefox và WebKit (không nằm trong danh sách được tải).
- Ổ đĩa còn khoảng 38 GB; Docker build cache khoảng 21 GB (muốn dọn thì hỏi).
- Kiểm thử unit và contract đạt 552 sau khi bỏ 2 ca MiniMax; bộ tích hợp đạt ở lần chạy đầy đủ trước đó. `.env` có khóa `SPIKE_*`: không bao giờ đặt `REAL_PROVIDER_TESTS=1`.
- Lỗi tốc độ giọng MiniMax (gửi ngoài 0,5–2) vẫn còn trong mã, ngoài phạm vi spec 006.

## Hiện trạng khi bàn giao MVP (2026-11-26)

- **T001–T092 xong**, trừ T041 (`parked — chờ video`). Dừng ở đây theo quyết định 2; T093–T143 chờ người dùng.
- Commit cục bộ trên `main`, chưa push: `a12afa1`, `ed71bc4` (phase 1), `6f757b0` (phase 2), `1757af8` (phase 3), `0ae9c7a` (phase 4), và commit phase 5 là commit đi cùng ghi chú này.
- Cổng trên mã phase 5: lint, `tsc --noEmit`, `check:i18n` đạt; `npm test` 1464 đạt, 6 bỏ qua; `test:isolation` 211 đạt; E2E 90/92 đạt.
- Hai ca E2E trượt không do spec 006 (theo lịch sử mã, chưa chạy lại trên mã trước spec 006; chi tiết ở T092): `ai-config.spec.ts:45`, `manage-jobs.spec.ts:20`.
- Lịch tự làm tiếp: các lời nhắc đã chạy được sau khi hạn mức đặt lại; đã xóa khi xong.

### Còn mở, mức thấp (agent kiểm lượt cuối)

- Khối xuất video: lỗi "phụ đề chưa được lưu" vẫn hiện sau khi đã lưu được, tới lần bấm sau.
- Khối tải lại video nguồn: `rejectedReason` (`export-panel.tsx`) có thể hiện lỗi cũ của lượt chuẩn bị đầu tiên (lỗi tạm, chạy lại thành công, rồi video hết hạn). Hướng sửa: trả `null` khi sau `uploadDone` gần nhất có `probed` hoặc `sourceExpired`.

### Việc ngoài phạm vi, phát hiện trong lúc làm (chưa sửa)

- Hai ca E2E nêu trên cần cập nhật theo giao diện hiện tại.
- `voice-view.tsx`: truy vấn lấy chữ gốc lỗi thì hiện "đang tải" mãi.
- `users-table.tsx`: `ConfirmDialog` gọi `mutateAsync` có thể để lọt lỗi không bắt.
- Ô cài đặt đơn vị MB làm tròn nên lưu lại có thể lệch giá trị đã lưu (các ô có từ trước spec 006).
- Dựng video overlay dùng khóa đối tượng cố định: tiến trình cũ bị thay thế có thể ghi đè kết quả mới.
- Tốc độ giọng MiniMax gửi ngoài khoảng 0,5–2.

### Chưa kiểm được

- Soniox thật (T041); chất lượng hình và chữ trên video thật; mở `.srt`/`.vtt` bằng trình phát; thời gian xuất trên máy triển khai.
- Độ tương phản và chế độ tối; trình duyệt với kịch bản 20.000 đoạn.

## Còn chờ người dùng

- Đường dẫn video cho T041.
- **Token GitHub nằm trong địa chỉ remote `origin`**: người dùng chưa cho biết đã thu hồi hay chưa. Không in địa chỉ remote ra màn hình. Hỏi trước bước push ở T143.
- Các việc kiểm tay ở `user-tasks.md`.
