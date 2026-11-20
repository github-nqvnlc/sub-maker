---
description: "Danh sách task cho tính năng 003 — Voice khớp mốc phụ đề, đa ngôn ngữ, Sáng/Tối, font tiếng Việt"
---

# Tasks: Voice khớp mốc thời gian phụ đề, đa ngôn ngữ, giao diện Sáng/Tối và font tiếng Việt

**Input**: Tài liệu thiết kế tại `/specs/003-subtitle-timing-i18n-theme/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md). Hiến pháp **1.1.0** đã cho phép đa ngôn ngữ (không còn task sửa hiến pháp).

**Tests**: CÓ — Nguyên tắc V của hiến pháp bắt buộc kiểm thử cho từng user story. Mọi kiểm thử dùng dữ liệu **tối đa 10 giây** (`tests/fixtures/sample-10s.srt`), **không** dùng cả `docs/example/tham-quyen-2026.srt` (chỉ thị của người dùng).

**Organization**: Nhóm theo user story để làm và kiểm thử độc lập. Đường dẫn tính từ gốc repo `C:\Users\Admin\Documents\makvid\sub-maker`.

## Format: `[ID] [P?] [Story] Mô tả kèm đường dẫn`

- **[P]**: chạy song song được (khác tệp, không phụ thuộc task chưa xong)
- **[USn]**: user story trong spec (US1 khớp mốc, US2 phụ đề dài, US3 Sáng/Tối, US4 đa ngôn ngữ, US5 font, US6 tab quản trị)
- Task đổi giao diện người dùng thấy được **PHẢI** chạy `ui-consistency:finding-patterns` trước (ghi thành task riêng ở mỗi story có UI).

---

## Phase 1: Setup (dữ liệu thử dùng chung)

- [X] T001 [P] Tạo `tests/fixtures/sample-10s.srt` = đúng 3 cue đầu của `docs/example/tham-quyen-2026.srt` (cue 1 `00:00:00,300 --> 00:00:04,675` "Bạn đã nghe hai bài phát biểu / ở Thẩm Quyến ngày 18 tháng 11."; cue 2 `00:00:05,005 --> 00:00:08,442` "Nhưng Tập Cận Bình không / nhắc đến Nga một lần nào."; cue 3 `00:00:08,772 --> 00:00:09,772` "Không Putin."), UTF-8, kết thúc tại 9,772 giây (≤ 10 giây)
- [X] T002 [P] Tạo `tests/fixtures/sample-synthetic.srt`: 12 cue ngắn tổng ≤ 10 giây, mỗi cue 0,8 s cách nhau 0,05–0,3 s, trong đó có (a) một câu bị tách thành 2 cue (cue đầu kết thúc bằng dấu phẩy), (b) một cue chỉ có `♪`, (c) một cue chỉ 1 s cho 18 ký tự (khe quá chật) — dùng cho kiểm thử ghép cue, `NO_SPEECH`, tràn khe và tiếp tục
- [X] T003 [P] Mở rộng `mock-provider/server.ts` bằng **scenario trên đường dẫn** (cơ chế hiện có `/s/<scenario>`; mock là tiến trình riêng nên không dùng biến môi trường), ghép nhiều thành phần bằng `+`: `ms-<n>` (thời lượng WAV = số ký tự × n ms, mặc định 60), `pad-<n>` (thêm n ms im lặng ở đầu và cuối WAV), `429-<k>` (trả 429 `retry-after: 0` cho k yêu cầu đầu rồi bình thường), `blocked-<từ khóa>` (trả lỗi "content management policy" cho văn bản chứa từ khóa, nếu chưa có); áp dụng cho route FPT Marketplace `/v1/audio/speech` và các route ShopAIKey; giữ nguyên mọi scenario lỗi hiện có (`401`, `403-model`, `mm-<code>`…)
- [X] T004 [P] Thêm hàm `uploadSampleSrt(page, fixtureName)` và `startTimedVoice(page, opts)` vào `tests/e2e/helpers.ts` để các spec E2E mới dùng chung

---

## Phase 2: Foundational (chặn mọi user story)

**⚠️ CRITICAL**: chưa xong phase này thì chưa làm user story nào.

- [X] T005 Thêm 5 cột vào bảng `subtitleFiles` trong `src/lib/db/schema/projects.ts` theo data-model: `has_timecodes` boolean `NOT NULL DEFAULT false`; `cue_count` integer `NULL` với `CHECK (cue_count IS NULL OR cue_count >= 0)`; `duration_ms` integer `NULL` với `CHECK (duration_ms IS NULL OR duration_ms >= 0)`; `cue_warnings` jsonb `NOT NULL DEFAULT '[]'` (kiểu `Array<{ cue: number; code: 'BAD_RANGE'|'OUT_OF_ORDER'|'OVERLAP'|'NO_SPEECH' }>`, tối đa 200 phần tử); `cue_warning_count` integer `NOT NULL DEFAULT 0`
- [X] T006 Thêm bảng `subtitleCues` vào `src/lib/db/schema/projects.ts` và xuất ở `src/lib/db/schema/index.ts`: `id` uuid PK `defaultRandom`; `subtitle_file_id` uuid `NOT NULL` FK → `subtitle_files(id)` `ON DELETE CASCADE`; `idx` integer `NOT NULL` `CHECK (idx >= 0)`; `n` integer `NOT NULL`; `start_ms` integer `NOT NULL` `CHECK (start_ms >= 0)`; `end_ms` integer `NOT NULL` `CHECK (end_ms > start_ms)`; `text` text `NOT NULL`; `speakable` boolean `NOT NULL DEFAULT true`; `char_count` integer `NOT NULL` `CHECK (char_count >= 0)`; `UNIQUE (subtitle_file_id, idx)`; chỉ mục `(subtitle_file_id, start_ms)`
- [X] T007 [P] Thêm cột vào `users` trong `src/lib/db/schema/auth.ts`: `locale` text `NOT NULL DEFAULT 'vi'` với `CHECK (locale IN ('vi','en'))`; `theme` text `NOT NULL DEFAULT 'system'` với `CHECK (theme IN ('light','dark','system'))`
- [X] T008 Mở rộng kiểu `JobSettings` (thêm `timing?: { mode: 'timed'; mergeCues: boolean; params: { maxSlipMs: number; maxCompressPct: number; mergeGapMs: number; partMinutes: number } }`) và `TimelineEntry` (thêm `text?`, `slipMs?`, `compress?`, `overflow?`, `cues?: Array<{ n; startMs; endMs }>`) trong `src/lib/db/schema/jobs.ts`; cập nhật mọi nơi dùng `TimelineEntry` cho khớp kiểu (`npx tsc --noEmit` sạch)
- [X] T009 Sinh migration bằng `npx drizzle-kit generate --name subtitle_cues_and_preferences` → `src/lib/db/migrations/0005_subtitle_cues_and_preferences.sql` (+ snapshot, `_journal.json`); kiểm tra SQL gồm đủ `CHECK`, `ON DELETE CASCADE`, `UNIQUE`, chỉ mục như T005–T007; áp dụng thử lên DB trống và DB đã có dữ liệu spec 001 (hàng cũ có `has_timecodes=false`)
- [X] T010 [P] Thêm vào `src/lib/settings-defaults.ts` các khóa số: `timingMaxSlipMs` 500, `timingMaxCompressPct` 125, `timingPartMinutes` 10, `timingMergeGapMs` 1000, `rpmFptMarketplace` 0, `rpmShopaikeyOpenai` 0, `rpmShopaikeyMinimax` 0 (0 = dùng giá trị mặc định của catalog); cập nhật kiểu `Settings`
- [X] T011 Cập nhật `src/app/api/admin/settings/route.ts` (schema zod `PATCH`): `timingMaxSlipMs` 100–2000, `timingMaxCompressPct` 100–150, `timingPartMinutes` 1–30, `timingMergeGapMs` 200–3000, `rpm*` 0–600 (số nguyên); giá trị ngoài khoảng → 400 `VALIDATION`
- [X] T012 [P] Mở rộng `PATCH /api/me` và `GET /api/me` (`src/app/api/me/route.ts`, `src/lib/users/service.ts` (`toMe`, `updateProfile`)): nhận/trả `locale` (`vi|en`) và `theme` (`light|dark|system`), `.strict()`, từ chối giá trị khác; cập nhật kiểu `Me` ở `src/lib/api-client.ts`
- [X] T013 [P] Hợp nhất phần `/me` (`locale`, `theme`) và schema `Me` của `contracts/openapi-delta.yaml` vào `specs/001-voice-sub-projects/contracts/openapi.yaml`; chạy `npx vitest run tests/isolation` (Nguyên tắc I, V)
- [X] T014 Test tích hợp `tests/integration/prefs.test.ts`: `PATCH /api/me` lưu `locale`/`theme`, giá trị sai → 400, người dùng A không đọc/ghi được tùy chọn của B, mặc định `vi`/`system` cho tài khoản mới

**Checkpoint**: DB và cài đặt sẵn sàng — các user story có thể bắt đầu.

---

## Phase 3: User Story 1 — Voice khớp mốc thời gian của từng cue (Priority: P1) 🎯 MVP

**Goal**: Tải `.srt`, bỏ số thứ tự/mốc khỏi văn bản đọc, ghép cue cùng câu, đặt từng đơn vị vào đúng mốc phụ đề (mượn khoảng nghỉ → nén ≤ 1,25× → trượt nhẹ ≤ 0,5 s), ước tính trước, trình phát highlight theo mốc.

**Independent Test**: Quickstart §1 và §3 với `sample-10s.srt`: mốc bắt đầu từng đơn vị trong ±150 ms; chạy lại hoàn toàn từ cache; ước tính đúng; không chồng tiếng.

### Tests cho US1 (viết trước, phải FAIL trước khi cài đặt)

- [X] T015 [P] [US1] `tests/unit/srt-cues.test.ts`: `parseSrtCues` — mốc `,` và `.`; số thứ tự không nằm trong `text`; thẻ `<i>`, `{\an8}`, `[hh:mm:ss]` bị làm sạch; nhiều dòng nối bằng khoảng trắng; NFC; `BAD_RANGE` (end ≤ start → bỏ cue), `OUT_OF_ORDER` (sắp lại theo start), `OVERLAP` (end bị giới hạn bởi start cue sau), `NO_SPEECH` (♪, `[Music]` → `speakable=false`, `charCount=0`); `sample-10s.srt` cho đúng 3 cue và `charCount` tổng bằng số ký tự chữ đọc; số cảnh báo tối đa 200 nhưng `warningCount` đếm đủ
- [X] T016 [P] [US1] `tests/unit/reading-units.test.ts`: `buildReadingUnits` — `merge=false` mỗi cue một đơn vị; `merge=true` đóng nhóm tại `. ? ! … :` (bỏ qua `"'”’)]»` ở cuối); cắt khi khoảng nghỉ > `maxGapMs`; cắt khi vượt `maxChars`; cue `speakable=false` ngắt nhóm và không thuộc đơn vị nào; cue đơn lẻ quá dài tách theo mệnh đề, thời gian chia theo tỷ lệ ký tự; mọi cue speakable phủ đúng một lần; kết quả xác định; ví dụ "Tập nói về một tương lai / mở, dựa trên luật lệ, / công nghệ và thị trường." thành **một** đơn vị
- [X] T017 [P] [US1] `tests/unit/placement.test.ts`: `placeUnits` — bất biến I1–I10 của `contracts/timing-engine.md` (không chồng tiếng, không sớm hơn mốc, `compress ∈ [1, maxCompress]`, `slip` tự về 0 khi gặp khoảng nghỉ đủ dài, kết quả xác định, không cắt cụt `out = ceil(need / compress)`, `overflow ⇔ slipMs > maxSlipMs`); ví dụ số "Không Putin." (khe 1,0 s, audio 1,28 s) cho `compress = 1,25`; chuỗi tràn liên tiếp gây trượt rồi bù ở khoảng nghỉ; đơn vị cuối không có `S_{i+1}`; **thêm**: đơn vị đầu có `S_0 = 0` bắt đầu đúng tại 0 (I8), đơn vị lỗi nội dung không nằm trong `audio` và không gây trượt (I9), và chuỗi tổng hợp 3.000 đơn vị chỉ bằng số (không audio) có `slipMs` của đơn vị cuối ≤ độ trễ lớn nhất của 100 đơn vị đầu (I10, SC-003)
- [X] T018 [P] [US1] `tests/unit/audio-trim-tempo.test.ts`: `trimSilence` (cắt lặng đầu/cuối ngưỡng −45 dB, giữ 30 ms; tín hiệu toàn lặng → giữ tối thiểu 1 mẫu hợp lệ) và `tempoPcm` (nén 1,25× cho độ dài ≈ `n/1,25` ±2%, `atempo` không đổi cao độ đáng kể); bỏ qua (skip) có thông báo nếu `ffmpegAvailable()` sai
- [X] T019 [P] [US1] `tests/integration/cues-api.test.ts`: tải `sample-10s.srt` ghi `subtitle_files.has_timecodes=true`, `cue_count=3`, `duration_ms=9772` và 3 hàng `subtitle_cues` trong **một** giao dịch; `GET /api/files/{id}/cues` phân trang đúng (`page`, `pageSize`, `total`); tệp `.txt` → 409 `NO_TIMECODES`; người dùng khác nhận 404; xóa Project/tệp/User xóa sạch `subtitle_cues`; tệp `.skt` bị từ chối
- [X] T020 [P] [US1] `tests/integration/estimate.test.ts`: `POST /api/files/{id}/estimate` — `requests = units − cachedUnits`; đơn vị đã có `audio_cache` của chính người dùng được loại; `priceConfigured=false` và `price=null` khi chưa có `pricePerMillionChars`; `quotaOk=false` kèm `needBytes` khi vượt hạn mức; chủ sở hữu khác → 404
- [X] T021 [P] [US1] `tests/integration/timed-job.test.ts` (nhà cung cấp giả, scenario `ms-60`, `sample-10s.srt` và `sample-synthetic.srt`): job `timed` hoàn tất; voice dài ≈ mốc kết thúc cue cuối; mốc bắt đầu từng đơn vị trong ±150 ms; chạy lại cùng cài đặt → 0 lần gọi nhà cung cấp, 0 bản ghi usage mới; tắt `mergeCues` chỉ gọi lại đơn vị có văn bản đổi; scenario `ms-120` cho nén/trượt với `slipMs ≤ 500` hoặc `overflow=true` và không chồng tiếng; đoạn bị chặn nội dung (scenario `blocked-<từ khóa>`) → khe im lặng, `timeline[i].failed=true`, job `completed`, `failedSegments` có đoạn đó; lỗi khác (`401`, `transient` hết lần thử) vẫn làm job `failed` và tiếp tục được; chế độ "Đọc liên tục" khi có đoạn bị chặn vẫn `failed` (không hồi quy spec 001); `mode: 'timed'` với tệp không mốc → 409 `NO_TIMECODES`; dừng giữa chừng rồi tiếp tục không tạo lại đơn vị đã xong; hai người dùng không dùng chung cache
- [X] T022 [P] [US1] `tests/integration/timed-edit-settings.test.ts`: sửa thiết lập job `timed` đã `stopped`/`failed` — đổi `mergeCues` hoặc chuyển `timed ↔ continuous` tạo lại `job_segments` và `progress_total` đúng danh sách đơn vị mới, đơn vị có văn bản trùng lấy lại từ cache (0 lần gọi nhà cung cấp cho chúng); đổi giọng/tốc độ giữ hành vi spec 001 (mọi đoạn về `pending`); người dùng khác không sửa được (404)
- [X] T023 [P] [US1] Mở rộng `tests/integration/perf.test.ts` (SC-004, FR-015): tạo trong bộ nhớ một `.srt` tổng hợp ≈ 2 MB (hàng chục nghìn cue, **chỉ văn bản, không audio**), tải lên và ghi cue hoàn tất < 10 giây, `GET /api/files/{id}/cues` trang đầu < 1 giây, và trong lúc tải một người dùng khác gọi `GET /api/projects` luôn < 1 giây

