---
description: "Danh sách công việc triển khai tính năng 004 — STT Soniox Tạo Phụ Đề & Tái Cấu Trúc Cấu Hình AI Provider Quản Trị"
---

# Tasks: STT Soniox Tạo Phụ Đề & Tái Cấu Trúc Cấu Hình AI Provider Quản Trị

**Input**: Thiết kế kỹ thuật từ `/specs/004-stt-soniox-subtitle/` ([spec.md](./spec.md), [plan.md](./plan.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/)).

**Prerequisites**: 
- Node.js 22, PostgreSQL 16, MinIO, FFmpeg (đã có trong container/hệ thống).
- Dữ liệu kiểm thử âm thanh ngắn $\le 10$ giây (`tests/fixtures/sample-10s.mp3`, `sample-video-5s.mp4`).

**Organization**: Các task được nhóm theo từng Phase và User Story để có thể triển khai, kiểm thử độc lập và bàn giao tăng dần. Thứ tự phase: US4 → US1 (MVP) → US5 → US2 → US3. US1 chỉ phụ thuộc Phase 2 và US4, nên được làm trước US5. Mã task giữ nguyên như bản trước để dễ đối chiếu.

## Format: `[ID] [P?] [Story] Mô tả chi tiết kèm đường dẫn tệp`
- **[P]**: Chạy song song được (khác tệp, không phụ thuộc task chưa xong).
- **[USn]**: Mã User Story trong spec.md (US1: STT Core MVP, US2: Định dạng & Diarization, US3: Background Progress, US4: Core AI Config 1 Token, US5: Custom OpenAI Providers CRUD & Phân quyền).
- **i18n**: Mỗi task có giao diện tự thêm khóa chữ của mình vào `src/lib/i18n/vi.ts` và `src/lib/i18n/en.ts` ngay trong task đó (Hiến pháp VI). T051/T052 chỉ rà soát lần cuối.

---

## Phase 1: Setup & Dữ liệu Kiểm thử Dùng chung

**Mục tiêu**: Chuẩn bị tệp fixture và giả lập phục vụ kiểm thử tự động độc lập.

- [X] T001 [P] Tạo tệp audio kiểm thử ngắn $\le 10$ giây `tests/fixtures/sample-10s.mp3` (chứa câu nói tiếng Việt rõ ràng) phục vụ kiểm thử STT độc lập.
  - Ghi chú triển khai: tệp là âm sin 10 giây (không có giọng nói thật); kiểm thử dùng Soniox giả nên nội dung âm thanh không ảnh hưởng.
- [X] T002 [P] Tạo tệp video ngắn 5 giây `tests/fixtures/sample-video-5s.mp4` (chứa luồng video + audio tiếng Việt) để kiểm thử FFmpeg bóc tách âm thanh.
- [X] T003 [P] Tạo tệp video không có tiếng `tests/fixtures/sample-silent-video.mp4` để kiểm thử trường hợp biên video không có audio stream.
- [X] T004 [P] Xây dựng `tests/mocks/soniox-mock.ts`: Mock client giả lập Soniox API (`uploadAudioFile`, `startTranscription`, `getTranscriptionStatus`, `getTranscript`, `deleteTranscription`, `deleteFile`, `testConnection`; ghi lại các lần gọi xóa để test kiểm tra) trả về tokens tiếng Việt có mốc thời gian $\le 10$ giây; cho phép cấu hình trả lỗi 429/401 và transcript rỗng.

---

## Phase 2: Foundational (Cơ sở dữ liệu & Core Provider Types)

**Mục tiêu**: Thiết lập bảng CSDL `stt_jobs`, `stt_job_logs`, `custom_ai_providers`, thay đổi `voice_jobs`/`usage_records` và chuẩn hóa types nhà cung cấp.

- [X] T005 Cập nhật enum `providerType` trong `src/lib/db/schema/ai-config.ts` thành `['fpt_ai', 'soniox', 'shopaikey', 'openai_compatible']` để phản ánh 3 core provider và provider tùy chỉnh.
  - Ghi chú triển khai: theo quyết định của người dùng, GIỮ tên kiểu nội bộ và chỉ thêm giá trị `soniox`; các cột TTS khai báo kiểu `TtsProviderType` (data-model §3).
