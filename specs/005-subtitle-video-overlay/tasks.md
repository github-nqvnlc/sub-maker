---
description: "Danh sách công việc triển khai tính năng 005 — Video overlay phụ đề chạy đồng bộ với voice"
---

# Tasks: Video overlay phụ đề chạy đồng bộ với voice

**Input**: Design documents from `/specs/005-subtitle-video-overlay/` ([spec.md](./spec.md), [plan.md](./plan.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md))

**Prerequisites**: Node.js 22, PostgreSQL 16 và MinIO của `docker/compose.dev.yml`, ffmpeg và ffprobe trong PATH. Dữ liệu kiểm thử tự động ≤ 10 giây. Không gọi nhà cung cấp AI thật.

**Trước T001** (hiến pháp 1.3.0): xác nhận đang ở nhánh `main` (không thì dừng và hỏi); ghi lại danh sách tệp đang có thay đổi chưa commit hoặc chưa theo dõi để không gộp vào commit của tính năng. Không tạo, chuyển hay push nhánh khác.

**Tests**: BẮT BUỘC (Hiến pháp V, FR-049). Trong mỗi phase, viết test trước và thấy test thất bại rồi mới cài đặt.

**Organization**: theo user story, thứ tự ưu tiên của spec: US1, US2 (P1) → US3, US4, US5, US6 (P2) → US7, US8 (P3).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: làm song song được (khác tệp, không phụ thuộc task chưa xong).
- **[USn]**: user story trong spec.md.
- **i18n**: task nào thêm chữ giao diện hoặc mã lỗi thì tự thêm khóa vào `src/lib/i18n/vi.ts` và `src/lib/i18n/en.ts` trong chính task đó. Các task như vậy cùng sửa hai tệp này nên không đánh dấu [P].
- **Quy ước task giao diện**: mỗi task mang sẵn các dòng checklist của vị trí nó viết. Ba bước: (1) đọc lại checklist trước khi viết; (2) xong thì báo để người kiểm (dùng `ui-consistency:verifying`, không phải người viết) đối chiếu, sửa theo báo cáo; (3) ghi kết quả `done` hoặc `parked — <lý do>` ngay tại task. Checklist là ảnh chụp mã ngày 2026-11-25; mã khác thì theo mã.

---

## Phase 1: Setup

**Purpose**: phụ thuộc, phông chữ và cổng kiểm chứng trong ảnh Docker

- [X] T001 Thêm `@napi-rs/canvas` `^1.2.0` vào `dependencies` của `package.json` và cập nhật `package-lock.json`; thêm `@napi-rs/canvas` vào `serverExternalPackages` trong `next.config.ts`.
- [X] T002 Tải TTF tĩnh 400/700/800 của Be Vietnam Pro, Roboto, Montserrat, Inter; 400/700 của Arimo; Noto Sans 400/700 vào `public/fonts/overlay/`, kèm tệp giấy phép từng họ trong `public/fonts/overlay/licenses/`. Nguồn là kho chính thức google/fonts; hỏi người dùng trước khi tải.
- [X] T003 Viết `scripts/build-font-coverage.ts` đọc bảng `cmap` của các TTF (không thêm phụ thuộc), ghi `public/fonts/overlay/coverage.json` dạng khoảng mã ký tự theo họ phông chữ và độ đậm; thoát mã 1 nếu phông chữ nào thiếu ký tự tiếng Việt có dấu (NFC).
- [X] T004 Sửa `docker/Dockerfile`: tầng `web` thêm `COPY --from=build --chown=node:node /app/public ./public`; tầng `worker` thêm `COPY --chown=node:node public/fonts/overlay ./public/fonts/overlay`.
- [X] T005 Viết `scripts/overlay-bench.ts`: `fork` một tiến trình con dưới `tsx`, vẽ bằng `@napi-rs/canvas` với phông chữ ở T002, đẩy khung sang ffmpeg cho ba định dạng của research R5, in thời gian và dung lượng; nguồn chữ là tệp `.srt` truyền vào, thời lượng truyền vào.
- [X] T006 **CỔNG**: dựng ảnh worker, chạy `scripts/overlay-bench.ts` trong ảnh (60 giây: dứt khoát, karaoke, nhòe) và ghi số đo vào `specs/005-subtitle-video-overlay/research.md` R1. Đạt khi `.mp4` xuất không lâu hơn thời lượng video, ffmpeg của ảnh có `libx264`, `prores_ks`, `libvpx-vp9`, `aac`, `libopus`, và `fork` dưới `tsx` chạy được. Không đạt thì xem lại R1/R3 với người dùng trước khi sang Phase 2.

**Checkpoint**: cách dựng hình đã được chứng minh trong môi trường triển khai.

---

## Phase 2: Foundational

**Purpose**: CSDL, cài đặt, lưu trữ và bộ dựng hình thuần mà mọi user story cần

**⚠️ CRITICAL**: chưa làm user story nào trước khi xong phase này.

### Dữ liệu và cấu hình

- [X] T007 Tạo `src/lib/db/schema/overlay.ts` và export ở `src/lib/db/schema/index.ts` theo data-model §1–§4. Ràng buộc phải có: `overlay_configs.project_id` PK, `config` not null, `source` not null mặc định `{}`; `overlay_audios.original_name` not null ≤ 255, `status` enum `overlay_audio_status` (`processing`, `ready`, `failed`) mặc định `processing`, `size_bytes` bigint not null mặc định 0, ≥ 0, `duration_ms` null hoặc > 0 và bắt buộc khi `ready`, `interruptions` mặc định 0; `overlay_jobs.client_request_id` not null, unique `(owner_id, client_request_id)`, `format` enum `overlay_format` (`mp4`, `mov`, `webm`), `duration_ms` not null > 0, `estimated_bytes` bigint not null, `warnings` not null mặc định `[]`, `status` enum `job_status` có sẵn mặc định `queued`, `progress_percent` not null 0–100, `attempt` mặc định 0, `interruptions` not null mặc định 0, `cancel_requested` mặc định false, `output_size_bytes` null hoặc > 0, và `status = 'completed'` ⇔ `output_storage_key` và `output_size_bytes` khác NULL; `voice_id`, `audio_id`, `subtitle_file_id` FK `ON DELETE SET NULL`; `project_id`, `owner_id` FK cascade; `overlay_job_logs.job_id` FK cascade. Đủ chỉ mục nêu trong data-model.
- [X] T008 Viết tay `src/lib/db/migrations/0008_overlay_video.sql` khớp T007 và thêm mục vào `src/lib/db/migrations/meta/_journal.json`; kiểm thử trong `tests/integration/migration-0008.test.ts` (chạy trên CSDL đã có 0007, từng ràng buộc CHECK và unique bị từ chối đúng).
- [X] T009 [P] Thêm `maxOverlayJobsPerUser: 2`, `maxConcurrentOverlayJobs: 1`, `overlayMaxMinutes: 60`, `overlayMaxMinutesTransparent: 10` vào `src/lib/settings-defaults.ts`.
- [X] T010 [P] Thêm `overlayVideo`, `overlayAudio`, `overlayAudioTemp` (đường dẫn ở data-model §6) vào `src/lib/storage/keys.ts`.
- [X] T011 [P] Thêm hàng đợi `renderOverlay: 'render-overlay'` và `prepareOverlayAudio: 'prepare-overlay-audio'` (retryLimit 0, hết hạn 24 giờ và 2 giờ) cùng `enqueueRenderOverlay`, `enqueuePrepareOverlayAudio` vào `src/worker/queues.ts`.
- [X] T012 Tạo `tests/integration/overlay-helpers.ts` (cần T007, T008): tạo voice khớp mốc và voice đọc liên tục bằng cách ghi thẳng CSDL và MinIO từ `tests/fixtures/sample-10s.mp3` và `sample-10s.srt` (không gọi nhà cung cấp), gồm voice có câu bị tách và mục `failed`; hàm đọc điểm ảnh một khung của video bằng ffmpeg, hàm đọc thông tin video bằng ffprobe.