### Cài đặt US1

- [X] T024 [US1] Thêm `parseSrtCues(text)` vào `src/lib/parsing/srt.ts` (giữ nguyên `srtToParagraphs`): kiểu `Cue = { idx, n, startMs, endMs, text, speakable, charCount }`, trả `{ cues, warnings, warningCount }` theo research R1 (mốc `hh:mm:ss,mmm`/`.`, làm sạch thẻ, nối dòng, NFC, bốn mã cảnh báo, cắt `warnings` tại 200)
- [X] T025 [P] [US1] Tạo `src/lib/parsing/reading-units.ts`: `buildReadingUnits(cues, { merge, maxChars, maxGapMs })` và kiểu `ReadingUnit` đúng `contracts/timing-engine.md` §1 (dùng `splitLongSentence` của `src/lib/parsing/segmenter.ts` cho cue quá dài)
- [X] T026 [P] [US1] Tạo `src/lib/audio/placement.ts`: `placeUnits(units, audio, params)` đúng thuật toán `contracts/timing-engine.md` §2 (số nguyên mẫu PCM, `minGap` 60 ms, `maxCompress`, `maxSlip`), xuất kiểu `Placed`/`Placement`
- [X] T027 [P] [US1] Tạo `src/lib/audio/trim.ts` (`trimSilence(pcm)` — ngưỡng −45 dB, giữ 30 ms, thuần JS) và `src/lib/audio/tempo.ts` (`tempoPcm(pcm, factor)` — chạy `ffmpeg -f s16le -ar 24000 -ac 1 -i - -filter:a atempo=<f> -f s16le -` qua helper của `src/lib/audio/ffmpeg.ts`, từ chối `factor` ngoài 1–2)
- [X] T028 [US1] Tạo `src/lib/audio/merge-timed.ts`: `mergeTimed(...)` ghi tuần tự vào tệp PCM (không giữ toàn bộ PCM trong RAM): ghi `startSample − writtenSamples` mẫu im lặng, đọc PCM đơn vị từ cache (`loadCachedById`), `trimSilence` → `tempoPcm` nếu `compress > 1`, ghi; dựng `TimelineEntry` (kèm `text`, `slipMs`, `compress`, `overflow`, `cues` chia theo tỷ lệ ký tự trên khoảng thật của đơn vị); đơn vị `failed` (nội dung bị chặn) không có audio: ghi im lặng đúng `slotEndMs − startMs` và `TimelineEntry` có `failed: true` (I9); mỗi phần tử `cues[]` gồm `{ n, text, startMs, endMs }` (chữ của từng cue để bôi theo cue)
- [X] T029 [US1] Cập nhật tải lên: `src/lib/projects/files.ts` và `src/app/api/projects/[projectId]/files/route.ts` — với `.srt` có ≥ 1 cue hợp lệ ghi `subtitle_files.has_timecodes/cue_count/duration_ms/cue_warnings/cue_warning_count` và chèn `subtitle_cues` theo lô 1.000 dòng trong **cùng giao dịch**; vẫn ghi `segments` cho chế độ "Đọc liên tục"; mở rộng DTO tệp (`src/lib/projects/dto.ts`) với `hasTimecodes`, `cueCount`, `durationMs`, `warningCount`
- [X] T030 [US1] Tạo `src/app/api/files/[fileId]/cues/route.ts` (`GET`, `route()` + `requireUser`, kiểm tra chủ sở hữu → 404, `NO_TIMECODES` → 409, `page`/`pageSize` ≤ 200, trả `warnings` ≤ 200 và `warningCount`) theo `contracts/openapi-delta.yaml`
- [X] T031 [US1] Tạo `src/lib/jobs/estimate.ts` và `src/app/api/files/[fileId]/estimate/route.ts` (`POST`): dùng đúng cấu hình AI mà job sẽ dùng, tính `cues`, `units`, `chars`, `cachedUnits` (so `content_hash` cache theo user), `requests`, `audioMs` (chế độ khớp mốc = `subtitle_files.duration_ms`; chế độ đọc liên tục = `chars / 14,5` giây), `outputBytes` (= thời lượng × 16 KB/s), `quotaOk`/`needBytes`, `etaMs`, `priceConfigured`/`price` theo `contracts/openapi-delta.yaml`; không gọi nhà cung cấp, không ghi usage
- [X] T032 [US1] Hợp nhất phần US1 của `contracts/openapi-delta.yaml` vào `specs/001-voice-sub-projects/contracts/openapi.yaml`: `/files/{fileId}/cues`, `/files/{fileId}/estimate`, `/projects/{projectId}/jobs` (`timing`), `/voices/{voiceId}` (`timeline` mở rộng), schema `TimingRequest`, `Cue`, `CueWarning`, `Estimate`, `TimelineEntry`, `File`; chạy `npx vitest run tests/isolation` đảm bảo mọi thao tác mới được cài đặt và có kiểm tra cô lập (chủ sở hữu khác → 404)
- [X] T033 [US1] Cập nhật `src/lib/jobs/service.ts` (`createJobSchema` + `createJob`): nhận `timing: { mode, mergeCues }` (`.strict()`), `timed` yêu cầu `has_timecodes=true` (409 `NO_TIMECODES`), tính lại ước tính và từ chối 409 `QUOTA_EXCEEDED` kèm `needBytes`, chốt `timing.params` từ cài đặt hệ thống vào `voice_jobs.settings`, đặt `progress_total` = số đơn vị
- [X] T034 [US1] Nhánh `timed` trong `src/worker/jobs/generate-voice.ts`: nạp `subtitle_cues` → `buildReadingUnits` → `job_segments` (idx = chỉ số đơn vị) → tạo audio từng đơn vị bằng `synthesizeSegment` (cache) → `placeUnits` → `mergeTimed` → `encodeMp3FromFile` → lưu `voices.timeline` mở rộng; giữ nguyên đường "Đọc liên tục"; thêm mã log `UNITS_BUILT`, `PLACEMENT_DONE`, `UNIT_OVERFLOW` (kèm số cue) vào `src/worker/job-log.ts`; **đổi xử lý lỗi cho chế độ `timed`** (research R15): chỉ lỗi `content_blocked` không làm job `failed` — đoạn đó giữ `job_segments.status='failed'`/`error_code='CONTENT_BLOCKED'`, job kết thúc `completed` kèm log cảnh báo `UNITS_FAILED` (số đoạn và số cue), voice vẫn được lưu; các loại lỗi còn lại giữ nhánh `FATAL_KINDS` → `failed`; chế độ "Đọc liên tục" giữ nguyên
- [X] T035 [US1] Cập nhật `src/lib/jobs/manage.ts` và `src/components/jobs/edit-settings-dialog.tsx`: khi `settings.timing` đổi (chế độ hoặc `mergeCues`) thì xóa và tạo lại `job_segments` theo danh sách đơn vị mới, đặt lại `progress_done`/`progress_total`, có nhãn tiếng Việt cho lựa chọn; ngoài ra giữ nguyên hành vi spec 001 (research R15)
- [X] T036 [P] [US1] Cập nhật DTO voice (`src/app/api/voices/[voiceId]/route.ts`, `src/lib/jobs/service.ts` (`getJobDetail`)) trả `timeline` mở rộng và `GET /api/jobs/{id}` trả `timing.overflowCount`
- [X] T037 [US1] Chạy `ui-consistency:finding-patterns` cho các màn hình US1 (hộp thoại tạo voice, xem trước tệp/cue, theo dõi tiến trình, trình phát) và lưu checklist trước khi làm T038–T042
- [X] T038 [P] [US1] Tạo `src/components/projects/cue-preview.tsx` (bảng cue phân trang: mốc bắt đầu–kết thúc, chữ đọc, cờ `NO_SPEECH`, danh sách cảnh báo; trạng thái tải/rỗng/lỗi) và dùng trong `src/components/projects/file-preview-dialog.tsx` khi `hasTimecodes`
- [X] T039 [US1] Cập nhật `src/components/jobs/start-job-dialog.tsx`: lựa chọn "Khớp mốc thời gian phụ đề"/"Đọc liên tục" (mặc định khớp mốc khi `hasTimecodes`, tắt kèm lý do khi không có mốc), công tắc "Ghép cue cùng câu" (mặc định bật), tạo `src/components/jobs/estimate-panel.tsx` hiển thị ký tự/yêu cầu/đã có cache/thời lượng/dung lượng/ETA/tiền (hoặc "chưa cấu hình đơn giá") và chặn nút bắt đầu khi `quotaOk=false`; tính lại khi đổi lựa chọn; `estimate-panel` PHẢI có đủ trạng thái đang tính (skeleton), lỗi (thông báo + nút thử lại) và rỗng (tệp không có đoạn đọc được) theo Nguyên tắc VI
- [X] T040 [P] [US1] Cập nhật `src/components/jobs/job-monitor.tsx` và `log-viewer.tsx`: hiển thị cảnh báo `overflow` (số cue vượt độ trễ tối đa) và danh sách đơn vị lỗi; không bùng nổ số dòng
- [X] T041 [P] [US1] Cập nhật `src/components/player/synced-text.tsx`, `voice-view.tsx` và `src/lib/player/active-segment.ts` (nếu cần): khi `timeline[i].text` có thì hiển thị văn bản đơn vị, highlight theo `timeline[i].cues` (mỗi phần tử có `text`, `startMs`, `endMs`) nếu có; đoạn `failed` hiển thị mờ kèm nhãn "đoạn lỗi"; voice cũ giữ hành vi hiện tại; thêm bài test nhỏ vào `tests/unit/` cho hàm chọn cue đang đọc
- [X] T042 [P] [US1] Thêm chuỗi tiếng Việt mới vào `src/lib/i18n/vi.ts` (nhãn chế độ, ước tính, cảnh báo tràn khe, mã cảnh báo cue, lỗi `NO_TIMECODES`/`QUOTA_EXCEEDED`); chạy `npx tsx scripts/check-i18n.ts`; **từ vựng giao diện**: "đoạn" = đơn vị đọc, "cue" = dòng phụ đề gốc (không dùng lẫn)
- [X] T043 [P] [US1] Thêm 4 ô cài đặt đặt mốc (`timingMaxSlipMs`, `timingMaxCompressPct`, `timingPartMinutes`, `timingMergeGapMs`) và 3 ô `rpm*` vào `src/components/admin/system-settings-form.tsx` với khoảng hợp lệ của T011 và chú thích đơn vị
- [X] T044 [US1] `tests/e2e/timed-voice.spec.ts`: tải `sample-10s.srt`, xem trước 3 cue không có số thứ tự/mốc trong chữ, tạo voice khớp mốc (nhà cung cấp giả), nghe/tua và highlight đúng đơn vị; tải `.skt` bị từ chối; chạy desktop và mobile 375 px
- [X] T045 [US1] Thủ công, có chủ đích (quickstart §8): với **tối đa 3 cue** của `sample-10s.srt` và `SPIKE_FPT_MARKETPLACE_KEY` trong `.env` (không in khóa), đo lại thời lượng đọc **sau khi cắt lặng**, nghe thử nén 1,25× trên "Không Putin."; ghi kết quả (tỷ lệ tràn khe, quyết định giữ/hạ `timingMaxCompressPct` mặc định) vào `docs/provider-spikes.md`

