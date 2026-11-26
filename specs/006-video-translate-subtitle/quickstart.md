# Quickstart: kiểm chứng tính năng dịch video

**Spec**: [spec.md](./spec.md) | **Dữ liệu**: [data-model.md](./data-model.md) | **API**: [contracts/openapi-delta.yaml](./contracts/openapi-delta.yaml)

## 0. Chuẩn bị

```powershell
npm install
```

```powershell
docker compose --env-file .env -f docker/compose.dev.yml up -d
```

```powershell
npm run db:migrate
```

Chạy web và worker ở hai cửa sổ:

```powershell
npm run dev
```

```powershell
npm run worker:dev
```

Cần `ffmpeg` trên máy chạy worker. Kiểm thử tự động dùng Soniox giả (`tests/mocks/soniox-mock.ts`, phải thêm kết quả dịch; kiểm thử Playwright cần thêm Soniox vào `mock-provider/`), dữ liệu video ≤ 10 giây, **không gọi nhà cung cấp thật**. Administrator bật quyền Dịch Video cho User thử ở Quản trị → Người dùng.

Cổng chung trước khi coi một bước là xong:

```powershell
npm run lint; if ($?) { npm run check:i18n }; if ($?) { npm test }; if ($?) { npm run test:isolation }
```

```powershell
npm run test:e2e
```

## 1. Tải lên và dịch (US1)

1. Tab "Dịch Video": chọn video tiếng Anh 5 phút, bắt đầu; tạm dừng, tiếp tục, ngắt mạng rồi nối lại.
2. Đóng trình duyệt khi đang tải, mở lại, chọn đúng tệp → tiếp tục; chọn tệp khác → bị từ chối.
3. Chờ "chờ duyệt": có hai cột, mốc khớp lời.
4. User không có quyền, video quá dài, hết hạn mức, đã có việc đang chạy → bị từ chối đúng lý do.

Tự động: `tests/integration/video-upload.test.ts`, `video-translate.test.ts`, `video-permission.test.ts`, `tests/unit/video/segmentation.test.ts`. Có ca video tiếng bắt đầu muộn 1,5 giây: cue đầu phải bắt đầu quanh 1,5 giây.

## 2. Biên tập (US2) và tìm thay (US6)

1. Phát video: cue tô sáng, tự cuộn, bấm cue thì tua.
2. Sửa chữ, ±100 ms, ±500 ms, kéo mốc, gộp, tách, thêm, xóa, hoàn tác; tải lại trang thấy còn nguyên.
3. Hai tab cùng sửa → tab sau được báo tải lại.
4. Tìm "ban" không dấu trên kịch bản có "bạn", "bán": hộp xác nhận liệt kê dạng khớp; hoàn tác một lần.
5. Kịch bản 3.000 cue: thay tất cả ≤ 2 giây (SC-006), gõ không giật.

Tự động: `tests/unit/video/cue-ops.test.ts`, `find-replace.test.ts`, `tests/integration/video-cues.test.ts`.

## 3. Xuất và tải tệp (US3, US10)

1. Xuất kiểu mặc định; so `ffprobe` của nguồn và thành phẩm: kích thước, số khung, thời lượng lệch ≤ 100 ms (SC-008).
2. Lặp với: video dọc có cờ xoay, tốc độ khung thay đổi, `.mkv` tiếng Opus, `.avi`, HDR (có cảnh báo), nhiều luồng tiếng.
3. Tải `.srt`, `.vtt` ba kiểu nội dung, mở bằng trình phát khác. Lưu thành kịch bản Project.
4. Xuất lớp phụ đề `.mp4` phông xanh và `.mov` trong suốt, đặt lên nguồn trong phần mềm dựng phim.

Tự động: `video-render.test.ts` (ffmpeg thật, 5–10 giây), `tests/unit/video/subtitle-files.test.ts`.

## 4. Kiểu và xem trước (US4, US8)

1. Đổi từng thuộc tính trên 9:16 và 16:9; song ngữ; ba vùng an toàn kèm cảnh báo.
2. Lấy 20 thời điểm, so ảnh khung xem trước với khung trích từ thành phẩm (SC-009): `tests/e2e/video-parity.spec.ts`.
3. Từng hiệu ứng, karaoke, cue ngắn hơn hiệu ứng.
4. Kiểm thử khung hình của tab Video Overlay vẫn đạt (bộ vẽ dùng chung không đổi kết quả).

## 5. Từ điển (US5)

Dán 10 dòng gồm dòng lỗi và dòng trùng; tạo việc mới trong Project thấy từ điển; "Dịch lại" phải xác nhận. Soniox giả kiểm đúng `context.translation_terms` được gửi.

## 6. Phục hồi, dung lượng, xóa (US7)

1. Tắt worker ở từng giai đoạn (chuẩn bị, đang chờ Soniox, đang xuất) rồi bật lại: không mất, **đúng một** bản ghi sử dụng cho mỗi lần dịch.
2. Gửi nhiều yêu cầu cùng lúc sát hạn mức: không lần nào vượt (SC-015).
3. Đặt thời hạn nhỏ trong cài đặt (hoặc lùi mốc trong CSDL kiểm thử), chạy việc dọn: tệp quá hạn bị xóa, tệp đang tải/đang dùng được giữ.
4. Xóa Project và User khi đang tải dở và đang xuất: không còn đối tượng hay phiên multipart; bộ đếm đúng.
5. Chạy đối soát dung lượng: hạn mức 500 MB không cộng video, vẫn gồm chữ phụ đề.

Tự động: `video-recovery.test.ts`, `video-quota.test.ts`, `video-retention.test.ts`, `video-deletion.test.ts`, `tests/isolation/` (hai User, mọi đường dẫn của openapi-delta).

## 7. Luồng nhanh (US9)

Chrome máy đủ mạnh: phụ đề sẵn sàng trước khi tải xong. Giả lập thiếu bộ nhớ, tệp `.avi`, lỗi giữa chừng: chuyển về luồng máy chủ, một bản ghi sử dụng. Gửi âm thanh ngắn hơn luồng tiếng nguồn > 1 giây: được hỏi trước khi dịch lại. Lập bảng kết quả theo trình duyệt và định dạng.

## 8. Việc cần người dùng hoặc máy triển khai

| Việc | Cách đo | Ngưỡng |
| --- | --- | --- |
| Một lần gọi Soniox thật (**có phí**, xin đồng ý trước) | video Anh/Nhật 3 phút, từ điển 200 cặp | đúng cấu trúc ở subtitle-pipeline §1; không `invalid_request` |
| SC-003, SC-004, SC-005 | video thật 60 phút | ≤ 10 phút; ≥ 95% cue lệch ≤ 300 ms; ≥ 90% thuật ngữ đúng |
| SC-010 | 10 phút 1080p trong ảnh Docker máy triển khai | ≤ 20 phút |
| FR-038 | 20 khung đặt cạnh nhau, thêm SSIM tham khảo | không phân biệt được |
| SC-001, SC-002 | 10 GB qua đường hầm thật | đạt theo spec |
| SC-014 | ít nhất 5 người thử | ≥ 90% tự làm được |