### Test bộ dựng hình (viết trước)

- [X] T013 [P] `tests/unit/overlay/config.test.ts`: mặc định hợp lệ; mọi khoảng giá trị của overlay-engine §1 (cỡ chữ 24–160, viền 1–20, bóng 0–40, bo góc 0–60, độ đục 0–100, độ rộng 40–100, `effectMs` 100–600 bước 10); trường lạ, màu sai, `800` với `arimo`, định dạng không hợp với nền đều bị từ chối; `normalizeConfig` sửa tổ hợp sai và trả danh sách trường đã sửa; `applyBackground` sang đen tắt viền đen mặc định, giữ viền màu khác.
- [X] T014 [P] `tests/unit/overlay/timing.test.ts`: bất biến của `applyTiming`; ghép theo chuỗi chữ (research R7) với cue ghép câu, câu bị tách, mục `failed` (chỉ cue chạm mục lỗi dùng mốc tệp), chuỗi không bằng nhau → `TIMELINE_FALLBACK`; kẹp thứ tự khi mốc voice trễ hơn mốc tệp đứng sau, mỗi cue ≥ 34 ms; cue không có chữ bị bỏ; voice ngắn hơn và dài hơn phụ đề; bốn loại `source` và đúng cảnh báo của từng loại (ngưỡng lệch 2 giây; `uploaded` không có `NOT_TIMED_VOICE`, `OTHER_FILE`).
- [X] T015 [P] `tests/unit/overlay/frames.test.ts`: `N = round(durationMs × 30 / 1000)`, thời điểm giữa khung; không trôi ở 60 phút; lệch mốc và thời lượng ≤ 16,7 ms.
- [X] T016 [P] `tests/unit/overlay/layout.test.ts`: xuống dòng tại khoảng trắng; từ dài hơn dòng mới bị ngắt và không tách cụm ký tự; canh trái/giữa/phải; khối luôn nằm trọn khung ở ba tỉ lệ kể cả câu rất dài (cỡ nhỏ hơn 24); `CUE_SHRUNK`, `MISSING_GLYPH`; chữ NFD được chuẩn hóa NFC.
- [X] T017 [P] `tests/unit/overlay/colors.test.ts`: đúng danh sách FR-010 (cảnh báo `#00FF00`, `#00FF66`, `#39FF14` trên xanh lá; `#0000FF`, `#1E40FF` trên xanh dương; `#000000`, `#1A1A1A` trên đen; không cảnh báo `#FFFFFF`, `#FFE600`, `#FF4500` trên cả ba); thành phần đang tắt không bị xét; màu nổi bật chỉ xét khi `sync = karaoke`, hoặc `sync = cue` và `enter = glow`; `SOFT_EDGE` đúng các trường hợp của FR-011 và chỉ một lần.
- [X] T018 [P] `tests/unit/overlay/estimate.test.ts`: ước tính theo định dạng, tỉ lệ khung, có/không tiếng; tăng theo thời lượng; trả số nguyên byte.
- [X] T019 [P] `tests/unit/overlay/draw-base.test.ts` (dùng `@napi-rs/canvas`): nền đúng màu, chữ chỉ hiện trong `[startMs, endMs)`, viền/bóng/hộp nền/vị trí/canh lề tác động đúng vùng điểm ảnh; cùng đầu vào cho cùng điểm ảnh; hai khung cùng khóa giống hệt nhau; chữ chứa `<b>`, `{\an8}`, `%`, dấu nháy được vẽ như chữ thường.

### Cài đặt bộ dựng hình

- [X] T020 [P] `src/lib/overlay/config.ts`: Zod `.strict()` cho `OverlayConfig`, `DEFAULT_CONFIG`, `normalizeConfig`, `applyBackground`, kích thước theo tỉ lệ, `ENGINE_VERSION = 1`.
- [X] T021 [P] `src/lib/overlay/timing.ts`: `applyTiming` (overlay-engine §2, research R7) và `src/lib/overlay/frames.ts` (research R6).
- [X] T022 [P] `src/lib/overlay/colors.ts`: `colorWarnings` (research R15).
- [X] T023 [P] `src/lib/overlay/estimate.ts`: bảng MB/phút của research R11, chú thích rõ là ước tính.
- [X] T024 `src/lib/overlay/fonts.ts`: danh mục họ, độ đậm, đường dẫn TTF, tra `coverage.json`, thứ tự phông chữ thay thế (cần T003).
- [X] T025 `src/lib/overlay/layout.ts`: `layoutCue` nhận `measure` từ ngoài (overlay-engine §4; cần T020, T024).
- [X] T026 `src/lib/overlay/draw.ts`: `drawFrame` với nền, chữ, viền, bóng, hộp nền, vị trí; hiệu ứng vào/ra `cut`; trả khóa khung (overlay-engine §5; cần T025). Không nhập DOM, Node hay CSDL.

**Checkpoint**: `npx vitest run --project unit tests/unit/overlay` xanh; migration chạy được.

---

## Phase 3: User Story 1 - Xuất video overlay theo câu (Priority: P1) 🎯 MVP

**Goal**: chọn voice và `.srt` trong Project, chọn tỉ lệ và phông, xuất `.mp4` bằng tiến trình nền, tải về.

**Independent Test**: Project có voice khớp mốc và `.srt` của nó; xuất 9:16 phông xanh lá; tệp tải về đúng chữ, đúng mốc, thời lượng bằng voice, xóa phông được.

### Tests cho User Story 1 (viết trước)