**Checkpoint**: US1 chạy độc lập — có thể demo/triển khai như MVP.

---

## Phase 4: User Story 2 — Phụ đề rất dài: chia phần, ghép về mốc tuyệt đối (Priority: P1)

**Goal**: Phụ đề dài được chia phần ~10 phút tại khoảng nghỉ lớn nhất, ghép về đúng mốc tuyệt đối (sai lệch không cộng dồn), tiếp tục không làm lại, tôn trọng giới hạn yêu cầu/phút, log và tiến độ theo phần.

**Independent Test**: Quickstart §2 với phụ đề tổng hợp trong bộ nhớ (số, không audio dài) và `sample-synthetic.srt` (`timingPartMinutes=1`): điểm cắt rơi vào khoảng nghỉ lớn nhất, cue cuối lệch ≤ cue đầu, tiếp tục bỏ qua 100% đơn vị đã xong.

### Tests cho US2

- [X] T046 [P] [US2] `tests/unit/plan-parts.test.ts`: `planParts` — điểm cắt là khoảng nghỉ lớn nhất trong `k·W ± 0,2·W`; không có khoảng nghỉ lớn thì cắt tại ranh giới đơn vị gần nhất; các phần phủ mọi đơn vị đúng một lần; một đơn vị không bị cắt đôi; xác định; tập tổng hợp 3 giờ (≈ 3.000 đơn vị) tạo trong bộ nhớ chỉ bằng số (không audio) chạy < 1 s
- [X] T047 [P] [US2] `tests/unit/rate-limit.test.ts`: token bucket theo cấu hình AI — không vượt `rpm` trong cửa sổ 60 s (dùng đồng hồ giả), khóa theo `config id`, `rpm=0` → dùng mặc định catalog, đơn vị chờ thay vì lỗi
- [X] T048 [P] [US2] `tests/integration/timed-parts.test.ts`: với `sample-synthetic.srt` và `timingPartMinutes=1` job ghi log theo phần (`PART_STARTED`/`PART_DONE`), `GET /api/jobs/{id}` trả `timing.parts {done,total}`; dừng giữa phần rồi tiếp tục → 100% đơn vị `done` được dùng lại, 0 lần gọi nhà cung cấp cho chúng; khi nhà cung cấp giả trả 429 vài lần (scenario `429-3`) job vẫn xong (chờ rồi tiếp tục)