- [X] T006 Tạo bảng `customAiProviders` trong `src/lib/db/schema/ai-config.ts`: chỉ chứa provider do Admin tạo (không có `scope`/`ownerUserId`; cấu hình riêng của User giữ ở `ai_provider_configs`), các trường `id`, `name`, `baseUrl`, `apiKeyEnc`, `apiKeyHint`, `models` (jsonb), `defaultModel`, `defaultVoice`, `accessMode` ('public'|'restricted'|'private'), `assignedUserIds` (jsonb), `enabled`, `pricePerMillionChars`, `lastTest*`.
- [X] T007 Tạo bảng `sttJobs` trong `src/lib/db/schema/stt-jobs.ts` và export tại `src/lib/db/schema/index.ts`: các trường `id`, `projectId`, `ownerId`, `originalFileName`, `mediaType`, `fileSizeBytes`, `tempStorageKey`, `targetFormat`, `targetFileName`, `language`, `enableDiarization`, `status` (`stt_job_status`, có giá trị `interrupted`), `progressPercent`, `stageMessage`, `errorMessage`, `sonioxFileId`, `sonioxTranscriptionId`, `resultSubtitleFileId`.
- [X] T007a Tạo bảng `sttJobLogs` trong `src/lib/db/schema/stt-jobs.ts` theo data-model §1 (`sttJobId` FK `ON DELETE CASCADE`, `ts`, `level`, `messageKey`, `params`), kèm index `(stt_job_id, ts)`.
- [X] T008 Tạo migration Drizzle `src/lib/db/migrations/0006_stt_and_custom_ai_providers.sql` bằng `npx drizzle-kit generate` và kiểm tra câu lệnh migration đảm bảo đầy đủ foreign keys, constraints và indexes.
  - Ghi chú triển khai: migration là `0007_stt_and_custom_ai_providers.sql` viết tay (0006 đã tồn tại và cũng viết tay), đăng ký trong `meta/_journal.json`.
- [X] T008a Viết phần chuyển dữ liệu cũ trong migration 0006 theo data-model §7: `fpt_marketplace` → `fpt_ai`; gộp `shopaikey_openai` + `shopaikey_minimax` → `shopaikey` (giữ token `shopaikey_openai` khi khác nhau, ghi cảnh báo); đổi `provider_type` trong `usage_records`; tạo lại enum không còn giá trị cũ; chuyển cấu hình `openai_compatible` có `scope = 'global'` sang `custom_ai_providers` (`access_mode = 'public'`) và chuyển `voice_jobs.config_id` trỏ tới nó sang `custom_provider_id`. Kèm test `tests/integration/migration-0006.test.ts` chạy trên dữ liệu mẫu có đủ 3 giá trị enum cũ và một cấu hình `openai_compatible` chung có voice job đang trỏ tới.
  - Ghi chú triển khai: không đổi tên/gộp enum (giữ tên nội bộ); ShopAIKey 1 token làm bằng đồng bộ khóa giữa hai bản ghi ở `config-service.ts`. Phần chuyển `openai_compatible` chung sang `custom_ai_providers` có test `tests/integration/migration-0007.test.ts`.
- [X] T008b Cập nhật `src/lib/db/schema/usage.ts` theo data-model §5: `unitsChars` nullable, thêm `unitsAudioSeconds`, `sttJobId` (FK `stt_jobs`, `ON DELETE SET NULL`) và ràng buộc phải có ít nhất một đơn vị. Cập nhật `src/lib/usage/aggregate.ts` để thống kê cộng được số giây âm thanh.
- [X] T008c [P] Thêm cài đặt hệ thống `maxSttJobsPerUser` (mặc định 2) vào schema cài đặt và trang cài đặt Admin (`src/app/api/admin/settings/route.ts`), cùng cách với `maxJobsPerUser`.
- [X] T008d Cập nhật `src/lib/db/schema/jobs.ts` theo data-model §8: thêm `customProviderId` vào `voiceJobs` (FK `custom_ai_providers`, `ON DELETE SET NULL`), ràng buộc `config_id` và `custom_provider_id` không cùng có giá trị, index `custom_provider_id`.
- [X] T009 [P] Cập nhật danh mục `src/lib/providers/catalog.ts`: chuẩn hóa FPT.AI (1 token dùng cho VITs, TTS-pro, TTS-ultra và model mở rộng), SONIOX (1 token dùng cho `stt-async-v6`, `stt-async-v5` và `stt-rt-v6`; đánh dấu `stt-rt-v6` là model real-time, không dùng cho tạo phụ đề), ShopAIKey (1 token dùng cho toàn bộ model OpenAI/Minimax).
- [X] T010 [P] Thêm tên hàng đợi mới `transcribeMedia: 'transcribe-media'` vào `QUEUES` trong `src/worker/queues.ts`.
- [X] T010a [P] Thêm ``sttTemp: (userId, jobId, ext) => `users/${userId}/stt-tmp/${jobId}/source.${ext}` `` vào `storageKeys` trong `src/lib/storage/keys.ts`.

**Checkpoint**: Nền tảng CSDL và catalog sẵn sàng — có thể bắt đầu cài đặt các User Stories.

---

## Phase 3: User Story 4 — Admin Cấu hình 1 Token cho Core AI Providers (Priority: P1)

**Mục tiêu**: Quản trị viên chỉ cần nhập 1 token duy nhất cho FPT.AI, 1 token cho SONIOX (chọn model Async STT), 1 token cho ShopAIKey.

### Tests cho US4 (Viết trước)
- [X] T011 [P] [US4] `tests/unit/core-provider-config.test.ts`: Kiểm tra lưu trữ mã hóa khóa API (AES-256-GCM), hiển thị che `apiKeyHint`, và 1 token FPT/Soniox/ShopAIKey được chia sẻ chung cho toàn bộ model trực thuộc.
- [X] T012 [P] [US4] `tests/integration/admin-ai-configs.test.ts`: API `PUT /api/admin/ai-configs/[type]` lưu cấu hình FPT, Soniox, ShopAIKey; kiểm tra người dùng không phải Admin bị từ chối 403; lưu Soniox với `defaultModel` dạng `stt-rt-*` bị từ chối; tạo `openai_compatible` với `scope = 'global'` bị từ chối. Thêm test trọn luồng cho Independent Test của US4 (dùng mock): sau khi lưu 1 token FPT và 1 token Soniox, một voice job FPT gọi nhà cung cấp bằng đúng token FPT ở mọi model, và một STT job gọi Soniox bằng đúng token Soniox.