- [X] T027 [P] [US1] `tests/integration/overlay-config-timeline.test.ts`: GET trả mặc định khi chưa lưu và trả `limits` đúng (`usedBytes`, `pendingBytes`); PUT lưu, 422 khi cấu hình sai; `timeline` cần đúng một trong `voiceId`/`audioId`, 409 `NO_TIMECODES` với tệp không có mốc, cảnh báo `NOT_TIMED_VOICE` và `OTHER_FILE`.
- [X] T028 [P] [US1] `tests/integration/overlay-jobs-api.test.ts`: tạo job đúng thứ tự kiểm tra của openapi-delta; vượt `overlayMaxMinutes` → 422 `OVERLAY_TOO_LONG`; tiến trình thứ 3 → 429 `OVERLAY_TOO_MANY_JOBS`; cùng `clientRequestId` → 200 và một dòng; `config` và `cues` được chốt, sửa cấu hình Project sau đó không đổi job; danh sách không trả `cues`.
- [X] T029 [P] [US1] `tests/integration/overlay-quota.test.ts`: ước tính vượt chỗ còn lại → 409 `QUOTA_EXCEEDED` kèm `needBytes`; hai yêu cầu song song không cùng vượt hạn mức; xong thì `storage_used_bytes` tăng đúng dung lượng thật; video thật vượt chỗ → `failed` `QUOTA_EXCEEDED`, không có đối tượng, hạn mức không đổi; hạ hạn mức dưới mức đang dùng thì video cũ vẫn tải được, tạo mới bị chặn; worker chết sau khi ghi đối tượng nhưng trước giao dịch hoàn tất rồi chạy lại thì hạn mức chỉ bị trừ một lần.
- [X] T030 [P] [US1] `tests/integration/overlay-render.test.ts` (mp4): ba tỉ lệ đúng kích thước, 30 hình/giây, thời lượng lệch ≤ 50 ms; màu ba phông lệch ≤ 4 mức mỗi kênh ngoài vùng chữ; khung ngay trước/sau mốc của từng cue đúng trạng thái hiện/ẩn; có và không có tiếng theo `includeAudio`; tệp tạm được dọn sau khi xong và sau khi lỗi.
- [X] T031 [P] [US1] `tests/integration/overlay-recovery.test.ts`: mất nhịp tim → `interrupted` → xếp lại và hoàn tất; gián đoạn quá 3 lần → `failed` `RENDER_CRASHED`; dừng khi `queued`, `running`, `interrupted`; dừng không để lại video; chạy lại giữ nguyên `config` và `cues`, đặt `interruptions` về 0 (chạy lại sau `RENDER_CRASHED` không bị lỗi oan); không có tiến độ 60 giây (rút ngắn trong test) → `RENDER_STALLED`.
- [X] T032 [P] [US1] `tests/integration/overlay-errors.test.ts`: `STORAGE_UNAVAILABLE` và `RENDER_FAILED` được thử lại tối đa 3 lần với thời gian chờ tăng dần; `SOURCE_DELETED`, `QUOTA_EXCEEDED`, `TOO_LONG`, `AUDIO_UNREADABLE`, `DISK_FULL` không thử lại; xóa voice hoặc kịch bản khi job chờ/chạy → `failed` `SOURCE_DELETED`, video đã xong không đổi; nhật ký không chứa bí mật hay đường dẫn nội bộ.
- [X] T033 [P] [US1] `tests/integration/overlay-isolation.test.ts`: User B và Administrator nhận 404 ở mọi route overlay của User A gồm `video` (kể cả có header Range); chưa đăng nhập nhận 401; `fileId`, `voiceId` của người khác khi tạo job hoặc xem timeline nhận 404. (Bộ `tests/isolation` chỉ đọc openapi của spec 001 nên test này là nơi phủ cô lập của overlay.)
- [X] T034 [P] [US1] `tests/integration/overlay-deletion.test.ts`: xóa một và nhiều job (đang chạy thì dừng trước); xóa Project, xóa User, khóa User; không còn đối tượng dưới `overlay/` và `overlay-tmp/`; hạn mức trả đúng; đối soát dung lượng bỏ qua `overlay-tmp/` và User đang có overlay hoạt động.
- [X] T035 [P] [US1] `tests/integration/overlay-concurrency.test.ts`: tối đa `maxConcurrentOverlayJobs` tiến trình `running`, việc tạo trước chạy trước; overlay đang chạy không chiếm chỗ của `generate-voice` và STT.

### Cài đặt User Story 1 — máy chủ

- [X] T036 [US1] `src/lib/overlay/service.ts` phần đọc: lấy/lưu cấu hình Project, `timeline` (nạp cue của tệp và `voices.timeline`, xác định `source`: `timed` khi job của voice có `settings.timing` và cùng tệp, `continuous` khi cùng tệp mà không có, `otherFile`, `uploaded`), danh sách và chi tiết job kèm 50 dòng nhật ký, DTO theo openapi-delta. Mọi truy vấn kèm `owner_id`, sai thì 404.
- [X] T037 [US1] `src/lib/overlay/service.ts` phần ghi: tạo job trong giao dịch có `pg_advisory_xact_lock` theo User (giới hạn job, hạn mức gồm Σ ước tính của `queued`/`running`/`interrupted`), chống trùng `clientRequestId`, chốt `config`, `cues`, `warnings` (chỉ cảnh báo mốc và màu), `source_names`; dừng, chạy lại (409 `CONFLICT`/`SOURCE_DELETED`/`QUOTA_EXCEEDED`, 429), xóa hàng loạt. Thêm mã lỗi `OVERLAY_TOO_LONG`, `OVERLAY_TOO_MANY_JOBS`, `SOURCE_DELETED` vào i18n.
- [X] T038 [US1] Route `src/app/api/projects/[projectId]/overlay/route.ts`, `overlay/timeline/route.ts`, `overlay/jobs/route.ts` theo openapi-delta (bọc `route()`, `requireUser`).
- [X] T039 [US1] Route `src/app/api/overlay/jobs/[jobId]/route.ts`, `stop/route.ts`, `rerun/route.ts`, `video/route.ts` (qua `serveObject`, tên tệp làm sạch, đúng kiểu nội dung từng định dạng) và `src/app/api/overlay/jobs/bulk-delete/route.ts`.
- [X] T040 [P] [US1] `src/worker/render/ffmpeg-args.ts`: dựng mảng tham số cho `.mp4` theo research R5 (thẻ BT.709, `faststart`, AAC 192 kbps, `apad`, `-t N/30`, `-protocol_whitelist file`); không qua shell.
- [X] T041 [US1] `src/worker/render/main.ts`: tiến trình con nhận việc qua IPC, nạp phông chữ, vẽ bằng `drawFrame`, bỏ vẽ khung trùng khóa (research R3), tôn trọng áp lực ngược, báo tiến độ mỗi 500 ms, dừng sớm khi tệp vượt `maxBytes`, hạ độ ưu tiên CPU.
- [X] T042 [US1] `src/worker/jobs/render-overlay.ts`: nhận việc có khóa và thứ tự tạo trước, nhịp tim 2 giây, kiểm nguồn còn và `cancel_requested`, kiểm chỗ trống đĩa, `fork` với môi trường tối thiểu (không bí mật), phân loại lỗi và thử lại bằng `backoffMs`, `putObjectStream` vào khóa cố định rồi trong một giao dịch `reserveBytes` chặt và chuyển `completed` (research R11), xóa đối tượng ở mọi kết thúc khác; nhật ký `overlay_job_logs` qua `redactDeep`, gồm `CUE_SHRUNK` và `MISSING_GLYPH` do tiến trình con báo; dọn thư mục tạm và dọn `submaker-overlay-*` khi worker khởi động. Thêm khóa nhật ký và lỗi vào i18n.
- [X] T043 [US1] Đăng ký trong `src/worker/handlers.ts` (`localConcurrency: 10`) và thêm quét `overlay_jobs` vào `src/worker/sweeper.ts` (quá hạn → `interrupted`, tăng `interruptions`, xếp lại; có `cancel_requested` → `stopped`; `interruptions` > 3 → `failed`; `stopped` và `failed` thì xóa đối tượng ở khóa cố định).
- [X] T044 [US1] `src/lib/overlay/cleanup.ts` và nối vào `src/lib/projects/delete.ts`, `src/lib/jobs/control.ts` (`stopAllForUser` gồm overlay), `src/worker/jobs/delete-user.ts` (chờ overlay dừng hẳn), `src/worker/jobs/reconcile-storage.ts`.
- [X] T045 [US1] Thêm 4 cài đặt vào `src/app/api/admin/settings/route.ts` (khoảng: 1–20, 1–10, 1–180, 1–60) và `src/components/admin/system-settings-form.tsx`; bổ sung `tests/integration/admin-settings.test.ts`.
  - Checklist: mỗi ô là một dòng trong `fieldsOf(t)` cùng `key`, `label`, `hint`, `unit: 'int'`, `min`, `max`, không viết ô riêng — 13/13 ô hiện có của tệp. Không chép gì thêm từ trang khác.