### Cài đặt US2

- [X] T049 [US2] Thêm `planParts(units, windowMs, gaps)` và kiểu `Part` vào `src/lib/audio/placement.ts` đúng `contracts/timing-engine.md` §3
- [X] T050 [P] [US2] Thêm trường `requestsPerMinute?: number` (ghi chú "ước tính theo tài liệu nhà cung cấp") vào kiểu catalog `src/lib/providers/types.ts` và `src/lib/providers/catalog.ts` (FPT.AI-VITs = 30 theo `docs/fpt.ai/`; các mô hình khác để trống); tạo `src/lib/providers/rate-limit.ts` (token bucket theo `config id`, giá trị `rpm*` của cài đặt hệ thống ghi đè catalog, 0 = theo catalog)
- [X] T051 [US2] Tích hợp bộ giới hạn vào `src/worker/pipeline/synthesize-segment.ts` (chờ lấy token trước mỗi lần gọi nhà cung cấp, không chờ khi trúng cache) và giữ nguyên backoff 429 hiện có
- [X] T052 [US2] Cập nhật nhánh `timed` ở `src/worker/jobs/generate-voice.ts`: xử lý lần lượt từng phần (đơn vị trong phần chạy song song theo `segmentConcurrency`), log theo phần khi số đơn vị > 200 (`PART_STARTED`, `PART_DONE`), cập nhật tiến độ theo đơn vị và theo phần, `slip` đặt lại tại điểm cắt; `src/lib/jobs/service.ts` (`getJobDetail`) trả `timing.parts` cho `GET /api/jobs/{id}`
- [X] T053 [US2] Cập nhật `src/lib/jobs/estimate.ts`: `etaMs = ceil(requests / rpm)` phút + thời gian ngoài (rpm lấy theo T050); cập nhật `src/components/jobs/job-monitor.tsx` hiển thị "Phần x/y" và `estimate-panel.tsx` hiển thị "khoảng … phút"; thêm chuỗi vào `src/lib/i18n/vi.ts`
- [X] T054 [US2] Chạy lại `tests/integration/timed-job.test.ts` và `tests/integration/timed-parts.test.ts` đảm bảo "Đọc liên tục" (spec 001) không hồi quy (`npx vitest run tests/integration`)

