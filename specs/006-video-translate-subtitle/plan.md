# Implementation Plan: Dịch video tự động và gắn đè phụ đề

**Branch**: `main` (hiến pháp 1.4.0, không tạo nhánh khác) | **Date**: 2026-11-26 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/006-video-translate-subtitle/spec.md`

## Summary

Thêm tab "Dịch Video" trong Project: tải video tới 10 GB theo từng phần, nhận dạng và dịch bằng Soniox, duyệt và sửa phụ đề song ngữ trên trình phát đồng bộ, tạo kiểu, rồi xuất video gắn cứng phụ đề, tệp `.srt`/`.vtt` hoặc lớp phụ đề riêng.

Hướng kỹ thuật ([research.md](./research.md)):

1. **Tải lên** S3 multipart qua ứng dụng, phần 16 MB, tiếp tục được, kiểm quyền từng phần (R7).
2. **Dịch**: mở rộng client Soniox với dịch một chiều và từ điển; chữ dịch không có mốc nên cue lấy mốc từ lời gốc theo cụm (R5, R6).
3. **Một bộ vẽ** của spec 005 cho xem trước và gắn cứng; chỉ vẽ dải chữ rồi ffmpeg ghép lên video nguồn. Đo phần ffmpeg: 1080p nhanh hơn thời gian thực khoảng 5,7 lần, 4K khoảng 1,2–1,4 lần (chưa gồm vẽ chữ) (R1, R2, R3).
4. **Âm thanh** giữ đúng độ lệch đầu luồng; luồng nhanh tách ngay trong trình duyệt bằng `mediabunny` (R4, R8).
5. **Nền, dung lượng, vòng đời**: bốn hàng đợi mới và một lịch dọn; hạn mức video riêng kèm trần hệ thống; tự xóa theo hạn, không xóa tệp đang dùng (R9, R12, R13).

## Technical Context

**Language/Version**: TypeScript 5.9 (strict), Node.js 22

**Primary Dependencies**: Next.js 16 (App Router), React 19, Tailwind CSS 4, shadcn/ui, TanStack Query, Drizzle ORM, pg-boss, `@napi-rs/canvas`, `@aws-sdk/client-s3`, ffmpeg/ffprobe (ảnh worker). **Mới**: `mediabunny` (MPL-2.0, chỉ trình duyệt), `@tanstack/react-virtual` (MIT). **Tệp phông mới** (OFL): Oswald, Open Sans và độ đậm 600 (R2; tải về cần người dùng đồng ý)

**Storage**: PostgreSQL 16, 7 bảng mới, 2 cột trên `users`, 1 cột trên `usage_records`, 13 cài đặt, migration `0009_video_translate` ([data-model.md](./data-model.md)); MinIO cho video nguồn, thành phẩm và tệp tạm dẫn xuất

**Testing**: Vitest (unit, integration, isolation), Playwright (desktop và 375 px); video thử ≤ 10 giây; Soniox giả ([quickstart.md](./quickstart.md))

**Target Platform**: Linux server (Docker: web + worker + postgres + minio + cloudflared); trình duyệt hiện đại, desktop và điện thoại

**Project Type**: Web application (một mã nguồn Next.js và tiến trình worker pg-boss)

**Performance Goals**: SC-003 (chờ duyệt ≤ 10 phút cho video 60 phút), SC-006 (thay tất cả 3.000 cue ≤ 2 giây), SC-007 (xem trước ≤ 0,2 giây), SC-010 (10 phút 1080p xuất ≤ 20 phút)

**Constraints**: ảnh `web` không có ffmpeg; CSP `connect-src`, `media-src`, `font-src` chỉ cùng nguồn; thân yêu cầu qua đường hầm ≤ 100 MB; một lần `PutObject` ≤ 5 GB; thời hạn công việc pg-boss ≤ 24 giờ; ngữ cảnh Soniox khoảng 10.000 ký tự, mỗi tệp ≤ 300 phút

**Scale/Scope**: video ≤ 10 GB và ≤ 180 phút, tối đa 20.000 cue; 1 bản xuất chạy cùng lúc mặc định; 1 tab mới, 1 trang mới (trình biên tập), 2 trang quản trị sửa; 34 thao tác API trên 31 đường dẫn (gồm 3 đường dẫn quản trị được mở rộng)

Không còn điểm NEEDS CLARIFICATION. Những điều chưa đo được ghi ở research R15, mỗi điều có bước kiểm và hướng xử lý.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.* Nguồn: [constitution.md](../../.specify/memory/constitution.md) 1.4.0.

| Nguyên tắc | Trước thiết kế | Sau thiết kế (Phase 1) |
| --- | --- | --- |
| I. Bảo mật và cô lập | ✅ FR-008, FR-056, FR-057 | ✅ Mọi bảng có chủ mang `owner_id`, sai trả 404; quyền kiểm ở máy chủ cho cả từng phần tải; phát và tải qua proxy; Administrator không đọc nội dung; tệp độc hại chỉ được ffmpeg đọc từ đĩa |
| II. Bí mật | ✅ Dùng cấu hình Soniox đã mã hóa | ✅ Khóa không xuống trình duyệt, không vào tiến trình dựng hình; nhật ký lưu khóa i18n và qua `redactDeep` |
| III. Tiến trình nền | ✅ FR-047 đến FR-052 | ✅ pg-boss, nhịp tim, sweeper, dừng, chạy lại, nhật ký, SSE ≤ 2 giây, giới hạn đồng thời, tối đa 3 lần thử lại |
| IV. Chi phí và dùng lại | ✅ FR-016, FR-053 đến FR-055 | ✅ Một bản ghi tính phí mỗi lần dịch thành công và một bản ghi lỗi mỗi lần gọi thất bại; giới hạn nhà cung cấp nằm trong cài đặt; tiếp tục theo id Soniox; hạn mức kiểm nguyên tử; thời hạn tự xóa và thẻ giữ lượt tải; xem Complexity Tracking mục 1 |
| V. Kiểm thử | ✅ FR-061 | ✅ Quickstart §1–§7 phủ từng user story và FR-061; Soniox giả trong tự động |
| VI. Giao diện | ✅ FR-059 | ✅ vi/en, thành phần dùng chung, đủ trạng thái, xác nhận xóa, tìm không dấu, dùng được ở 375 px (xem "Giao diện") |
| Lưu trữ file; dịch vụ nội bộ không mở | ✅ FR-004 | ✅ Không mở cổng mới, kho không công khai |
| Bền dữ liệu | ✅ | ✅ Cue và kịch bản ở CSDL; tệp ở volume MinIO; xóa chỉ theo hạn đã hiện cho User |
| Văn bản NFC, UTF-8 | ✅ | ✅ Chuẩn hóa ở gom token, sửa cue, từ điển, xuất tệp |
| Mốc từng từ; mốc phụ đề dịch | ✅ FR-015, FR-034 | ✅ Mốc từ suy ra từ cue, không lưu; cue có cột `timing` ghi mốc ước lượng |
| Định dạng phụ đề | ✅ FR-039 | ✅ `.srt` chuẩn, `.vtt` chỉ xuất |
| Phạm vi giai đoạn | ✅ Có từ 1.4.0 | ✅ Sửa và xuất phụ đề chỉ trong tính năng này; không thêm tính phí, chia sẻ |
| Quy trình: đổi hành vi cập nhật spec trước | ⚠️ FR-011 so sai mốc | ✅ FR-011 đã sửa trong spec ngày 2026-11-26 |
| Hoàn tất triển khai trên `main` | ✅ | ✅ Ghi nhận thay đổi có sẵn trước task đầu; task cuối commit, push, thông báo |

**Kết quả cổng**: ĐẠT trước và sau thiết kế.

## Project Structure

### Documentation (this feature)

```text
specs/006-video-translate-subtitle/
├── plan.md                    # Tệp này
├── research.md                # Phase 0 (R1–R15, có số đo)
├── data-model.md              # Phase 1
├── quickstart.md              # Phase 1
├── contracts/
│   ├── openapi-delta.yaml     # API
│   ├── subtitle-pipeline.md   # Token → cue, sửa, tìm thay, từ điển, tệp phụ đề
│   └── render-and-media.md    # Bộ vẽ, tiến trình con, ffmpeg, phần trình duyệt
├── checklists/requirements.md
└── tasks.md                   # Do /speckit-tasks tạo
```

### Source Code (repository root)

```text
src/
├── lib/
│   ├── video/                         # MỚI
│   │   ├── segmentation.ts, cue-ops.ts, find-replace.ts, glossary.ts,
│   │   │   subtitle-files.ts, style.ts, safe-zones.ts, estimate.ts     # thuần
│   │   ├── expiry.ts                                                   # máy chủ: hạn xóa video nguồn
│   │   ├── upload-client.ts, extract-audio.worker.ts                   # trình duyệt
│   │   └── service.ts, uploads.ts, cues.ts, exports.ts, quota.ts,
│   │       permission.ts, retention.ts, cleanup.ts, log.ts             # máy chủ
│   ├── overlay/draw.ts, layout.ts, effects.ts, fonts.ts, config.ts     # mở rộng bộ vẽ
│   ├── db/schema/video.ts             # MỚI (+ migrations/0009_video_translate.sql)
│   ├── storage/client.ts (multipart, abort), keys.ts, proxy.ts
│   ├── providers/adapters/soniox.ts, soniox-types.ts                   # dịch, ngữ cảnh
│   ├── audio/ffmpeg.ts                # probeVideo, tách âm thanh giữ độ lệch
│   ├── usage/record.ts, settings-defaults.ts, users/admin-service.ts
│   ├── projects/delete.ts
│   ├── hooks/use-video.ts             # MỚI
│   └── i18n/vi.ts, en.ts
├── worker/
│   ├── queues.ts, handlers.ts, sweeper.ts
│   ├── jobs/video-prepare.ts, video-translate.ts, video-preview.ts,
│   │        video-render.ts, video-retention.ts                        # MỚI
│   ├── jobs/delete-user.ts, reconcile-storage.ts
│   └── render/main.ts, ffmpeg-args.ts, protocol.ts                     # thêm tác vụ gắn cứng
├── app/
│   ├── (app)/projects/[projectId]/video/[jobId]/page.tsx               # MỚI
│   └── api/
│       ├── projects/[projectId]/video/                                 # MỚI
│       ├── video/uploads/, video/jobs/, video/exports/                 # MỚI
│       └── admin/users, admin/settings, admin/stats
└── components/
    ├── video/                         # MỚI: tab, tải lên, từ điển, danh sách, trình biên tập,
    │                                  #      danh sách cue, tìm thay, dòng thời gian, kiểu, xuất
    ├── projects/project-detail.tsx    # thêm tab
    └── admin/users-table.tsx, system-settings-form.tsx, admin-stats-view.tsx