### Cài đặt User Story 1 — giao diện

- [X] T046 [US1] Hiệu chỉnh người kiểm: chép `src/components/projects/media-tab.tsx` ra ngoài repo, cố ý viết khác một vai trò, giao cho người kiểm dùng `ui-consistency:verifying` với checklist của T050; không phát hiện thì dừng và báo. Người kiểm là một agent hoặc phiên riêng, không phải người viết: hỏi người dùng trước khi chạy; không được phép thì ghi `parked — chưa có người kiểm độc lập` và báo rõ khi bàn giao. Kết quả ghi tại đây.
  - Kết quả (2026-11-25): đạt. Người dùng cho phép dùng agent; bản chép cài sẵn một điểm khác (trạng thái rỗng viết tay bằng `<p>` thay vì `EmptyState`). Người kiểm báo đúng điểm này ở dòng 252–253, không báo sai các dòng khác của checklist. Agent này không dùng cho T096.
- [X] T047 [US1] `src/lib/hooks/use-overlay.ts`: truy vấn cấu hình, timeline, danh sách job (hỏi lại mỗi 1 giây khi còn `queued`/`running`/`interrupted`), chi tiết job, các thao tác ghi; làm mới `['overlay', projectId]` và dung lượng.
- [X] T048 [US1] Tách `src/components/shared/event-log.tsx` từ `SttLog` trong `src/components/projects/stt-dialog.tsx` (nhận danh sách dòng đã dựng chữ, nhãn, trạng thái tải/lỗi/rỗng) và cho `stt-dialog.tsx` dùng lại; hiển thị không đổi. Người dùng đã đồng ý tách ngày 2026-11-25.
  - Checklist: giữ `role="log"`, khung `max-h-48 overflow-y-auto rounded-lg border bg-muted/30 p-3 font-mono text-xs`, màu mức `LEVEL_STYLE`, giờ bằng `fx.time` — nguyên trạng ở `stt-dialog.tsx`.
- [X] T049 [US1] Tạo `src/components/overlay/canvas-panel.tsx`: chọn tỉ lệ và màu phông (qua `applyBackground`, báo bằng `toast` khi viền đen mặc định bị tắt).
  - Checklist: `Select` của `ui/select` với `Label` đứng trên, khối `space-y-2`, `SelectTrigger` có `className="w-full"` và `aria-label` — 8 trên 16 ô chọn trong biểu mẫu, không có đa số; hai tệp mới sửa nhất (`media-tab.tsx`, `start-job-dialog.tsx`) viết như vậy (mức 5). Chữ phụ `text-xs text-muted-foreground`. Mẫu màu phông là nội dung người dùng: đặt bằng `style`, không thêm màu vào theme.
- [X] T050 [US1] Tạo `src/components/overlay/overlay-tab.tsx`, `src/components/overlay/source-picker.tsx` và thêm tab vào `src/components/projects/project-detail.tsx` (nhãn kèm số lần xuất như các tab khác). Chọn sẵn voice mới nhất và đúng tệp `.srt` của nó; kịch bản không dùng được bị khóa kèm lời giải thích. Trạng thái rỗng có lối tắt tới tab Kịch bản và hộp thoại tạo voice.
  - Checklist (overlay-tab so với loại "tab của Project" trong `project-detail.tsx`, tham chiếu `media-tab.tsx`, 4 tab):
    - bố cục `grid grid-cols-1 gap-6 lg:grid-cols-12`, cột trái `lg:col-span-7` biểu mẫu, cột phải `lg:col-span-5` danh sách — 2/2 tab có biểu mẫu kèm danh sách (tab còn lại chỉ có danh sách)
    - tiêu đề mục `h2` `text-base font-semibold`, 6/6 tiêu đề trong các tab; tiêu đề của danh sách kèm `Badge variant="secondary"` đếm số — 4/4
    - khối nội dung `Card` + `CardContent` — tham chiếu và tab Tiến trình
    - tải/lỗi/rỗng qua `LoadingList`, `ErrorState`, `EmptyState` (`action` cho lối tắt) — thành phần chung, 19/18/9 tệp
    - lỗi gửi: `<p role="alert" className="text-sm text-destructive">` — 5 trên 7 lỗi biểu mẫu
    - thành công: `toast.success` — 20 tệp
    - nút gửi ở cuối biểu mẫu, căn phải, `Loader2` quay khi đang gửi — tham chiếu
    - ngày giờ qua `useFormat()`, dung lượng qua `fmtBytes`, thời lượng qua `fmtDuration` — thành phần chung
    - mọi chữ qua `useT()`; không màu, khoảng cách viết tay ngoài thang Tailwind
    - không chép từ tham chiếu: mã `asChild` lẫn trong `className`, liên kết `/api/files/{id}/download` (route không tồn tại), `className` dùng nháy đơn
- [X] T051 [US1] Tạo `src/components/overlay/export-panel.tsx`: thời lượng, dung lượng ước tính (ghi rõ là ước tính), chỗ còn lại, danh sách cảnh báo, công tắc kèm tiếng, nút "Xuất Video Overlay" (sinh `clientRequestId`, khóa khi đang gửi); vượt hạn mức thì khóa nút, nêu còn lại, cần thêm và cách giải phóng.
  - Checklist: khối ước tính theo `src/components/jobs/estimate-panel.tsx` (`section` `rounded-lg border p-3`, `h3` `text-sm font-medium`, `dl` hai cột, số `tabular-nums`) — khối ước tính duy nhất; cảnh báo theo khối `role="status"` của `cue-preview.tsx` — không có quy ước (một tệp), dùng cách của tệp đó; công tắc: hàng `flex items-center justify-between` nhãn trái công tắc phải kèm dòng phụ — `timing-options.tsx` và `media-tab.tsx`.
- [X] T052 [US1] Tạo `src/components/overlay/overlay-job-list.tsx` bản đầu: trạng thái, tiến độ, dung lượng, tải về, dừng, chạy lại (ẩn khi `canRerun = false`, nêu lý do), xem nhật ký bằng `EventLog` (cập nhật ≤ 2 giây, Nguyên tắc III), xóa từng lần xuất có xác nhận nêu dung lượng được trả lại (FR-043).
  - Checklist: `DataTable` chung, `StatusBadge` chung (cùng sáu trạng thái), `Progress` `h-1.5` có `aria-label` — theo `job-table.tsx`; tải về là `Button asChild` bọc `<a download>` — 3 nơi; thao tác dòng là `Button size="sm" variant="outline"`, xóa là `size="icon" variant="ghost"` với `Trash2`, xác nhận qua `ConfirmDialog` nêu số lượng và hậu quả — `job-table.tsx`; nhật ký qua `event-log.tsx` (T048).
- [X] T053 [US1] `tests/e2e/overlay.spec.ts` phần US1: mở tab, voice và phụ đề chọn sẵn, xuất, rời trang, quay lại thấy tiến độ, mở nhật ký, tải `.mp4`, xóa và thấy dung lượng giảm; chạy ở desktop và 375 px (không cuộn ngang).

