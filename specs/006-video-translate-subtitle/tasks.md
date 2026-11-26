---
description: "Danh sách công việc triển khai tính năng 006 — Dịch video tự động và gắn đè phụ đề"
---

# Tasks: Dịch video tự động và gắn đè phụ đề

**Input**: `/specs/006-video-translate-subtitle/` ([spec.md](./spec.md), [plan.md](./plan.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md))

**Prerequisites**: Node.js 22, PostgreSQL 16 và MinIO của `docker/compose.dev.yml`, ffmpeg và ffprobe trong PATH. Video kiểm thử tự động ≤ 10 giây, tạo bằng ffmpeg trong kiểm thử. Soniox luôn là bản giả; **không gọi nhà cung cấp thật** trừ T041 (cần người dùng đồng ý).

**Trước T001** (hiến pháp 1.4.0): xác nhận đang ở nhánh `main` (không thì dừng và hỏi); ghi lại danh sách tệp đang thay đổi hoặc chưa theo dõi để không gộp nhầm vào commit của tính năng. Không tạo, chuyển hay push nhánh khác.

**Tests**: BẮT BUỘC (hiến pháp V, FR-061). Trong mỗi phase, viết kiểm thử trước và thấy nó trượt rồi mới cài đặt.

**Organization**: theo user story: US1, US2, US3 (P1) → US4, US5, US6, US7 (P2) → US8, US9, US10 (P3).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: làm song song được (khác tệp, không phụ thuộc task chưa xong).
- **[USn]**: user story trong spec.md.
- **i18n**: task nào thêm chữ hoặc mã lỗi thì tự thêm khóa vào `src/lib/i18n/vi.ts` và `src/lib/i18n/en.ts` trong chính task đó, nên các task đó không đánh dấu [P].
- **Task giao diện** mang sẵn dòng checklist của vị trí nó viết (đọc mã ngày 2026-11-26; mã khác thì theo mã) và ba bước: (1) đọc lại checklist trước khi viết; (2) xong thì báo sẵn sàng kiểm: một người kiểm **không phải người viết**, dùng chung cho mọi trang cùng loại, đối chiếu bằng `ui-consistency:verifying`, sửa theo báo cáo; (3) ghi `done` hoặc `parked — <lý do>` ngay tại task. Người kiểm là agent hoặc phiên riêng: hỏi người dùng trước khi chạy.
- **Thêm phụ thuộc hoặc tải tệp** (npm, phông chữ): hỏi người dùng trước.

---

## Phase 1: Setup

**Purpose**: mốc ban đầu và cổng kiểm chứng trong ảnh worker

- [ ] T001 Chạy `npm run lint`, `npm run check:i18n`, `npm test`, `npm run test:isolation`; ghi ca trượt có sẵn vào mục Notes của `specs/006-video-translate-subtitle/tasks.md`.
- [ ] T002 Viết `scripts/video-bench.ts`: vẽ chữ bằng bộ vẽ hiện có (khung 16:9), chỉ đẩy dải chữ RGBA nhân sẵn alpha vào ffmpeg theo tham số ở `specs/006-video-translate-subtitle/contracts/render-and-media.md` §3; in tốc độ so với thời gian thực cho 1080p và 4K, và kiểm ffmpeg có `zscale`, `tonemap`, `overlay`, bộ tách `mov`, `matroska`, `avi`, `flv`, bộ mã `libx264`, `aac`, `libmp3lame`.
- [ ] T003 **CỔNG**: dựng lại ảnh worker (`docker/Dockerfile`), chạy `scripts/video-bench.ts` trong ảnh (ffmpeg 5.1), ghi số đo vào `specs/006-video-translate-subtitle/research.md` R1. Đạt khi 1080p ≥ 0,5 lần thời gian thực (SC-010) và đủ bộ lọc, bộ tách, bộ mã. Không đạt thì xem lại R1/R3 với người dùng trước Phase 2.

---

## Phase 2: Foundational

**Purpose**: CSDL, quyền, dung lượng, lưu trữ, dọn dẹp và phần mở rộng bộ vẽ mà mọi story cần

**⚠️ CRITICAL**: chưa làm user story nào trước khi xong phase này.

### Dữ liệu và cấu hình

- [ ] T004 Tạo `src/lib/db/schema/video.ts`: `video_project_settings` (`direction`: `to_vi` mặc định | `vi_to_en`; `glossary` jsonb `[{ source, target, keep }]`; `style` jsonb) và `video_jobs` đúng mọi cột của data-model §1.2 (`original_file_name` ≤ 255; `ext` `mp4|mov|mkv|webm|avi|flv|m4v`; `source_state` `uploading|checking|ready|deleted|rejected`; `preview_state` `none|pending|ready|failed`; `preview_heartbeat_at`, `preview_attempt`; enum `video_job_status` `waiting_media, queued, preparing, translating, segmenting, review_ready, failed, stopped, interrupted`; chỉ mục `(project_id, created_at)`, `(owner_id, status)`, `(status, heartbeat_at)`, `(source_expires_at)`). Dung lượng `bigint`, khóa ngoại cascade.
- [ ] T005 Thêm vào `src/lib/db/schema/video.ts`: `video_uploads` (`kind` `source|client_audio`; `state` `active|completing|completed|aborted`; mỗi `(job_id, kind)` nhiều nhất một phiên `active|completing`) và `video_upload_parts` (khóa chính `(upload_id, n)`; `size`, `etag`, `sha256`).
- [ ] T006 Thêm vào `src/lib/db/schema/video.ts`: `video_cues` (`0 ≤ start`, `end − start ≥ 100`; `timing` `measured|estimated|manual`; `source_text`, `target_text` ≤ 2.000 ký tự; `flags` jsonb; chỉ mục `(job_id, start_ms)`), `video_exports` (`kind` `burn|layer`; `format` `mp4|mov`; enum `video_export_status` `queued, running, completed, failed, stopped, interrupted, expired`; một việc nhiều nhất một bản `queued|running|interrupted`), `video_job_logs`.
- [ ] T007 Thêm `can_translate_video boolean not null default false` và `video_used_bytes bigint not null default 0` (≥ 0) vào `src/lib/db/schema/auth.ts`; `video_job_id` (`set null`) vào `src/lib/db/schema/usage.ts`; xuất schema mới ở `src/lib/db/schema/index.ts`.
- [ ] T008 Sinh migration `src/lib/db/migrations/0009_video_translate.sql` và viết `tests/integration/migration-0009.test.ts` (áp trên CSDL có dữ liệu, giá trị mặc định, ràng buộc).
- [ ] T009 Thêm 13 cài đặt vào `src/lib/settings-defaults.ts` và khoảng hợp lệ vào `src/app/api/admin/settings/route.ts`: `userVideoQuotaBytes` 30 GB (1 GB–1 TB), `videoSystemCapBytes` 100 GB (1 GB–10 TB), `videoMaxBytes` 10 GB (100 MB–10 GB), `videoMaxMinutes` 180 (1 đến `videoProviderMaxMinutes`, kiểm chéo ở API), `videoMaxJobsPerUser` 1 (1–10), `maxConcurrentVideoRenders` 1 (1–4), `videoSourceRetainHours` 48 (1–720), `videoIdleRetainDays` 7 (1–90), `videoOutputRetainDays` 7 (1–90), `videoProviderMaxMinutes` 300 (1–1000), `videoGlossaryMaxPairs` 200 (1–1000), `videoGlossaryMaxChars` 8000 (500–10000), `maxConcurrentVideoTranslations` 2 (1–10); giới hạn của nhà cung cấp chỉ nằm trong cài đặt; mở rộng `tests/integration/admin-settings.test.ts`.

### Kiểm thử nền (viết trước)