**Checkpoint**: US1 + US2 hoạt động độc lập và cùng nhau.

---

## Phase 5: User Story 3 — Giao diện Sáng / Tối, viền ô nhập nổi bật (Priority: P2)

**Goal**: Ba chế độ theme ở mọi màn hình (kể cả đăng nhập), lưu theo trình duyệt/tài khoản, không nhấp nháy; viền ô nhập đạt ≥ 3:1 ở cả hai theme.

**Independent Test**: Quickstart §4: đổi theme, tải lại giữ lựa chọn, test tương phản xanh, ô nhập thấy rõ ở cả hai theme.

### Tests cho US3

- [X] T055 [P] [US3] `tests/unit/field-contrast.test.ts`: đọc `src/app/globals.css`, chuyển OKLCH → sRGB, khẳng định `--field-border` đạt ≥ 3:1 với `--background`, `--card` và `--input` ở **cả** `:root` và `.dark`
- [X] T056 [P] [US3] `tests/e2e/theme.spec.ts`: chuyển Sáng/Tối/Hệ thống ở trang đăng nhập và trong ứng dụng; tải lại giữ lựa chọn; lớp `dark` có trước khi nội dung hiện (không nhấp nháy sai); "Hệ thống" đổi theo `prefers-color-scheme`; đăng nhập ghi đè theo `users.theme`; localStorage bị chặn vẫn chạy với mặc định; ô nhập có viền thấy được và focus nổi hơn; trình phát highlight đọc rõ ở Tối

### Cài đặt US3