- [ ] T054 [US1] Kiểm tay `.mp4` theo dòng đầu bảng quickstart §6 (CapCut, Premiere, DaVinci Resolve xóa phông sạch; After Effects mở được — SC-006 và phần `.mp4` của SC-007), ghi kết quả vào `specs/005-subtitle-video-overlay/quickstart.md`. Cần người dùng thực hiện; chưa có kết quả thì ghi `parked — chờ người dùng`.
  - Trạng thái: `parked — chờ người dùng` (hướng dẫn ở `user-tasks.md`, tệp mẫu tạo bằng `scripts/overlay-samples.ts`).

**Checkpoint**: US1 dùng được độc lập (quickstart §2, §3, §4 bước 1 và 5). Đây là MVP.

---

## Phase 4: User Story 2 - Xem trước và tùy chỉnh kiểu chữ (Priority: P1)

**Goal**: chỉnh phông chữ, màu, viền, bóng, hộp nền, vị trí và thấy ngay trên khung xem trước có tiếng.

**Independent Test**: đổi từng thuộc tính khi phát và khi dừng; xuất video rồi so cùng thời điểm với khung xem trước.

### Tests cho User Story 2 (viết trước)

- [X] T055 [P] [US2] `tests/unit/overlay/font-coverage.test.ts`: mọi họ và độ đậm có đủ chữ tiếng Việt; `arimo` không có 800; ký tự lạ rơi về phông chữ thay thế rồi mới cảnh báo.
- [X] T056 [P] [US2] `tests/e2e/overlay-preview.spec.ts`: đổi kiểu thấy ngay (≤ 0,2 giây) khi đang phát và tiếng không ngắt; tua đúng chữ trong 0,5 giây; chặn tự phát thì chờ bấm; cấu hình còn sau khi rời trang; chữ xanh lá trên phông xanh lá có cảnh báo; "Về mặc định".
- [X] T057 [P] [US2] `tests/e2e/overlay-parity.spec.ts` (SC-005): 20 thời điểm, khung xem trước và khung trích từ video cùng chữ, cùng dòng, vị trí khối lệch ≤ 1% chiều cao; ca bật bóng mờ có bề rộng vùng bóng khớp; bắt buộc Chromium, chạy thêm Firefox và WebKit để ghi nhận.

### Cài đặt User Story 2

- [X] T058 [US2] Tạo `src/components/shared/color-field.tsx` (ô màu hệ thống, ô nhập `#RRGGBB`, các mẫu gợi ý tùy chọn). Người dùng đã đồng ý tạo ngày 2026-11-25; dự án chưa có ô chọn màu nào (0 tệp dùng `type="color"`).
  - Checklist: `Label` gắn `htmlFor`, `Input` của `ui/input`, khối `space-y-2`, sai định dạng thì `aria-invalid` và dòng `text-xs text-destructive` — theo `system-settings-form.tsx`; mẫu màu là `button` có `aria-label` tên màu và `aria-pressed`.
- [X] T059 [US2] Tạo `src/components/overlay/slider-field.tsx` (nhãn, giá trị, `Slider`). Người dùng đã đồng ý tạo ngày 2026-11-25.
  - Checklist: hàng `flex justify-between` gồm `Label` và giá trị `text-sm tabular-nums text-muted-foreground`, dưới là `Slider` có `aria-label`, khối `space-y-2` — theo 2/2 thanh trượt biểu mẫu (`start-job-dialog.tsx`, `edit-settings-dialog.tsx`).
- [X] T060 [US2] `src/lib/hooks/use-overlay-canvas.ts`: nạp `FontFace` từ `public/fonts/overlay`, đo chữ ở cỡ xuất ra, vẽ bằng `drawFrame` theo `audio.currentTime` mỗi khung hình trình duyệt, `<canvas>` đúng kích thước xuất và co bằng CSS (không `ctx.scale`, research R1); máy yếu thì giảm số khung vẽ; tab ẩn thì dừng vẽ.
- [X] T061 [US2] `src/components/overlay/preview-player.tsx`: `<canvas>` đúng tỉ lệ, phát/tạm dừng, tua, thời gian, trạng thái đang tải phông chữ, lỗi âm thanh.
  - Checklist: một phần tử `<audio>` dùng chung qua `ref`, nút `size="icon"` `Play`/`Pause` có `aria-label`, `Slider` tua bước 0,05, thời gian `tabular-nums` bằng `fmtDuration`, lỗi `role="alert"` — theo `voice-player.tsx` (trình phát duy nhất). Không chép: ô tốc độ, âm lượng, nút tải (ngoài yêu cầu). `<canvas>` có `role="img"` và `aria-label`.
- [X] T062 [US2] `src/components/overlay/typography-panel.tsx`: phông chữ, cỡ, độ đậm (khóa độ đậm không có), màu chữ, viền, bóng, hộp nền, vị trí nhanh, độ cao, canh lề, độ rộng tối đa.
  - Checklist: như T049 cho `Select`; `ColorField` và `SliderField` cho màu và số; bật/tắt bằng hàng `Switch` như T051; nhóm bằng `Separator` và `h3` `text-sm font-medium` (không có quy ước, một tệp: `estimate-panel.tsx`).
- [X] T063 [US2] Tự lưu cấu hình (chờ 800 ms sau lần đổi cuối, báo lỗi nhưng không mất thay đổi trên màn hình), nút "Về mặc định" và hiển thị `colorWarnings`, `CUE_SHRUNK`, `MISSING_GLYPH` trong `src/components/overlay/overlay-tab.tsx` và `export-panel.tsx`.

**Checkpoint**: US1 và US2 hoạt động; quickstart §4 bước 2–4 và §5 đạt trên Chromium.

---

## Phase 5: User Story 3 - Hiệu ứng xuất hiện và biến mất (Priority: P2)

**Goal**: hiệu ứng câu nhóm cơ bản và động lực, thời lượng, độ nảy, cách biến mất.

**Independent Test**: lần lượt từng hiệu ứng, kiểm chuyển động ở xem trước và video.

- [X] T064 [P] [US3] `tests/unit/overlay/effects-basic.test.ts` (viết trước): giá trị tại p = 0, giữa, 1 của `fade`, `pop` (80→100%, đỉnh 100/102/104% theo `intensity`), `bounce` (đỉnh 103/105/110% theo `low`/`medium`/`high`), `slideUp`, `slideLeft`, `slideRight`, `dropDown`; `exit` `fade`/`slideDown` ẩn hẳn tại `endMs`; `e + x > D` thì cả hai nhân `D / (e + x)` (FR-027); khóa khung hết hiệu ứng thì ổn định.
- [X] T065 [US3] `src/lib/overlay/effects.ts` và nối vào `src/lib/overlay/draw.ts`: các hiệu ứng trên và `exit` (overlay-engine §5).
- [X] T066 [US3] `src/components/overlay/effects-panel.tsx`: chọn hiệu ứng, thời lượng 100–600 ms bước 10, độ nảy, cách biến mất; thông số không áp dụng thì khóa; chọn `fade` khi `exit = cut` thì đổi `exit` thành `fade`.
  - Checklist: như T049, T059, T062.
- [X] T067 [US3] Bổ sung `tests/integration/overlay-render.test.ts` (một video `bounce` + `slideDown`) và `tests/e2e/overlay-preview.spec.ts` (đổi hiệu ứng thấy ngay).

**Checkpoint**: US3 đạt; cảnh báo `SOFT_EDGE` hiện với `fade` trên phông xanh.

---

## Phase 6: User Story 4 - Theo từng từ và karaoke (Priority: P2)