public/fonts/overlay/                  # thêm phông, coverage.json
tests/
├── unit/video/*.test.ts
├── integration/video-*.test.ts
├── isolation/                         # thêm mọi đường dẫn mới
└── e2e/video*.spec.ts
```

**Structure Decision**: Giữ một mã nguồn. `src/lib/video/` chia ba nhóm: thuần (dùng chung), trình duyệt, máy chủ; nhóm thuần không nhập CSDL. Bộ vẽ vẫn ở `src/lib/overlay/` và chỉ mở rộng, không tạo bộ thứ hai.

## Thứ tự triển khai đề xuất

| Bước | Nội dung | User Story |
| --- | --- | --- |
| 0 | Trong ảnh worker kiểm bộ lọc và bộ tách của ffmpeg 5.1, đo lại R1 gồm vẽ chữ. **Cổng**: không đạt thì xem lại R1/R3 | nền |
| 1 | Migration, cài đặt, quyền, khóa đối tượng, hạn mức video và trần hệ thống, multipart, sửa đối soát | nền |
| 2 | Tải lên: dịch vụ, API, phần trình duyệt, tab và danh sách việc; dừng, xóa, dọn phiên dở | US1, US7 |
| 3 | Đo video, tách âm thanh giữ độ lệch | US1 |
| 4 | Dịch Soniox, gom cue, bản ghi sử dụng, phục hồi (cần một lần gọi thật đã được đồng ý) | US1 |
| 5 | API cue, trang biên tập, trình phát, bản xem trước | US2 |
| 6 | Mở rộng bộ vẽ, gắn cứng, tải `.mp4`/`.srt`/`.vtt`; tải lại video nguồn; tự xóa theo hạn; xóa Project/User. **Mốc MVP** | US3, US7 |
| 7 | Kiểu, song ngữ, vùng an toàn, phông mới | US4 |
| 8 | Từ điển; tìm và thay thế; phần quản lý còn lại | US5, US6, US7 |
| 9 | Hiệu ứng | US8 |
| 10 | Lấy âm thanh trong trình duyệt | US9 |
| 11 | Lớp phụ đề riêng | US10 |
| 12 | E2E đầy đủ, đo hiệu năng, kiểm tay, README và `docs/operations.md` | tất cả |

Dừng, phục hồi, hạn mức, tự xóa và dọn dẹp làm cùng bước tạo ra dữ liệu (2–6) vì Nguyên tắc III và IV cần từ lần phát hành đầu.

## Giao diện

Checklist dưới đây do `ui-consistency:finding-patterns` lập. `/speckit-tasks` đưa từng dòng vào task giao diện tương ứng. Không có `DESIGN.md`; theme ở `src/app/globals.css`.

### Tab "Dịch Video"

Tab của Project (xác định bởi `TabsContent` trong `project-detail.tsx`), mẫu từ `overlay/overlay-tab.tsx` (tab thêm gần nhất), 5 thành viên (files, media, jobs, voices, overlay) trong `src/`, đọc 2026-11-26.

- [ ] thẻ tab: `TabsTrigger` nhãn kèm số lượng (5/5), thêm `Badge` số đang chạy như overlay
- [ ] tiêu đề vùng: `h2` `text-base font-semibold`, mô tả `text-xs text-muted-foreground` — 4/5 tab có tiêu đề này
- [ ] bố cục nhập + danh sách: `grid grid-cols-1 gap-6 lg:grid-cols-12` — 3/3 tab có cả hai phần
- [ ] chọn tệp: `shared/file-dropzone.tsx` — thành phần chung, 3 tệp dùng
- [ ] đang tải, lỗi, rỗng: `LoadingList`, `ErrorState` (có thử lại), `EmptyState` — rỗng 5/5
- [ ] danh sách việc: `shared/data-table.tsx` có chọn nhiều, `jobs/status-badge.tsx` (thêm `label`), `Progress` `h-1.5` kèm phần trăm `tabular-nums` — 2/2 danh sách dùng bảng chung
- [ ] nhật ký: `shared/event-log.tsx` trong `Dialog` `max-h-[90dvh] overflow-y-auto sm:max-w-2xl`
- [ ] xóa: `shared/confirm-dialog.tsx` nêu số lượng, dung lượng, hậu quả
- [ ] phản hồi: `toast` của `sonner`; lỗi trong dòng có `role="alert"` `text-xs text-destructive`
- [ ] nút trong hàng: `Button size="sm" variant="outline"`, xóa là `size="icon" variant="ghost"` kèm `aria-label`
- [ ] ghi chú bắt buộc: âm thanh được gửi cho nhà cung cấp bên ngoài, hiện trước lần dùng đầu (FR-058); từ điển chỉ là chỉ dẫn cho máy dịch (FR-021) — theo yêu cầu spec
- [ ] không chép từ overlay: chữ trạng thái riêng của overlay, nút "dùng lại cấu hình"

### Trang biên tập

Trang chi tiết dưới Project, mẫu từ `player/voice-view.tsx` (trình phát đồng bộ), 2 thành viên (voice, job), đọc 2026-11-26. Gia đình chỉ có hai trang nên phần lớn là cách của trang mẫu.

- [ ] đầu trang: tên `h1` `truncate text-2xl font-semibold` (cách của trang voice), nút về Project `Button asChild variant="outline" size="sm"` bọc `Link` — 2/2 có đường về
- [ ] tải và lỗi cấp trang: `LoadingList`, `ErrorState` với thông báo riêng cho 404 — 2/2
- [ ] xem trước: cột phải bám cuộn `lg:sticky lg:top-4`, lên đầu trên điện thoại (cách của `overlay-tab`)
- [ ] đồng bộ danh sách: như `synced-text.tsx`: tự cuộn vào giữa, ngưng 3,5 giây khi người dùng tự cuộn, tôn trọng `prefers-reduced-motion`, bấm để tua
- [ ] nhóm chức năng: `Tabs` (kiểu, từ điển, xuất) như trang voice
- [ ] điều khiển kiểu: `SliderField`, `SelectField`, `SwitchRow`, `shared/color-field.tsx` — dùng bằng import, hàng `space-y-2`
- [ ] tiến độ dịch và xuất: SSE theo `lib/hooks/use-job-stream.ts`
- [ ] chữ qua `useT()`; màu và khoảng cách theo theme; màu chữ phụ đề trong `<canvas>` là nội dung người dùng

Thành phần chưa có trong dự án, đã được spec nêu tên và vị trí: dòng thời gian kéo mốc, khung vùng an toàn, thanh tải lên có MB/s và thời gian còn lại (dựng trên `Progress`), bảng từ điển (dựng trên `Table`), danh sách cue ảo hóa.

### Quản trị (sửa một vùng, dùng `ui-consistency:adjusting`)

Cột và nút bật tắt quyền Dịch Video trong `users-table.tsx` (theo cặp nút khóa/mở khóa; thu hồi có `ConfirmDialog`); 13 ô cài đặt trong `system-settings-form.tsx`; dung lượng video trong `admin-stats-view.tsx`.

### Hai đề xuất giao diện (đã chốt ngày 2026-11-26)

1. **Không tách** bảng điều khiển kiểu chữ của overlay: viết bảng riêng, chỉ import các hàng điều khiển có sẵn (mặc định, người dùng không đổi).
2. **`StatusBadge` nhận thêm prop `label` tùy chọn** (thành phần chung, 3 tệp dùng, hành vi cũ không đổi) để hiện "đang tải lên", "chờ duyệt", "hết hạn"; người dùng đồng ý khi cho sửa lỗi I3.

## Rủi ro

| Rủi ro | Xử lý |
| --- | --- |
| Kết quả dịch thật khác tài liệu (thứ tự cụm, giới hạn ngữ cảnh) | Một lần gọi thật trước bước 4; bộ gom token là hàm thuần, dễ chỉnh |
| Máy production chậm với 4K dài | Cổng bước 0; hiện thời gian ước tính; 1 bản xuất cùng lúc |
| Ổ đĩa đầy (mỗi người tới 30 GB cộng tệp tạm) | Trần hệ thống, kiểm đĩa tạm, tự xóa theo hạn; ghi cách chọn trần vào hướng dẫn vận hành |
| Điều khoản Cloudflare về video và tệp lớn | Người vận hành đọc trước khi mở tính năng; chưa kiểm chứng |
| Sửa bộ vẽ làm đổi video overlay | Mặc định giữ hành vi cũ; kiểm thử khung hình spec 005 chạy ở mọi bước |
| Sửa đối soát sai làm lệch hạn mức 500 MB | Kiểm thử đối soát trước khi lưu tệp video đầu tiên |
| `mediabunny` không đạt trên một số trình duyệt | Luồng máy chủ luôn dùng được; luồng nhanh làm sau MVP |
| Âm thanh tách ra lệch so với hình | Đã sửa ở `extractAudioToMp3File` (commit `b417ce0`); tính năng này dùng lại và giữ kiểm thử tiếng bắt đầu muộn |
| Thay đổi chưa commit lẫn vào commit cuối | Ghi nhận trước task đầu; không tách được thì hỏi |

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| 1. Bản xem trước 720p và âm thanh tách được coi là **tệp tạm** (không tính hạn mức video, nguyên tắc IV) dù sống cùng video nguồn tới 7 ngày | Là tệp hệ thống tự dẫn xuất để phát và dịch, người dùng không tải; vẫn bị chặn bởi trần hệ thống và xóa cùng nguồn | Tính vào hạn mức khiến người dùng bị trừ dung lượng cho tệp họ không tạo và không xóa riêng được; không tạo bản xem trước thì không xem trước được `.avi`, `.mkv`, nguồn bitrate cao (US2) |