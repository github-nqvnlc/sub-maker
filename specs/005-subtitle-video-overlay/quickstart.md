# Quickstart: Kiểm chứng Video overlay phụ đề

**Quy ước**: dữ liệu kiểm thử tự động tối đa 10 giây (`tests/fixtures/sample-10s.mp3`, `sample-10s.srt`). Không gọi nhà cung cấp AI thật, trừ §7 do người dùng chủ động chạy. Tên tệp kiểm thử dưới đây là tên dự kiến, sẽ được tạo ở bước triển khai.

## 0. Chuẩn bị

```bash
docker compose --env-file .env -f docker/compose.dev.yml up -d
npm ci
npm run db:migrate
npm run dev          # cửa sổ 1
npm run worker:dev   # cửa sổ 2
```

Cần `ffmpeg` và `ffprobe` trong PATH.

## 1. Bộ dựng hình (kiểm thử đơn vị)

```bash
npx vitest run --project unit tests/unit/overlay
```

Kỳ vọng ([overlay-engine.md](./contracts/overlay-engine.md)):

- `applyTiming`: dùng mốc voice khi đúng tệp, lùi về mốc tệp khi không khớp; không chồng lấn; cảnh báo đủ.
- `wordSpans`: mọi bất biến FR-025 trên 244 cue của tệp mẫu và các ca biên (một từ, số, ký hiệu, câu rất ngắn).
- Phép tính khung: 60 phút không trôi, lệch ≤ 16,7 ms (không xuất video).
- Rút ngắn hiệu ứng, cấu hình không hợp lệ, cảnh báo màu (đủ danh sách FR-010), xuống dòng, thu nhỏ câu dài.
- `drawFrame`: cùng đầu vào cho cùng điểm ảnh; hai khung cùng khóa thì giống nhau.

## 2. Xuất video thật (tích hợp)

```bash
npx vitest run --project integration tests/integration/overlay-render.test.ts
```

Kỳ vọng với nguồn 10 giây: `.mp4`, `.mov`, `.webm` đúng kích thước và 30 hình/giây; thời lượng lệch ≤ 50 ms; màu phông lệch ≤ 4 mức mỗi kênh ở mọi điểm ngoài chữ; có/không có tiếng theo lựa chọn; `.mov`, `.webm` có alpha bằng 0 ngoài chữ; chữ hiện đúng tại khung trước/sau mốc của từng cue.

## 3. API, hạn mức, phục hồi, cô lập (tích hợp)

```bash
npx vitest run --project integration tests/integration/overlay-
npm run test:isolation
npm run check:i18n
```

Kỳ vọng (`test:isolation` đọc openapi của spec 001 nên chỉ kiểm không hồi quy; cô lập của overlay do `overlay-isolation.test.ts` và `overlay-audio.test.ts` phủ): User B nhận 404 ở mọi route overlay kể cả tải video và âm thanh; tiến trình thứ 3 bị 429; hai yêu cầu song song không cùng vượt hạn mức; xóa trả lại đúng dung lượng; worker chết giữa chừng thì tiến trình chạy lại; lỗi tạm thử lại ≤ 3, lỗi vĩnh viễn không; xóa Project/User không để lại đối tượng; xóa voice nguồn khi đang chạy cho `SOURCE_DELETED`; bấm trùng trả cùng một tiến trình.

## 4. Luồng người dùng (E2E, desktop và điện thoại 375 px)

```bash
npx playwright test tests/e2e/overlay.spec.ts
```

1. Mở Project có voice khớp mốc, vào tab "Video Overlay": voice và phụ đề được chọn sẵn.
2. Đổi phông chữ, màu, vị trí khi đang phát: khung xem trước đổi ngay, tiếng không ngắt.
3. Tua tới giữa: chữ đúng thời điểm trong 0,5 giây.
4. Chọn chữ xanh lá trên phông xanh lá: có cảnh báo.
5. Xuất, rời trang, quay lại: còn tiến độ; xong thì tải được `.mp4`.
6. "Dùng lại cấu hình", xóa hai mục có xác nhận, đổi sang English và theme Tối.

## 5. Khung xem trước giống video (SC-005)

E2E chụp `<canvas>` tại 20 thời điểm và so với khung trích từ video: cùng dòng chữ, vị trí khối lệch ≤ 1% chiều cao; có ca bật bóng mờ, so bề rộng vùng bóng. Chạy trên Chromium là bắt buộc; chạy thêm Firefox và WebKit, ghi lại chênh lệch. Nếu xuống dòng khác ở hai trình duyệt này thì báo trước khi phát hành.

## 6. Kiểm thử tay trong phần mềm dựng phim (SC-006, SC-007)

Dòng `.mp4` kiểm ở cuối US1; các dòng còn lại ở US7.

| Tệp | CapCut | Premiere | DaVinci Resolve | After Effects |
| --- | --- | --- | --- | --- |
| `.mp4` phông xanh lá, chữ trắng viền đen | mở, xóa phông sạch | mở, xóa phông sạch | mở, xóa phông sạch | mở được |
| `.mov` ProRes 4444 bóng mờ, hộp 50% | ghi nhận | trong suốt đúng | trong suốt đúng | trong suốt đúng |
| `.webm` | ghi nhận | ghi nhận | ghi nhận | ghi nhận |
| `.mov` QuickTime Animation (tệp thử) | ghi nhận | ghi nhận | ghi nhận | ghi nhận |

Dòng cuối quyết định có đổi `.mov` sang Animation để nhỏ hơn 5–8 lần hay không ([research R5](./research.md#r5-định-dạng-và-tham-số-mã-hóa)). Kết quả ghi vào bảng này.

## 7. Đo độ khớp từng từ (SC-008), chạy có chủ đích

Cần khóa Soniox thật và tốn phí nhỏ; chỉ chạy khi người dùng yêu cầu. Lấy tối thiểu 3 voice khớp mốc tiếng Việt của người dùng (mỗi voice ≤ 10 giây), phiên âm bằng Soniox để có mốc từng từ, so với `wordSpans`. Đạt khi ≥ 80% từ lệch ≤ 300 ms. Không đạt: chỉnh hệ số ở research R8 rồi đo lại bằng voice khác; vẫn không đạt thì quay lại sửa spec.

## 8. Hiệu năng trong ảnh Docker (SC-009, SC-011)

Dựng ảnh worker, xuất một video 60 giây (chữ lặp từ tệp mẫu) với hiệu ứng theo câu, karaoke và nhòe. Đạt khi thời gian xuất ≤ thời lượng video trên máy triển khai. Trong lúc xuất, bắt đầu một tiến trình voice (nhà cung cấp giả): phải chạy trong 10 giây. Ghi số đo vào research R1. Không đạt thì làm phương án ở research R3.