**Goal**: mốc từng từ ước lượng, chế độ theo từng từ và karaoke.

**Independent Test**: voice khớp mốc tiếng Việt, từng chế độ đúng thứ tự và nằm trong khoảng đọc.

- [X] T068 [P] [US4] `tests/unit/overlay/words.test.ts` (viết trước): mọi bất biến overlay-engine §3 trên 244 cue của `docs/example/tham-quyen-2026.srt` và ca biên (một từ, số, ký hiệu, dấu câu, khoảng đọc ngắn hơn số từ); cùng đầu vào cho cùng kết quả; nối lại ra đúng chữ.
- [X] T069 [P] [US4] `tests/unit/overlay/effects-word.test.ts` (viết trước): `word/cut`, `word/pop`, `word/typewriter` (không tách dấu, không làm nhảy dòng); `karaoke/active` nhiều nhất một từ nổi bật, 115/118/120%, sau `readEndMs` không từ nào; `karaoke/wipe` phủ hết khi đọc xong.
- [X] T070 [US4] `src/lib/overlay/words.ts`: `wordSpans` theo research R8, hệ số gom trong một hằng số.
- [X] T071 [US4] Vẽ các hiệu ứng từ trong `src/lib/overlay/effects.ts` và `draw.ts`; karaoke kết hợp được với hiệu ứng vào của câu.
- [X] T072 [US4] Bổ sung `src/components/overlay/effects-panel.tsx`: chọn chế độ, hiệu ứng từ, màu nổi bật (gợi ý `#FFE600`, `#00FF66`, `#FF4500`, hồng phấn), ghi chú "nhịp từng từ là ước lượng"; đổi chế độ làm lựa chọn sai thì `normalizeConfig` và báo bằng `toast`.
  - Checklist: như T049, T058, T059; ghi chú `text-xs text-muted-foreground`.
- [X] T073 [US4] Bổ sung `tests/integration/overlay-render.test.ts` (một video karaoke, một video theo từng từ) và `tests/e2e/overlay-preview.spec.ts` (đổi chế độ, ghi chú ước lượng).
- [ ] T074 [US4] Đo SC-008 theo quickstart §7 **chỉ khi người dùng yêu cầu** (tốn phí Soniox): viết `scripts/overlay-word-accuracy.ts`, ghi kết quả vào `specs/005-subtitle-video-overlay/research.md` R8; không đạt thì chỉnh hệ số và đo lại bằng voice khác, vẫn không đạt thì báo để sửa spec. Chưa được yêu cầu thì ghi `parked — chờ người dùng cho phép`.
  - Trạng thái: `parked — chờ người dùng cho phép` (tốn phí; hướng dẫn ở `user-tasks.md`).

**Checkpoint**: US4 đạt về chức năng; SC-008 có số đo hoặc được ghi rõ là chưa đo.

---

## Phase 7: User Story 5 - Voice và phụ đề tải lên từ máy (Priority: P2)

**Goal**: dùng tệp âm thanh và `.srt` ngoài hệ thống.

**Independent Test**: Project trống, tải `.mp3` và `.srt`, xem trước rồi xuất.

- [X] T075 [P] [US5] `tests/integration/overlay-audio.test.ts` (viết trước): `.mp3`, `.wav`, `.m4a` → `ready`, `size_bytes` bằng dung lượng MP3 thật và được tính hạn mức; sai đuôi, tệp giả đuôi, tệp hỏng, > 100 MB, > `overlayMaxMinutes`, vượt hạn mức đều bị từ chối hoặc `failed` đúng mã; tối đa 3 tệp `processing`; tệp tạm được dọn; gián đoạn thì xếp lại, `interruptions` > 3 thì `failed`; chết giữa ghi tệp và hoàn tất thì hạn mức chỉ bị trừ một lần; xóa trả hạn mức và job đang dùng chuyển `SOURCE_DELETED`; User B nhận 404 ở `stream` và xóa.
- [X] T076 [US5] `src/lib/overlay/audio-service.ts`: nhận luồng tải lên vào `overlayAudioTemp` bằng `putObjectStream`, kiểm đuôi (`.mp3`, `.wav`, `.m4a`), 100 MB, chỗ còn lại, giới hạn 3 tệp đang xử lý (429 `OVERLAY_TOO_MANY_UPLOADS`); danh sách; xóa hàng loạt. Mã lỗi riêng `OVERLAY_AUDIO_TOO_LARGE`, `OVERLAY_AUDIO_UNSUPPORTED` (thông báo của `MEDIA_*` nói về video nên không dùng lại).
- [X] T077 [US5] `src/worker/jobs/prepare-overlay-audio.ts`: tải về đĩa tạm, ép bộ tách theo đuôi (`-f mp3|wav|mov`, `-protocol_whitelist file`), đo thời lượng, chuyển MP3 192 kbps có thẻ Xing, ghi `overlayAudio` rồi trong một giao dịch `reserveBytes` chặt và chuyển `ready` (research R11), xóa đối tượng ở mọi kết thúc khác; đăng ký trong `src/worker/handlers.ts` (`localConcurrency: 2`), quét trong `src/worker/sweeper.ts`.
- [X] T078 [US5] Route `src/app/api/projects/[projectId]/overlay/audios/route.ts`, `src/app/api/overlay/audios/[audioId]/stream/route.ts`, `src/app/api/overlay/audios/bulk-delete/route.ts`; `timeline` và tạo job nhận `audioId` (409 `AUDIO_NOT_READY` khi chưa xong) trong `src/lib/overlay/service.ts`; `src/lib/overlay/cleanup.ts` gồm cả tệp âm thanh.
- [X] T079 [US5] Tách `src/components/shared/file-dropzone.tsx` từ ba bản chép ở `src/components/projects/upload-dropzone.tsx`, `stt-dialog.tsx`, `media-tab.tsx`, có hai kiểu `row` (hai tệp đầu) và `stack` (media-tab) để hiển thị không đổi, rồi cho ba nơi dùng lại. Người dùng đã đồng ý tách ngày 2026-11-25. `media-tab.tsx` có thay đổi chưa commit của người dùng: làm trên bản hiện có, không ghi đè.
  - Checklist: giữ nguyên lớp, bàn phím (Enter, Space), `aria-label`, kéo-thả và `input type="file"` ẩn của từng bản; chạy lại E2E hiện có của tải kịch bản và STT.
- [X] T080 [US5] Bổ sung `src/components/overlay/source-picker.tsx`: tải âm thanh bằng `FileDropzone` kiểu `row`, tải `.srt` qua `POST /api/projects/{projectId}/files` hiện có rồi tự chọn, danh sách tệp âm thanh kèm trạng thái, dung lượng, xóa có xác nhận; hiện cảnh báo lệch thời lượng trước khi xuất.
  - Checklist: như T050 cho trạng thái và lỗi; xóa qua `ConfirmDialog` nêu số lượng và hậu quả — thành phần chung, 9 tệp.
- [X] T081 [US5] Bổ sung `tests/e2e/overlay.spec.ts`: Project trống, tải hai tệp, xem trước, xuất.

**Checkpoint**: US5 đạt độc lập với voice của hệ thống.

---

## Phase 8: User Story 6 - Theo dõi và quản lý các lần xuất (Priority: P2)

**Goal**: quản lý nhiều lần xuất: chọn nhiều, dùng lại cấu hình, xem cấu hình đã chốt, số đang chạy. Phần máy chủ, nhật ký, dừng, chạy lại và xóa từng mục đã có từ US1.