- [ ] T010 [P] Viết `tests/integration/video-quota.test.ts`: giữ chỗ, trần hệ thống, giới hạn việc đang chạy, nhiều yêu cầu đồng thời không vượt (FR-007, FR-008, FR-053, SC-015).
- [ ] T011 [P] Viết `tests/integration/video-permission.test.ts`: mặc định tắt, Administrator luôn được, bật tắt, thu hồi đặt cờ dừng (FR-008). Việc xem, tải, xóa sau khi thu hồi kiểm ở T075.
- [ ] T012 [P] Mở rộng `tests/integration/reconcile-storage.test.ts`: hạn mức 500 MB loại `video/` và `video-tmp/`, cộng `script_bytes`; bộ đếm video được đối soát riêng (FR-053, FR-055).
- [ ] T013 [P] Viết `tests/integration/storage-multipart.test.ts`: tạo, tải phần, ghép, hủy, tải tệp từ đĩa theo multipart, đọc dải có hủy.
- [ ] T014 [P] Viết `tests/unit/video/scene.test.ts`: cách xuống dòng không đổi theo `k`; `\n` là ngắt bắt buộc; không điểm ảnh nào ngoài `sceneBand`; mọi cấu hình mẫu của Video Overlay vẽ ra không đổi một điểm ảnh (FR-036).

### Cài đặt nền

- [ ] T015 [P] Thêm khóa đối tượng vào `src/lib/storage/keys.ts` theo data-model §5 (nguồn, bản xuất dưới `video/`; âm thanh, bản xem trước, token thô dưới `video-tmp/`).
- [ ] T016 [P] Thêm vào `src/lib/storage/client.ts`: tạo, tải phần, liệt kê phần, ghép, hủy multipart; tải tệp trên đĩa theo multipart (thành phẩm có thể > 5 GB).
- [ ] T017 [P] Sửa `src/lib/storage/proxy.ts`: truyền `signal` cho lệnh đọc kho; tùy chọn giới hạn dải mở 8 MB; móc gia hạn thẻ giữ lượt tải mỗi 60 giây khi luồng còn chạy; mở rộng `tests/unit/range-proxy.test.ts`.
- [ ] T018 [P] Viết `src/lib/video/permission.ts` (`requireVideoPermission`, lỗi 403 `VIDEO_NOT_ALLOWED`).
- [ ] T019 Viết `src/lib/video/quota.ts`: giữ chỗ suy ra từ phiên tải mở và bản xuất đang chờ/chạy; trần hệ thống gồm cả bản xem trước; đếm việc đang chạy theo data-model §3.2; tất cả trong giao dịch có khóa tư vấn. Viết thêm `src/lib/video/expiry.ts` với `recomputeSourceExpiry(jobId, tx)` theo data-model §5: hàm duy nhất ghi `source_expires_at`.
- [ ] T020 Sửa `src/worker/jobs/reconcile-storage.ts` theo research R12.
- [ ] T021 Viết `src/lib/video/log.ts` (đi qua `redactDeep`, lưu khóa i18n) và thêm nhóm chữ `video.log`, `video.errors`, `video.status` vào `src/lib/i18n/vi.ts`, `en.ts`.
- [ ] T022 Thêm hàng đợi `video-prepare`, `video-translate`, `video-preview`, `video-render` và lịch `video-retention` vào `src/worker/queues.ts`; thời hạn ≤ 24 giờ, không retry tự động; đăng ký dần ở `src/worker/handlers.ts`.
- [ ] T023 Viết `src/lib/video/cleanup.ts` (dừng tiến trình, hủy phiên multipart theo bản ghi, xóa đối tượng, dữ liệu Soniox, trả cả hai hạn mức) và nối vào `src/lib/projects/delete.ts`, `src/worker/jobs/delete-user.ts`, `stopAllForUser` trong `src/lib/jobs/control.ts` (FR-057).
- [ ] T024 Thêm `canTranslateVideo` vào `src/lib/users/admin-service.ts` và `src/app/api/admin/users/[userId]/route.ts`; tắt quyền thì đặt cờ dừng cho tiến trình video đang chạy.
- [ ] T025 Mở rộng bộ vẽ: `createScene` nhận `SceneStyle` (kích thước khung chuẩn cạnh ngắn 1080, hệ số `k`) trong `src/lib/overlay/draw.ts`, `layout.ts`, `effects.ts`, `config.ts`; nhân mọi thông số điểm ảnh theo `k`; ngắt bắt buộc theo `\n`; thêm `sceneBand`. `ENGINE_VERSION` giữ nguyên.
- [ ] T026 Viết `src/lib/video/style.ts`: `VideoStyle` (zod) đúng data-model §2.1 (`size` 16–96; `weight` 400|600|700|800; viền 1–10; bóng `blur` 0–40, `distance` 0–20, `opacity` 0–100; hộp bo 0–60; `y` 0–100, ba vị trí 85/50/15; `maxWidthPct` 40–100 mặc định 80; `effectMs` 100–500 mặc định 250), mặc định, chuẩn hóa tổ hợp sai, đổi sang `SceneStyle`.

**Checkpoint**: nền xong; kiểm thử Video Overlay vẫn đạt.

---

## Phase 3: User Story 1 - Tải video lớn lên và nhận phụ đề đã dịch (Priority: P1) 🎯 MVP

**Goal**: tải video từng phần, tiếp tục được, nhận kịch bản song ngữ "chờ duyệt".

**Independent Test**: video tiếng Anh 5 phút, ngắt mạng rồi tiếp tục; nhận kịch bản tiếng Việt khớp mốc kèm câu gốc.

### Tests cho User Story 1 (viết trước)

- [ ] T027 [P] [US1] `tests/unit/video/segmentation.test.ts` theo contracts/subtitle-pipeline.md §1–§2 gồm mọi bất biến, cụm `none`, `untranslated`, chuỗi không khoảng trắng, ≤ 24 từ, ≤ 12 từ mỗi dòng, tối thiểu 700 ms (FR-014, FR-015, FR-018).
- [ ] T028 [P] [US1] `tests/integration/video-upload.test.ts`: định dạng, dung lượng, mã băm phần, gửi lại phần, tiếp tục, tệp khác trả `FILE_MISMATCH`, 429, hết hạn 48 giờ, hủy (FR-002, FR-004 đến FR-007).
- [ ] T029 [P] [US1] `tests/unit/video/probe.test.ts`: không có hình, không có tiếng, hỏng, quá thời lượng, quá 4096×2304, cờ xoay, nhiều luồng tiếng, tiếng bắt đầu muộn (FR-003). Tệp hỏng là lỗi vĩnh viễn, không thử lại; lỗi kho lưu tệp khi chuẩn bị là lỗi tạm, thử lại tối đa 3 lần (ca này ở `tests/integration/video-recovery.test.ts`) (FR-051, FR-061). Tệp giả dạng danh sách phát không mở được kết nối mạng.
- [ ] T030 [P] [US1] Thêm kết quả dịch vào `tests/mocks/soniox-mock.ts`; viết `tests/integration/video-translate.test.ts`: thân yêu cầu hai hướng, một bản ghi tính phí khi thành công và một bản ghi `ok = false` cho mỗi lần gọi lỗi, xóa dữ liệu ở nhà cung cấp, video tiếng muộn 1,5 giây cho cue đầu quanh 1,5 giây, chưa cấu hình bị chặn trước khi tải (FR-009, FR-012, FR-013, FR-017). Video không có lời nói báo lỗi rõ.
- [ ] T031 [P] [US1] `tests/integration/video-recovery.test.ts`: tắt giữa từng giai đoạn, chạy lại từ tệp token hoặc id Soniox, không tính phí lần hai, gián đoạn quá 3 lần thì lỗi, dừng và chạy lại; lỗi tạm (Soniox giả `429-<k>`, lỗi kho lưu tệp) thử lại tối đa 3 lần, lỗi vĩnh viễn (`401`, `402`, tệp hỏng) không thử lại (FR-047 đến FR-051, FR-061, SC-011). Dừng sau khi nhà cung cấp đã xong thì chạy lại không gọi lại (FR-017).

### Cài đặt — máy chủ