- [X] T057 [US3] Chạy `ui-consistency:finding-patterns` cho nút đổi theme, ô nhập, popover/select, biểu đồ, trình phát, bảng, hộp thoại ở theme Tối và lưu checklist trước khi làm T058–T063
- [X] T058 [US3] Bọc `ThemeProvider` của `next-themes` trong `src/components/app/providers.tsx` (`attribute="class"`, `defaultTheme="system"`, `enableSystem`, `storageKey="theme"`, `disableTransitionOnChange`); giữ `suppressHydrationWarning` ở `src/app/layout.tsx`
- [X] T059 [P] [US3] Tạo `src/components/app/theme-toggle.tsx` (Sáng/Tối/Hệ thống bằng dropdown của shadcn, `aria-label`, hiển thị chế độ hiện tại) và đồng bộ lên `PATCH /api/me` khi đã đăng nhập (thất bại không chặn); đặt vào `src/components/app/app-shell.tsx` và `src/app/(auth)/layout.tsx`
- [X] T060 [US3] Thêm token `--field-border` (Sáng `oklch(0.55 0 0)`, Tối `oklch(0.62 0 0)`) vào `:root` và `.dark` và `--color-field-border: var(--field-border)` vào `@theme inline` trong `src/app/globals.css`
- [X] T061 [US3] Đổi `border-input` → `border-field-border` và tăng độ nổi focus (`focus-visible:border-ring focus-visible:ring-2`) trong `src/components/ui/input.tsx`, `textarea.tsx`, `select.tsx` (trigger), `popover.tsx` (ô tìm kiếm nếu có), `checkbox.tsx`, `switch.tsx` nếu có viền; lỗi giữ `aria-invalid:border-destructive`
- [X] T062 [US3] Hydrate theme khi đăng nhập: trong `src/components/app/providers.tsx` (hoặc `user-menu.tsx`) dùng `GET /api/me` để gọi `setTheme(me.theme)` khi khác giá trị cục bộ
- [X] T063 [P] [US3] Rà soát và sửa các màu cứng không đọc được ở Tối: `src/components/dashboard/*` (màu biểu đồ), `src/components/player/synced-text.tsx` (highlight câu đang đọc), `src/components/jobs/status-badge.tsx`, `src/components/ui/chart.tsx`; chỉ dùng token của theme, không thêm màu ngoài hệ thống thiết kế

**Checkpoint**: US3 độc lập.

---

## Phase 6: User Story 4 — Đa ngôn ngữ: Tiếng Việt và English (Priority: P2)

**Goal**: Đổi ngôn ngữ vi/en ở mọi màn hình, ghi nhớ, mọi chữ giao diện/lỗi API/định dạng theo ngôn ngữ; thiếu khóa là lỗi biên dịch; thêm ngôn ngữ thứ ba chỉ cần thêm một từ điển.

**Independent Test**: Quickstart §5: đi qua mọi màn hình chính ở English không sót chữ Việt (trừ nội dung người dùng); lỗi API đổi ngôn ngữ; `check-i18n` + `tsc` xanh.

> Task nào thêm chuỗi mới (kể cả US1/US2/US6) sau T068 PHẢI thêm đồng thời vào `vi.ts` và `en.ts`.

### Tests cho US4

- [X] T064 [P] [US4] `tests/unit/i18n-dict.test.ts`: `en` và `vi` có cùng tập khóa, không chuỗi rỗng, cùng giữ chỗ `{name}`; `fmt('{n} đoạn', { n: 3 })`; `getDict('xx')` rơi về `vi`; định dạng `Intl` (`vi-VN` 1.234,5; `en-US` 1,234.5; ngày giờ)
- [X] T065 [P] [US4] `tests/integration/error-locale.test.ts`: cùng một lỗi (đăng nhập sai, 404, lỗi zod `passwordMin`) trả `error.message` bằng tiếng Việt khi cookie `locale=vi` và bằng English khi `locale=en` hoặc `users.locale='en'` đã đăng nhập; `error.code` không đổi; không lộ chi tiết nội bộ
- [X] T066 [P] [US4] `tests/e2e/locale.spec.ts`: đổi English ở trang đăng nhập → toàn bộ chữ đổi; đăng nhập; đi qua Dashboard, Project, tạo voice, trình phát, Cài đặt, Quản trị không còn chữ Việt giao diện; tên Project/nội dung phụ đề/tên giọng giữ nguyên; tìm "ngoc lam" không dấu vẫn ra "Ngọc Lam" ở English; tải lại giữ lựa chọn; `<html lang>` đúng

### Cài đặt US4

- [X] T067 [US4] Chạy `ui-consistency:finding-patterns` cho nút đổi ngôn ngữ và các màn hình bị ảnh hưởng độ dài chữ English (nút, bảng, hộp thoại, thanh điều hướng) ở 375 px và desktop, lưu checklist
- [X] T068 [US4] Hạ tầng từ điển: `src/lib/i18n/index.ts` (kiểu `Dict = typeof vi`, `DeepStrings<Dict>`, `LOCALES = ['vi','en']`, `getDict(locale)`, `fmt(template, values)`), `src/lib/i18n/en.ts` (khung với `satisfies DeepStrings<Dict>` để thiếu khóa là lỗi biên dịch), `src/lib/i18n/server.ts` (`getLocale()` đọc cookie `locale` / `users.locale`; `getT()`), `src/lib/i18n/client.tsx` (`I18nProvider`, `useT()`, `useFormat()` dùng `Intl` theo `vi-VN`/`en-US`)
- [X] T069 [US4] Dịch toàn bộ `src/lib/i18n/en.ts` đầy đủ mọi khóa của `vi.ts` (gồm chuỗi mới của US1/US2), giữ cùng giữ chỗ; mục log `jobLog` có mẫu theo `code` + `meta` ở cả hai ngôn ngữ
- [X] T070 [US4] `src/app/layout.tsx`: `<html lang={locale}>` theo `getLocale()`, truyền từ điển vào `I18nProvider` (chỉ từ điển của ngôn ngữ đang dùng); `metadata` lấy từ `getT()` (`generateMetadata`)
- [X] T071 [P] [US4] Tạo `src/components/app/locale-switch.tsx` (chọn Tiếng Việt/English, ghi cookie `locale` `Path=/; SameSite=Lax; Max-Age=31536000`, gọi `PATCH /api/me` khi đã đăng nhập, `router.refresh()`); đặt cạnh `theme-toggle` trong `src/components/app/app-shell.tsx` và `src/app/(auth)/layout.tsx`; hydrate `users.locale` khi đăng nhập
- [X] T072 [US4] Lỗi API theo khóa: sửa `src/lib/api/errors.ts` (`HttpError` mang `messageKey` + tham số), hàm `route()` (cùng tệp `src/lib/api/errors.ts`) dịch theo `getLocale()` của yêu cầu và trả `{ error: { code, message, fields } }` đúng hợp đồng; đổi mọi `new HttpError(..., vi.errors.X)` sang khóa; `code` không đổi
- [X] T073 [US4] Đổi thông báo zod sang khóa trong `src/lib/schemas/*.ts` (ví dụ `validation.passwordMin`) và dịch ở tầng trả lỗi validation của `route()`; kiểm tra trường `fields`
- [X] T074 [P] [US4] Chuyển `src/components/auth/*` và các trang `src/app/(auth)/**` từ `import { vi }` sang `useT()`/`getT()` (đổi `vi.` → `t.`)
- [X] T075 [P] [US4] Chuyển `src/components/app/*` (app-shell, user-menu, active-jobs) và `src/app/(app)/layout.tsx`
- [X] T076 [P] [US4] Chuyển `src/components/projects/*` và `src/app/(app)/projects/**`
- [X] T077 [P] [US4] Chuyển `src/components/jobs/*` và hiển thị log theo `code` + `meta` (mẫu `dict.jobLog[code]`, thiếu mẫu thì dùng `message` đã lưu) trong `src/components/jobs/log-viewer.tsx`
- [X] T078 [P] [US4] Chuyển `src/components/player/*`, `src/components/dashboard/*`, `src/app/(app)/dashboard/**`
- [X] T079 [P] [US4] Chuyển `src/components/settings/*` và `src/app/(app)/settings/**`
- [X] T080 [P] [US4] Chuyển `src/components/admin/*`, `src/app/(admin)/admin/**` (kể cả `ADMIN_NAV` ở `layout.tsx` — đưa ra khỏi phạm vi module để dịch theo yêu cầu) và `src/components/shared/*`, `src/components/ui/*` có chuỗi
- [X] T081 [P] [US4] Định dạng ngày giờ/số/tiền/dung lượng: thay các chỗ gọi `toLocale*`/định dạng cứng bằng `useFormat()`/`getFormat()` (`src/lib/format.ts` và nơi dùng)
- [X] T082 [US4] Mở rộng `scripts/check-i18n.ts`: (1) không còn chuỗi tiếng Việt cứng ngoài `src/lib/i18n/vi.ts`; (2) `vi`/`en` cùng khóa, không chuỗi rỗng; (3) cùng tập giữ chỗ `{name}`; (4) không còn import trực tiếp `vi` ngoài lớp i18n; chạy `npx tsx scripts/check-i18n.ts` và `npx tsc --noEmit` đạt