### Cài đặt US4
- [X] T013 [US4] Cập nhật service `src/lib/providers/config-service.ts`: hỗ trợ lưu và đọc cấu hình 1 token cho `fpt_ai`, `soniox`, `shopaikey` với kiểm tra phân quyền Admin. Từ chối lưu Soniox `defaultModel` dạng `stt-rt-*` (FR-010). Từ chối tạo `openai_compatible` với `scope = 'global'` (provider chung chuẩn OpenAI nay nằm ở `custom_ai_providers`).
  - Ghi chú triển khai: cấu hình Soniox ở service riêng `src/lib/stt/config.ts` (bảng `stt_provider_configs`).
- [X] T014 [US4] Cài đặt `SonioxSttClient.testConnection` trong `src/lib/providers/adapters/soniox.ts`: gọi `GET https://api.soniox.com/v1/models` với API Key để kiểm tra tính hợp lệ và trả về `TestResult` (latency, danh sách model). Trước khi viết, thử thật một lần (Hiến pháp: điểm chưa kiểm chứng phải thử thật) các điểm: endpoint `GET /v1/models`, trường `audio_duration_ms` trong kết quả phiên âm, tham số `language_hints`, và hai endpoint xóa `DELETE /v1/transcriptions/{id}`, `DELETE /v1/files/{id}`; ghi kết quả vào research.md R1 trước khi làm T034 và T036a. Điểm nào không đúng thì sửa thiết kế trước khi làm.
  - Ghi chú triển khai: đã đối chiếu tài liệu chính thức (research.md R1b); CHƯA gọi thử bằng token thật — cần làm thủ công.
- [X] T015 [US4] Cập nhật API route `src/app/api/admin/ai-configs/[type]/test/route.ts` hỗ trợ test kết nối cho Soniox và các core provider.
  - Ghi chú triển khai: route riêng `POST /api/admin/stt-config/test` (và `GET/PUT/DELETE /api/admin/stt-config`).
- [X] T016 [US4] Tái cấu trúc component `src/components/settings/ai-config-manager.tsx` (kèm khóa i18n):
  - Tab 1: **FPT.AI** — 1 ô nhập API Key duy nhất, chọn model mặc định, nút Test Connection, công tắc Bật/Tắt.
  - Tab 2: **SONIOX** — 1 ô nhập API Key duy nhất, dropdown chọn model STT mặc định (`stt-async-v6` khuyến nghị, `stt-async-v5` kèm nhãn "Bản cũ", tự nhập model async; `stt-rt-v6` hiển thị nhưng bị khóa với ghi chú "Dành cho tính năng real-time sau này"), ô "Đơn giá ước tính (USD/giờ âm thanh)" lưu vào `settings.pricePerAudioHourUsd`, nút Test Connection, công tắc Bật/Tắt.
  - Tab 3: **ShopAIKey** — 1 ô nhập API Key duy nhất, chọn model mặc định, nút Test Connection, công tắc Bật/Tắt.

---

## Phase 4: User Story 1 — Tải Audio/Video lên & Tạo Phụ Đề .srt qua Soniox STT (Priority: P1) 🎯 Core STT MVP

**Mục tiêu**: Tải file âm thanh (.mp3, .wav,...) hoặc video (.mp4, .mov,...), bóc tách âm thanh qua FFmpeg, phiên âm qua Soniox STT, gom nhóm token thành câu phụ đề chuẩn `.srt` và nạp vào Project.

### Tests cho US1 (Viết trước)
- [X] T029 [P] [US1] `tests/unit/media-extract.test.ts`: Kiểm tra hàm `extractAudioFromMedia` dùng FFmpeg trích xuất luồng audio mono 16kHz MP3 từ video; kiểm tra ném lỗi sớm khi video không có tiếng (`sample-silent-video.mp4`).
- [X] T030 [P] [US1] `tests/unit/stt-chunker.test.ts`: Kiểm tra hàm `chunkTokensToSrt` gom nhóm tokens Soniox thành cue phụ đề chuẩn `.srt`: ngắt câu theo dấu chấm/hỏi/than, ngắt theo khoảng lặng $\ge 380\text{ ms}$, giới hạn $\le 75$ ký tự/cue, thời lượng cue 1,2–5,5 giây, định dạng `HH:MM:SS,mmm --> HH:MM:SS,mmm`.
- [X] T031 [P] [US1] `tests/integration/soniox-client.test.ts`: Kiểm tra `SonioxSttClient` gọi Mock Soniox API (upload audio buffer, tạo async transcription, polling và lấy transcript tokens), gửi `language_hints` khi `language ≠ auto`, dùng model từ cấu hình Soniox; transcript rỗng làm job `failed` với mã `NO_SPEECH_DETECTED`.
- [X] T032 [P] [US1] `tests/integration/stt-create-job.test.ts`: Kiểm tra API `POST /api/projects/[projectId]/stt` nhận file media hợp lệ (kèm trường `language`, mặc định `auto`), lưu tạm MinIO tại `users/{userId}/stt-tmp/{jobId}/`, tạo record `stt_jobs` trạng thái `queued` và đẩy vào hàng đợi pg-boss.
- [X] T032a [P] [US1] `tests/integration/stt-limits.test.ts`: video > 500 MB hoặc audio > 100 MB trả 413; User đã có `maxSttJobsPerUser` job đang chờ/chạy nhận 429 ở yêu cầu tiếp theo; file > 60 phút làm job `failed` với mã `MEDIA_TOO_LONG` trước khi gọi Soniox; tạo job không làm tăng `storageUsedBytes` của User.
- [X] T032b [P] [US1] `tests/integration/stt-isolation.test.ts`: User B gọi `GET /api/stt/{jobId của A}`, `GET` và `POST /api/projects/{project của A}/stt` đều nhận 404 (Hiến pháp I/V).

