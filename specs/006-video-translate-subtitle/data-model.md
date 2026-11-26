# Data Model: Dịch video tự động và gắn đè phụ đề

**Date**: 2026-11-26 | Migration `0009_video_translate` | Mã: `src/lib/db/schema/video.ts`

Mọi bảng có chủ đều mang `owner_id`; mọi truy vấn của người dùng lọc theo `owner_id`, sai thì 404. Dung lượng dùng `bigint`; 1 MB = 1.024² byte, 1 GB = 1.024³ byte. Khóa ngoại `on delete cascade` theo `projects` và `users`.

## 1. Bảng mới

### 1.1 `video_project_settings` — cài đặt dịch video của Project (FR-019, FR-031)

| Cột | Kiểu | Ràng buộc, ghi chú |
| --- | --- | --- |
| `project_id` | uuid | khóa chính, → `projects` |
| `owner_id` | uuid | → `users` |
| `direction` | text | `to_vi` (mặc định) \| `vi_to_en` |
| `glossary` | jsonb | `[{ source, target, keep }]`; ≤ `videoGlossaryMaxPairs` cặp (mặc định 200), tổng chữ ≤ `videoGlossaryMaxChars` (mặc định 8.000); `source` không trùng (so không phân biệt hoa/thường, NFC) |
| `style` | jsonb | kiểu gần nhất (§2.1) |
| `updated_at` | timestamptz | |

### 1.2 `video_jobs` — việc dịch video

| Cột | Kiểu | Ràng buộc, ghi chú |
| --- | --- | --- |
| `id`, `project_id`, `owner_id` | uuid | |
| `original_file_name` | text | ≤ 255 |
| `ext` | text | `mp4\|mov\|mkv\|webm\|avi\|flv\|m4v` |
| `file_size_bytes` | bigint | 1 … `videoMaxBytes` |
| `fingerprint` | text | R7; dùng khi tải tiếp và tải lại (FR-005, FR-046) |
| `direction` | text | chốt lúc dịch |
| `glossary` | jsonb | bản chụp đã dùng (FR-021) |
| `client_audio` | boolean | đã dịch từ âm thanh trình duyệt gửi |
| `audio_mismatch` | boolean | FR-011, chờ xác nhận dịch lại |
| `source_state` | text | `uploading` → `checking` → `ready` → `deleted`; `rejected` |
| `source_key` | text \| null | |
| `source_expires_at` | timestamptz \| null | §5 |
| `source_lease_until` | timestamptz \| null | lượt phát đang dùng |
| `media` | jsonb \| null | `{ durationMs, width, height, fps, videoCodec, videoBitrate, audioCodec, audioIndex, audioStartMs, audioDurationMs, rotation, hdr, browserPlayable }`; `width/height` là kích thước hiển thị |
| `audio_temp_key` | text \| null | MP3 16 kHz |
| `preview_state` | text | `none\|pending\|ready\|failed` |
| `preview_key`, `preview_bytes` | text, bigint \| null | |
| `preview_heartbeat_at`, `preview_attempt` | timestamptz \| null, int | bản xem trước chạy song song với dịch nên có nhịp tim và số lần chạy riêng; quá 3 lần gián đoạn thì `failed` |
| `status` | enum `video_job_status` | `waiting_media`, `queued`, `preparing`, `translating`, `segmenting`, `review_ready`, `failed`, `stopped`, `interrupted` |
| `progress_percent` | int | 0–50 cho pipeline dịch (FR-049) |
| `stage_key`, `error_code` | text \| null | khóa i18n |
| `cancel_requested` | boolean | |
| `attempt`, `interruptions` | int | |
| `heartbeat_at` | timestamptz \| null | |
| `soniox_file_id`, `soniox_transcription_id` | text \| null | tiếp tục sau gián đoạn |
| `model` | text \| null | |
| `translation_run` | int | tăng khi "Dịch lại" |
| `cue_revision` | int | tăng mỗi lô thao tác |
| `cue_count`, `script_bytes` | int, bigint | `script_bytes` tính vào hạn mức 500 MB (FR-055) |
| `style` | jsonb | kiểu của việc (§2.1) |
| `last_activity_at` | timestamptz | sửa cue, đổi kiểu, tạo bản xuất, dịch |
| `created_at`, `started_at`, `finished_at`, `updated_at` | timestamptz | |

