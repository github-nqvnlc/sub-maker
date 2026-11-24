# Implementation Plan: Video overlay phụ đề chạy đồng bộ với voice

**Branch**: `main` (hiến pháp 1.3.0, không tạo nhánh khác) | **Date**: 2026-11-25 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/005-subtitle-video-overlay/spec.md`

## Summary

Thêm tab "Video Overlay" trong Project: chọn voice và phụ đề, chỉnh kiểu chữ và hiệu ứng với xem trước tức thì, rồi xuất video chữ trên phông màu hoặc nền trong suốt bằng tiến trình nền.

Hướng kỹ thuật ([research.md](./research.md)):

1. **Một bộ dựng hình dùng chung** viết trên API Canvas 2D: trình duyệt vẽ xem trước, tiến trình con của worker vẽ bằng `@napi-rs/canvas` rồi đẩy khung thô vào ffmpeg. Đo thử: độ rộng chữ giữa Chrome và thư viện lệch 0 px trên 244 cue; 60 giây video 1080×1920 xuất trong 15–30 giây trên máy dev (R1).
2. **Mốc**: dùng mốc đọc thật của voice khớp mốc khi đúng tệp, ngược lại dùng mốc tệp (R7); mốc từng từ ước lượng bằng trọng số, không gọi AI (R8).
3. **Nền**: hàng đợi riêng, nhận việc có khóa, nhịp tim, sweeper, dừng, chạy lại theo khuôn mẫu voice/STT đang có (R4, R12).
4. **Hạn mức**: kiểm ước tính (gồm việc đang chờ) khi tạo, trừ theo dung lượng thật khi xong (R11).

## Technical Context

**Language/Version**: TypeScript 5.9 (strict), Node.js 22

**Primary Dependencies**: Next.js 16 (App Router), React 19, Tailwind CSS 4, shadcn/ui, TanStack Query, Drizzle ORM, pg-boss, ffmpeg (đã có trong ảnh worker). **Phụ thuộc mới**: `@napi-rs/canvas` 1.2.x (MIT, có bản dựng sẵn cho linux x64/arm64 và Windows; chỉ worker dùng). Phông chữ TTF giấy phép mở (R9)

**Storage**: PostgreSQL 16, 4 bảng mới (`overlay_configs`, `overlay_audios`, `overlay_jobs`, `overlay_job_logs`), migration `0008`; MinIO cho video và âm thanh tải lên ([data-model.md](./data-model.md))

**Testing**: Vitest (unit, integration, isolation), Playwright (desktop và 375 px); dữ liệu ≤ 10 giây; không gọi nhà cung cấp AI ([quickstart.md](./quickstart.md))

**Target Platform**: Linux server (Docker: web + worker + postgres + minio + cloudflared); trình duyệt hiện đại, desktop và điện thoại

**Project Type**: Web application (một mã nguồn Next.js và tiến trình worker pg-boss)

**Performance Goals**: xuất `.mp4` nhanh hơn thời gian thực (SC-009); xem trước phản hồi ≤ 0,2 giây, tua ≤ 0,5 giây (SC-004); voice mới bắt đầu ≤ 10 giây khi đang xuất (SC-011)

**Constraints**: lệch mốc ≤ 50 ms và không trôi (SC-002, SC-003); xem trước giống video (SC-005); ảnh `web` không có ffmpeg; CSP `font-src 'self'`, `media-src 'self'`; một lần ghi đối tượng ≤ 5 GB; không giữ quá 2 khung (8,3 MB mỗi khung) trong bộ nhớ

**Scale/Scope**: video ≤ 60 phút (màu) hoặc ≤ 10 phút (trong suốt), khoảng 1.500 cue; 1 tiến trình xuất chạy cùng lúc mặc định; 11 đường dẫn API mới và 1 đường dẫn sửa (cài đặt Administrator); 1 tab mới, 1 trang cài đặt sửa

Không còn điểm NEEDS CLARIFICATION.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.* Nguồn: [constitution.md](../../.specify/memory/constitution.md) 1.3.0 (kiểm lại ngày 2026-11-25 sau khi thêm "Hoàn tất triển khai trên `main`").

| Nguyên tắc | Trước thiết kế | Sau thiết kế (Phase 1) |
| --- | --- | --- |
| I. Bảo mật và cô lập | ✅ FR-045 đến FR-047 | ✅ Mọi truy vấn kèm `owner_id`, sai thì 404; video và âm thanh phát qua `serveObject`; không có đường cho Administrator xem nội dung; route bọc `route()` và `requireUser`; kiểm thử cô lập cho cả tải video |
| II. Bí mật | ✅ Không có khóa mới | ✅ Tiến trình con không nhận biến môi trường bí mật; nhật ký đi qua `redactDeep`, lưu khóa i18n thay vì chuỗi lỗi thô |
| III. Tiến trình nền | ✅ FR-035 đến FR-042 | ✅ pg-boss, nhịp tim, sweeper, dừng, chạy lại, nhật ký lưu, tiến độ ≤ 2 giây; giới hạn đồng thời riêng; lỗi tạm ≤ 3 lần, lỗi vĩnh viễn không thử lại; gián đoạn lặp quá 3 lần thì báo lỗi thay vì chạy mãi |
| IV. Chi phí và dùng lại | ✅ Không gọi AI, hạn mức ở máy chủ | ✅ Không có bản ghi sử dụng vì không gọi nhà cung cấp; hạn mức kiểm nguyên tử khi tạo và khi xong; hệ số ước tính ghi rõ là ước tính; mọi giới hạn nằm trong cài đặt |
| V. Kiểm thử | ✅ FR-049 | ✅ Quickstart §1–§5 phủ từng user story và danh sách FR-049; không dùng nhà cung cấp thật trong kiểm thử tự động |
| VI. Giao diện | ✅ FR-048 | ✅ vi/en đủ khóa, thành phần shadcn/ui có sẵn, đủ trạng thái, xác nhận xóa có số lượng và hậu quả, dùng được ở 375 px |
| Mốc từng từ trong video overlay | ✅ Ước lượng, chỉ hiển thị | ✅ Không lưu mốc từng từ, suy ra từ mốc câu, giao diện ghi rõ ước lượng |
| Ràng buộc kỹ thuật | ✅ Next.js, shadcn, MinIO, Docker | ✅ Không mở cổng mới; tệp không công khai; phông chữ là tài nguyên tĩnh, không phải dữ liệu User |
| Phạm vi giai đoạn | ✅ Có từ 1.2.0 | ✅ Không làm highlight theo từ trong trình phát voice, không xuất phụ đề, không sửa chữ trong màn hình này |
| Hoàn tất triển khai trên `main` | ✅ Quy định từ 1.3.0 | ✅ Có bước ghi nhận thay đổi có sẵn trước T001 và task cuối commit, push, thông báo (T100) |

**Kết quả cổng**: ĐẠT trước và sau thiết kế, không có vi phạm cần biện minh.

## Project Structure

### Documentation (this feature)

```text
specs/005-subtitle-video-overlay/
├── plan.md                    # Tệp này
├── research.md                # Phase 0 (R1–R15, có số đo)
├── data-model.md              # Phase 1
├── quickstart.md              # Phase 1
├── contracts/
│   ├── openapi-delta.yaml     # API
│   └── overlay-engine.md      # Bộ dựng hình, mốc, tiến trình con
├── checklists/requirements.md
└── tasks.md                   # Do /speckit-tasks tạo
```

### Source Code (repository root)

```text
src/
├── lib/
│   ├── overlay/                       # MỚI
│   │   ├── config.ts                  # Zod, mặc định, normalizeConfig
│   │   ├── timing.ts                  # applyTiming
│   │   ├── words.ts                   # wordSpans
│   │   ├── layout.ts                  # layoutCue
│   │   ├── effects.ts, draw.ts        # drawFrame
│   │   ├── colors.ts                  # colorWarnings
│   │   ├── estimate.ts                # estimate
│   │   ├── fonts.ts                   # danh mục phông chữ, bảng ký tự
│   │   ├── service.ts                 # tiến trình: tạo, dừng, chạy lại, xóa, DTO
│   │   ├── audio-service.ts           # tệp âm thanh tải lên
│   │   └── cleanup.ts                 # thu thập và dọn khi xóa Project/User
│   ├── db/schema/overlay.ts           # MỚI (+ migrations/0008_overlay_video.sql)
│   ├── hooks/use-overlay.ts, use-overlay-canvas.ts  # MỚI
│   ├── storage/keys.ts                # thêm 3 khóa
│   ├── settings-defaults.ts           # thêm 4 cài đặt
│   ├── projects/delete.ts, jobs/control.ts
│   └── i18n/vi.ts, en.ts
├── worker/
│   ├── queues.ts, handlers.ts, sweeper.ts
│   ├── jobs/render-overlay.ts         # MỚI: nhận việc, nhịp tim, hạn mức, tải lên
│   ├── jobs/prepare-overlay-audio.ts  # MỚI
│   ├── jobs/delete-user.ts, reconcile-storage.ts
│   └── render/main.ts, ffmpeg-args.ts # MỚI: tiến trình con dựng hình
├── app/api/
│   ├── projects/[projectId]/overlay/  # route, timeline, audios, jobs
│   ├── overlay/                       # audios/*, jobs/*
│   └── admin/settings/route.ts
└── components/
    ├── overlay/                       # MỚI
    │   ├── overlay-tab.tsx            # bố cục tab
    │   ├── source-picker.tsx, canvas-panel.tsx, typography-panel.tsx, effects-panel.tsx
    │   ├── preview-player.tsx         # <canvas> + <audio>
    │   ├── export-panel.tsx, slider-field.tsx
    │   └── overlay-job-list.tsx
    ├── shared/color-field.tsx, event-log.tsx, file-dropzone.tsx  # MỚI (hai tệp sau tách từ mã có sẵn)
    ├── projects/project-detail.tsx    # thêm tab; stt-dialog, media-tab, upload-dropzone dùng thành phần tách
    └── admin/system-settings-form.tsx # thêm 4 ô
