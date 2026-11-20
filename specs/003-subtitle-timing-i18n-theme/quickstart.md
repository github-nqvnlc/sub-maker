# Quickstart: kiểm chứng tính năng 003

**Quy ước dữ liệu thử** (chỉ thị của người dùng): **không** chạy trên cả `docs/example/tham-quyen-2026.srt` (11 phút 45 giây). Mọi kịch bản dưới đây dùng `tests/fixtures/sample-10s.srt` = 3 cue đầu của tệp mẫu (kết thúc ở 9,77 giây, khoảng 120 ký tự) hoặc phụ đề tổng hợp ≤ 10 giây.

Tham chiếu: [spec](./spec.md) · [data-model](./data-model.md) · [contracts/](./contracts/) · [research](./research.md).

## 0. Chuẩn bị

```bash
npm install
npm run db:migrate          # áp dụng 0004 (skt→srt) và 0005 (cue, tùy chọn giao diện)
npm run typecheck && npm run lint && npx tsx scripts/check-i18n.ts
```

Dịch vụ phụ thuộc (PostgreSQL, MinIO, ffmpeg) và nhà cung cấp giả chạy như ở spec 001 (`docs/operations.md`, `npm run test:e2e` tự dựng).

## 1. Voice khớp mốc (US1, US2)

| Bước | Hành động | Kết quả mong đợi |
|------|-----------|------------------|
| 1.1 | Tải `sample-10s.srt` vào một Project | Chấp nhận; xem trước hiện 3 cue kèm mốc; văn bản không có số thứ tự/mốc; `hasTimecodes=true` |
| 1.2 | Tải tệp `.skt` | Bị từ chối, thông báo chỉ nhận `.txt`, `.md`, `.srt` |
| 1.3 | Mở "Tạo voice" | Chế độ "Khớp mốc thời gian phụ đề" bật sẵn, "Ghép cue cùng câu" bật; hiện ước tính (ký tự, yêu cầu, thời lượng, dung lượng, ETA) |
| 1.4 | Bắt đầu với nhà cung cấp giả (scenario `ms-60`) | Hoàn tất; voice dài ≈ 9,8 giây; mốc bắt đầu từng đơn vị trong ±150 ms so với mốc phụ đề |
| 1.5 | Dùng scenario `ms-120` (đọc chậm) rồi chạy lại | Có nén ≤ 1,25× hoặc trượt nhẹ; `slipMs ≤ 500` hoặc đơn vị bị đánh dấu `overflow` và có cảnh báo; không chồng tiếng (bất biến I1) |
| 1.6 | Chạy lại đúng như 1.4 | Mọi đơn vị lấy từ cache: 0 lần gọi nhà cung cấp, 0 usage mới |
| 1.7 | Tắt "Ghép cue cùng câu" | Số đơn vị = số cue; chỉ đơn vị có văn bản đổi mới bị gọi lại |
| 1.7a | Đoạn bị chặn nội dung (scenario `ms-60+blocked-Putin`) | Job `completed`, đoạn đó im lặng và hiện ở "Đoạn lỗi"; các đoạn khác đúng mốc |
| 1.8 | Dừng giữa chừng rồi "Tiếp tục" (phụ đề tổng hợp 10 giây gồm 12 cue ngắn) | Đơn vị đã xong không bị tạo/tính phí lại |
| 1.9 | Mở trình phát, tua tới giữa voice | Highlight đúng cue/đơn vị tại thời điểm đó |

Tự động: `npx vitest run tests/unit/placement.test.ts tests/unit/reading-units.test.ts tests/unit/srt-cues.test.ts tests/integration/timed-job.test.ts`.

## 2. Phụ đề dài và phần (US2) — bằng dữ liệu tổng hợp, không dùng tệp mẫu

Tạo phụ đề tổng hợp ngắn bằng cấu hình thu nhỏ để kiểm thử logic phần mà không cần dữ liệu dài: đặt `timingPartMinutes=1` (cài đặt hệ thống, giá trị tối thiểu cho phép là 1) và dùng tệp tổng hợp ≤ 10 giây lặp cue mỗi 1 giây để có nhiều "phần" nhỏ; kiểm tra điểm cắt rơi vào khoảng nghỉ lớn nhất, mốc tuyệt đối không trôi (cue cuối lệch ≤ cue đầu), log ghi theo phần.

Tự động: `tests/unit/plan-parts.test.ts`.