Chỉ mục: `(project_id, created_at)`, `(owner_id, status)`, `(status, heartbeat_at)`, `(source_expires_at)`.

### 1.3 `video_uploads` và `video_upload_parts`

`video_uploads`: `id`, `job_id`, `owner_id`, `kind` (`source` \| `client_audio`), `storage_upload_id`, `key`, `size_bytes`, `part_size` (16 MB), `part_count`, `fingerprint`, `state` (`active` → `completing` → `completed`; `aborted`), `expires_at` (48 giờ sau phần gần nhất), `created_at`. Mỗi `(job_id, kind)` có nhiều nhất một phiên `active|completing`.

`video_upload_parts`: khóa chính `(upload_id, n)`; `size`, `etag`, `sha256`. Gửi lại cùng phần thì ghi đè.

Giới hạn `client_audio`: ≤ 500 MB.

### 1.4 `video_cues` (FR-014, FR-015, FR-023, FR-024)

| Cột | Kiểu | Ghi chú |
| --- | --- | --- |
| `id`, `job_id` | uuid | |
| `start_ms`, `end_ms` | int | `0 ≤ start`, `end − start ≥ 100`, `end ≤ thời lượng`; không chồng nhau trong cùng việc (kiểm trong giao dịch); thứ tự theo `start_ms` |
| `timing` | text | `measured` \| `estimated` \| `manual` |
| `source_text`, `target_text` | text | NFC; ≤ 2.000 ký tự mỗi cột; `target_text` có thể chứa `\n` |
| `source_lang` | text \| null | |
| `speaker` | text \| null | |
| `flags` | jsonb | `{ untranslated?, fast?, review? }` |

Chỉ mục `(job_id, start_ms)`. Tối đa 20.000 cue mỗi việc.

### 1.5 `video_exports` — bản xuất

| Cột | Kiểu | Ghi chú |
| --- | --- | --- |
| `id`, `job_id`, `owner_id` | uuid | |
| `kind` | text | `burn` (gắn cứng) \| `layer` (lớp phụ đề) |
| `format` | text | `burn`: `mp4`; `layer`: `mp4` (phông xanh lá) \| `mov` (trong suốt) |
| `style` | jsonb | chốt lúc bấm xuất (FR-042) |
| `cues` | jsonb | bản chụp cue đã chốt; dùng cho chạy lại |
| `cue_revision` | int | |
| `status` | enum `video_export_status` | `queued`, `running`, `completed`, `failed`, `stopped`, `interrupted`, `expired` |
| `progress_percent` | int | 50–100 |
| `estimated_bytes`, `output_bytes` | bigint | |
| `output_key` | text \| null | |
| `duration_ms` | int | |
| `error_code`, `cancel_requested`, `attempt`, `interruptions`, `heartbeat_at` | | như §1.2 |
| `expires_at` | timestamptz \| null | tạo xong + 7 ngày |
| `download_lease_until` | timestamptz \| null | |
| `created_at`, `started_at`, `finished_at` | timestamptz | |

Một việc có nhiều nhất một bản xuất đang `queued|running|interrupted`.

### 1.6 `video_job_logs`

`id` (bigserial), `job_id`, `export_id` (null), `ts`, `level`, `message_key`, `params`. Không chứa khóa, URL ký hay đường dẫn máy chủ (đi qua `redactDeep`).

## 2. Cấu trúc JSON

### 2.1 Kiểu phụ đề (`VideoStyle`)