### Cài đặt US1
- [X] T033 [US1] Thêm hàm `extractAudioFromMedia(inputBuffer: Buffer, ext: string): Promise<Buffer>` vào `src/lib/audio/ffmpeg.ts`: sử dụng FFmpeg với tham số `-vn -acodec libmp3lame -q:a 4 -ac 1 -ar 16000` chuyển đổi media sang MP3 mono 16kHz siêu nhẹ; kiểm tra luồng audio tồn tại.
- [X] T034 [US1] Xây dựng client `src/lib/providers/adapters/soniox.ts` và types `soniox-types.ts`:
  - `uploadAudioFile(buffer, filename)`: `POST /v1/files`
  - `startTranscription(fileId, options)`: `POST /v1/transcriptions` với model đọc từ cấu hình Soniox (`settings.defaultModel`, mặc định `stt-async-v6`); nếu model có dạng `stt-rt-*` thì báo lỗi cấu hình (lỗi vĩnh viễn) thay vì gọi; gửi `language_hints: [language]` khi `language ≠ auto`
  - Phân loại lỗi tạm thời (mạng, 429, 5xx) và vĩnh viễn (401, 403, 4xx còn lại) theo bảng trong `contracts/soniox-client.md`
  - `getTranscriptionStatus(id)`: `GET /v1/transcriptions/{id}`
  - `getTranscript(id)`: `GET /v1/transcriptions/{id}/transcript`
  - `deleteTranscription(id)`: `DELETE /v1/transcriptions/{id}`; `deleteFile(id)`: `DELETE /v1/files/{id}` (404 coi như đã xóa) — theo `contracts/soniox-client.md` mục "Dọn dữ liệu trên Soniox"
- [X] T035 [US1] Xây dựng thư viện `src/lib/parsing/stt-chunker.ts`:
  - `chunkTokensToSrt(tokens: SonioxToken[], options)`: Gom nhóm tokens theo dấu câu (`.`, `!`, `?`), dấu ngắt nhịp (`,`, `;`, `:`), khoảng lặng $\ge 380\text{ ms}$, độ dài $\le 75$ ký tự/cue, trả về mảng cue chuẩn SubRip.
  - `formatSrtTime(totalMs: number)`: Format mili-giây sang `HH:MM:SS,mmm`.
- [X] T036 [US1] Cài đặt worker job `src/worker/jobs/transcribe-media.ts`:
  - Mỗi lần đổi giai đoạn, mỗi lần thử lại và mỗi lỗi ghi một dòng vào `stt_job_logs` (khóa i18n + tham số; không chứa khóa API hay URL có khóa) (FR-020).
  - Trước mỗi giai đoạn, kiểm tra job còn tồn tại; nếu Project/User đã bị xóa (job không còn) thì dừng, xóa file tạm của job và xóa file/bản phiên âm đã gửi lên Soniox (FR-021).
  - Tải file tạm từ MinIO; đo thời lượng bằng ffprobe, nếu > 60 phút thì `failed` với mã `MEDIA_TOO_LONG` và dừng.
  - Cập nhật status `extracting`; nếu là video: gọi `extractAudioFromMedia` bóc tách sang MP3.
  - Cập nhật job status `uploading` $\rightarrow$ gọi `SonioxSttClient.uploadAudioFile`, lưu `sonioxFileId`.
  - Cập nhật job status `transcribing` $\rightarrow$ gọi `SonioxSttClient.startTranscription`, lưu `sonioxTranscriptionId`.
  - Polling trạng thái định kỳ 2s $\rightarrow$ cập nhật `progressPercent`.
  - Khi hoàn tất: lấy transcript tokens; nếu rỗng thì `failed` với mã `NO_SPEECH_DETECTED`. Cập nhật status `formatting` $\rightarrow$ gọi `chunkTokensToSrt` sinh nội dung `.srt`.
  - Gọi `uploadScript(...)` nạp file phụ đề vào `subtitle_files` và `subtitle_cues` của Project.
  - Xóa file media tạm trên MinIO, gọi `deleteTranscription` rồi `deleteFile` để xóa dữ liệu trên Soniox (lỗi khi xóa chỉ ghi dòng `warn` vào nhật ký, không làm job thất bại), rồi đánh dấu job `completed` kèm `resultSubtitleFileId`.