- [ ] T032 [US1] Viết `src/lib/video/uploads.ts`: phần 16 MB, kiểm `x-part-sha256` và độ dài, giữ tối đa 8 phần trong bộ nhớ (429 + `Retry-After`), hoàn tất an toàn khi gọi lại, hết hạn 48 giờ sau phần gần nhất, nhận diện tệp theo dung lượng + SHA-256 ba đoạn 1 MB. Gọi `recomputeSourceExpiry` trong cùng giao dịch khi đổi trạng thái hoặc có hoạt động.
- [ ] T033 [US1] Viết `src/lib/video/service.ts`: tạo, danh sách, chi tiết, xóa, dừng, chạy lại; trạng thái hiển thị theo data-model §3.2; mọi truy vấn theo `owner_id`, sai thì 404 (FR-044, FR-048, FR-056, FR-060). Dữ liệu trả về gồm `sourceExpiresAt`. Gọi `recomputeSourceExpiry` trong cùng giao dịch khi đổi trạng thái hoặc có hoạt động.
- [ ] T034 [US1] Viết route `src/app/api/projects/[projectId]/video/route.ts` và `.../video/jobs/route.ts` theo contracts/openapi-delta.yaml (mã lỗi `VIDEO_*`, `STT_NOT_CONFIGURED`).
- [ ] T035 [US1] Viết route `src/app/api/video/uploads/[uploadId]/route.ts`, `.../parts/[n]/route.ts`, `.../complete/route.ts`; kiểm quyền ở mỗi phần.
- [ ] T036 [US1] Viết route `src/app/api/video/jobs/[jobId]/route.ts`, `stop`, `rerun` và SSE `events/route.ts` theo khuôn `src/app/api/jobs/[jobId]/events/route.ts`.
- [ ] T037 [US1] Thêm `probeVideo` và tham số chọn luồng tiếng cho `extractAudioToMp3File` trong `src/lib/audio/ffmpeg.ts` (giữ `aresample=async=1:first_pts=0`, ép bộ tách theo đuôi, `-protocol_whitelist file`).
- [ ] T038 [US1] Viết `src/worker/jobs/video-prepare.ts`: kiểm đĩa tạm, tải nguồn, `probeVideo`, từ chối kèm lý do, lưu `media`, tách âm thanh, nhịp tim, tiến độ 0–10%. Lỗi tạm (`STORAGE_UNAVAILABLE`, `RENDER_FAILED`, `RENDER_STALLED`) thử lại tối đa 3 lần, chờ tăng dần; lỗi vĩnh viễn (`SOURCE_UNREADABLE`, `VIDEO_UNSUPPORTED`, `QUOTA_EXCEEDED`, `DISK_FULL`) không thử lại; gián đoạn quá 3 lần thì báo lỗi. ffmpeg/ffprobe đọc tệp không tin cậy với `-protocol_whitelist file` và ép bộ tách theo đuôi; chạy ưu tiên CPU thấp, tối đa số luồng − 2.
- [ ] T039 [US1] Mở rộng `src/lib/providers/adapters/soniox.ts` và `soniox-types.ts`: `translation` một chiều, `context.translation_terms`, `language_hints` cho hướng Việt → Anh.
- [ ] T040 [US1] Thêm bản ghi sử dụng gắn `video_job_id` trong `src/lib/usage/record.ts`: một bản ghi `ok = true` khi dịch xong và một bản ghi `ok = false` (chi phí 0) cho mỗi lần gọi Soniox thất bại, như spec 004 (FR-016, hiến pháp IV).
- [ ] T041 [US1] **CỔNG (người dùng đồng ý, có phí)**: viết `scripts/soniox-check.ts` dùng client của T039, gọi Soniox thật một lần với video Anh hoặc Nhật 3 phút và từ điển đúng mức mặc định của cài đặt; đối chiếu thứ tự cụm token, `translation_status: none`, giới hạn ngữ cảnh; ghi vào `specs/006-video-translate-subtitle/research.md` R5 và sửa `specs/006-video-translate-subtitle/contracts/subtitle-pipeline.md` §1 nếu khác, trước khi viết bộ gom cue. Chưa được đồng ý thì `parked`, làm tiếp theo tài liệu và nêu khi bàn giao.
- [ ] T042 [US1] Viết `src/lib/video/segmentation.ts` theo contracts/subtitle-pipeline.md §1–§2.
- [ ] T043 [US1] Viết `src/worker/jobs/video-translate.ts` theo research R5 (gửi kèm từ điển đã chụp trong việc; token thô → bản ghi sử dụng → cue → xóa dữ liệu nhà cung cấp), tiến độ 10–50%, thử lại tối đa 3 lần cho lỗi tạm; đăng ký ở `src/worker/handlers.ts`. Mỗi lần gọi lỗi ghi bản ghi `ok = false` (T040). Gọi `recomputeSourceExpiry` trong cùng giao dịch khi đổi trạng thái hoặc có hoạt động. Nhịp tim mỗi 2 giây; dừng khi có yêu cầu dừng, bản ghi bị xóa hoặc bị thu hồi quyền; chỉ ghi khi còn đang chạy và đúng lượt, như `src/worker/jobs/render-overlay.ts`. Giới hạn dịch đồng thời toàn hệ thống theo `maxConcurrentVideoTranslations` bằng khóa tư vấn, phần dư xếp hàng; `video-prepare` và `video-preview` mỗi worker 1 (FR-052). Lượt dịch lại: tăng `translation_run`, xóa id Soniox cũ, dùng lại MP3 đã tách; cue cũ giữ nguyên tới khi lượt mới lưu xong, lượt mới lỗi thì giữ cue cũ. Dừng hoặc lỗi vĩnh viễn: có kết quả thì lưu tệp token trước rồi xóa dữ liệu và id Soniox; gián đoạn thì giữ id để tiếp tục (FR-017). Không có lời nói: lỗi `NO_SPEECH_DETECTED` kèm cách xử lý, vẫn ghi bản ghi tính phí.
- [ ] T044 [US1] Mở rộng `src/worker/sweeper.ts`: việc video mất nhịp tim, phiên tải hết hạn. Gồm cả bản xem trước mất nhịp tim (`preview_heartbeat_at`).

### Cài đặt — giao diện

- [ ] T045 [US1] Hiệu chỉnh người kiểm cho loại **tab của Project**: chép `src/components/overlay/overlay-tab.tsx` vào worktree tạm ngoài repo, cố ý viết khác một vai trò, giao người kiểm khác dùng `ui-consistency:verifying` với checklist của T048–T050, chỉ nói rằng bản chép có khác đâu đó. Không phát hiện thì dừng và báo. Hỏi người dùng trước khi chạy; ghi kết quả tại đây.
- [ ] T046 [US1] Viết `src/lib/video/upload-client.ts` (contracts/render-and-media.md §5: 3 phần song song bằng `XMLHttpRequest`, tạm dừng, thử lại 1–16 giây, tốc độ trung bình 10 giây, 401 thì tạm dừng) và `tests/unit/video/upload-client.test.ts`.
- [ ] T047 [US1] Viết `src/lib/hooks/use-video.ts` (danh sách hỏi lại 2 giây khi đang chạy, chi tiết qua SSE theo `src/lib/hooks/use-job-stream.ts`). Thêm bậc GB vào `fmtBytes` trong `src/lib/format.ts` kèm kiểm thử.
- [ ] T048 [US1] Viết `src/components/video/video-tab.tsx` và thêm tab vào `src/components/projects/project-detail.tsx` (FR-001). Mẫu: `src/components/overlay/overlay-tab.tsx`.
  - Thẻ tab: `TabsTrigger` nhãn kèm số lượng (5/5 tab), thêm `Badge` số đang chạy như overlay.
  - Tiêu đề vùng `h2` `text-base font-semibold`, mô tả `text-xs text-muted-foreground`; bố cục `grid grid-cols-1 gap-6 lg:grid-cols-12`.
  - `LoadingList`, `ErrorState` (có thử lại), `EmptyState` (5/5 tab).
  - Ghi chú âm thanh được gửi cho nhà cung cấp bên ngoài trước lần dùng đầu (FR-058); User không có quyền thấy cách xin quyền.
  - Không chép: chữ trạng thái riêng của overlay, nút "dùng lại cấu hình".
  - Ba bước: đọc lại checklist; gửi người kiểm; ghi `done` hoặc `parked`.
- [ ] T049 [US1] Viết `src/components/video/upload-panel.tsx` (chọn tệp, hướng dịch, tạm dừng, tiếp tục, hủy, phần trăm, MB/s, thời gian còn lại). Mẫu: `src/components/overlay/source-picker.tsx`.
  - Chọn tệp bằng `shared/file-dropzone.tsx`; tiến độ bằng `Progress` `h-1.5`, số `tabular-nums`; lỗi trong dòng `role="alert"` `text-xs text-destructive`; phản hồi bằng `toast` của `sonner`; nút `Button size="sm" variant="outline"`.
  - Chữ qua `useT()`; chọn tiếp đúng tệp khi quay lại, tệp khác thì hỏi tạo việc mới.
  - Không chép: danh sách tệp âm thanh của overlay.
  - Ba bước: đọc lại checklist; gửi người kiểm; ghi `done` hoặc `parked`.