**Independent Test**: xuất ba video, dừng một, chạy lại một, xóa hai cùng lúc; khởi động lại worker khi đang xuất.

- [X] T082 [P] [US6] `tests/e2e/overlay-manage.spec.ts` (viết trước): dừng, chạy lại, mở nhật ký, dùng lại cấu hình, xóa hai mục có xác nhận nêu số lượng và dung lượng, chuyển English và theme Tối, 375 px.
- [X] T083 [US6] Hoàn thiện `src/components/overlay/overlay-job-list.tsx`: chọn nhiều, thanh chọn kèm nút xóa, dùng lại cấu hình (nạp vào màn hình và cuộn lên), xem cấu hình và cảnh báo đã chốt, tổng dung lượng đang dùng.
  - Checklist: thanh chọn `role="status"` `rounded-lg border bg-accent/40`, nút xóa `variant="destructive"` kèm `Trash2`, `ConfirmDialog` nêu số lượng và hậu quả — theo `job-table.tsx`; phần còn lại giữ như T052.
- [X] T084 [US6] Hiện số tiến trình overlay đang chạy cạnh nhãn tab và tính vào huy hiệu "đang chạy" của Project trong `src/components/projects/project-detail.tsx`.
  - Checklist: cùng cách `totalActive` và `Badge` đang dùng cho voice và STT trong chính tệp này.

**Checkpoint**: US6 đạt; quickstart §4 bước 6.

---

## Phase 9: User Story 7 - Nền trong suốt (Priority: P3)

**Goal**: xuất `.mov` và `.webm` giữ kênh trong suốt.

**Independent Test**: `.mov` và `.webm` có bóng mờ và hộp 50%, đặt lên video khác nhìn xuyên đúng chỗ.

- [X] T085 [P] [US7] Bổ sung `tests/integration/overlay-render.test.ts` (viết trước): alpha bằng 0 ngoài chữ, alpha trung gian ở hộp 50% và bóng, đúng màu không bị viền đen; có tiếng; vượt `overlayMaxMinutesTransparent` → 422; ước tính `.mov` vượt hạn mức → 409.
- [X] T086 [US7] Thêm `.mov` (ProRes 4444, `qscale 11`, `alpha_bits 8`) và `.webm` (VP9 `yuva420p`, CRF 24, Opus) vào `src/worker/render/ffmpeg-args.ts`; vẽ nền trong suốt và đọc điểm ảnh không nhân sẵn alpha trong `src/lib/overlay/draw.ts` và `src/worker/render/main.ts`.
- [X] T087 [US7] Giao diện: thêm nền trong suốt và định dạng vào `src/components/overlay/canvas-panel.tsx` (chỉ định dạng hợp lệ, ghi phần mềm phù hợp, nêu `.mov` khoảng 2–3,5 phút với 500 MB và gợi ý `.webm`); ô bàn cờ kèm ghi chú trong `src/components/overlay/preview-player.tsx`; gợi ý khi bị chặn trong `export-panel.tsx`.
  - Checklist: như T049, T051; ô bàn cờ dựng bằng màu theme `muted` và `background`, không màu viết tay.
- [ ] T088 [US7] Kiểm tay các dòng `.mov` và `.webm` của quickstart §6 (Premiere, DaVinci Resolve, After Effects, CapCut; kèm tệp thử QuickTime Animation), ghi kết quả vào `specs/005-subtitle-video-overlay/quickstart.md`. Cần người dùng thực hiện; chưa có kết quả thì ghi `parked — chờ người dùng`.
  - Trạng thái: `parked — chờ người dùng` (hướng dẫn ở `user-tasks.md`).

**Checkpoint**: US7 đạt về kỹ thuật; kết quả phần mềm dựng phim được ghi.

---

## Phase 10: User Story 8 - Hiệu ứng điện ảnh (Priority: P3)

**Goal**: nhòe tụ nét, giật tách màu, phát sáng, lật 3D, rung.

**Independent Test**: từng hiệu ứng ở xem trước và video, trên phông xanh lá và nền trong suốt.

- [X] T089 [P] [US8] `tests/unit/overlay/effects-cinematic.test.ts` (viết trước): `glitch` chỉ 100 ms đầu và tất định; `shake` theo `exclaim` chỉ câu kết thúc bằng `!`, theo `all` mọi câu; `flip3d` 90°→0°; `blurIn` và `glow` về trạng thái thường; cùng đầu vào cho cùng điểm ảnh.
- [X] T090 [US8] Thêm năm hiệu ứng vào `src/lib/overlay/effects.ts` và `draw.ts`; nhòe bằng thu-phóng lớp phụ (research R2), không dùng `filter: blur()` mỗi từ.
- [X] T091 [US8] Thêm lựa chọn và phạm vi rung vào `src/components/overlay/effects-panel.tsx`; `SOFT_EDGE` hiện đúng.
  - Checklist: như T066.
- [X] T092 [US8] Bổ sung `tests/integration/overlay-render.test.ts` (một video `blurIn`, một video `glitch` trên nền trong suốt) và đo lại thời gian `blurIn` bằng `scripts/overlay-bench.ts`.

**Checkpoint**: đủ danh mục hiệu ứng của REQ-005.

---

## Phase 11: Polish & Cross-Cutting

- [X] T093 [P] Cập nhật `README.md` (tính năng, kiến trúc, API, hạn chế) và `docs/operations.md` (4 cài đặt, dung lượng theo định dạng, đĩa tạm của worker, giới hạn tải lên của Cloudflare Tunnel, phông chữ và giấy phép).
- [X] T094 Chạy quickstart §8: hiệu năng trong ảnh Docker sau khi hoàn thiện (SC-009), voice mới bắt đầu ≤ 10 giây khi đang xuất (SC-011); ghi vào `specs/005-subtitle-video-overlay/research.md` R1.
- [X] T095 [P] Rà bảo mật: `tests/unit/route-guards.test.ts` phủ các route mới; kiểm tiến trình con không có biến môi trường bí mật bằng `tests/unit/overlay/render-env.test.ts`.
- [X] T096 Người kiểm (không phải người viết) đối chiếu toàn bộ tab với checklist của T050 và các task giao diện bằng `ui-consistency:verifying` (cách chọn người kiểm như T046); sửa theo báo cáo ở `src/components/overlay/`.
  - Kết quả (2026-11-25): agent độc lập báo 7 dòng lệch checklist và 18 điểm ngoài checklist. Đã sửa: nút tải về dùng kiểu viền; dòng phụ cho ba công tắc; nhóm bằng `Separator` và `h3` ở bảng kiểu chữ và bảng hiệu ứng; hộp xác nhận xóa tệp âm thanh nêu số lượng; chữ chỉ sai hướng; trạng thái khi danh sách âm thanh đang tải hoặc lỗi; đệm thẻ `p-5`; thứ tự DOM theo màn hình rộng; tiêu đề xác nhận có dấu hỏi; chữ của ô kéo-thả; tiêu đề khối ước tính; dùng lại chuỗi có sẵn; hàng tab xuống dòng theo cách của `ai-config-manager.tsx`; viền tiêu điểm và cách báo màu sai của ô màu; thông số không áp dụng trong "Xem cấu hình"; báo rõ khi `.srt` không có mốc; ẩn "Tạo voice" khi chưa có kịch bản; lỗi máy chủ cũ biến mất khi đổi cấu hình.
  - Giữ nguyên, có lý do: danh sách tệp âm thanh rỗng thì ẩn (không dùng `EmptyState` cao 70dvh giữa một thẻ); chiều cao khung xem trước theo `dvh` (không trang nào có khung video); tám `h2` cùng cỡ (checklist T050 yêu cầu); `toast.info`, `sticky`, `SelectGroup` là mới nhưng không có cách khác trong dự án; "Về mặc định" và "Dùng lại cấu hình" không hỏi lại (spec không yêu cầu, không mất dữ liệu nguồn).