**Checkpoint**: US4 độc lập; thêm ngôn ngữ thứ ba chỉ cần một tệp từ điển + một mục `LOCALES` (kiểm chứng bằng cách thử tạm).

---

## Phase 7: User Story 5 — Font chữ phù hợp tiếng Việt (Priority: P2)

**Goal**: Toàn giao diện dùng Be Vietnam Pro có đủ bộ ký tự tiếng Việt; dấu chồng không bị cắt; font dự phòng hỗ trợ tiếng Việt.

**Independent Test**: Quickstart §6: 100% ký tự Việt lấy từ font chính, dấu không bị cắt, mạng chậm vẫn đọc được.

### Tests cho US5

- [X] T083 [P] [US5] `tests/e2e/typography.spec.ts`: mở `/dev/typography` (bật ngoài production) kiểm tra `document.fonts.check('16px "Be Vietnam Pro"', ch)` cho toàn bộ nguyên âm Việt hoa/thường đủ dấu ở 4 độ đậm; `fontFamily` tính toán bắt đầu bằng font chính; chụp ảnh "Ệ Ữ Ẳ" ở tiêu đề/nút/ô nhập/bảng và khẳng định vùng mực không chạm mép hộp (dấu không bị cắt); chặn mạng tới font → chữ vẫn hiện bằng font dự phòng

### Cài đặt US5

- [X] T084 [US5] Chạy `ui-consistency:finding-patterns` cho tiêu đề, nút, ô nhập, bảng, hộp thoại, trình phát (chiều cao dòng và dấu chồng) và lưu checklist
- [X] T085 [US5] `src/app/layout.tsx`: thay Outfit bằng `Be_Vietnam_Pro({ subsets: ['latin','latin-ext','vietnamese'], weight: ['400','500','600','700'], variable: '--font-be-vietnam', display: 'swap' })`; cập nhật `src/app/globals.css`: `--font-sans: var(--font-be-vietnam), system-ui, "Segoe UI", Roboto, "Noto Sans", sans-serif`, `--font-heading` cùng font, `body { line-height: 1.5 }`
- [X] T086 [US5] Rà soát tiêu đề/nút/thành phần có `leading-*` < 1,25 hoặc `leading-none`/`overflow-hidden` cắt dấu (grep `leading-none`, `leading-tight`, `truncate`, `h-` cố định quanh chữ) trong `src/components/**` và sửa tối thiểu; không đổi bố cục khác
- [X] T087 [P] [US5] Tạo `src/app/(dev)/dev/typography/page.tsx` (trang kiểm thử chữ: bảng chữ cái Việt hoa/thường đủ dấu ở 12–32 px, 4 độ đậm, ví dụ "Ệ Ữ Ẳ"; trả `notFound()` khi `NODE_ENV === 'production'`)
- [X] T088 [P] [US5] Ghi vào `docs/operations.md` rằng Docker build cần mạng tới Google Fonts một lần (như Outfit trước đây) và phương án B nếu build offline (tải font vào repo); xóa tham chiếu Outfit trong tài liệu

**Checkpoint**: US5 độc lập.

---

## Phase 8: User Story 6 — Tab quản trị đang chọn nổi bật (Priority: P3)

**Goal**: Thanh tab khu quản trị làm nổi bật đúng một tab ứng với trang đang mở, không chỉ dựa vào màu, có `aria-current`.

**Independent Test**: Quickstart §7.

- [X] T089 [P] [US6] `tests/e2e/admin-nav.spec.ts`: mở lần lượt `/admin/users`, `/admin/ai-configs`, `/admin/custom-ai-users`, `/admin/stats`, `/admin/settings`: đúng một liên kết có `aria-current="page"`, đúng tab, có `font-weight` đậm và viền dưới khác tab thường (không chỉ khác màu); lặp ở theme Tối và ở English; User thường vào `/admin/*` vẫn nhận 404
- [X] T090 [US6] Chạy `ui-consistency:finding-patterns` cho thanh tab quản trị (token `primary`, kiểu tab của shadcn) và lưu checklist
- [X] T091 [US6] Tạo `src/components/admin/admin-nav.tsx` (client, `usePathname`; tab đang chọn khi `pathname === href || pathname.startsWith(href + '/')`; `aria-current="page"`; đang chọn `bg-primary/10 font-semibold border-b-2 border-primary text-foreground`, thường `text-muted-foreground hover:bg-accent`; nhãn từ `useT()`); thay `<nav>` trong `src/app/(admin)/admin/layout.tsx` bằng `AdminNav`

**Checkpoint**: tất cả user story hoạt động.

---

## Phase 9: Polish & cross-cutting