- [X] T036a [US1] Ghi usage trong worker (FR-018): khi phiên âm hoàn tất, gọi `recordUsage` đúng 1 lần với `providerType = 'soniox'`, `ok = true`, `unitsAudioSeconds` (từ `audio_duration_ms` Soniox trả về, không tự tính), `sttJobId`, model, chi phí ước tính từ `settings.pricePerAudioHourUsd` (NULL nếu chưa cấu hình). Mỗi lần gọi Soniox thất bại ghi 1 bản ghi `ok = false`, chi phí 0. Upload và poll không ghi.
- [X] T036b [P] [US1] `tests/integration/stt-usage.test.ts`: một job thành công có đúng 1 bản ghi `ok = true` với đủ trường; mỗi lần gọi lỗi (mock 429/401) có 1 bản ghi `ok = false`; các lần poll không sinh bản ghi; không bịa số giây khi mock không trả về thời lượng.
- [X] T037 [US1] Đăng ký handler `transcribeMedia` trong `src/worker/handlers.ts` với `boss.work(QUEUES.transcribeMedia, { localConcurrency: 2 }, ...)`; phần vượt mức nằm chờ trong hàng đợi (Hiến pháp III).
- [X] T038 [US1] Cài đặt API route `src/app/api/projects/[projectId]/stt/route.ts`:
  - `POST`: Nhận `multipart/form-data` gồm file media, `language` (mặc định `auto`), định dạng và tùy chọn diarization. Theo thứ tự: (1) kiểm tra quyền sở hữu Project, trả 404 nếu không phải của mình; (2) kiểm tra dung lượng video ≤ 500 MB, audio ≤ 100 MB, trả 413; (3) đếm job đang chờ/chạy của User, nếu ≥ `maxSttJobsPerUser` trả 429; (4) lưu file tạm vào MinIO tại `storageKeys.sttTemp(userId, jobId, ext)` (không gọi `reserveBytes`), tạo bản ghi `stt_jobs`, đẩy job vào pg-boss.
  - `GET`: Danh sách các STT jobs thuộc Project.
- [X] T039 [US1] Cài đặt API route `src/app/api/stt/[jobId]/route.ts`: `GET` chi tiết trạng thái, tiến độ, kết quả và 50 dòng nhật ký gần nhất từ `stt_job_logs`.
- [X] T040 [US1] Xây dựng component `src/components/projects/stt-dialog.tsx` (kèm khóa i18n):
  - Vùng kéo thả / chọn file video hoặc audio.
  - Ô nhập tên kịch bản mong muốn, lựa chọn định dạng (`.srt` mặc định).
  - Ô chọn "Ngôn ngữ gợi ý" (mặc định "Tự nhận diện", các lựa chọn vi, en, ...).
  - Hiển thị lỗi 413/429 bằng thông báo nêu giới hạn bị vượt và bước nên làm tiếp.
  - Nút "Bắt đầu chuyển đổi STT".
  - Hiển thị thanh tiến trình % động và thông điệp trạng thái (Đang trích xuất âm thanh $\rightarrow$ Đang gửi Soniox $\rightarrow$ Đang phiên âm $\rightarrow$ Hoàn tất).
  - Đủ trạng thái đang tải, rỗng ("Chưa có tiến trình phiên âm") và lỗi có nút thử lại (Hiến pháp VI).
- [X] T041 [US1] Tích hợp nút mở `SttDialog` ("Tạo phụ đề từ Audio/Video") vào khung upload bên phải trong `src/components/projects/project-detail.tsx`.
  - Ghi chú triển khai: nút đặt ở cột "Tạo mới" (cột chứa khung upload) của trang Project; banner tiến trình đặt trên các tab.
- [X] T042 [US1] Khi STT job hoàn tất: tự động invalidate query `['project', projectId]`, file `.srt` mới xuất hiện ngay lập tức trong danh sách kịch bản (khung bên trái), mở xem trước được và có thể bấm Tạo Voice ngay.

---

## Phase 5: User Story 5 — Admin Quản lý CRUD Custom AI Providers & Phân quyền User (Priority: P2)

**Mục tiêu**: Admin có thể tạo nhiều Provider chuẩn OpenAI, sửa, xóa, test kết nối và phân quyền (Công khai / Chỉ định User / Chỉ Admin); User được quyền dùng được provider đó để tạo Voice; User được phép có thể cấu hình riêng.