- [ ] T050 [US1] Viết `src/components/video/video-job-list.tsx` (danh sách, tiến độ, nhật ký, dừng, chạy lại, xóa một); cột tên tệp, dung lượng, thời lượng, hướng dịch, trạng thái, tiến độ, ngày xóa video nguồn (FR-044, FR-054). Mẫu: `src/components/overlay/overlay-job-list.tsx`.
  - `shared/data-table.tsx`; trước hết thêm prop tùy chọn `label` vào `src/components/jobs/status-badge.tsx` (các nơi đang dùng không đổi) để hiện đủ trạng thái FR-048: đang tải lên, chuẩn bị, đang dịch, đang xuất dùng tông `running`; chờ duyệt dùng tông `queued`; `Progress` `h-1.5` kèm phần trăm.
  - Nhật ký bằng `shared/event-log.tsx` trong `Dialog` `max-h-[90dvh] overflow-y-auto sm:max-w-2xl`.
  - Xóa qua `shared/confirm-dialog.tsx` nêu số lượng, dung lượng, hậu quả; nút xóa `size="icon" variant="ghost"` kèm `aria-label`.
  - Không chép: "Xem cấu hình", "Dùng lại cấu hình".
  - Hộp xác nhận dừng khi đang dịch (`shared/confirm-dialog.tsx`) nói rõ: chưa có kết quả thì chạy lại sẽ phát sinh phí mới (FR-017).
  - Ba bước: đọc lại checklist; gửi người kiểm; ghi `done` hoặc `parked`.
- [ ] T051 [US1] (dùng `ui-consistency:adjusting`) Thêm cột và nút bật tắt quyền Dịch Video trong `src/components/admin/users-table.tsx`, theo cặp nút khóa/mở khóa; thu hồi có `ConfirmDialog` nêu tiến trình đang chạy sẽ dừng. Ghi `done` hoặc `parked`.
- [ ] T052 [US1] (dùng `ui-consistency:adjusting`) Thêm 13 ô cài đặt của T009 vào `src/components/admin/system-settings-form.tsx` theo cách các ô hiện có. Ghi `done` hoặc `parked`.
- [ ] T053 [US1] Thêm Soniox giả vào `mock-provider/server.ts` và viết `tests/e2e/video-upload.spec.ts` (desktop và 375 px).
- [ ] T054 [US1] Chạy Independent Test của US1 theo `specs/006-video-translate-subtitle/quickstart.md` §1 và ghi kết quả tại đây; không đạt thì story chưa xong (hiến pháp V).

**Checkpoint**: tải lên và dịch được từ đầu tới "chờ duyệt".

---

## Phase 4: User Story 2 - Duyệt và sửa phụ đề trên trình phát đồng bộ (Priority: P1)

**Goal**: xem video có phụ đề nổi, sửa chữ và mốc, tự lưu, hoàn tác.

**Independent Test**: sửa chữ, dịch mốc ±100 ms, gộp, tách, tải lại trang vẫn còn.

### Tests (viết trước)

- [ ] T055 [P] [US2] `tests/unit/video/cue-ops.test.ts`: tất cả hoặc không, lô nghịch đảo, gộp, tách, kẹp ±100/±500 ms, `end − start ≥ 100`, không chồng, không vượt thời lượng (FR-023, FR-024).
- [ ] T056 [P] [US2] `tests/integration/video-cues.test.ts`: `CUE_CONFLICT`, `CUE_INVALID`, `script_bytes` và hạn mức 500 MB đầy vẫn lưu, 3.000 cue (FR-055).

### Cài đặt

- [ ] T057 [US2] Viết `src/lib/video/cue-ops.ts` theo contracts/subtitle-pipeline.md §3 (`ops` 1–20.000).
- [ ] T058 [US2] Viết `src/lib/video/cues.ts` (giao dịch theo `cue_revision`, tối đa 20.000 cue, cập nhật `script_bytes`, `last_activity_at`). Gọi `recomputeSourceExpiry` trong cùng giao dịch khi đổi trạng thái hoặc có hoạt động.
- [ ] T059 [US2] Viết route `src/app/api/video/jobs/[jobId]/cues/route.ts` và `cues/ops/route.ts`.
- [ ] T060 [US2] Viết route `src/app/api/video/jobs/[jobId]/media/route.ts` (`kind` `source|preview|audio`, Range, thẻ giữ lượt tải).
- [ ] T061 [US2] Viết `src/worker/jobs/video-preview.ts` (khi nguồn không phát được phổ biến, cao hơn 1080 hoặc trên 8 Mbps; 720p CRF 28, khung khóa 2 giây); xếp việc từ `video-prepare.ts`; kiểm trong `tests/integration/video-translate.test.ts`. Nhịp tim mỗi 2 giây; dừng khi có yêu cầu dừng, bản ghi bị xóa hoặc bị thu hồi quyền; chỉ ghi khi còn đang chạy và đúng lượt, như `src/worker/jobs/render-overlay.ts`. Dùng `preview_heartbeat_at`, `preview_attempt`. Lỗi tạm (`STORAGE_UNAVAILABLE`, `RENDER_FAILED`, `RENDER_STALLED`) thử lại tối đa 3 lần, chờ tăng dần; lỗi vĩnh viễn (`SOURCE_UNREADABLE`, `VIDEO_UNSUPPORTED`, `QUOTA_EXCEEDED`, `DISK_FULL`) không thử lại; gián đoạn quá 3 lần thì báo lỗi. ffmpeg/ffprobe đọc tệp không tin cậy với `-protocol_whitelist file` và ép bộ tách theo đuôi; chạy ưu tiên CPU thấp, tối đa số luồng − 2.
- [ ] T062 [US2] Hỏi người dùng, rồi thêm `@tanstack/react-virtual` vào `package.json`.
- [ ] T063 [US2] Hiệu chỉnh người kiểm cho loại **trang chi tiết dưới Project**: như T045 nhưng chép `src/components/player/voice-view.tsx`, checklist của T064–T068. Ghi kết quả tại đây.
- [ ] T064 [US2] Viết `src/app/(app)/projects/[projectId]/video/[jobId]/page.tsx` và `src/components/video/editor.tsx`. Mẫu: `src/components/player/voice-view.tsx`.
  - Đầu trang `h1` `truncate text-2xl font-semibold`; nút về Project `Button asChild variant="outline" size="sm"` bọc `Link`.
  - `LoadingList`, `ErrorState` với thông báo riêng cho 404.
  - Nhóm chức năng bằng `Tabs`; xem trước ở cột phải `lg:sticky lg:top-4`, lên đầu trên điện thoại.
  - Không chép: ô chọn voice khác, tab "văn bản gốc".
  - Khi video có nhiều luồng tiếng, nêu rõ đang dùng luồng nào.
  - Ba bước: đọc lại checklist; gửi người kiểm; ghi `done` hoặc `parked`.
- [ ] T065 [US2] Viết `src/components/video/video-preview.tsx` (`<video>` hoặc `<audio>` + `<canvas>`, `requestVideoFrameCallback`, chỉ vẽ khi khóa khung đổi, ưu tiên tệp trên máy → bản xem trước → nguồn; báo rõ khi chưa phát được hình). Mẫu: `src/components/overlay/preview-player.tsx`.
  - Cột phải `lg:sticky lg:top-4`; trạng thái bằng `LoadingList`, `ErrorState`; chữ qua `useT()`; màu chữ trong `<canvas>` là nội dung người dùng, mọi màu khác theo theme.
  - Không chép: điều khiển chỉ dành cho âm thanh của `overlay/preview-player.tsx`.
  - Ba bước: đọc lại checklist; gửi người kiểm; ghi `done` hoặc `parked`.