- [X] T092 Rà soát lần cuối và hợp nhất **phần còn lại** của `specs/003-subtitle-timing-i18n-theme/contracts/openapi-delta.yaml` vào `specs/001-voice-sub-projects/contracts/openapi.yaml` (phần `/me` đã hợp nhất ở Foundational, phần tệp/job/voice của US1 ở US1; còn `/jobs/{jobId}` (`timing`) và `/admin/settings` (bảy khóa)) (đường dẫn `/files/{fileId}/cues`, `/files/{fileId}/estimate`, mở rộng `/me`, `/projects/{projectId}/jobs`, `/jobs/{jobId}`, `/voices/{voiceId}`, `/admin/settings` và các schema `TimingRequest`, `Cue`, `CueWarning`, `Estimate`, `TimelineEntry`); chạy `npx vitest run tests/isolation` đảm bảo **mọi** thao tác mới được cài đặt và có kiểm tra cô lập
- [X] T093 [P] Cập nhật `README.md`: tính năng khớp mốc `.srt` (thay `.skt`), Sáng/Tối, đa ngôn ngữ vi/en, font, cài đặt hệ thống mới; cập nhật bảng kiểm thử
- [X] T094 [P] Cập nhật `docs/operations.md`: các khóa cài đặt `timing*`/`rpm*`, ý nghĩa độ trễ tối đa/mức nén, các scenario của nhà cung cấp giả (`ms-<n>`, `pad-<n>`, `429-<k>`, `blocked-<từ khóa>`) dùng khi kiểm thử
- [X] T095 Chạy toàn bộ: `npm run typecheck`, `npm run lint`, `npx tsx scripts/check-i18n.ts`, `npx vitest run` (unit, integration, contract, isolation) và `npx playwright test` (desktop + mobile 375 px) — tất cả xanh; ghi vết bất kỳ test bị bỏ qua
- [X] T096 Chạy lần lượt kịch bản `quickstart.md` §1–§7 bằng dữ liệu ≤ 10 giây (nhà cung cấp giả) và ghi kết quả; không chạy trên cả tệp mẫu *(đã kiểm bằng e2e `timed-voice`, integration `timed-job/timed-parts/estimate` với `sample-10s.srt`/`sample-synthetic.srt`)*
- [X] T097 Trước khi commit: xóa chú thích "Sync Impact Report" ở đầu `.specify/memory/constitution.md` (theo ghi chú của hiến pháp)

---

## Dependencies & Execution Order

### Phụ thuộc giữa các phase

- **Phase 1 (Setup)**: không phụ thuộc; mọi task [P] chạy song song.
- **Phase 2 (Foundational)**: chặn mọi user story. Thứ tự: T005 → T006 → T009 (migration cần schema xong); T007, T010, T012 [P] độc lập; T008 sau T005–T006; T011 sau T010; T014 sau T012.
- **Phase 3 (US1)** và **Phase 4 (US2)**: US2 mở rộng nhánh `timed` của US1 (T034, T052) nên làm **sau** US1.
- **Phase 5 (US3)**, **Phase 6 (US4)**, **Phase 7 (US5)**, **Phase 8 (US6)**: độc lập với US1/US2 về mã (chỉ cần Phase 2), nhưng:
  - US6 dùng `useT()` của US4 cho nhãn nếu US4 đã xong; nếu làm trước, dùng `vi` và để US4 (T080) chuyển.
  - US4 (T069) phải dịch cả chuỗi mới của US1/US2 → nên làm US4 **sau** US1/US2; sau khi có `en.ts` (T068), mọi chuỗi mới phải thêm vào cả hai từ điển.
  - US3 (T061) và US5 (T085–T086) chạm các thành phần `src/components/ui/*`/`layout.tsx`; làm tuần tự để tránh xung đột tệp.
- **Phase 9 (Polish)**: sau khi các story cần có đã xong; T092 phải xong trước T095.

### Trong từng user story

- Tests (nếu có) viết **trước** và phải FAIL; `ui-consistency:finding-patterns` trước task UI đầu tiên.
- Hàm thuần (`parseSrtCues`, `buildReadingUnits`, `placeUnits`, `planParts`) → I/O (`trim`, `tempo`, `merge-timed`) → API → worker → UI → E2E.

### Cơ hội chạy song song

- Setup: T001–T004 cùng lúc.
- Foundational: T007, T010, T012 song song với chuỗi T005→T006→T009.
- US1: T015–T021 (tests, khác tệp) cùng lúc; T025, T026, T027 cùng lúc sau T024; T038, T040, T041, T042, T043 cùng lúc sau T039 khởi động.
- US2: T046–T048 cùng lúc; T050 song song T049.
- US4: T074–T081 cùng lúc (mỗi task một thư mục khác nhau) sau T068–T073.
- US3, US4, US5, US6 có thể giao cho các người thực hiện khác nhau sau Phase 2 (lưu ý ràng buộc tệp chung ở trên).

---

## Parallel Examples

**US1 (viết test)**:

```text
Task: T015 tests/unit/srt-cues.test.ts
Task: T016 tests/unit/reading-units.test.ts
Task: T017 tests/unit/placement.test.ts
Task: T018 tests/unit/audio-trim-tempo.test.ts
Task: T019 tests/integration/cues-api.test.ts
Task: T020 tests/integration/estimate.test.ts
Task: T021 tests/integration/timed-job.test.ts
```

**US1 (hàm thuần)**:

```text
Task: T025 src/lib/parsing/reading-units.ts
Task: T026 src/lib/audio/placement.ts
Task: T027 src/lib/audio/trim.ts + tempo.ts
```

**US4 (chuyển module)**:

```text
Task: T074 src/components/auth/*     Task: T076 src/components/projects/*
Task: T075 src/components/app/*      Task: T077 src/components/jobs/*
Task: T078 player + dashboard        Task: T079 settings
Task: T080 admin + shared + ui
```

---

## Implementation Strategy

### MVP trước (US1)

1. Phase 1 → Phase 2 (đến T014).
2. Phase 3 (US1) → **dừng và kiểm chứng** quickstart §1/§3 và T045 (thử ≤ 3 cue thật).
3. Triển khai/demo: người dùng đã có voice khớp mốc cho phụ đề ngắn.

### Giao dần

1. US1 → US2 (phụ đề dài) — hai story P1.
2. US3 (theme) → US5 (font) → US4 (đa ngôn ngữ, sau cùng vì phải dịch hết chuỗi) — ba story P2.
3. US6 (tab quản trị, P3) — có thể chèn bất kỳ lúc nào sau Phase 2.
4. Polish: hợp nhất openapi, tài liệu, chạy toàn bộ kiểm thử.

### Ghi chú

- [P] = khác tệp, không phụ thuộc task chưa xong; commit sau mỗi task hoặc nhóm logic.
- Mọi kiểm thử dùng dữ liệu ≤ 10 giây; gọi nhà cung cấp thật chỉ ở T045 và tối đa 3 cue.
- Task đổi giao diện luôn đi sau task `ui-consistency:finding-patterns` của story đó.