### Tests cho US5 (Viết trước)
- [X] T018 [P] [US5] `tests/unit/custom-provider-access.test.ts`: Kiểm tra logic phân quyền: provider `public` cho mọi User, `restricted` chỉ User nằm trong `assignedUserIds` mới truy cập được, `private` chỉ Admin.
- [X] T019 [P] [US5] `tests/integration/custom-ai-providers-crud.test.ts`: Kiểm tra các API routes CRUD (`GET`, `POST`, `PUT`, `DELETE`, `/test`) cho Custom AI Providers. Thêm 2 test cho xóa và tắt provider (US5-AS4): voice job `queued`/`interrupted` có `custom_provider_id = id` chuyển `failed` với thông báo "Nhà cung cấp đã bị xóa hoặc tắt"; job `running` không bị động tới.
- [X] T022b [P] [US5] `tests/integration/voice-custom-provider.test.ts`: User A tạo voice bằng provider `restricted` có A thì job chạy được và gọi đúng `base_url` (mock); User B gửi thẳng `customProviderId` đó thì bị từ chối; provider bị tắt rồi job bị gián đoạn và chạy lại thì chuyển `failed` với "Nhà cung cấp đã bị xóa hoặc tắt"; User A bị gỡ khỏi `assignedUserIds` thì job đang chạy vẫn hoàn tất, còn job chưa bắt đầu hoặc chạy lại sau gián đoạn chuyển `failed` với "Bạn không còn quyền dùng nhà cung cấp này"; API tạo voice với `customProviderId` không có quyền trả 404; usage ghi `provider_type = openai_compatible`, `config_scope = global`.

### Cài đặt US5
- [X] T020 [US5] Xây dựng service quản trị `src/lib/providers/custom-provider-service.ts`:
  - `listCustomProviders(userId)`: Lấy danh sách provider do Admin tạo theo quyền truy cập (`public`, hoặc `restricted` có `userId`; `private` chỉ khi là Admin).
  - `createCustomProvider(input)`: Tạo mới provider chuẩn OpenAI (mã hóa API Key).
  - `updateCustomProvider(id, input)`: Cập nhật thông tin, model, phân quyền. Khi đổi `enabled` thành `false`, áp dụng cùng cách xử lý job như khi xóa.
  - `deleteCustomProvider(id)`: Trong một transaction, chuyển các voice job `queued` hoặc `interrupted` có `custom_provider_id = id` sang `failed` với thông báo "Nhà cung cấp đã bị xóa hoặc tắt", không động tới job `running`, rồi xóa provider. Trả về số job bị hủy để hiển thị.
  - `countPendingJobs(id)`: Đếm voice job `queued`/`interrupted` có `custom_provider_id = id`, cho hộp thoại xác nhận.
  - `testCustomProvider(id)`: Gọi `GET {baseUrl}/models` kiểm tra kết nối.
- [X] T021 [US5] Cài đặt API routes Admin CRUD trong `src/app/api/admin/custom-ai-providers/`:
  - `route.ts`: `GET` danh sách provider, `POST` tạo mới.
  - `[providerId]/route.ts`: `PUT` sửa, `DELETE` xóa.
  - `[providerId]/test/route.ts`: `POST` test kết nối.
- [X] T022 [US5] Cài đặt API route `src/app/api/me/ai-providers/route.ts`: trả về danh sách các provider hợp lệ để tạo Voice cho User hiện tại (Core TTS + Custom Public + Custom Restricted + cấu hình riêng trong `ai_provider_configs` nếu có `canUseCustomAi`). Không dùng danh sách này cho STT (STT luôn dùng Soniox).
- [X] T022a [US5] Cho voice job dùng Custom Provider (FR-022, data-model §8):
  - API tạo voice job (`src/app/api/projects/[projectId]/jobs/` và `src/lib/jobs/service.ts`) thêm `customProviderId` vào `createJobSchema` (theo `contracts/openapi-delta.yaml`); chỉ nhận khi Project có `providerType = 'openai_compatible'` (ngược lại trả 400); kiểm tra quyền truy cập ở máy chủ trước khi tạo job (không có quyền hoặc provider không tồn tại/đã tắt thì trả 404), lưu vào `voice_jobs.custom_provider_id`.
  - `resolveConfigForJob` (`src/lib/providers/config-service.ts`) thêm nhánh, chạy khi worker nhận job (job chưa bắt đầu hoặc chạy lại sau gián đoạn; không kiểm tra lại giữa chừng): job có `customProviderId` thì kiểm tra lại provider còn `enabled` và User còn quyền, rồi trả cấu hình adapter `openai_compatible` với `base_url` và khóa của provider. Provider bị tắt, hoặc `custom_provider_id` đã thành NULL do provider bị xóa, thì báo lỗi vĩnh viễn với "Nhà cung cấp đã bị xóa hoặc tắt"; User không còn quyền thì báo lỗi vĩnh viễn với "Bạn không còn quyền dùng nhà cung cấp này".
  - `src/worker/jobs/generate-voice.ts` (đoạn gán `configId` quanh dòng 160–169) lưu `customProviderId` thay vì `configId` khi job dùng Custom Provider; usage ghi `provider_type = openai_compatible`, `config_scope = global`.
  - Giao diện chọn nhà cung cấp khi tạo Voice hiển thị Custom Provider từ T022.