- [ ] T066 [US2] Viết `src/components/video/cue-list.tsx` (hai cột gốc/dịch, ảo hóa, tô sáng, bấm để tua). Mẫu: `src/components/player/synced-text.tsx`.
  - Tự cuộn vào giữa, ngưng 3,5 giây khi người dùng tự cuộn, tôn trọng `prefers-reduced-motion`, bấm để phát từ cue.
  - `EmptyState` khi không có cue; chữ qua `useT()`; khoảng cách theo theme.
  - Không chép: gộp nhiều cue trong một đoạn và nhãn "lỗi"/"tràn" của voice.
  - Ba bước: đọc lại checklist; gửi người kiểm; ghi `done` hoặc `parked`.
- [ ] T067 [US2] Viết `src/components/video/cue-editing.tsx` và `src/lib/hooks/use-cue-editor.ts`: sửa tại chỗ, ±100/±500 ms, nhập mốc, gộp, tách, thêm, xóa, tự lưu sau 800 ms, hoàn tác và làm lại, báo tải lại khi xung đột.
  - Nút `Button size="sm" variant="outline"`; xóa qua `shared/confirm-dialog.tsx` nêu số lượng và hậu quả; phản hồi `toast`; lỗi `role="alert"`.
  - Mẫu: `src/components/player/synced-text.tsx` cho hàng cue. Không chép: hàng là một nút bấm duy nhất (hàng ở đây có ô nhập).
  - Ba bước: đọc lại checklist; gửi người kiểm; ghi `done` hoặc `parked`.
- [ ] T068 [US2] Viết `src/components/video/timeline.tsx` (kéo mốc bắt đầu, kết thúc; dùng được bằng bàn phím). Thành phần mới do spec nêu tên (FR-023).
  - Màu và khoảng cách theo theme; nút theo `Button`; chữ qua `useT()`.
  - Mẫu: thanh tua trong `src/components/player/voice-player.tsx`. Không chép: nút tốc độ, âm lượng.
  - Ba bước: đọc lại checklist; gửi người kiểm; ghi `done` hoặc `parked`.
- [ ] T069 [US2] `tests/e2e/video-editor.spec.ts`: đồng bộ, sửa, hoàn tác, hai tab, 375 px (FR-022).
- [ ] T070 [US2] Chạy Independent Test của US2 theo `specs/006-video-translate-subtitle/quickstart.md` §2 và ghi kết quả tại đây; không đạt thì story chưa xong (hiến pháp V).

**Checkpoint**: sửa được kịch bản đã dịch.

---

## Phase 5: User Story 3 - Xuất video gắn cứng phụ đề và tải tệp phụ đề (Priority: P1)

**Goal**: `.mp4` gắn phụ đề, `.srt`/`.vtt`; tự xóa theo hạn. **Mốc MVP.**

**Independent Test**: xuất video 5 phút, so thời lượng, kích thước, số khung, tiếng với nguồn; tải hai tệp phụ đề.

### Tests (viết trước)

- [ ] T071 [P] [US3] `tests/unit/video/subtitle-files.test.ts` theo contracts/subtitle-pipeline.md §6 (FR-039).
- [ ] T072 [P] [US3] `tests/integration/video-render.test.ts` (ffmpeg thật): thời lượng lệch ≤ 100 ms, giữ số khung khi tốc độ thay đổi, cờ xoay, chép tiếng AAC, chuyển Opus, `.avi`, HDR có cảnh báo, vượt hạn mức không lưu; lỗi dựng hình hoặc kho lưu tệp được thử lại tối đa 3 lần, tệp nguồn hỏng, vượt hạn mức, hết đĩa thì không; tắt worker giữa lúc xuất rồi chạy lại; video thử có chớp sáng và tiếng bíp cùng lúc ở đầu và cuối, trong thành phẩm hai mốc lệch không quá 50 ms kể cả khi tốc độ khung hình thay đổi (FR-037, FR-042, FR-043, FR-050, FR-051, SC-008). Khi đang dịch và xuất video lớn, tiến trình voice, phụ đề, video overlay vẫn bắt đầu trong 10 giây nếu còn chỗ (FR-052).
- [ ] T073 [P] [US3] Thêm ca tải lại video nguồn đã xóa (đúng tệp thì xuất tiếp, tệp khác trả `FILE_MISMATCH`, không dịch lại) vào `tests/integration/video-upload.test.ts` (FR-046).
- [ ] T074 [P] [US3] `tests/integration/video-retention.test.ts`: nguồn 48 giờ sau lần xuất gần nhất, 7 ngày không hoạt động, thành phẩm 7 ngày, phiên dở 48 giờ, không xóa khi đang dùng; video được sửa ở ngày thứ 6 không bị xóa ở ngày thứ 7 (FR-054, SC-013).
- [ ] T075 [P] [US3] `tests/integration/video-deletion.test.ts`: xóa việc, Project, User khi đang tải dở và đang xuất; không còn đối tượng, phiên multipart; hai bộ đếm đúng (FR-057). User bị thu hồi quyền vẫn xem, tải, xóa được dữ liệu đã có (FR-008).
- [ ] T076 [P] [US3] Thêm mọi đường dẫn video đã có vào `tests/isolation/isolation.test.ts` (hai User và Administrator; trả 404) (FR-056, SC-012).

### Cài đặt

- [ ] T077 [US3] Viết `src/lib/video/subtitle-files.ts`.
- [ ] T078 [US3] Viết route `src/app/api/video/jobs/[jobId]/subtitles/route.ts` và `to-script/route.ts` (dùng `uploadScript`, giới hạn kịch bản hiện có) (FR-040).
- [ ] T079 [US3] Viết `src/lib/video/estimate.ts`: `thời lượng × (maxrate + tiếng) / 8 × 1,05`; thời gian ước tính theo độ phân giải; cảnh báo HDR, ký tự thiếu; ghi rõ là ước tính. Cảnh báo cả khi phải làm tròn kích thước hình.
- [ ] T080 [US3] Viết `src/lib/video/exports.ts`: chốt cue và kiểu, giữ chỗ, dừng, chạy lại, xóa, hết hạn. Gọi `recomputeSourceExpiry` trong cùng giao dịch khi đổi trạng thái hoặc có hoạt động.
- [ ] T081 [US3] Viết route `src/app/api/video/jobs/[jobId]/exports/route.ts`, `exports/estimate/route.ts`, `src/app/api/video/exports/[exportId]/route.ts`, `video`, `stop`, `rerun`.
- [ ] T082 [US3] Viết route `src/app/api/video/jobs/[jobId]/source/route.ts` (phiên tải lại, so nhận diện tệp) và nối vào `src/lib/video/uploads.ts` (FR-046).
- [ ] T083 [US3] Thêm `BurnTask` và mã `SOURCE_UNREADABLE` vào `src/worker/render/protocol.ts`; thêm tham số gắn cứng đúng contracts/render-and-media.md §3 vào `src/worker/render/ffmpeg-args.ts` kèm `tests/unit/video/burn-args.test.ts` (`maxrate` = max(1,3 × nguồn; 720p 4, 1080p 8, 4K 24 Mbps)) (FR-038).
- [ ] T084 [US3] Thêm chế độ gắn cứng vào `src/worker/render/main.ts` (chỉ vẽ dải chữ, dùng lại bộ đệm khi khóa trùng, dừng sớm khi vượt chỗ).
- [ ] T085 [US3] Viết `src/worker/jobs/video-render.ts`: giới hạn đồng thời bằng khóa tư vấn, kiểm đĩa tạm (nguồn + ước tính + 1 GB), tiến độ 50–100%, tải lên multipart, một giao dịch trừ hạn mức và hoàn tất, đặt hạn xóa (FR-050, FR-052). Gọi `recomputeSourceExpiry` trong cùng giao dịch khi đổi trạng thái hoặc có hoạt động. Nhịp tim mỗi 2 giây; dừng khi có yêu cầu dừng, bản ghi bị xóa hoặc bị thu hồi quyền; chỉ ghi khi còn đang chạy và đúng lượt, như `src/worker/jobs/render-overlay.ts`. Lỗi tạm (`STORAGE_UNAVAILABLE`, `RENDER_FAILED`, `RENDER_STALLED`) thử lại tối đa 3 lần, chờ tăng dần; lỗi vĩnh viễn (`SOURCE_UNREADABLE`, `VIDEO_UNSUPPORTED`, `QUOTA_EXCEEDED`, `DISK_FULL`) không thử lại; gián đoạn quá 3 lần thì báo lỗi.
- [ ] T086 [US3] Mở rộng `src/worker/sweeper.ts` cho bản xuất.
- [ ] T087 [US3] Viết `src/lib/video/retention.ts` và `src/worker/jobs/video-retention.ts` (mỗi 10 phút). `retention.ts` chỉ đọc `source_expires_at`, không tự tính.
- [ ] T088 [US3] Viết `src/components/video/export-panel.tsx` (ước tính, cảnh báo, xuất, khóa kèm lý do khi nguồn chưa sẵn hoặc đã xóa, tải `.srt`/`.vtt`, lưu thành kịch bản), gắn vào `Tabs` của `editor.tsx`. Mẫu: `src/components/overlay/export-panel.tsx`.
  - Tiêu đề `h2` `text-base font-semibold`; `SelectField` từ `overlay/fields.tsx`; lỗi `role="alert"`; `toast`; chữ "ước tính" rõ ràng.
  - Không chép: lựa chọn nền và định dạng của overlay.
  - Ba bước: đọc lại checklist; gửi người kiểm; ghi `done` hoặc `parked`.
