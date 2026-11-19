---

description: "Danh sách công việc: Quản lý Project tạo Voice từ Subtitle (CRUDS)"
---

# Tasks: Quản lý Project tạo Voice từ Subtitle (CRUDS)

**Input**: Tài liệu thiết kế tại `/specs/001-voice-sub-projects/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Tests**: BẮT BUỘC. Constitution Nguyên tắc V yêu cầu kiểm thử trước khi phát hành, nên mỗi user story có nhóm test. Viết test TRƯỚC và xác nhận test FAIL trước khi cài đặt.

**Organization**: Nhóm theo user story để làm và kiểm thử độc lập. Thứ tự phase theo phụ thuộc thực tế (không hoàn toàn theo số thứ tự story): US7 → US9 → US1 → US2 → US3 → US6 → US4 → US5 → US8.

## Format: `[ID] [P?] [Story] Mô tả kèm đường dẫn file`

- **[P]**: Có thể chạy song song (khác file, không phụ thuộc task chưa xong)
- **[Story]**: US1…US9 theo [spec.md](spec.md)
- Đường dẫn theo cấu trúc ở [plan.md](plan.md) (một ứng dụng TypeScript ở thư mục gốc)

## Ánh xạ User Story

| Nhãn | Story | Ưu tiên |
| --- | --- | :-: |
| US1 | Tạo Project và sinh voice từ file subtitle | P1 |
| US2 | Chạy nền và theo dõi tiến trình | P1 |
| US3 | Xem Project, nghe voice, highlight theo thời gian thực | P1 |
| US4 | Chỉnh sửa Project và quản lý tiến trình voice | P2 |
| US5 | Xóa một hoặc nhiều Project | P2 |
| US6 | Tìm kiếm, sắp xếp, lọc danh sách Project | P2 |
| US7 | Tài khoản, đăng nhập, hồ sơ cá nhân, quản lý User | P1 |
| US8 | Dashboard cá nhân, thống kê Administrator, cài đặt hệ thống | P2 |
| US9 | Cấu hình nhà cung cấp AI chung và riêng | P1 |

---

## Phase 1: Setup (hạ tầng dùng chung)

**Purpose**: Khởi tạo dự án và môi trường dev

- [X] T001 Khởi tạo dự án Next.js (App Router, TypeScript `strict`, Node.js LTS) ở thư mục gốc: `package.json` (scripts `dev`, `build`, `start`, `worker:dev`, `worker:start`, `db:generate`, `db:migrate`, `test`, `test:e2e`, `test:isolation`, `lint`), `tsconfig.json` (alias `@/*` → `src/*`), `next.config.ts` (`output: 'standalone'`), `src/app/layout.tsx`, `src/app/page.tsx`
- [X] T002 [P] Cấu hình ESLint + Prettier + `.editorconfig` (`eslint.config.mjs`, `.prettierrc`); thêm quy tắc cấm chuỗi tiếng Việt cứng trong `src/components/**` ngoài `src/lib/i18n/`
- [X] T003 [P] Cài Tailwind CSS và khởi tạo shadcn/ui (`components.json`); thêm các thành phần vào `src/components/ui/`: button, input, textarea, label, form, select, checkbox, switch, slider, tabs, table, badge, card, dialog, alert-dialog, dropdown-menu, popover, tooltip, avatar, progress, skeleton, scroll-area, pagination, sonner, chart
- [X] T004 Áp dụng theme tweakcn `https://tweakcn.com/themes/cmmdxhg6d000804l5f6xlcbh3` vào `src/app/globals.css` (Spike S6: tìm đúng URL registry; nếu không cài được qua lệnh shadcn thì chép biến CSS light/dark của theme thủ công); phụ thuộc T003
- [X] T005 [P] Tạo `.env.example` (không giá trị thật) với: `DATABASE_URL`, `POSTGRES_PASSWORD`, `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, `S3_ENDPOINT`, `S3_BUCKET`, `APP_ENCRYPTION_KEY`, `AUTH_SECRET`, `APP_URL`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `CLOUDFLARE_TUNNEL_TOKEN`, `ALLOW_INSECURE_PROVIDER_URLS`; và `src/lib/env.ts` kiểm tra bằng Zod (lỗi rõ khi thiếu; `ALLOW_INSECURE_PROVIDER_URLS` mặc định `false`)
- [X] T006 [P] Tạo `docker/compose.dev.yml` (PostgreSQL 16, MinIO, dịch vụ khởi tạo bucket riêng tư `S3_BUCKET`, volume bền, cổng chỉ bind `127.0.0.1`) và `docker/postgres-init.sql` (`CREATE EXTENSION unaccent, pg_trgm`)
- [X] T007 [P] Cấu hình Vitest: `vitest.config.ts`, `tests/setup.ts`, thư mục `tests/unit/`, `tests/integration/`, `tests/contract/`, `tests/isolation/`
- [X] T008 [P] Cấu hình Playwright: `playwright.config.ts`, `tests/e2e/fixtures.ts` (đăng nhập sẵn User/Admin, tạo dữ liệu qua API, tệp audio mẫu)
- [X] T009 [P] Viết máy chủ nhà cung cấp giả `mock-provider/server.ts` mô phỏng cả 3 dịch vụ (FPT Speech async + link, FPT Marketplace nhị phân, ShopAIKey trả URL) với các chế độ chọn qua header/tham số: `ok`, `slow-async`, `429-then-ok`, `5xx`, `401`, `403-quota`, `400-policy`, `400-voice`, `malformed`, `timeout`, `redirect-internal`; trả WAV hợp lệ có độ dài tỉ lệ số ký tự

---

## Phase 2: Foundational (BẮT BUỘC xong trước mọi user story)

**Purpose**: CSDL, bảo mật, lưu trữ, xác thực lõi, khung giao diện, khung worker

**⚠️ CRITICAL**: Chưa user story nào được bắt đầu trước khi xong phase này

### Cơ sở dữ liệu

- [X] T010 [P] Schema Drizzle `src/lib/db/schema/auth.ts`: bảng xác thực của thư viện + mở rộng `users` đúng [data-model.md](data-model.md): `email` text unique chữ thường; `username` text unique null; `display_name` text 1–60 ký tự; `bio` text null ≤ 500 ký tự; `avatar_key` text null; `role` enum `admin|user` mặc định `user`; `status` enum `active|banned|deleting` mặc định `active`; `can_use_custom_ai` boolean mặc định **false**; `storage_used_bytes` bigint mặc định 0; `last_active_at` timestamptz null; `created_at`, `updated_at`
- [X] T011 [P] Schema Drizzle `src/lib/db/schema/ai-config.ts`: `ai_provider_configs` — `scope` enum `global|user`; `owner_user_id` uuid null FK users cascade (NULL khi `global`, bắt buộc khi `user`); `type` enum `fpt_speech|fpt_marketplace|shopaikey_openai`; `api_key_enc` bytea; `api_key_hint` text; `max_chars_per_request` int; `price_per_million_chars` numeric null; `enabled` boolean; `disabled_reason` enum null `owner_removed_from_list|admin_disabled`; ràng buộc duy nhất `(scope, coalesce(owner_user_id, zero-uuid), type)`
- [X] T012 [P] Schema Drizzle `src/lib/db/schema/projects.ts`: `projects` (`name` 1–120 ký tự, `description` ≤ 2000 ký tự null, `provider_type`, `voice_count` int mặc định 0, `owner_id` FK cascade), `subtitle_files` (`ext` enum `txt|md|skt`, `size_bytes` int, `storage_key`, `content_hash`, `char_count`, `segment_count`, bất biến sau khi tạo), `segments` (`idx` từ 0, unique `(subtitle_file_id, idx)`, `text`, `char_count`)
- [X] T013 [P] Schema Drizzle `src/lib/db/schema/jobs.ts`: `voice_jobs` (`status` enum `queued|running|completed|failed|stopped|interrupted`, `config_scope` enum `global|user`, `settings` jsonb `{model,voice,speed,maxCharsPerSegment,pauseMs}`, `progress_done/total`, `cancel_requested`, `attempt`, `heartbeat_at`, `queue_job_id`, các mốc thời gian), `job_segments` (PK `(job_id, idx)`, `status` enum `pending|running|done|failed`), `audio_cache` (unique `(owner_id, content_hash)`, `last_used_at`), `job_logs` (`id` bigserial, `level` enum `info|warn|error`, chỉ mục `(job_id, id)`), `voices` (`job_id` **unique**, `timeline` jsonb `[{idx,startMs,endMs}]`)
- [X] T014 [P] Schema Drizzle `src/lib/db/schema/usage.ts`: `usage_records` (`user_id`, `project_id`, `job_id` uuid null FK **set null**, `units_chars` int, `units_tokens` int null, `cost_estimate_usd` numeric null, `ok` boolean, chỉ mục `(user_id, ts)` và `(ts)`) và `system_settings` (`key` text PK, `value` jsonb, `updated_by`)
- [X] T015 `src/lib/db/schema/index.ts`, `src/lib/db/index.ts` (kết nối), `drizzle.config.ts`; sinh migration đầu tiên `src/lib/db/migrations/0000_init.sql`; phụ thuộc T010–T014
- [X] T016 Migration tay `src/lib/db/migrations/0001_search_and_indexes.sql`: hàm `immutable_unaccent(text)` khai báo IMMUTABLE (xem [research.md](research.md) R12), cột sinh `projects.search_text = immutable_unaccent(lower(name || ' ' || coalesce(description,'')))`, chỉ mục GIN `pg_trgm` trên `search_text`, chỉ mục `(owner_id, updated_at desc)`, `(owner_id, name)`, `(owner_id, provider_type)`; phụ thuộc T015
- [X] T017 `src/lib/db/migrate.ts` (chạy migration) và seed `system_settings` mặc định: `max_file_bytes=2097152`, `user_quota_bytes=524288000`, `max_concurrent_jobs=3`, `max_jobs_per_user=2`, `segment_concurrency=3`; `src/lib/settings.ts` đọc cài đặt có giá trị mặc định (dùng chung cho API và worker); phụ thuộc T016
- [X] T018 [P] Mã hóa khóa API `src/lib/security/crypto.ts` (AES-256-GCM, khóa từ `APP_ENCRYPTION_KEY`; hàm `encryptSecret`, `decryptSecret`, `secretHint` trả vài ký tự cuối) và test `tests/unit/crypto.test.ts` (round-trip, sai khóa/giả mạo bị từ chối, nonce khác nhau mỗi lần)
- [X] T019 [P] Lớp chống SSRF `src/lib/security/safe-fetch.ts` (chỉ `https`, cho `http` khi `ALLOW_INSECURE_PROVIDER_URLS=true`; phân giải DNS rồi từ chối loopback, riêng tư, link-local, `169.254.0.0/16`, tên nội bộ Docker; ghim IP đã kiểm tra; không theo chuyển hướng; giới hạn kích thước và thời gian) và test `tests/unit/safe-fetch.test.ts` (IP riêng, DNS rebinding giả lập, redirect sang nội bộ, URL quá lớn)
- [X] T020 [P] Client MinIO `src/lib/storage/client.ts` và `src/lib/storage/keys.ts` (hàm sinh khóa: `users/{uid}/subtitles/{fileId}/original`, `users/{uid}/cache/{hash}.wav`, `users/{uid}/voices/{voiceId}.mp3`, `users/{uid}/avatar`; hàm xóa theo tiền tố có phân trang)
- [X] T021 [P] Proxy phát file có `Range` `src/lib/storage/proxy.ts` (200/206/416, `Accept-Ranges`, `Content-Type`, `Content-Disposition` khi tải về, hủy luồng khi client ngắt) và test `tests/unit/range-proxy.test.ts`
- [X] T022 Cấu hình xác thực `src/lib/auth/auth.ts` (Spike S5: email + mật khẩu, session cookie, mật khẩu băm có muối, từ chối `banned`/`deleting`, giới hạn tốc độ đăng nhập/đăng ký **lưu bền trong DB**, chỉ tin `CF-Connecting-IP` khi request đến từ tunnel) và `src/app/api/auth/[...all]/route.ts`; nếu Better Auth không đáp ứng, dùng Auth.js (Credentials) giữ nguyên hợp đồng ở T023; chặn CSRF: mọi `POST/PUT/PATCH/DELETE` dùng cookie phiên MUST kiểm tra `Origin`/`Host` khớp `APP_URL` (sai → 403); phụ thuộc T015
- [X] T023 `src/lib/auth/guards.ts`: `requireUser()` (401 chưa đăng nhập; từ chối `banned`/`deleting`), `requireAdmin()` (User thường nhận **404**), `ownerScope(userId)` bắt buộc dùng cho mọi truy vấn dữ liệu người dùng; phụ thuộc T022
- [X] T024 Seed Administrator idempotent `src/lib/auth/seed-admin.ts` từ `ADMIN_EMAIL`/`ADMIN_PASSWORD` (đồng bộ mật khẩu khi đổi, không bao giờ tạo `admin` qua đăng ký) và gọi trong `src/instrumentation.ts` sau migration; phụ thuộc T017, T022
- [X] T025 [P] Hạ tầng API `src/lib/api/errors.ts` (định dạng lỗi `{error:{code,message,fields}}`, bộ bọc `route()` bắt lỗi, Zod → 422, không lộ chi tiết nội bộ) và `src/lib/api/pagination.ts`
- [X] T026 [P] Zod dùng chung `src/lib/schemas/common.ts` (`ProviderType`, `JobStatus`, phân trang, id, `passwordSchema`: 10–128 ký tự, không toàn chữ số, không thuộc danh sách mật khẩu phổ biến) khớp [contracts/openapi.yaml](contracts/openapi.yaml)
- [X] T027 [P] Chuỗi tiếng Việt tập trung `src/lib/i18n/vi.ts` (nhãn, thông báo lỗi kèm gợi ý xử lý, trạng thái job, mã lỗi nhà cung cấp → thông báo thân thiện theo [contracts/tts-provider.md](contracts/tts-provider.md))
- [X] T028 [P] Thành phần dùng chung `src/components/shared/`: `confirm-dialog.tsx` (nêu số lượng và hậu quả), `data-table.tsx` (chọn nhiều), `empty-state.tsx`, `error-state.tsx`, `loading-skeleton.tsx`
- [X] T029 [P] `src/lib/api-client.ts` (fetch bọc, đọc định dạng lỗi chuẩn, tự điều hướng khi 401) và `src/lib/query-provider.tsx` (TanStack Query)
- [X] T030 Khung ứng dụng `src/app/(app)/layout.tsx` (thanh bên, tiêu đề, menu User) và `src/app/(admin)/admin/layout.tsx` (chặn không phải admin bằng 404); phụ thuộc T023, T028, T029
- [X] T031 Khung worker `src/worker/index.ts` (khởi động pg-boss, đăng ký hàng đợi, tắt êm khi nhận SIGTERM) và `src/worker/queues.ts` (tên hàng đợi: `generate-voice`, `delete-user`, `reconcile-storage`); phụ thuộc T015
- [X] T032 [P] Ghi log job `src/worker/job-log.ts` (`appendLog(jobId, level, code, message, meta)` ghi `job_logs`; làm sạch mọi chuỗi để không chứa khóa API hay URL có tham số `key`) và test `tests/unit/job-log-redaction.test.ts`
- [X] T033 [P] Bộ trợ giúp kiểm thử tích hợp `tests/integration/helpers.ts` (DB và MinIO test, tạo User/Admin, đăng nhập lấy cookie, gọi API, tạo dữ liệu mẫu) và `tests/integration/globalSetup.ts`

**Checkpoint**: Nền tảng sẵn sàng; có thể bắt đầu các user story

---

## Phase 3: User Story 7 - Tài khoản, đăng nhập, hồ sơ, quản lý User (Priority: P1) 🎯

**Goal**: User tự đăng ký/đăng nhập, cá nhân hóa hồ sơ; Administrator cấp sẵn quản lý User (khóa, đặt lại mật khẩu, xóa); dữ liệu cô lập giữa các User.

**Independent Test**: Đăng ký User A, đăng nhập, sửa hồ sơ; đăng nhập User B xác nhận không thấy dữ liệu của A; đăng nhập Administrator khóa User rồi xóa (quickstart #2, #9, #12).

### Tests for User Story 7 ⚠️ (viết trước, phải FAIL)

- [X] T034 [P] [US7] `tests/integration/auth.test.ts`: đăng ký (email trùng, mật khẩu vi phạm chính sách 10–128 ký tự, không toàn chữ số, không thuộc danh sách mật khẩu phổ biến bị từ chối), đăng nhập/đăng xuất, giới hạn sau nhiều lần sai, `banned` không đăng nhập được, `deleting` bị chặn, seed admin idempotent, không thể tự đăng ký thành admin, `POST/PUT/PATCH/DELETE` có `Origin` lạ → 403
- [X] T035 [P] [US7] `tests/integration/profile.test.ts`: `PATCH /api/me` (`displayName` 1–60, `bio` ≤ 500 → 422 khi vượt), avatar `png|jpeg|webp` ≤ 1 MB (loại khác/lớn hơn bị từ chối), đổi mật khẩu cần mật khẩu hiện tại
- [X] T036 [P] [US7] `tests/integration/admin-users.test.ts`: liệt kê/tìm kiếm/lọc trạng thái, khóa/mở khóa, đặt lại mật khẩu, xóa phải kèm `confirm` đúng email, không xóa/khóa được admin cấp sẵn, User thường gọi `/api/admin/*` nhận 404, xóa User → `status=deleting` rồi dữ liệu và đối tượng MinIO biến mất, `usage_records.user_id` thành NULL
- [X] T037 [US7] `tests/isolation/isolation.test.ts`: bộ kiểm thử cô lập đọc `contracts/openapi.yaml`, với mỗi đường dẫn có tham số id: tạo tài nguyên bằng User A rồi gọi bằng User B kỳ vọng **404**, gọi không đăng nhập kỳ vọng 401; chỉ duyệt các route **đã được cài đặt** (danh sách `IMPLEMENTED_PATHS`, mỗi story bổ sung cùng fixture của mình); các đường dẫn chưa cài được liệt kê tường minh là `PENDING` và **không** làm test thất bại (điều kiện bao phủ 100% chỉ bật ở T157)
- [X] T038 [P] [US7] `tests/e2e/auth.spec.ts`: đăng ký → đăng nhập → sửa hồ sơ/avatar; Admin khóa User → User không vào được

### Implementation for User Story 7

- [X] T039 [P] [US7] Trang `src/app/(auth)/login/page.tsx` và `src/app/(auth)/register/page.tsx` cùng `src/components/auth/login-form.tsx`, `register-form.tsx` (Zod, thông báo tiếng Việt, trạng thái đang gửi/lỗi)
- [X] T040 [US7] `src/lib/users/service.ts` và `src/app/api/me/route.ts` (GET, PATCH theo [openapi.yaml](contracts/openapi.yaml) `Me`: gồm `storageUsedBytes`, `storageQuotaBytes`, `canUseCustomAi`)
- [X] T041 [P] [US7] `src/app/api/me/avatar/route.ts` (PUT multipart, GET, DELETE; kiểm tra magic bytes png/jpeg/webp, ≤ 1 MB; khóa `users/{id}/avatar`; phát qua proxy)
- [X] T042 [P] [US7] `src/app/api/me/password/route.ts` (đổi mật khẩu, `newPassword` theo `passwordSchema`)
- [X] T043 [US7] Trang `src/app/(app)/settings/profile/page.tsx` (ảnh đại diện, tên hiển thị, giới thiệu, đổi mật khẩu) và `src/components/app/user-menu.tsx` hiển thị avatar/tên
- [X] T044 [US7] `src/lib/users/admin-service.ts`: liệt kê/tìm kiếm, khóa/mở khóa, bật/tắt `can_use_custom_ai`, đặt lại mật khẩu, khởi tạo xóa (`status=deleting` + đưa job `delete-user` vào hàng đợi); chặn thao tác lên admin cấp sẵn
- [X] T045 [P] [US7] `src/app/api/admin/users/route.ts` (GET), `src/app/api/admin/users/[userId]/route.ts` (PATCH, DELETE với `confirm`), `src/app/api/admin/users/[userId]/reset-password/route.ts`
- [X] T046 [US7] Worker `src/worker/jobs/delete-user.ts` (idempotent, thử lại đến khi sạch): xóa đối tượng MinIO tiền tố `users/{id}/`, xóa bản ghi theo thứ tự phụ thuộc, `usage_records` đặt NULL (giữ thống kê ẩn danh); việc dừng job đang chạy được nối ở T107
- [X] T047 [US7] Trang `src/app/(admin)/admin/users/page.tsx` (bảng tìm kiếm, lọc trạng thái, khóa/mở khóa, đặt lại mật khẩu, xóa với hộp xác nhận gõ lại email và nêu rõ hậu quả không khôi phục)
- [X] T048 [US7] Cập nhật `last_active_at` (tối đa 1 lần/phút) trong `src/lib/auth/guards.ts`

**Checkpoint**: Đăng ký/đăng nhập, hồ sơ và quản lý User hoạt động; cô lập dữ liệu được kiểm thử

---

## Phase 4: User Story 9 - Cấu hình nhà cung cấp AI chung và riêng (Priority: P1)

**Goal**: Administrator cấu hình AI chung và quản lý danh sách User được dùng cấu hình riêng; User trong danh sách nhập cấu hình riêng; có 3 adapter và kiểm tra kết nối.

**Independent Test**: Quickstart #1 và #10: Admin nhập cấu hình chung, kiểm tra kết nối; thêm/gỡ User khỏi danh sách; User nhập cấu hình riêng.

### Spike và tests ⚠️

- [X] T049 [US9] Spike S1–S3: `scripts/spike-providers.ts` gọi thật từng adapter bằng một câu tiếng Việt (khóa lấy từ biến môi trường, không ghi ra log/file); ghi kết quả (chất lượng tiếng Việt, độ trễ, định dạng, khoảng `speed` hợp lệ của Marketplace, hỗ trợ `mp3`, hành vi link `async` của FPT Speech trước khi sẵn sàng) vào `docs/provider-spikes.md`; cập nhật [contracts/tts-provider.md](contracts/tts-provider.md) và `catalog.ts` theo kết quả **(script `scripts/spike-providers.ts` và mẫu `docs/provider-spikes.md` đã có; CHỜ khóa API thật để chạy và ghi kết quả)** _(2026-11-19: Marketplace ✅; ShopAIKey MiniMax ✅ (adapter mới `shopaikey_minimax`); ShopAIKey OpenAI TTS ❌ do group của khóa; **FPT.AI Speech đã gỡ** theo yêu cầu — xem `docs/provider-spikes.md`.)_
- [X] T050 [P] [US9] `tests/contract/adapter-suite.ts`: bộ kiểm thử hợp đồng chung chạy trên máy chủ giả theo [contracts/tts-provider.md](contracts/tts-provider.md) (thành công, async chậm, 429 rồi ok, 5xx liên tục, 401, 403 quota, 400 policy, 400 voice sai, phản hồi hỏng, timeout, hủy giữa chừng, URL nội bộ bị chặn; quét log không chứa khóa API)
- [X] T051 [P] [US9] `tests/contract/fpt-speech.test.ts` chạy suite cho `fpt_speech` (thêm: `error != 0`, polling backoff, hết hạn ~150 s)
- [X] T052 [P] [US9] `tests/contract/fpt-marketplace.test.ts` chạy suite cho `fpt_marketplace` (thêm: 403 chưa cấp model, voice không dùng chéo model)
- [X] T053 [P] [US9] `tests/contract/shopaikey-openai.test.ts` chạy suite cho `shopaikey_openai` (thêm: tải audio từ URL qua `safeFetch`, 404/503 "No available channel")
- [X] T054 [P] [US9] `tests/unit/config-resolution.test.ts`: chọn cấu hình lúc bắt đầu job — User trong danh sách có cấu hình riêng `enabled` → dùng riêng; không trong danh sách → chung; cấu hình riêng lỗi **không** rơi về chung; không có cấu hình → `PROVIDER_NOT_CONFIGURED`; bị gỡ khỏi danh sách → cấu hình riêng vô hiệu và quay về chung
- [X] T055 [P] [US9] `tests/integration/ai-config-api.test.ts`: Admin CRUD cấu hình chung; **khóa API không bao giờ có trong phản hồi** (chỉ `apiKeyHint`); `PUT` để trống `apiKey` giữ khóa cũ; `baseUrl` trỏ nội bộ bị 422; User ngoài danh sách gọi `/api/me/ai-config` nhận 404; thêm/gỡ User khỏi danh sách; gỡ → cấu hình riêng `enabled=false`, `disabled_reason=owner_removed_from_list`, còn nguyên; kiểm tra kết nối trả thông báo thân thiện
- [X] T056 [P] [US9] `tests/e2e/ai-config.spec.ts` (quickstart #1, #10)

### Implementation for User Story 9

- [X] T057 [P] [US9] `src/lib/providers/types.ts` (`TtsProvider`, `SynthesizeRequest`, `SynthesizeResult`, `CallContext`) và `src/lib/providers/errors.ts` (`ProviderError` với `kind`: `transient|auth|quota|forbidden_model|voice_invalid|content_blocked|bad_request|ssrf_blocked`)
- [X] T058 [P] [US9] `src/lib/providers/catalog.ts`: model, giọng đọc, thang tốc độ theo từng adapter (FPT Speech `banmai, thuminh, leminh, giahuy, myan, lannhi, linhsan` tốc độ `-3..3`; Marketplace theo model VITs/pro/ultra, voice không dùng chéo model; OpenAI TTS `alloy…shimmer`, tốc độ 0.25–4.0) và `maxCharsPerRequest` mặc định (5.000 / 10.000 / 4.096); cập nhật theo kết quả T049
- [X] T059 [P] [US9] `src/lib/providers/adapters/fpt-speech.ts` theo [contracts/tts-provider.md](contracts/tts-provider.md) (header `api_key`, polling backoff 1,5 → 8 s tối đa ~150 s, body UTF-8 NFC)
- [X] T060 [P] [US9] `src/lib/providers/adapters/fpt-marketplace.ts` (`Authorization: Bearer`, `response_format: wav`, `speed` chỉ gửi khi khác 1)
- [X] T061 [P] [US9] `src/lib/providers/adapters/shopaikey-openai.ts` (`/tts/openai/speech`, `input` ≤ 4.096 ký tự, tải URL audio qua `safeFetch`)
- [X] T062 [US9] `src/lib/providers/index.ts`: registry theo `type` và bộ phân loại lỗi HTTP dùng chung; phụ thuộc T057–T061
- [X] T063 [US9] `src/lib/providers/config-service.ts`: tạo/sửa/xóa/bật tắt cấu hình (mã hóa khóa bằng T018, `api_key_hint`, kiểm tra `baseUrl` bằng quy tắc `safeFetch`), kiểm tra kết nối (gọi thử câu ngắn, kết quả lưu `last_test_*`), `resolveConfigForJob(user, providerType)` theo [data-model.md](data-model.md), `disablePersonalConfigs(userId)`; phụ thuộc T018, T019, T062
- [X] T064 [P] [US9] `src/app/api/providers/route.ts` (danh mục + `available` + `usingOwnConfig`)
- [X] T065 [P] [US9] `src/app/api/me/ai-config/route.ts`, `src/app/api/me/ai-config/[type]/route.ts`, `src/app/api/me/ai-config/[type]/test/route.ts` (404 nếu User không có `can_use_custom_ai`)
- [X] T066 [P] [US9] `src/app/api/admin/ai-configs/route.ts`, `src/app/api/admin/ai-configs/[type]/route.ts`, `src/app/api/admin/ai-configs/[type]/test/route.ts`
- [X] T067 [P] [US9] `src/app/api/admin/custom-ai-users/route.ts` (GET có tìm kiếm, POST) và `src/app/api/admin/custom-ai-users/[userId]/route.ts` (DELETE → gọi `disablePersonalConfigs`)
- [X] T068 [US9] Nối `disablePersonalConfigs` vào `src/lib/users/admin-service.ts` khi PATCH `canUseCustomAi=false` (FR-044 nhất quán ở cả hai đường); phụ thuộc T044, T063
- [X] T069 [US9] Trang `src/app/(admin)/admin/ai-configs/page.tsx` (loại, địa chỉ gốc, khóa API dạng che, model/giọng/tốc độ mặc định, giá mỗi triệu ký tự, bật/tắt, nút kiểm tra kết nối, cảnh báo khi chưa có cấu hình chung) và `src/app/(admin)/admin/custom-ai-users/page.tsx` (thêm/gỡ User, tìm kiếm)
- [X] T070 [US9] Trang `src/app/(app)/settings/ai/page.tsx` cho User trong danh sách (cùng biểu mẫu, hiển thị rõ đang dùng cấu hình riêng hay chung; User ngoài danh sách nhận 404 và không có mục menu); phụ thuộc T065

**Checkpoint**: Cấu hình AI chung/riêng chạy, 3 adapter qua bộ kiểm thử hợp đồng

---

## Phase 5: User Story 1 - Tạo Project và sinh voice từ file subtitle (Priority: P1) 🎯 MVP

**Goal**: Tạo Project, upload `.txt/.md/.skt`, xem trước đoạn, tạo voice bằng AI, theo dõi log thời gian thực.

**Independent Test**: Quickstart #2–#3, #13: tạo Project, upload file `.txt`, bắt đầu tạo voice, log chạy đến `completed`, voice nằm trong Project.

### Tests for User Story 1 ⚠️

- [X] T071 [P] [US1] `tests/unit/parsing.test.ts`: `.txt`; `.md` (bỏ tiêu đề/danh sách/nhấn mạnh/liên kết, bỏ khối mã); `.skt`/`.srt` (bỏ số thứ tự và dòng `HH:MM:SS,mmm --> …`, thẻ `<…>`/`{…}`); BOM; UTF-8 không hợp lệ; byte nhị phân; rỗng sau chuẩn hóa; > 2 MB; NFC; bỏ emoji và URL dài; tách câu tiếng Việt (viết tắt, dấu ba chấm, số thập phân); gộp đoạn ≤ `maxCharsPerSegment` và luôn ≤ giới hạn nhà cung cấp
- [X] T072 [P] [US1] `tests/unit/audio-timeline.test.ts`: ghép PCM — mốc `startMs/endMs` chính xác theo số mẫu, khoảng lặng ~380 ms sau `. ! ?` và ~220 ms sau `, ; :`, tổng thời lượng bằng tổng đoạn + khoảng lặng, mp3 cuối lệch ≤ 50 ms so với PCM
- [X] T073 [P] [US1] `tests/integration/files-api.test.ts`: upload hợp lệ trả đoạn xem trước; `.pdf`/không UTF-8/rỗng/3 MB bị từ chối kèm lý do và không tạo gì; vượt 500 MB → 409 `QUOTA_EXCEEDED`; `GET /api/files/{id}` và `/raw`; xóa file đang dùng bởi job chạy → 409
- [X] T074 [P] [US1] `tests/integration/voice-pipeline.test.ts` (worker + máy chủ giả): thành công; chạy lại cùng nội dung → mọi đoạn `cache_hit`, **không** thêm `usage_records`; 429 thử lại rồi ok; 5xx hết lần thử → `failed`; `content_blocked` → đoạn `failed`, không retry, các đoạn khác vẫn xong, job `failed` kèm danh sách đoạn; 401/403 quota dừng job; log và `usage_records` ghi đúng `config_scope`; **mọi log không chứa khóa API**; tiến độ `progress_done/total`; User sát hạn mức vẫn hoàn tất job đang chạy (vượt hạn mức không làm job thất bại) nhưng bị chặn khi tạo job mới
- [X] T075 [P] [US1] `tests/integration/jobs-api.test.ts`: tạo job (409 `PROVIDER_NOT_CONFIGURED`, 409 `QUOTA_EXCEEDED`), `GET /api/jobs/{id}`, `/logs?after=`; SSE theo [contracts/job-events.md](contracts/job-events.md): thứ tự sự kiện, `Last-Event-ID` không mất/không trùng, log đầu ≤ 2 s, sự kiện `end` đóng luồng
- [X] T076 [P] [US1] `tests/e2e/create-voice.spec.ts` (quickstart #2–#3, #13); chạy thêm ở viewport điện thoại 375 px (FR-031) và đo thời gian từ đăng ký đến bắt đầu tạo voice dưới 2 phút (SC-001)

### Implementation for User Story 1

- [X] T077 [P] [US1] `src/lib/parsing/detect.ts`: kiểm tra đuôi `.txt|.md|.skt`, ≤ `max_file_bytes` (mặc định 2 MB), UTF-8 hợp lệ (bỏ BOM), không nhị phân
- [X] T078 [P] [US1] `src/lib/parsing/markdown.ts` (bóc ký hiệu Markdown bằng bộ phân tích unified/remark) và `src/lib/parsing/skt.ts` (bỏ số thứ tự, mốc thời gian, thẻ; coi như văn bản thuần)
- [X] T079 [P] [US1] `src/lib/parsing/normalize.ts` (NFC, gộp khoảng trắng, bỏ emoji và URL dài) và `src/lib/parsing/segmenter.ts` (`Intl.Segmenter('vi','sentence')` + quy tắc viết tắt/ba chấm/số thập phân, gộp đến `maxCharsPerSegment` mặc định 400)
- [X] T080 [US1] `src/lib/parsing/index.ts`: `parseScript(buffer, ext)` trả `{rawText, cleanedText, segments, charCount}`; phụ thuộc T077–T079
- [X] T081 [US1] `src/lib/storage/quota.ts`: `reserveBytes/releaseBytes` cập nhật `users.storage_used_bytes` trong cùng giao dịch, kiểm tra hạn mức từ `settings.ts` ở máy chủ; có hai chế độ: **chặt** (`reserveBytes(userId, bytes)`, từ chối khi vượt, dùng lúc upload file và lúc tạo job mới) và **mềm** (`reserveBytes(userId, bytes, { soft: true })`, luôn cho phép và chỉ cộng số liệu, dùng trong worker để job đang chạy không bao giờ bị hủy vì vượt hạn mức)
- [X] T082 [P] [US1] `src/app/api/projects/route.ts`: `GET` danh sách phân trang cơ bản (mặc định `updatedAt desc`, kèm `voiceCount`, `runningJobs`, `failedJobs`) và `POST` tạo Project (`name` 1–120 ký tự và không toàn khoảng trắng, `description` ≤ 2000 ký tự, `providerType` hợp lệ; luôn gắn `owner_id` từ session)
- [X] T083 [P] [US1] `src/app/api/projects/[projectId]/route.ts` `GET` chi tiết (files, jobs, voices) theo `ProjectDetail`
- [X] T084 [US1] `src/app/api/projects/[projectId]/files/route.ts`: `GET` danh sách, `POST` multipart (validate T077, parse T080, kiểm tra quota T081, lưu file gốc vào MinIO, ghi `subtitle_files` + `segments`, trả `SubtitleFileDetail`); phụ thuộc T080, T081
- [X] T085 [P] [US1] `src/app/api/files/[fileId]/route.ts` (GET, DELETE; DELETE trả 409 nếu job đang chạy dùng file) và `src/app/api/files/[fileId]/raw/route.ts` (tải file gốc)
- [X] T086 [P] [US1] `src/lib/audio/ffmpeg.ts` (giải mã bất kỳ định dạng → PCM 24 kHz mono 16-bit; mã hóa PCM → MP3 128 kbps) và `src/lib/audio/merge.ts` (ghép PCM, chèn khoảng lặng theo dấu câu, tính `timeline` theo số mẫu)
- [X] T087 [P] [US1] `src/lib/usage/record.ts`: `recordUsage` ghi `usage_records` (`units_chars` = `[...text].length`, `units_tokens` chỉ khi có, `cost_estimate_usd` = ký tự × `price_per_million_chars` / 1.000.000 hoặc NULL, `config_scope`, `ok`)
- [X] T088 [US1] `src/worker/pipeline/cache.ts`: khóa `sha256(userId | providerType | model | voice | speed | format | textNFC)`, tra/lưu `audio_cache` (`users/{uid}/cache/{hash}.wav`, cập nhật `last_used_at`, cộng quota bằng chế độ **mềm** của `reserveBytes`); phụ thuộc T020, T081
- [X] T089 [US1] `src/worker/pipeline/synthesize-segment.ts`: gọi adapter qua `safeFetch`, thử lại `transient` tối đa 4 lần (backoff mũ + jitter, tôn trọng `retryAfterMs`), không thử lại lỗi vĩnh viễn, ghi `job_segments`, `usage_records` (T087) và log (T032); phụ thuộc T062, T087, T088
- [X] T090 [US1] `src/worker/jobs/generate-voice.ts`: xác định cấu hình bằng `resolveConfigForJob` lúc bắt đầu (log `PROVIDER_SELECTED` chỉ nêu chung/riêng, không lộ khóa), chạy các đoạn song song theo `segment_concurrency`, cập nhật `progress_*` và `heartbeat_at`, ghép + mã hóa MP3, lưu `users/{uid}/voices/{voiceId}.mp3`, tạo `voices` (`timeline`), cập nhật `projects.voice_count`/`updated_at`, kết thúc `completed|failed`; đăng ký trong `src/worker/index.ts`; phụ thuộc T086, T089
- [X] T091 [US1] `src/app/api/projects/[projectId]/jobs/route.ts`: `GET` danh sách, `POST` bắt đầu (kiểm tra cấu hình khả dụng → 409 `PROVIDER_NOT_CONFIGURED`, quota → 409, ghi `voice_jobs` trạng thái `queued`, chụp `settings`, đưa vào pg-boss, log `JOB_QUEUED`)
- [X] T092 [P] [US1] `src/app/api/jobs/route.ts` (`GET ?status=` liệt kê tiến trình của tôi xuyên Project, dùng cho popover ở T109), `src/app/api/jobs/[jobId]/route.ts` (`GET` `JobDetail` kèm `failedSegments`) và `src/app/api/jobs/[jobId]/logs/route.ts` (đọc theo con trỏ `after`)
- [X] T093 [US1] `src/app/api/jobs/[jobId]/events/route.ts`: SSE theo [contracts/job-events.md](contracts/job-events.md) (header đúng, truy vấn `job_logs` theo con trỏ mỗi ~1 s, `id` = `job_logs.id`, `Last-Event-ID`, keep-alive 15 s, sự kiện `log|progress|status|end`; `interrupted` không đóng luồng)
- [X] T094 [US1] Trang `src/app/(app)/projects/page.tsx` (danh sách cơ bản + hộp thoại tạo Project: tên, mô tả, nhà cung cấp lấy từ `/api/providers` kèm trạng thái khả dụng)
- [X] T095 [US1] Trang `src/app/(app)/projects/[projectId]/page.tsx` (tab Tệp, Tiến trình, Voice) và `src/components/projects/upload-dropzone.tsx` (kiểm tra phía client, hiển thị lỗi rõ lý do) + hộp thoại xem trước đoạn
- [X] T096 [P] [US1] `src/components/jobs/start-job-dialog.tsx` (chọn model/giọng/tốc độ theo catalog, hiển thị đang dùng cấu hình chung hay riêng)
- [X] T097 [P] [US1] `src/lib/hooks/use-job-stream.ts` (EventSource, `Last-Event-ID`, khử trùng theo `id`) và `src/components/jobs/log-viewer.tsx` (thời điểm, mức độ, nội dung, tự cuộn, trạng thái đang tải/rỗng/lỗi)
- [X] T098 [US1] Trang `src/app/(app)/projects/[projectId]/jobs/[jobId]/page.tsx` (trạng thái, thanh tiến độ x/y đoạn, log viewer, danh sách đoạn lỗi với thông báo thân thiện, liên kết sang voice khi xong); phụ thuộc T097
- [X] T099 [US1] Bổ sung fixture cho các endpoint US1 vào `tests/isolation/isolation.test.ts` (projects, files, jobs, logs, events)

**Checkpoint**: MVP lõi — tạo Project → upload → sinh voice → xem log; kiểm thử độc lập được

---

## Phase 6: User Story 2 - Chạy nền và theo dõi tiến trình (Priority: P1)

**Goal**: Tiến trình độc lập với trình duyệt, chịu khởi động lại, có giới hạn đồng thời, quay lại thấy đúng trạng thái; có lõi dừng tiến trình.

**Independent Test**: Quickstart #4, #14: bắt đầu job, đóng tab/khởi động lại worker, quay lại thấy đã hoàn tất hoặc tiếp tục chạy với log đầy đủ.

### Tests for User Story 2 ⚠️

- [X] T100 [P] [US2] `tests/integration/recovery.test.ts`: dừng worker giữa job → heartbeat hết hạn → `interrupted` → tự `queued` lại → hoàn tất **không gọi lại đoạn đã xong** (kiểm tra số `usage_records`); log `JOB_INTERRUPTED`, `JOB_RESUMED`; thêm kịch bản khởi động lại toàn bộ stack (`docker compose restart`) rồi xác nhận dữ liệu Project, file và voice còn nguyên (FR-032)
- [X] T101 [P] [US2] `tests/integration/concurrency.test.ts`: vượt `max_concurrent_jobs` thì job dư ở `queued` rồi chạy tuần tự; `max_jobs_per_user`; yêu cầu dừng giữa các đoạn dừng đúng chỗ và giữ phần đã xong
- [X] T102 [P] [US2] `tests/e2e/background.spec.ts` (quickstart #4, #14): đóng tab, mở lại thấy tiến độ và log đầy đủ; hai tab thấy cùng log

### Implementation for User Story 2

- [X] T103 [US2] `src/worker/sweeper.ts`: khi khởi động và định kỳ, job `running` có `heartbeat_at` quá hạn → `interrupted` rồi đưa lại hàng đợi, ghi log; gọi trong `src/worker/index.ts`
- [X] T104 [US2] Giới hạn đồng thời trong `src/worker/queues.ts`/`generate-voice.ts`: toàn hệ thống theo `max_concurrent_jobs`, mỗi User theo `max_jobs_per_user` (job dư giữ `queued`, log lý do chờ)
- [X] T105 [US2] Tính idempotent trong `src/worker/jobs/generate-voice.ts`: bỏ qua `job_segments` đã `done` (an toàn vì mọi đoạn `done` luôn cùng một thiết lập, xem T129), tăng `attempt`, log `JOB_RESUMED`; phụ thuộc T090
- [X] T106 [US2] Lõi dừng tiến trình `src/lib/jobs/control.ts` (`requestStop(jobIds)` đặt `cancel_requested`, hủy bằng `AbortSignal` giữa các đoạn, trạng thái `stopped`, log `JOB_STOP_REQUESTED/JOB_STOPPED`) và worker kiểm tra cờ trong `generate-voice.ts`
- [X] T107 [US2] Nối `requestStop` vào khóa User (`src/lib/users/admin-service.ts`) và `src/worker/jobs/delete-user.ts` (dừng job trước khi xóa dữ liệu); phụ thuộc T046, T106
- [X] T108 [P] [US2] Bổ sung polling dự phòng và chỉ báo kết nối lại vào `src/lib/hooks/use-job-stream.ts` (`GET /logs?after=` mỗi 2 s khi SSE lỗi)
- [X] T109 [P] [US2] `src/components/jobs/status-badge.tsx` và chỉ báo "đang chạy" trong danh sách Project, chi tiết Project, cùng popover "Tiến trình đang chạy" ở tiêu đề (`src/components/app/active-jobs.tsx`, dữ liệu từ `GET /api/jobs?status=running,queued`) để người dùng làm việc khác mà vẫn thấy trạng thái

**Checkpoint**: Job chạy nền bền vững, tự tiếp tục sau sự cố

---

## Phase 7: User Story 3 - Xem Project, nghe voice, highlight thời gian thực (Priority: P1)

**Goal**: Nghe voice, văn bản làm nổi bật đúng câu đang đọc, tự cuộn, tua và bấm câu để phát.

**Independent Test**: Quickstart #5: phát, tua, bấm vào câu; highlight đúng (lệch ≤ 0,3 s).

### Tests for User Story 3 ⚠️

- [X] T110 [P] [US3] `tests/unit/active-segment.test.ts`: tìm nhị phân đoạn đang đọc (biên đoạn, khoảng lặng giữa đoạn, trước đoạn đầu, sau đoạn cuối, tua lùi)
- [X] T111 [P] [US3] `tests/integration/voices-api.test.ts`: `GET /api/voices/{id}` trả `segments` (văn bản + `startMs/endMs`); `/audio` trả 200/206/416 đúng `Range`; `download=true` có `Content-Disposition`; User khác nhận 404; không truy cập được không xác thực
- [X] T112 [P] [US3] `tests/e2e/player-sync.spec.ts` (quickstart #5): highlight đổi đúng đoạn, tự cuộn, tua nhảy đúng đoạn, bấm câu phát từ đó, đo độ lệch ≤ 0,3 s và sau tua ≤ 0,5 s; chạy thêm trên viewport 375 px (FR-031)

### Implementation for User Story 3

- [X] T113 [P] [US3] `src/lib/player/active-segment.ts` (hàm thuần tìm nhị phân theo `timeline`)
- [X] T114 [P] [US3] `src/app/api/voices/[voiceId]/route.ts` (GET) và `src/app/api/voices/[voiceId]/audio/route.ts` (dùng `storage/proxy.ts`, kiểm tra chủ sở hữu, hỗ trợ `download`)
- [X] T115 [US3] `src/components/player/voice-player.tsx` (phát/tạm dừng, thanh tua, tốc độ phát, âm lượng, tải về) trên `HTMLAudioElement`
- [X] T116 [US3] `src/components/player/synced-text.tsx`: vòng `requestAnimationFrame` đọc `currentTime`, đánh dấu đoạn đang đọc, `scrollIntoView({block:'center'})` có điều kiện (không giật khi người dùng đang tự cuộn), cập nhật khi `seeked`, bấm đoạn → đặt `currentTime = startMs/1000`; phụ thuộc T113
- [X] T117 [US3] Trang `src/app/(app)/projects/[projectId]/voices/[voiceId]/page.tsx` ghép trình phát + văn bản đồng bộ; chọn giữa nhiều voice của Project; tab xem **kịch bản gốc** (FR-010) lấy từ `/api/files/{id}`
- [X] T118 [P] [US3] `src/components/projects/job-table.tsx` (chỉ đọc): hiển thị các tiến trình đang chạy và trạng thái từng tiến trình trong chi tiết Project (FR-002); dùng `status-badge.tsx`
- [X] T119 [US3] Bổ sung fixture `voices` vào `tests/isolation/isolation.test.ts`

**Checkpoint**: P1 hoàn chỉnh — MVP đầy đủ giá trị (đăng nhập → tạo → upload → voice → nghe có highlight)

---

## Phase 8: User Story 6 - Tìm kiếm, sắp xếp, lọc Project (Priority: P2)

**Goal**: Tìm không dấu, sắp xếp, lọc và kết hợp trên danh sách Project.

**Independent Test**: Quickstart #8: tìm "kich ban", đổi sắp xếp, lọc, kết hợp.

### Tests for User Story 6 ⚠️

- [X] T120 [P] [US6] `tests/integration/project-search.test.ts`: "kich ban" khớp "Kịch bản"; "duong" khớp "đường" (kiểm tra `đ/Đ`); sắp xếp `name|createdAt|updatedAt|voiceCount` hai chiều; lọc `provider`, `jobState` (`running|failed|none`); kết hợp; phân trang; **200 Project phản hồi < 1 s**
- [X] T121 [P] [US6] `tests/e2e/search.spec.ts` (quickstart #8, gồm trạng thái "không tìm thấy" và xóa bộ lọc)

### Implementation for User Story 6

- [X] T122 [US6] `src/lib/db/queries/projects.ts` (truy vấn có `q` dùng `immutable_unaccent`, sắp xếp, lọc, đếm tổng) và mở rộng `src/app/api/projects/route.ts` theo [openapi.yaml](contracts/openapi.yaml) (`q ≤ 200`, `pageSize ≤ 100`)
- [X] T123 [US6] Nếu T120 phát hiện `đ/Đ` không được chuyển thành `d`, sửa `immutable_unaccent` bằng migration mới `src/lib/db/migrations/0002_unaccent_d.sql`
- [X] T124 [US6] `src/components/projects/project-toolbar.tsx` (ô tìm có debounce, chọn sắp xếp, bộ lọc nhà cung cấp/trạng thái, xóa bộ lọc, đồng bộ lên URL) và phân trang; cập nhật `src/app/(app)/projects/page.tsx` với trạng thái rỗng, "không tìm thấy" và tải

**Checkpoint**: Danh sách Project dùng tốt với số lượng lớn

---

## Phase 9: User Story 4 - Sửa Project và quản lý tiến trình voice (Priority: P2)

**Goal**: Sửa thông tin Project; xem, sửa thiết lập, dừng, tiếp tục, chạy lại và xóa một hoặc nhiều tiến trình.

**Independent Test**: Quickstart #6, #7 (phần tiến trình): dừng job, sửa giọng, chạy lại tái sử dụng cache, xóa nhiều tiến trình.

### Tests for User Story 4 ⚠️

- [X] T125 [P] [US4] `tests/integration/job-control.test.ts`: dừng giữ phần đã xong; `resume` (stopped|failed|interrupted) tiếp tục từ đoạn chưa xong; **đổi giọng/tốc độ rồi `resume` → mọi đoạn của voice cuối cùng một thiết lập, đoạn không đổi vẫn `cache_hit` và không thêm `usage_records`**; `PATCH` thiết lập chỉ khi `stopped|failed|interrupted`, còn `queued|running|completed` → 409 (job `completed` dùng `rerun` kèm thiết lập mới); `rerun` tạo job mới với đoạn trùng `cache_hit`; xóa job đang chạy → 409, `bulk-delete` có `rejectedRunning`, với `stopFirst` thì dừng rồi xóa; xóa job xóa `voices`, đối tượng MinIO, giải phóng quota và giảm `voice_count` của Project
- [X] T126 [P] [US4] `tests/integration/project-edit.test.ts`: `PATCH /api/projects/{id}` (kiểm tra `name` 1–120, `description` ≤ 2000, đổi `providerType`)
- [X] T127 [P] [US4] `tests/e2e/manage-jobs.spec.ts` (quickstart #6, #7)

### Implementation for User Story 4

- [X] T128 [P] [US4] `PATCH` trong `src/app/api/projects/[projectId]/route.ts` và `src/components/projects/edit-project-dialog.tsx`
- [X] T129 [P] [US4] `src/app/api/jobs/[jobId]/stop/route.ts`, `resume/route.ts`, `rerun/route.ts` và `PATCH` (chỉ cho `stopped|failed|interrupted`, trạng thái khác → 409; **khi thiết lập thay đổi phải đặt lại toàn bộ `job_segments` về `pending` và `progress_done = 0` (đoạn có cùng hash vẫn được lấy từ `audio_cache`, nên không tốn phí lặp)** để voice cuối không trộn nhiều giọng/tốc độ) và `DELETE` trong `src/app/api/jobs/[jobId]/route.ts`; `rerun` nhận thiết lập mới tùy chọn trong body (dùng `lib/jobs/control.ts` T106)
- [X] T130 [US4] `src/lib/jobs/delete.ts`: xóa job → `voices` + đối tượng MinIO voice + các `audio_cache` không còn được `job_segments` nào của User tham chiếu (xóa cả đối tượng) + giải phóng quota + **giảm `projects.voice_count` (chỉ khi job có voice) và cập nhật `projects.updated_at` trong cùng giao dịch**; dùng chung với US5
- [X] T131 [US4] `src/app/api/jobs/bulk-delete/route.ts` (`ids` 1–100, `stopFirst`; kết quả `deleted|rejectedRunning|notFound`); phụ thuộc T130
- [X] T132 [US4] Nâng `src/components/projects/job-table.tsx` thành có thao tác: xem, `src/components/jobs/edit-settings-dialog.tsx` (chỉ khi `stopped|failed|interrupted`; job `completed` dùng "Chạy lại với thiết lập mới"), dừng, tiếp tục, chạy lại, chọn nhiều + xóa có xác nhận nêu số lượng và hậu quả
- [X] T133 [US4] Bổ sung fixture các endpoint mới vào `tests/isolation/isolation.test.ts`

**Checkpoint**: Quản lý vòng đời tiến trình đầy đủ

---

## Phase 10: User Story 5 - Xóa một hoặc nhiều Project (Priority: P2)

**Goal**: Xóa Project (đơn lẻ/hàng loạt) kèm toàn bộ dữ liệu liên quan, có xác nhận.

**Independent Test**: Quickstart #7: chọn nhiều Project, xác nhận, dữ liệu và file MinIO biến mất.

### Tests for User Story 5 ⚠️

- [X] T134 [P] [US5] `tests/integration/project-delete.test.ts`: xóa đơn và hàng loạt; job đang chạy bị dừng trước; **không còn dữ liệu mồ côi** (file, voice, `audio_cache`, `job_logs`, đối tượng MinIO); quota được giải phóng; **xóa 10 Project < 5 s**; `bulk-delete` trả `deleted|notFound`
- [X] T135 [P] [US5] `tests/e2e/delete-projects.spec.ts` (hộp xác nhận nêu số lượng và hậu quả, hủy thì không xóa)

### Implementation for User Story 5

- [X] T136 [US5] `src/lib/projects/delete.ts`: dừng job → xóa file gốc MinIO, voice, `audio_cache` không còn tham chiếu (tái dùng `lib/jobs/delete.ts`) → xóa bản ghi (cascade) → giải phóng quota
- [X] T137 [P] [US5] `DELETE` trong `src/app/api/projects/[projectId]/route.ts` và `src/app/api/projects/bulk-delete/route.ts` (`ids` 1–100)
- [X] T138 [US5] Chọn nhiều + xóa hàng loạt trong `src/app/(app)/projects/page.tsx` (dùng `confirm-dialog.tsx`) và nút xóa trong chi tiết Project
- [X] T139 [US5] Bổ sung fixture vào `tests/isolation/isolation.test.ts`

**Checkpoint**: Xóa dữ liệu sạch và có kiểm chứng

---

## Phase 11: User Story 8 - Dashboard, thống kê Administrator, cài đặt hệ thống (Priority: P2)

**Goal**: User xem thống kê của mình; Administrator xem thống kê từng User và chỉnh cài đặt hệ thống (giới hạn file, hạn mức, đồng thời).

**Independent Test**: Quickstart #11: số liệu Dashboard và thống kê Admin khớp; chung/riêng tách riêng; User thường vào trang Admin nhận 404.

### Tests for User Story 8 ⚠️

- [X] T140 [P] [US8] `tests/integration/usage-stats.test.ts`: số Project/voice/thời lượng khớp; `usage` theo ngày, theo nhà cung cấp và `charsByScope` (chung/riêng); cache hit không tính; `tokens` NULL không bịa số; `costEstimateUsd` NULL khi không có giá; User bị xóa vẫn còn trong tổng ẩn danh; `/api/admin/stats` User thường → 404; Dashboard cập nhật ≤ 1 phút sau khi job xong
- [X] T141 [P] [US8] `tests/integration/admin-settings.test.ts`: đọc/ghi `maxFileBytes`, `userQuotaBytes`, `maxConcurrentJobs`, `maxJobsPerUser`, `segmentConcurrency` (giá trị âm/0 bị 422); đổi `maxFileBytes` có hiệu lực ngay; đổi hạn mức áp ngay; User thường 404
- [X] T142 [P] [US8] `tests/e2e/dashboard.spec.ts` (quickstart #11)

### Implementation for User Story 8

- [X] T143 [US8] `src/lib/usage/aggregate.ts`: truy vấn tổng hợp theo User/ngày/nhà cung cấp/nguồn cấu hình, thống kê Project/voice/thời lượng/trạng thái job
- [X] T144 [P] [US8] `src/app/api/dashboard/route.ts` (`from`, `to`)
- [X] T145 [P] [US8] `src/app/api/admin/stats/route.ts` (`from`, `to`, `sort`, `order`)
- [X] T146 [P] [US8] `src/app/api/admin/settings/route.ts` (GET, PUT) dùng `src/lib/settings.ts`
- [X] T147 [US8] Trang `src/app/(app)/dashboard/page.tsx` (thẻ số liệu, biểu đồ theo ngày và theo nhà cung cấp bằng thành phần Chart của shadcn, bộ lọc khoảng thời gian, đồng hồ dung lượng so với hạn mức)
- [X] T148 [US8] Trang `src/app/(admin)/admin/stats/page.tsx` (tổng hợp toàn hệ thống + bảng từng User sắp xếp được theo `projects|voices|chars|cost|storage|lastActive`, tách chung/riêng)
- [X] T149 [US8] Trang `src/app/(admin)/admin/settings/page.tsx` (giới hạn file, hạn mức mỗi User, số tiến trình đồng thời)
- [X] T150 [US8] Worker `src/worker/jobs/reconcile-storage.ts` (định kỳ đối soát `users.storage_used_bytes` với tổng thực tế từ MinIO/DB, ghi log chênh lệch)

**Checkpoint**: Có thể theo dõi chi phí AI và mức dùng theo từng User

---

## Phase 12: Polish và các việc xuyên suốt

**Purpose**: Triển khai production, bảo mật, chất lượng chung

- [X] T151 [P] `docker/Dockerfile` (nhiều tầng; web `standalone`; worker có `ffmpeg`; chạy bằng user không phải root) và `docker/compose.prod.yml` (`postgres`, `minio`, `migrate` chạy một lần, `web`, `worker`, `cloudflared`; **không công bố cổng** của `postgres`/`minio`/`web` ra host; volume bền; `restart: unless-stopped`; healthcheck; bí mật qua `.env`)
- [X] T152 [P] `docs/operations.md` (tiếng Việt): gắn tên miền qua Cloudflare Tunnel (Public Hostname → `http://web:3000`), sao lưu/khôi phục `pg_dump` và đồng bộ bucket MinIO, đổi khóa `APP_ENCRYPTION_KEY`/`AUTH_SECRET` và xử lý khi nghi lộ khóa
- [ ] T153 Spike S4: kiểm tra SSE qua Cloudflare Tunnel (độ trễ log ≤ 2 s, không bị đệm); điều chỉnh header/keep-alive ở `src/app/api/jobs/[jobId]/events/route.ts` nếu cần và ghi kết quả vào `docs/operations.md` _(Header/keep-alive đã chuẩn bị sẵn; **chưa kiểm tra trên tunnel thật** — cần tên miền, xem `docs/operations.md` §3.)_
- [X] T154 [P] `tests/integration/log-secrets.test.ts`: chạy các kịch bản lỗi của adapter rồi quét toàn bộ `job_logs`, log máy chủ và phản hồi API: không chứa khóa API hay URL có tham số `key`
- [X] T155 [P] Rà soát bảo mật theo Nguyên tắc I/II: mọi Route Handler đều qua `requireUser/requireAdmin`; không có API nhận `owner_id` từ client; MinIO/Postgres không truy cập được từ ngoài; xác nhận kiểm tra `Origin` (CSRF) hoạt động ở mọi route ghi; kiểm tra tiêu đề an toàn (CSP, `X-Content-Type-Options`, cookie `Secure/HttpOnly/SameSite`) trong `next.config.ts`
- [X] T156 [P] Rà soát giao diện (Nguyên tắc VI): mọi màn hình có trạng thái tải/rỗng/lỗi, dùng tốt trên điện thoại/tablet (xem, nghe, theo dõi tiến trình), không còn chuỗi tiếng Việt cứng ngoài `src/lib/i18n/` (`scripts/check-i18n.ts` chạy trong CI)
- [X] T157 Hoàn thiện `tests/isolation/isolation.test.ts`: bao phủ 100% đường dẫn của `contracts/openapi.yaml`, bật kiểm tra bắt buộc (test thất bại nếu còn đường dẫn `PENDING` hoặc đường dẫn OpenAPI không có ca); chạy `npm run test:isolation` xanh
- [X] T158 [P] `README.md` (tiếng Việt): giới thiệu, yêu cầu, chạy dev, chạy test, triển khai, liên kết `docs/` và `specs/`
- [X] T159 Chạy toàn bộ test (`npm run test`, `npm run test:e2e`, `npm run test:isolation`) và 14 kịch bản thủ công ở [quickstart.md](quickstart.md); đo SC-006 (≈ 5.000 ký tự ≤ 5 phút), SC-007 (200 Project < 1 s), SC-009 (xóa 10 mục < 5 s); sửa sai lệch phát hiện được _(Đã chạy: `npm test`, `test:isolation`, `test:e2e` (30/30), `tests/integration/perf.test.ts` đo SC-006/007/009 với nhà cung cấp giả. Chưa chạy: kịch bản thủ công với nhà cung cấp thật — cần khóa API, xem T049.)_

---

## Dependencies và thứ tự thực hiện

### Phụ thuộc giữa các phase

- **Phase 1 (Setup)** → **Phase 2 (Foundational)** chặn tất cả user story.
- **US7** (tài khoản) trước mọi story khác: mọi truy cập đều cần đăng nhập và cô lập dữ liệu.
- **US9** (cấu hình AI) phụ thuộc US7 (Admin, `can_use_custom_ai`); **US1** phụ thuộc US7 và US9 (`resolveConfigForJob`, adapter).
- **US2** phụ thuộc US1 (mở rộng `generate-voice.ts`); **US3** phụ thuộc US1 (cần `voices` và `timeline`).
- **US6** phụ thuộc US1 (mở rộng `GET /api/projects`); độc lập với US2/US3.
- **US4** phụ thuộc US1 và US2 (lõi dừng `lib/jobs/control.ts`); **US5** phụ thuộc US4 (`lib/jobs/delete.ts`).
- **US8** phụ thuộc US1 (nguồn `usage_records`) và US9 (`config_scope`).
- **Phase 12 (Polish)** sau khi các story cần thiết xong.

### Thứ tự trong một story

Test (phải FAIL) → schema/hàm thuần → service → endpoint → giao diện → fixture cô lập dữ liệu.

### Cơ hội chạy song song

- Phase 1: T002, T003, T005–T009 sau T001.
- Phase 2: T010–T014 (schema), T018–T021 (bảo mật + lưu trữ), T025–T029, T032–T033 chạy song song; T015 → T016 → T017 theo chuỗi.
- Mỗi story: mọi task test `[P]` chạy cùng lúc; các adapter T059–T061 song song; các Route Handler khác file song song.
- Sau US1, hai nhóm có thể làm song song: **{US2 → US3}** và **{US6}**; **US8** có thể song song với US4/US5 vì khác file.

### Ví dụ song song: User Story 9

```text
Cùng lúc:  T050 (suite)  T054 (config-resolution)  T055 (ai-config-api)
Rồi:       T057 types/errors  T058 catalog
Rồi cùng:  T059 fpt-speech  T060 fpt-marketplace  T061 shopaikey-openai
Rồi:       T062 registry → T063 config-service
Rồi cùng:  T064 /api/providers  T065 /api/me/ai-config  T066 /api/admin/ai-configs  T067 /api/admin/custom-ai-users
```

---

## Chiến lược triển khai

### MVP trước (khuyến nghị)

1. Phase 1 → Phase 2.
2. US7 → US9 → US1 → US2 → US3.
3. **Dừng và kiểm chứng**: quickstart #1–#5, #9, #13, #14. Đây là giá trị cốt lõi (đăng nhập → tạo Project → upload → voice → nghe có highlight, chạy nền bền vững).
4. Triển khai thử (Phase 12: T151–T153) để xác nhận SSE và truy cập qua tunnel sớm.

### Giao tăng dần sau MVP

US6 (tìm kiếm) → US4 (quản lý tiến trình) → US5 (xóa Project) → US8 (thống kê và cài đặt) → hoàn thiện Phase 12.

### Lưu ý

- `[P]` = khác file, không phụ thuộc task chưa xong; hai task cùng sửa một file KHÔNG đánh `[P]`.
- Mọi story kết thúc bằng việc bổ sung fixture vào bộ kiểm thử cô lập dữ liệu; T157 chốt 100% bao phủ.
- Task spike (T004, T022, T049, T153) có thể thay đổi quyết định đã ghi; cập nhật tài liệu thiết kế tương ứng khi kết quả khác dự kiến.
- Commit sau mỗi task hoặc nhóm logic; dừng ở các checkpoint để kiểm chứng độc lập từng story.