- [X] T023 [US5] Xây dựng component `src/components/settings/custom-provider-table.tsx` (kèm khóa i18n): Hiển thị bảng danh sách các Custom Provider do Admin quản lý với huy hiệu phân quyền (Công khai, Số User chỉ định, Chỉ Admin), trạng thái và nút thao tác (Sửa, Xóa, Test). Nút Xóa mở hộp thoại xác nhận nêu tên provider và hậu quả ("N tiến trình đang chờ sẽ bị hủy", lấy từ `countPendingJobs`), theo Hiến pháp VI. Đủ trạng thái đang tải, rỗng ("Chưa có nhà cung cấp nào") và lỗi có nút thử lại.
- [X] T024 [US5] Xây dựng component `src/components/settings/custom-provider-dialog.tsx` (kèm khóa i18n): Hộp thoại thêm/sửa Custom Provider với các trường Name, Base URL, API Key, Default Model và Radio chọn phạm vi phân quyền.
- [X] T025 [US5] Xây dựng component `src/components/settings/user-assignment-picker.tsx` (kèm khóa i18n): Bộ chọn danh sách User (tìm kiếm, tích chọn nhiều User) hiển thị khi chọn chế độ phân quyền "Chỉ định User". Ô tìm kiếm chấp nhận gõ tiếng Việt không dấu, dùng lại cách chuẩn hóa trong `src/lib/projects/service.ts` (Hiến pháp VI).
- [X] T026 [US5] Tích hợp Tab 4 "Nhà cung cấp OpenAI tùy chỉnh" vào `src/components/settings/ai-config-manager.tsx`.
- [X] T027 [P] [US5] Rà trang `/settings/ai` hiện có (dùng `/api/me/ai-config` và `ai_provider_configs` với `scope = 'user'`): chỉ bổ sung phần còn thiếu để User có `canUseCustomAi = true` thêm/sửa cấu hình chuẩn OpenAI theo enum mới. Không tạo nơi lưu thứ hai.
  - Ghi chú triển khai: vì giữ tên kiểu nội bộ, trang `/settings/ai` hiện có dùng được nguyên trạng; không cần sửa.

---

## Phase 6: User Story 2 — Tùy chọn Định dạng Xuất (.srt, .txt, .md) & Nhận diện Người nói (Priority: P2)

**Mục tiêu**: Người dùng có thể chọn xuất `.txt` (văn bản thuần) hoặc `.md` (có đánh dấu người nói nếu bật Speaker Diarization).

### Tests cho US2 (Viết trước)
- [X] T043 [P] [US2] `tests/unit/stt-formats.test.ts`: Kiểm tra hàm `chunkTokensToTxt` (văn bản ngắt đoạn tự nhiên) và `chunkTokensToMd` (định dạng Markdown có phân biệt `**Người nói 1**:`, `**Người nói 2**:`; bản tiếng Anh `**Speaker 1**:`).

### Cài đặt US2
- [X] T044 [US2] Bổ sung hàm `chunkTokensToTxt` và `chunkTokensToMd` trong `src/lib/parsing/stt-chunker.ts`:
  - `.txt`: Nối các câu tự nhiên, ngắt dòng giữa các đoạn nói.
  - `.md`: Đặt tiêu đề và tiền tố `**Người nói X**:` khi `enableDiarization = true` (nhãn theo ngôn ngữ giao diện, tiếng Anh là `**Speaker X**:`).
- [X] T045 [US2] Cập nhật worker `transcribe-media.ts`: sinh file theo đúng `targetFormat` (`srt`, `txt`, `md`) và cấu hình `enableDiarization` gửi sang Soniox.
- [X] T046 [US2] Cập nhật giao diện `src/components/projects/stt-dialog.tsx` (kèm khóa i18n):
  - Radio/Tabs chọn định dạng đầu ra: `.srt` (Phụ đề mốc thời gian), `.txt` (Văn bản thuần), `.md` (Tài liệu Markdown).
  - Checkbox tùy chọn: "Phân tách người nói (Speaker Diarization)".

---

## Phase 7: User Story 3 — Theo dõi Tiến trình Phiên âm Nền Bền vững (Priority: P3)

**Mục tiêu**: Tiến trình STT chạy ngầm độc lập với trình duyệt, tự phục hồi trạng thái khi tải lại trang hoặc đổi thiết bị.

### Tests cho US3 (Viết trước)
- [X] T047 [P] [US3] `tests/integration/stt-progress-recovery.test.ts`: Kiểm tra query `GET /api/stt/[jobId]` trả về tiến độ chính xác theo thời gian thực kèm nhật ký; mỗi giai đoạn sinh một dòng `stt_job_logs`; khi worker lỗi hoặc dừng, thông báo lỗi tiếng Việt được lưu vào `error_message` và nhật ký; nhật ký không chứa khóa API.
- [X] T047a [P] [US3] `tests/integration/stt-retry-resume.test.ts`: mock trả 429 rồi thành công thì job vẫn `completed` (đã thử lại); mock trả 401 thì job `failed` ngay, không thử lại; job `running` quá hạn bị sweeper chuyển `interrupted` rồi xếp hàng lại, và job đã có `sonioxTranscriptionId` tiếp tục poll, không upload lại.
- [X] T050c [P] [US3] `tests/integration/stt-deletion.test.ts` (FR-021, Hiến pháp V): xóa Project thì `stt_jobs` và `stt_job_logs` của Project mất và file tạm bị xóa; xóa User thì không còn đối tượng nào dưới `users/{id}/` (gồm `stt-tmp/`); `usage_records` có `stt_job_id` và `user_id` thành NULL nhưng số liệu tổng hợp vẫn còn; worker đang chạy job bị xóa thì dừng và không để lại file tạm. Kiểm tra thêm (qua mock): job `completed` và job `failed` đều gọi `deleteTranscription` và `deleteFile` với đúng id; xóa Project/User có job còn id trên Soniox cũng gọi hai hàm này; mock trả lỗi khi xóa thì job vẫn `completed` và nhật ký có dòng `warn`.