- [ ] T089 [US3] Thêm tải lại video nguồn vào `src/components/video/export-panel.tsx` dùng `upload-panel.tsx` (FR-046).
  - `FileDropzone`, `Progress`; lỗi `role="alert"`.
  - Mẫu: `src/components/overlay/source-picker.tsx`. Không chép: lựa chọn nguồn voice.
  - Ba bước: đọc lại checklist; gửi người kiểm; ghi `done` hoặc `parked`.
- [ ] T090 [US3] Viết `src/components/video/export-list.tsx` (tiến độ qua SSE, tải về, dừng, chạy lại, xóa, ngày hết hạn). Mẫu: `src/components/overlay/overlay-job-list.tsx`.
  - `shared/data-table.tsx`, `StatusBadge` (bản xuất `expired` dùng tông `stopped` với `label` "Hết hạn"), `Progress` `h-1.5`; tải về `Button size="sm" variant="outline"`; xóa qua `ConfirmDialog` nêu số lượng, dung lượng.
  - Không chép: "Xem cấu hình", "Dùng lại cấu hình".
  - Ba bước: đọc lại checklist; gửi người kiểm; ghi `done` hoặc `parked`.
- [ ] T091 [US3] `tests/e2e/video-export.spec.ts`: xuất, tải ba loại tệp, ngày xóa video nguồn và thành phẩm hiện đúng, nguồn đã xóa thì tải lại đúng video rồi xuất được.
- [ ] T092 [US3] Chạy Independent Test của US3 theo `specs/006-video-translate-subtitle/quickstart.md` §3 và §6 và ghi kết quả tại đây; không đạt thì story chưa xong (hiến pháp V).

**Checkpoint (MVP)**: US1–US3 dùng được từ đầu tới cuối.

---

## Phase 6: User Story 4 - Kiểu chữ, vị trí, song ngữ, vùng an toàn (Priority: P2)

**Goal**: tùy chỉnh kiểu và chế độ hiển thị, xem trước giống thành phẩm.

**Independent Test**: đổi từng thuộc tính trên video dọc và ngang, so khung xem trước với thành phẩm.

- [ ] T093 [P] [US4] `tests/unit/video/style.test.ts` và mở rộng `scene.test.ts`: song ngữ (cụm nằm trọn khung), bóng khoảng cách và độ đậm, 600, vùng an toàn (FR-026 đến FR-031).
- [ ] T094 [US4] Hỏi người dùng, rồi tải vào `public/fonts/overlay/` Oswald 400/600/700, Open Sans 400/600/700/800 và bản 600 của Be Vietnam Pro, Roboto, Montserrat, Inter kèm giấy phép; chạy `scripts/build-font-coverage.ts`.
- [ ] T095 [US4] Thêm họ phông và độ đậm 600 vào `src/lib/overlay/fonts.ts`; lọc danh sách của tab Video Overlay trong `src/components/overlay/typography-panel.tsx` về bộ cũ.
- [ ] T096 [US4] Thêm khối thứ hai (song ngữ), bóng khoảng cách và độ đậm vào `src/lib/overlay/draw.ts`, `layout.ts`.
- [ ] T097 [P] [US4] Viết `src/lib/video/safe-zones.ts` (TikTok, Shorts, Reels theo phần trăm khung 9:16, ghi rõ là mô phỏng gần đúng).
- [ ] T098 [US4] Viết route `src/app/api/video/jobs/[jobId]/style/route.ts` và `src/app/api/projects/[projectId]/video/settings/route.ts` (kiểu gần nhất, về mặc định). Gọi `recomputeSourceExpiry` trong cùng giao dịch khi đổi trạng thái hoặc có hoạt động.
- [ ] T099 [US4] Viết `src/components/video/style-panel.tsx` (bảng riêng, không tách mã của overlay; có nút về mặc định, tự lưu; gắn vào `Tabs` của `editor.tsx`) (FR-031). Mẫu: `src/components/overlay/typography-panel.tsx`.
  - `SliderField`, `SelectField`, `SwitchRow`, `shared/color-field.tsx` dùng bằng import; hàng `space-y-2`; nhóm có tiêu đề `h2` `text-base font-semibold`.
  - Không chép: giới hạn cỡ, viền, phông của overlay.
  - Ba bước: đọc lại checklist; gửi người kiểm; ghi `done` hoặc `parked`.
- [ ] T100 [US4] Thêm lớp vùng an toàn và cảnh báo chữ lấn vùng vào `src/components/video/video-preview.tsx` (lớp DOM riêng, không vào bộ vẽ).
  - Công tắc bằng `SwitchRow`/`SelectField`; cảnh báo `role="alert"`; màu theo theme.
  - Mẫu: `src/components/overlay/preview-player.tsx`. Không chép: ô bàn cờ nền trong suốt.
  - Ba bước: đọc lại checklist; gửi người kiểm; ghi `done` hoặc `parked`.
- [ ] T101 [US4] `tests/e2e/video-parity.spec.ts`: 20 thời điểm, 9:16 và 16:9, lệch ≤ 1% chiều cao (SC-009); thay đổi hiện ≤ 0,2 giây (SC-007).
- [ ] T102 [US4] Chạy Independent Test của US4 theo `specs/006-video-translate-subtitle/quickstart.md` §4 và ghi kết quả tại đây; không đạt thì story chưa xong (hiến pháp V).

---

## Phase 7: User Story 5 - Từ điển thuật ngữ (Priority: P2)

**Goal**: từ điển theo Project, dán hàng loạt, dịch lại có xác nhận.

**Independent Test**: nhập 10 cặp, dịch, đối chiếu; việc mới trong Project thấy từ điển.

- [ ] T103 [P] [US5] `tests/unit/video/glossary.test.ts` (`->` ưu tiên hơn dấu phẩy, "giữ nguyên", lỗi theo dòng, trùng nguồn, ≤ `videoGlossaryMaxPairs` mặc định 200, ≤ `videoGlossaryMaxChars` mặc định 8.000, đổi cài đặt thì giới hạn đổi theo) và ca dịch lại trong `tests/integration/video-translate.test.ts` (FR-019 đến FR-021).
- [ ] T104 [P] [US5] Viết `src/lib/video/glossary.ts`. Giới hạn nhận qua tham số lấy từ cài đặt, không viết cứng.
- [ ] T105 [US5] Lưu và kiểm từ điển ở route `video/settings`; chụp từ điển vào việc; viết `src/app/api/video/jobs/[jobId]/retranslate/route.ts` (`confirm: true`, `baseRevision`, `VIDEO_SOURCE_GONE`). Đọc giới hạn từ cài đặt khi kiểm ở máy chủ. Thêm `retranslate/estimate/route.ts`: thời lượng và chi phí ước tính theo đơn giá đã cấu hình, `null` khi chưa có (FR-016).
- [ ] T106 [US5] Viết `src/components/video/glossary-editor.tsx` (bảng dựng trên `Table`, thêm sửa xóa, dán hàng loạt), dùng ở tab và trang biên tập.
  - `ui/table.tsx`, `Input`, `Textarea`; xóa qua `ConfirmDialog`; lỗi theo dòng `role="alert"` `text-xs text-destructive`; ghi chú từ điển chỉ là chỉ dẫn cho máy dịch (FR-021).
  - Mẫu: `src/components/overlay/source-picker.tsx` cho bố cục vùng nhập. Không chép: ô chọn tệp, danh sách âm thanh.
  - Ba bước: đọc lại checklist; gửi người kiểm; ghi `done` hoặc `parked`.