## 3. Ước tính và hạn mức (FR-008, FR-013)

- `POST /api/files/{id}/estimate` với `sample-10s.srt`: `requests = units − cachedUnits`; `priceConfigured=false` khi cấu hình AI chưa có đơn giá (không có số tiền).
- Giảm hạn mức lưu trữ của người dùng thử xuống vài KB → tạo job bị `409 QUOTA_EXCEEDED` kèm `needBytes`; ước tính cho `quotaOk=false`.

## 4. Sáng / Tối và viền ô nhập (US3)

1. Bấm nút theme (ở mọi màn hình, kể cả đăng nhập): chọn Sáng, Tối, Hệ thống → đổi ngay, không tải lại.
2. Tải lại và mở trang mới: giữ lựa chọn, không nhấp nháy sai theme (Playwright: chặn render đầu, kiểm tra lớp `dark` đã có trước khi `DOMContentLoaded`).
3. Mở ô nhập (đăng nhập, tạo Project, tìm kiếm, hộp thoại tạo voice): viền thấy rõ ở cả hai theme; focus nổi hơn; ô lỗi có viền cảnh báo.
4. Tự động: `npx vitest run tests/unit/field-contrast.test.ts` (tương phản `--field-border` ≥ 3:1 với `--background`, `--card`, `--input` ở cả hai theme).

## 5. Đa ngôn ngữ (US4)

1. Đổi sang English ở trang đăng nhập → toàn bộ chữ đổi; đăng nhập; mở Dashboard, Project, tạo voice, trình phát, Cài đặt, Quản trị: không còn chữ tiếng Việt thuộc giao diện (tên Project, nội dung phụ đề, tên giọng giữ nguyên).
2. Gây lỗi (ví dụ đăng nhập sai) → thông báo lỗi bằng English; đổi lại tiếng Việt → bằng tiếng Việt, `code` không đổi.
3. Ngày giờ/số/tiền theo `en-US` (1,234.5) và `vi-VN` (1.234,5).
4. Tự động: `npx tsx scripts/check-i18n.ts` (đủ khóa, đủ giữ chỗ); `npx tsc --noEmit` (thiếu khóa ở `en.ts` là lỗi biên dịch).

## 6. Font tiếng Việt (US5)

1. Mở trang kiểm thử chữ (`/dev/typography`, chỉ bật ngoài production) hiển thị toàn bộ nguyên âm Việt hoa/thường đủ dấu ở cỡ 12–32 px, đủ 4 độ đậm.
2. Playwright: với mỗi ký tự, `document.fonts.check('16px "Be Vietnam Pro"', ch)` đúng và `getComputedStyle(...).fontFamily` bắt đầu bằng font chính; chụp ảnh tiêu đề "Ệ Ữ Ẳ" kiểm tra không bị cắt dấu (so sánh vùng pixel không chạm mép hộp).
3. Giả lập mạng chậm: chữ vẫn hiện bằng font dự phòng, bố cục không nhảy lớn.

## 7. Tab quản trị (US6)

Mở lần lượt `/admin/users`, `/admin/ai-configs`, `/admin/custom-ai-users`, `/admin/stats`, `/admin/settings`: đúng một tab có `aria-current="page"`, nổi bật bằng nền + chữ đậm + gạch chân, ở cả hai theme và cả hai ngôn ngữ. Tự động: `tests/e2e/admin-nav.spec.ts`.

## 8. Thử nhà cung cấp thật (thủ công, có chủ đích)

Chỉ với `sample-10s.srt` (3 cue ≈ 120 ký tự, chi phí không đáng kể), dùng khóa trong `.env` (`SPIKE_FPT_MARKETPLACE_KEY`), không in khóa ra log. Mục đích: xác nhận giả thuyết R3 — thời lượng thô của nhà cung cấp gồm khoảng lặng đầu/cuối; sau khi cắt lặng, tỷ lệ cue tràn khe nhỏ hơn số đo thô (27%/40 cue). Ghi kết quả vào `docs/provider-spikes.md`.

## Tiêu chí hoàn thành (tóm tắt)

- Mọi kịch bản 1–7 đạt; `npm run typecheck`, `lint`, `check-i18n`, `vitest` (unit, integration, contract, isolation) và `playwright` (desktop + mobile 375 px) xanh.
- `tests/isolation/isolation.test.ts` phủ các thao tác mới đã hợp nhất vào `openapi.yaml` của spec 001.