### Cài đặt US3
- [X] T048 [US3] Xây dựng hook `useSttJob(jobId)` sử dụng `@tanstack/react-query`: polling trạng thái mỗi 2 giây khi job còn active (`queued`, `extracting`, `uploading`, `transcribing`, `formatting`, `interrupted`; `interrupted` hiển thị "Bị gián đoạn, đang chạy lại") và dừng khi `completed` hoặc `failed`.
- [X] T049 [US3] Cập nhật `stt-dialog.tsx` và thêm banner thông báo tiến trình thu nhỏ trên trang Project Detail (kèm khóa i18n): cho phép người dùng đóng dialog trong lúc chờ mà không làm mất tiến trình; có thể mở lại xem tiến độ bất cứ lúc nào; có phần "Nhật ký" thu gọn được hiển thị các dòng từ `stt_job_logs`; dùng được trên điện thoại và máy tính bảng.
- [X] T050 [US3] Xử lý lỗi trong worker (FR-019): lỗi tạm thời từ Soniox (mạng, 429, 5xx) thử lại tối đa 3 lần với `backoffMs` (`src/worker/pipeline/synthesize-segment.ts`, tôn trọng `Retry-After`); lỗi vĩnh viễn (401, 403, file hỏng, model real-time) không thử lại. Khi hết lượt thử hoặc lỗi vĩnh viễn: `status = 'failed'`, thông báo tiếng Việt nêu nguyên nhân và bước tiếp theo, dọn file tạm trên MinIO và xóa file/bản phiên âm đã gửi lên Soniox (nếu có id).
- [X] T050a [US3] Mở rộng `sweepStaleJobs` (`src/worker/sweeper.ts`) cho `stt_jobs`: job ở trạng thái đang chạy quá hạn chuyển `interrupted` rồi xếp hàng lại vào `transcribe-media`. Worker nhận job `interrupted`: nếu đã có `sonioxTranscriptionId` thì tiếp tục poll; nếu đã có `sonioxFileId` thì bắt đầu từ bước phiên âm; ngược lại chạy lại từ đầu.
- [X] T050b [US3] Dọn dữ liệu STT khi xóa Project/User (FR-021):
  - Xóa Project: lấy danh sách `temp_storage_key`, `soniox_file_id`, `soniox_transcription_id` của các STT job thuộc Project trước khi xóa trong DB; xóa file tạm (cùng cách `src/lib/storage/cleanup.ts` đang làm cho voice job) và gọi `deleteTranscription`/`deleteFile` cho các id còn trên Soniox.
  - Xóa User (`src/worker/jobs/delete-user.ts`): file tạm đã được `deleteByPrefix(users/{id}/)` bao phủ nhờ khóa `stt-tmp/` nằm dưới tiền tố User; bổ sung bước lấy các id Soniox của User trước khi xóa trong DB rồi gọi hai hàm xóa.
  - Lỗi khi xóa trên Soniox không chặn việc xóa Project/User; ghi log máy chủ không chứa khóa.

---

## Phase 8: Hoàn thiện, Đa ngôn ngữ (i18n) & Kiểm thử Toàn diện

**Mục tiêu**: Đảm bảo 100% tuân thủ Hiến pháp dự án (Nguyên tắc VI: không có chuỗi tiếng Việt cứng trong code giao diện) và vượt qua toàn bộ test suite.

- [X] T051 Rà soát `src/lib/i18n/vi.ts`: đủ các khóa mà các task giao diện đã thêm (STT Dialog, ngôn ngữ gợi ý, lỗi 413/429, `MEDIA_TOO_LONG`, `NO_SPEECH_DETECTED`, trạng thái `interrupted`, nhật ký STT, cấu hình Admin 1 token, đơn giá Soniox, `maxSttJobsPerUser`, Custom Provider, hộp thoại xác nhận xóa, phân quyền User); bổ sung khóa còn thiếu.
  - Ghi chú triển khai: thêm nhóm khóa `stt`, `providersAdmin`, mã lỗi mới và luật dịch tiếng Anh cho câu lỗi máy chủ (`server-messages.ts`).
- [X] T052 Rà soát `src/lib/i18n/en.ts` khớp 100% các khóa với `vi.ts`; bổ sung khóa còn thiếu.
- [X] T053 Chạy kiểm tra đa ngôn ngữ `npm run check:i18n` — đảm bảo 0 vi phạm chuỗi tiếng Việt cứng trong giao diện.
- [X] T054 Chạy kiểm tra kiểu tĩnh `npx tsc --noEmit` — đảm bảo không có lỗi type.
- [X] T055 Chạy toàn bộ unit tests `npm run test:unit` — đảm bảo 100% test suites passed.
- [X] T056 Chạy kiểm thử production build `npm run build` — đảm bảo toàn bộ các route biên dịch tối ưu thành công.