- [X] T097 Chạy `npm run lint`, `npx tsc --noEmit`, `npm run check:i18n`, `npm test`, `npm run test:isolation`, `npx playwright test`, `npm run build`; ghi kết quả, sửa lỗi do tính năng này gây ra.
  - Kết quả (2026-11-25): lint, tsc, check:i18n, build đạt. `npm test`: 1079 đạt, 6 bỏ qua, 3 không đạt. `test:isolation`: 115/115 đạt. Playwright: 74/76 đạt (chạy bằng Chrome cài sẵn vì chưa tải trình duyệt của Playwright 1.65.1); 19/19 kịch bản overlay đạt ở desktop và 375 px.
  - 5 ca không đạt đều **có sẵn trước tính năng này** và không thuộc danh sách bắt buộc của Nguyên tắc V: `usage-stats.test.ts` (1, phụ thuộc giờ trong ngày), `shopaikey-minimax.test.ts` (2, danh mục giọng đã đổi) không đạt ở mốc đo trước T001; `ai-config.spec.ts` (1, tên tab đã đổi thành "FPT.AI") và `manage-jobs.spec.ts` (1, chạy lại chuyển sang trang tiến trình) không đạt y hệt khi dựng riêng bản HEAD `86ab9d0`. Không sửa vì ngoài phạm vi.
- [ ] T098 Kiểm thử người dùng SC-001 và SC-013 (cần người dùng chọn người thử), ghi kết quả vào `specs/005-subtitle-video-overlay/quickstart.md`; chưa có thì ghi `parked — chờ người dùng`.
  - Trạng thái: `parked — chờ người dùng` (hướng dẫn ở `user-tasks.md`).
- [X] T099 Trước khi commit: xóa chú thích "Sync Impact Report" ở đầu `.specify/memory/constitution.md`.
- [X] T100 Hoàn tất theo hiến pháp 1.3.0 (làm cuối cùng, sau T001–T099); đánh dấu T100 trong `specs/005-subtitle-video-overlay/tasks.md` ngay trước khi commit để không sót thay đổi, push không thành công thì bỏ đánh dấu và báo:
  - Kiểm: mọi task agent làm được đã `done` và T097 đạt. Người dùng quyết định ngày 2026-11-25: T054, T074, T088, T098 để riêng kèm hướng dẫn ở `specs/005-subtitle-video-overlay/user-tasks.md`, không chặn commit và push; người dùng làm sau và báo kết quả. Kiểm thử không đạt vì tính năng này thì không push; ca không đạt có sẵn từ trước T001 thì nêu rõ trong thông báo.
  - Commit trên `main`: chỉ tệp của tính năng, thêm từng đường dẫn (không `git add -A`), gồm `specs/005-subtitle-video-overlay/`, `.specify/memory/constitution.md` và `docs/todo/requirements/req-005/` (người dùng đồng ý gộp ngày 2026-11-25). Không gộp thay đổi có sẵn khác đã ghi nhận trước T001. Không tách được thì hỏi. Kiểm không có bí mật trong nội dung commit.
  - Lấy `origin/main` về; nếu có commit mới thì ghép vào `main` rồi chạy lại T097; có xung đột thì dừng và báo.
  - Push lên `origin/main`, không force, không bỏ qua hook; bị từ chối thì dừng và báo.
  - Thông báo cho người dùng: mã commit, kết quả push, kết quả kiểm thử, việc còn lại.

---

## Dependencies & Execution Order

### Phase

- **Phase 1** không phụ thuộc; **T006 là cổng** cho mọi phase sau.
- **Phase 2** chặn mọi user story.
- **US1 → US2**: US2 cần tab và API của US1. **US3, US4, US6, US7, US8** cần US1 và US2 (giao diện chỉnh và xem trước). **US5** cần US1; phần xem trước cần US2.
- **US4** dùng `effects-panel.tsx` và `effects.ts` của US3; **US8** dùng của US3. **US6**, **US5**, **US7** độc lập với US3 và US4 về chức năng.
- **Phase 11** sau mọi user story: T093–T096 → T097 → T098 → T099 → T100. T100 cần T001–T099 xong.

```text
Setup (T006 cổng) → Foundational → US1 (MVP) → US2 → ┬─ US3 → ┬─ US4
                                                     │        └─ US8
                                                     ├─ US5
                                                     ├─ US6
                                                     └─ US7
                                                            → Polish
```

### Trong mỗi story

Test trước (phải thất bại) → phần thuần → dịch vụ → route → worker → giao diện → E2E.

### Tệp nhiều task cùng sửa (làm tuần tự)

`src/lib/i18n/vi.ts`, `en.ts`; `src/lib/overlay/service.ts`, `draw.ts`, `effects.ts`; `src/worker/handlers.ts`, `sweeper.ts`; `src/components/overlay/overlay-tab.tsx`, `effects-panel.tsx`, `source-picker.tsx`, `export-panel.tsx`; `src/components/projects/project-detail.tsx`, `stt-dialog.tsx`; `tests/integration/overlay-render.test.ts`; `tests/e2e/overlay*.spec.ts`.

## Parallel Examples

```text
Foundational: T009, T010, T011 cùng lúc; T013–T019 cùng lúc; rồi T020, T021, T022, T023 cùng lúc.
US1: T027–T035 cùng lúc; T040 song song với T036.
US2: T055, T056, T057 cùng lúc.
US4: T068, T069 cùng lúc.
Sau US2: hai người có thể chia {US3 → US4 → US8} và {US5, US6, US7}; cùng sửa i18n và overlay-render.test.ts nên phải ghép theo lượt.
```

## Implementation Strategy

**MVP**: Phase 1 → cổng T006 → Phase 2 → US1. Dừng, kiểm quickstart §2, §3 và bước 1, 5 của §4. Bản này đã cho xuất `.mp4` theo câu với kiểu chữ mặc định.

**Phát hành P1**: thêm US2 (xem trước và kiểu chữ).

**Tăng dần**: US3 → US4 → US5 → US6 → US7 → US8; mỗi story kết thúc bằng checkpoint riêng và không làm hỏng story trước.

**Commit và push**: tự động một lần ở T100 khi mọi task xong. Dừng ở MVP hoặc giữa chừng thì không tự commit hay push; người dùng muốn phát hành sớm thì nói rõ.

## Notes

- Chỉ làm trên nhánh `main` (hiến pháp 1.3.0). Ba tệp `start-job-dialog.tsx`, `media-tab.tsx`, `ui/select.tsx` đang có thay đổi chưa commit của người dùng, không gộp vào commit của tính năng này. T079 là task duy nhất đụng `media-tab.tsx`: nên để người dùng commit thay đổi của họ trước.
- Cần người dùng: tải phông chữ (T002), đo có phí (T074), phần mềm dựng phim (T054, T088), người thử (T098), người kiểm giao diện độc lập (T046, T096).
- Không commit giữa chừng trừ khi người dùng yêu cầu; commit và push cuối cùng theo T100.