- [ ] T107 [US5] Thêm hộp "Dịch lại" (nêu thời lượng, chi phí ước tính hoặc "chưa ước tính được", và việc chỉnh sửa tay bị thay) vào `src/components/video/editor.tsx`.
  - `shared/confirm-dialog.tsx`; `toast`; chữ qua `useT()`.
  - Mẫu: hộp xác nhận trong `src/components/overlay/overlay-job-list.tsx`. Không chép: chữ về xóa.
  - Ba bước: đọc lại checklist; gửi người kiểm; ghi `done` hoặc `parked`.
- [ ] T108 [US5] Chạy Independent Test của US5 theo `specs/006-video-translate-subtitle/quickstart.md` §5 và ghi kết quả tại đây; không đạt thì story chưa xong (hiến pháp V).

---

## Phase 8: User Story 6 - Tìm kiếm và thay thế hàng loạt (Priority: P2)

**Goal**: sửa lỗi lặp trong toàn kịch bản bằng một thao tác.

**Independent Test**: đếm, tô sáng, thay một, thay tất cả, tùy chọn, hoàn tác.

- [ ] T109 [P] [US6] `tests/unit/video/find-replace.test.ts`: không dấu và có dấu, `đ`, hoa/thường, cả từ tiếng Việt, dạng khớp, vị trí không còn khớp; 3.000 cue ≤ 2 giây (FR-025, SC-006).
- [ ] T110 [US6] Viết `src/lib/video/find-replace.ts` theo contracts/subtitle-pipeline.md §4.
- [ ] T111 [US6] Viết `src/components/video/find-replace.tsx` và tô sáng trong `cue-list.tsx`.
  - `Input`, `SelectField`, `SwitchRow`, `Button size="sm" variant="outline"`; số kết quả `tabular-nums`; xác nhận nhiều dạng khác dấu bằng `ConfirmDialog`; không có kết quả thì nói rõ.
  - Mẫu: `src/components/overlay/typography-panel.tsx` cho các hàng điều khiển. Không chép: tiêu đề và nhóm kiểu chữ.
  - Ba bước: đọc lại checklist; gửi người kiểm; ghi `done` hoặc `parked`.
- [ ] T112 [US6] Thêm ca tìm thay vào `tests/e2e/video-editor.spec.ts`.
- [ ] T113 [US6] Chạy Independent Test của US6 theo `specs/006-video-translate-subtitle/quickstart.md` §2 và ghi kết quả tại đây; không đạt thì story chưa xong (hiến pháp V).

---

## Phase 9: User Story 7 - Theo dõi, phục hồi và quản lý dung lượng (Priority: P2)

**Goal**: xóa nhiều, thấy dung lượng video đã dùng. (Dừng, phục hồi, tự xóa, hạn xóa và tải lại nguồn đã làm ở phase 2–5.)

**Independent Test**: khởi động lại ở từng giai đoạn, dừng, chạy lại, xóa nhiều; dung lượng đúng.

- [ ] T114 [P] [US7] Thêm ca xóa nhiều vào `tests/integration/video-upload.test.ts` (FR-045).
- [ ] T115 [US7] Viết route `src/app/api/video/jobs/bulk-delete/route.ts`.
- [ ] T116 [US7] Thêm chọn nhiều, dung lượng video đã dùng so với hạn mức vào `src/components/video/video-job-list.tsx` và `video-tab.tsx`.
  - `DataTable` có chọn nhiều và thanh "đã chọn n"; `ConfirmDialog` nêu số lượng, dung lượng; cỡ chữ phụ `text-xs text-muted-foreground`.
  - Mẫu: `src/components/overlay/overlay-job-list.tsx`. Không chép: tổng dung lượng chỉ của tệp đã xong (ở đây so với hạn mức video).
  - Ba bước: đọc lại checklist; gửi người kiểm; ghi `done` hoặc `parked`.
- [ ] T117 [US7] (dùng `ui-consistency:adjusting`) Thêm dung lượng video theo User và toàn hệ thống vào `src/app/api/admin/stats/route.ts` và `src/components/admin/admin-stats-view.tsx` (FR-053). Ghi `done` hoặc `parked`.
- [ ] T118 [US7] Chạy Independent Test của US7 theo `specs/006-video-translate-subtitle/quickstart.md` §6 và ghi kết quả tại đây; không đạt thì story chưa xong (hiến pháp V).

---

## Phase 10: User Story 8 - Hiệu ứng hoạt ảnh (Priority: P3)

**Goal**: hiệu ứng xuất hiện, theo từ, karaoke.

**Independent Test**: từng hiệu ứng giống nhau ở xem trước và thành phẩm.

- [ ] T119 [P] [US8] Mở rộng `tests/unit/video/scene.test.ts`: từng hiệu ứng, 100–500 ms, rút ngắn khi cue ngắn, mốc từ ước lượng trong cue, song ngữ chỉ áp cho dòng dịch, dải chữ bao hết chuyển động (FR-032 đến FR-035).
- [ ] T120 [US8] Nối hiệu ứng của `VideoStyle` vào `src/lib/video/style.ts`, `src/lib/overlay/effects.ts` (karaoke phóng 115%) và `sceneBand`.
- [ ] T121 [US8] Thêm nhóm hiệu ứng vào `src/components/video/style-panel.tsx`. Mẫu: `src/components/overlay/effects-panel.tsx`.
  - `SelectField`, `SliderField`, `ColorField`; ghi chú nhịp từng từ là ước lượng và với bản dịch từ được tô không phải từ đang nói; ẩn hoặc khóa thông số không áp dụng.
  - Không chép: hiệu ứng, cách biến mất và phạm vi rung không có trong `VideoStyle`.
  - Ba bước: đọc lại checklist; gửi người kiểm; ghi `done` hoặc `parked`.
- [ ] T122 [US8] Thêm ca hiệu ứng vào `tests/e2e/video-parity.spec.ts` và `tests/integration/video-render.test.ts`.
- [ ] T123 [US8] Chạy Independent Test của US8 theo `specs/006-video-translate-subtitle/quickstart.md` §4 và ghi kết quả tại đây; không đạt thì story chưa xong (hiến pháp V).

---

## Phase 11: User Story 9 - Lấy âm thanh trên máy người dùng (Priority: P3)

**Goal**: có phụ đề trong lúc video còn đang tải; thiếu khả năng thì im lặng chuyển luồng.

**Independent Test**: máy đủ khả năng có phụ đề trước khi tải xong; máy bị chặn vẫn hoàn tất.

- [ ] T124 [P] [US9] `tests/integration/video-client-audio.test.ts`: kiểm tệp không tin cậy, giới hạn ≤ 500 MB, lệch mốc bắt đầu > 100 ms thì dời cue không tính phí, lệch thời lượng > 1 giây so với **luồng tiếng nguồn** thì chờ xác nhận, `skip`, một bản ghi tính phí, âm thanh dài quá `videoMaxMinutes` bị từ chối trước khi gọi Soniox, video không đạt sau khi tải xong thì việc bị từ chối mà phụ đề vẫn tải được (FR-003, FR-010, FR-011).
- [ ] T125 [US9] Viết route `src/app/api/video/jobs/[jobId]/client-audio/route.ts` và `skip/route.ts`; xử lý âm thanh trình duyệt, đối chiếu và dời cue trong `src/worker/jobs/video-prepare.ts`. Trước khi gọi Soniox kiểm âm thanh đọc được, có tiếng, dài không quá `videoMaxMinutes`; video tải xong mà không đạt thì `source_state = rejected` (FR-003). ffmpeg/ffprobe đọc tệp không tin cậy với `-protocol_whitelist file` và ép bộ tách theo đuôi; chạy ưu tiên CPU thấp, tối đa số luồng − 2.
- [ ] T126 [US9] Hỏi người dùng, rồi thêm `mediabunny` vào `package.json`.
- [ ] T127 [US9] Viết `src/lib/video/extract-audio.worker.ts` và kiểm khả năng theo research R8 (chỉ `.mp4 .m4v .mov .mkv .webm`; `deviceMemory` ≥ 4 hoặc ≥ 4 luồng CPU; quá 5 phút thì bỏ; > 150 MB thì mã hóa mono 64 kbps nếu được). Không dùng luồng nhanh khi trình duyệt đọc thấy không có hình hoặc vượt 4096×2304.
- [ ] T128 [US9] Nối luồng nhanh vào `src/components/video/upload-panel.tsx` và `editor.tsx` (sửa được khi chưa tải xong, nút xuất khóa kèm tiến độ, hộp xác nhận khi âm thanh lệch).
  - `ConfirmDialog`, `Progress`; lỗi của luồng nhanh không hiện cho người dùng.
  - Mẫu: `src/components/overlay/source-picker.tsx` cho trạng thái đang xử lý. Không chép: lựa chọn nguồn voice.
  - Ba bước: đọc lại checklist; gửi người kiểm; ghi `done` hoặc `parked`.