```ts
{
  display: 'target' | 'bilingual' | 'source';            // mặc định 'target'
  font: { family, size /* 16–96 */, weight /* 400|600|700|800 */ };
  color: string;                                          // #RRGGBB
  sourceLine: { size /* 16–96 */, color, opacity /* 0–100 */ };
  stroke: { enabled, color, width /* 1–10 */ };
  shadow: { enabled, color, blur /* 0–40 */, distance /* 0–20 */, opacity /* 0–100 */ };
  box: { enabled, color, radius /* 0–60 */, opacity /* 0–100 */ };
  position: { anchor: 'bottom'|'center'|'top', y /* 0–100 */ };  // 85 | 50 | 15
  align: 'left'|'center'|'right';
  maxWidthPct: number;                                    // 40–100, mặc định 80
  sync: 'cue'|'word'|'karaoke';
  enter: 'cut'|'fade'|'pop'|'bounce'|'slideUp'|'blurIn'|'glow';
  wordEffect: 'none'|'pop'|'typewriter'|'active';
  effectMs: number;                                       // 100–500, mặc định 250
  highlightColor: string;
}
```

Tổ hợp không hợp lệ đưa về mặc định của chế độ (cùng cách `normalizeConfig`). Độ đậm phông không có thì không hợp lệ. Vùng an toàn là lựa chọn của khung xem trước, không lưu vào bản xuất.

## 3. Trạng thái

### 3.1 Pipeline dịch (`video_jobs.status`)

```text
waiting_media ─(tải xong nguồn | tải xong âm thanh trình duyệt)→ queued → preparing → translating → segmenting → review_ready
queued|preparing|translating|segmenting ─ dừng → stopped ─ chạy lại → queued
                                        ─ lỗi vĩnh viễn → failed ─ chạy lại → queued
                                        ─ mất nhịp tim → interrupted → queued (quá 3 lần → failed)
review_ready ─ dịch lại (đã xác nhận) → queued
```

Chạy lại: có tệp token thô của lượt hiện tại thì gom cue từ đó; có `soniox_transcription_id` thì chỉ hỏi kết quả; đã có cue của lượt hiện tại thì không dịch lại (FR-016, SC-011). "Dịch lại" tăng `translation_run`, xóa id Soniox; cue cũ giữ nguyên tới khi lượt mới lưu xong rồi được thay trong một giao dịch; lượt mới lỗi thì giữ cue cũ.

Dừng hoặc lỗi vĩnh viễn (FR-017): nhà cung cấp đã có kết quả thì lưu tệp token trước, rồi xóa dữ liệu và id Soniox; chưa có thì xóa, chạy lại sẽ gọi mới. Gián đoạn do khởi động lại thì giữ id để tiếp tục.

### 3.2 Trạng thái hiển thị (FR-048), xét theo thứ tự

| Điều kiện | Hiển thị |
| --- | --- |
| có bản xuất `running\|queued` | đang xuất / đang chờ |
| có bản xuất `interrupted` | bị gián đoạn |
| `status` là `queued\|preparing\|translating\|segmenting` | đang chờ / chuẩn bị âm thanh / đang dịch (hai trạng thái cuối) |
| `status` là `failed\|stopped\|interrupted` | lỗi / đã dừng / bị gián đoạn |
| `waiting_media` | đang tải lên |
| `review_ready` và bản xuất gần nhất `completed` | hoàn tất |
| `review_ready` và bản xuất gần nhất `failed` hoặc `stopped` | lỗi / đã dừng (kịch bản vẫn sửa và xuất lại được) |
| `review_ready` | chờ duyệt (kèm tiến độ tải nếu nguồn chưa xong) |

Xét trước mọi dòng trên: `source_state = rejected` (video không đạt sau khi đã dịch ở luồng nhanh, FR-003) → lỗi kèm nguyên nhân; phụ đề vẫn tải được, không xuất video.