public/fonts/overlay/                  # MỚI: TTF, giấy phép, coverage.json
docker/Dockerfile                      # web: COPY public; worker: COPY public/fonts/overlay
tests/
├── unit/overlay/*.test.ts
├── integration/overlay-*.test.ts
└── e2e/overlay.spec.ts
```

**Structure Decision**: Giữ cấu trúc một mã nguồn hiện có. `src/lib/overlay/` chia hai nửa: phần bộ dựng hình thuần (dùng ở cả trình duyệt và tiến trình con, không nhập CSDL) và phần dịch vụ (chỉ máy chủ). Tiến trình con ở `src/worker/render/` chỉ nhập phần thuần.

## Thứ tự triển khai đề xuất

| Bước | Nội dung | User Story |
| --- | --- | --- |
| 0 | Kiểm chứng trong ảnh Docker: cài `@napi-rs/canvas`, `fork` dưới `tsx`, ffmpeg 5.1 có đủ bộ mã hóa, đo lại R1. **Cổng**: không đạt thì xem lại R1/R3 trước khi làm tiếp | nền |
| 1 | Migration, schema, cài đặt, phông chữ, Dockerfile | nền |
| 2 | Bộ dựng hình thuần: cấu hình, mốc, bố cục, `cut`, ước tính, cảnh báo màu | US1, US2 |
| 3 | Dịch vụ, API, worker, tiến trình con, dọn dẹp, cô lập; xuất `.mp4` theo câu | US1 |
| 4 | Tab, xem trước, bảng kiểu chữ | US1, US2 |
| 5 | Hiệu ứng câu và thông số | US3 |
| 6 | Mốc từ, theo từng từ, karaoke, đo SC-008 | US4 |
| 7 | Tải âm thanh từ máy; phụ đề `.srt` dùng lại `POST /api/projects/{projectId}/files` (FR-003) | US5 |
| 8 | Chọn nhiều, dùng lại cấu hình, xem cấu hình đã chốt, số đang chạy | US6 |
| 9 | Trong suốt `.mov`, `.webm` | US7 |
| 10 | Hiệu ứng điện ảnh | US8 |
| 11 | E2E đầy đủ, hiệu năng, kiểm tay phần mềm dựng phim, README và `docs/operations.md` | tất cả |

Dừng, hủy và dọn dẹp phía máy chủ làm ngay ở bước 3 vì Nguyên tắc III cần từ lần phát hành đầu; bước 8 là phần giao diện quản lý nâng cao. Xem nhật ký, chạy lại và xóa từng lần xuất có giao diện ngay ở US1 (Nguyên tắc III, FR-043).

**Giao diện**: `ui-consistency:finding-patterns` đã chạy khi lập tasks.md. Mẫu cần theo: bố cục hai cột của `media-tab.tsx`, `EmptyState`/`ErrorState`/`LoadingList`, `ConfirmDialog`, `DataTable` và `StatusBadge` của `job-table.tsx`, `Slider` và phần tử `<audio>` của `voice-player.tsx`, hàng `Switch` của `timing-options.tsx`. Người dùng đã đồng ý ngày 2026-11-25: tạo `shared/color-field.tsx`, `overlay/slider-field.tsx`; tách `shared/event-log.tsx` (từ `stt-dialog.tsx`) và `shared/file-dropzone.tsx` (từ ba bản chép). Checklist đã nằm trong từng task giao diện của tasks.md. Màu phông và màu chữ trong `<canvas>` là nội dung người dùng, không phải màu theme.

## Rủi ro

| Rủi ro | Xử lý |
| --- | --- |
| Máy production yếu, xuất chậm | Cổng ở bước 0; giảm băng thông theo R3; giới hạn 1 tiến trình mặc định |
| `.mov` trong suốt chỉ chứa khoảng 2–3,5 phút với 500 MB | Ước tính và gợi ý `.webm` trước khi xuất; thử QuickTime Animation (quickstart §6); Administrator nâng hạn mức |
| Chrome và Firefox/Safari xuống dòng khác nhau | So sánh ở quickstart §5 |
| Mốc từng từ ước lượng không đạt SC-008 | Hệ số chỉnh được; đo ở bước 6; không đạt thì quay lại spec |
| Cloudflare Tunnel chặn tệp tải lên gần 100 MB | Ghi vào hướng dẫn vận hành; gợi ý `.mp3`, `.m4a` |
| Thay đổi chưa commit của người dùng lẫn vào tệp của tính năng | Ghi nhận trước T001; T079 chờ người dùng commit `media-tab.tsx`; không tách được thì hỏi trước khi commit |
| Task chờ người dùng làm chưa thể tự push | T100 dừng, nêu từng task và hỏi người dùng |
| Đĩa tạm của worker đầy với `.mov` lớn | Kiểm chỗ trống trước khi chạy (`DISK_FULL`), dừng sớm khi vượt, dọn khi khởi động |

## Complexity Tracking

Không có vi phạm Constitution cần biện minh.