- [ ] T129 [US9] Thử trên Chrome, Edge, Firefox, Safari với từng định dạng, kiểm mốc bắt đầu luồng; ghi bảng vào `specs/006-video-translate-subtitle/research.md` R8 và đưa định dạng không đạt vào danh sách luồng máy chủ trong `extract-audio.worker.ts`. Trình duyệt không có sẵn thì ghi vào `user-tasks.md`.
- [ ] T130 [US9] Chạy Independent Test của US9 theo `specs/006-video-translate-subtitle/quickstart.md` §7 và ghi kết quả tại đây; không đạt thì story chưa xong (hiến pháp V).

---

## Phase 12: User Story 10 - Xuất riêng lớp phụ đề (Priority: P3)

**Goal**: `.mp4` phông xanh hoặc `.mov` trong suốt, đúng kích thước và thời lượng nguồn.

**Independent Test**: xuất hai dạng, chèn lên nguồn trong phần mềm dựng phim, khớp mốc.

- [ ] T131 [P] [US10] Thêm ca lớp phụ đề vào `tests/integration/video-render.test.ts`: kích thước nguồn, nền, `VIDEO_LAYER_TOO_LONG`, tính hạn mức video, hết hạn 7 ngày (FR-041).
- [ ] T132 [US10] Hỗ trợ `kind: 'layer'` trong `src/lib/video/exports.ts`, `estimate.ts` (bảng của spec 005 nhân theo diện tích) và `src/worker/jobs/video-render.ts` (tác vụ `render` với kích thước bất kỳ, không tiếng).
- [ ] T133 [US10] Thêm lựa chọn lớp phụ đề vào `src/components/video/export-panel.tsx`.
  - `SelectField`; ghi phần mềm phù hợp; lỗi `role="alert"`.
  - Mẫu: `src/components/overlay/canvas-panel.tsx`. Không chép: tỉ lệ khung và nền xanh dương, đen.
  - Ba bước: đọc lại checklist; gửi người kiểm; ghi `done` hoặc `parked`.
- [ ] T134 [US10] Chạy Independent Test của US10 theo `specs/006-video-translate-subtitle/quickstart.md` §3 và ghi kết quả tại đây; không đạt thì story chưa xong (hiến pháp V).

---

## Phase 13: Polish & Cross-Cutting

- [ ] T135 Rà `src/lib/i18n/vi.ts`, `en.ts`; chạy `npm run check:i18n`.
- [ ] T136 Bổ sung mọi đường dẫn còn thiếu của openapi-delta vào `tests/isolation/isolation.test.ts`; kiểm nhật ký không có khóa trong `tests/integration/log-secrets.test.ts` (FR-056, FR-058).
- [ ] T137 Người kiểm đối chiếu toàn bộ tab và trang biên tập với checklist của các task giao diện bằng `ui-consistency:verifying`; sửa trong `src/components/video/`; ghi kết quả tại đây (FR-059).
- [ ] T138 [P] `tests/e2e/video-mobile.spec.ts`: 375 px, theme Sáng và Tối.
- [ ] T139 Đo SC-006, SC-007, SC-010 và thành phẩm so với nguồn (FR-038) trong ảnh worker; ghi vào `specs/006-video-translate-subtitle/research.md`.
- [ ] T140 [P] Viết `specs/006-video-translate-subtitle/user-tasks.md` cho việc cần người dùng hoặc máy triển khai (quickstart §8: SC-001 đến SC-005, SC-014, điều khoản Cloudflare, phần mềm dựng phim).
- [ ] T141 [P] Cập nhật `README.md` và `docs/operations.md` (quyền, hạn mức, chọn trần hệ thống thấp hơn ổ đĩa thật, đĩa tạm, tự xóa, đường hầm).
- [ ] T142 Chạy các mục tự động được của `specs/006-video-translate-subtitle/quickstart.md` và toàn bộ cổng chung; ghi kết quả tại đây.
- [ ] T143 Hoàn tất theo hiến pháp 1.4.0 (làm cuối cùng): mọi task đã `done`, task `parked` hoặc chờ người dùng thì dừng, nêu từng task và hỏi trước; chỉ commit thay đổi của tính năng, không commit bí mật; kéo `origin/main` mới (nếu có) và chạy lại kiểm thử; push `origin/main`; thông báo mã commit, kết quả push, kiểm thử, việc còn lại; đánh dấu T143 trong `specs/006-video-translate-subtitle/tasks.md`.

---

## Dependencies & Execution Order

### Phase

- **1 → 2**: T003 là cổng. Phase 2 chặn mọi story.
- **US1** (phase 3) trước **US2** (cần việc và cue) và **US3** (cần cue).
- **US2** trước **US3** về giao diện (bảng xuất nằm trong trang biên tập); phần máy chủ của US3 (T071–T087) chỉ cần US1.
- **US4** sau US2 và US3. **US5** sau US2 và T098 (route cài đặt Project). **US6** sau US2. **US7** sau US3. **US8** sau US4. **US9** sau US1, US2 và US3. **US10** sau US3.
- **Phase 13** sau mọi story; T143 làm cuối.

### Trong mỗi story

Kiểm thử (thấy trượt) → hàm thuần → dịch vụ → API → worker → giao diện → e2e → chạy Independent Test của story. Hiệu chỉnh người kiểm (T045, T063) trước task giao diện đầu tiên của loại đó được bàn giao.

### Tệp nhiều task cùng sửa (làm tuần tự)

`src/lib/i18n/vi.ts`, `en.ts`; `src/lib/db/schema/video.ts` (T004–T006); `src/lib/overlay/draw.ts`, `layout.ts` (T025, T096, T120); `src/worker/sweeper.ts` (T044, T086); `src/worker/handlers.ts`; `src/components/video/editor.tsx`, `export-panel.tsx`, `upload-panel.tsx`, `video-preview.tsx`, `video-job-list.tsx`.

## Parallel Examples

- **Nền**: T010, T011, T012, T013, T014 cùng lúc; sau đó T015, T016, T017, T018.
- **US1**: T027, T028, T029, T030, T031 cùng lúc.
- **US2**: T055, T056.
- **US3**: T071 đến T076 cùng lúc.
- **US4**: T093, T097.
- **Cuối**: T138, T140, T141.

## Implementation Strategy

1. **MVP**: Setup + Foundational + US1 + US2 + US3 (T001–T092). Dừng, kiểm theo quickstart §1–§3 và §6, rồi mới làm tiếp.
2. **Đợt 2**: US4 → US5 → US6 → US7.
3. **Đợt 3**: US8 → US9 → US10 → Polish.

**Commit và push**: tự động một lần ở T143 khi mọi task xong (hiến pháp 1.4.0). Dừng ở MVP hoặc giữa chừng thì không tự commit hay push; muốn phát hành sớm thì người dùng nói rõ.

## Notes

- Đề xuất giao diện trong plan: bảng kiểu chữ viết riêng, không tách mã của overlay (mặc định, T099); `StatusBadge` nhận thêm prop `label` tùy chọn (người dùng đồng ý sửa lỗi I3 ngày 2026-11-26, T050).
- Chỉ làm trên nhánh `main`. `[P]` không áp dụng cho task sửa i18n.