"Việc đang chạy" (giới hạn mỗi User, FR-008): phiên tải `active|completing`, pipeline `queued|preparing|translating|segmenting|interrupted`, hoặc bản xuất `queued|running|interrupted`. Đếm và tạo trong một giao dịch có khóa tư vấn.

## 4. Thay đổi bảng và cài đặt có sẵn

- `users`: thêm `can_translate_video boolean not null default false`, `video_used_bytes bigint not null default 0` (≥ 0).
- `usage_records`: thêm `video_job_id uuid null` → `video_jobs` (`set null`).
- `system_settings` (mặc định trong `settings-defaults.ts`, sửa được ở trang cài đặt):

| Khóa | Mặc định | Khoảng |
| --- | --- | --- |
| `userVideoQuotaBytes` | 30 GB | 1 GB – 1 TB |
| `videoSystemCapBytes` | 100 GB | 1 GB – 10 TB |
| `videoMaxBytes` | 10 GB | 100 MB – 10 GB |
| `videoMaxMinutes` | 180 | 1 – `videoProviderMaxMinutes` |
| `videoMaxJobsPerUser` | 1 | 1 – 10 |
| `maxConcurrentVideoRenders` | 1 | 1 – 4 |
| `maxConcurrentVideoTranslations` | 2 | 1 – 10 |
| `videoSourceRetainHours` | 48 | 1 – 720 |
| `videoIdleRetainDays` | 7 | 1 – 90 |
| `videoOutputRetainDays` | 7 | 1 – 90 |
| `videoProviderMaxMinutes` | 300 | 1 – 1000; giới hạn thời lượng mỗi tệp của nhà cung cấp |
| `videoGlossaryMaxPairs` | 200 | 1 – 1000 |
| `videoGlossaryMaxChars` | 8.000 | 500 – 10.000; theo giới hạn ngữ cảnh của nhà cung cấp |

## 5. Khóa đối tượng, hạn mức, thời hạn

| Đối tượng | Khóa | Tính vào | Xóa khi |
| --- | --- | --- | --- |
| video nguồn | `users/{u}/video/{job}/source.{ext}` | hạn mức video | `source_expires_at` |
| thành phẩm, lớp phụ đề | `users/{u}/video/{job}/exports/{id}.{ext}` | hạn mức video | `expires_at` |
| âm thanh tách / do trình duyệt gửi | `users/{u}/video-tmp/{job}/audio.*` | chỉ trần hệ thống | âm thanh trình duyệt: sau khi chuyển MP3; MP3: cùng video nguồn |
| bản xem trước | `users/{u}/video-tmp/{job}/preview.mp4` | chỉ trần hệ thống | cùng video nguồn |
| token thô của Soniox | `users/{u}/video-tmp/{job}/transcript-{lượt}.json` | chỉ trần hệ thống | sau khi lưu cue; còn sót thì theo `last_activity_at` + `videoIdleRetainDays` |
| chữ phụ đề (trong CSDL) | — | 500 MB (`script_bytes`) | xóa việc, Project, User |

`source_expires_at`: đã có bản xuất thành công → `finished_at` gần nhất + `videoSourceRetainHours`; chưa có → `last_activity_at` + `videoIdleRetainDays`; đang tải → theo `expires_at` của phiên. Chỉ một hàm được ghi cột này: `recomputeSourceExpiry(jobId, tx)` trong `src/lib/video/expiry.ts`, gọi trong cùng giao dịch ở mỗi sự kiện làm đổi một trong các giá trị đó (tạo và hoàn tất tải lên; dừng, lỗi, chạy lại, chờ duyệt; sửa cue; đổi kiểu; tạo, hoàn tất, lỗi bản xuất). Việc dọn dẹp chỉ đọc. Đến hạn mà còn tiến trình hoặc thẻ giữ lượt tải thì để lượt quét sau.

`script_bytes` đổi thì cập nhật `users.storage_used_bytes` cùng giao dịch ở chế độ mềm (không bao giờ chặn lưu).
