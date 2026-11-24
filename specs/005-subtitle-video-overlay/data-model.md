# Data Model: Video overlay phụ đề

**Date**: 2026-11-25 | **Spec**: [spec.md](./spec.md) | **Research**: [research.md](./research.md)

Migration mới: `src/lib/db/migrations/0008_overlay_video.sql` (viết tay như 0007, kèm mục trong `meta/_journal.json`). Không sửa bảng có sẵn. Schema Drizzle: `src/lib/db/schema/overlay.ts`.

## 1. `overlay_configs` — cấu hình gần nhất của Project (FR-016)

| Cột | Kiểu | Ràng buộc | Ghi chú |
| --- | --- | --- | --- |
| `project_id` | uuid | PK, FK `projects` cascade | mỗi Project một dòng |
| `owner_id` | uuid | not null, FK `users` cascade | |
| `config` | jsonb | not null | `OverlayConfig` (contracts/overlay-engine.md §1) |
| `source` | jsonb | not null, mặc định `{}` | `{ voiceId?, audioId?, fileId? }`, chỉ để mở lại màn hình; id không còn thì bỏ qua |
| `updated_at` | timestamptz | not null | |

## 2. `overlay_audios` — tệp âm thanh tải lên (FR-002, FR-043)

| Cột | Kiểu | Ràng buộc | Ghi chú |
| --- | --- | --- | --- |
| `id` | uuid | PK | |
| `project_id` | uuid | not null, FK cascade | |
| `owner_id` | uuid | not null, FK cascade | |
| `original_name` | text | not null, ≤ 255 | |
| `status` | enum `overlay_audio_status` | not null, mặc định `processing` | `processing`, `ready`, `failed` |
| `temp_storage_key` | text | null | `users/{u}/overlay-tmp/{id}/source.{ext}`, NULL sau khi dọn |
| `storage_key` | text | null | `users/{u}/overlay/audio/{id}.mp3` khi `ready` |
| `size_bytes` | bigint | not null, mặc định 0, ≥ 0 | dung lượng thật của MP3, tính hạn mức |
| `duration_ms` | integer | null, > 0 | bắt buộc khi `ready` |
| `error_code` | text | null | |
| `interruptions`, `heartbeat_at` | integer mặc định 0, timestamptz | | phục hồi sau gián đoạn |
| `created_at` | timestamptz | not null | |

Chỉ mục: `(project_id, created_at)`, `(owner_id, status)`. Tối đa 3 dòng `processing` mỗi User (429).

Chuyển trạng thái: `processing → ready` (đo được, ≤ giới hạn, đủ hạn mức) hoặc `processing → failed` (`AUDIO_UNREADABLE`, `AUDIO_TOO_LONG`, `QUOTA_EXCEEDED`, `INTERNAL`). Gián đoạn thì xếp lại, quá 3 lần thì `failed`.

## 3. `overlay_jobs` — tiến trình xuất và video thành phẩm (FR-035 đến FR-044)

Video là 1–1 với tiến trình nên nằm cùng dòng.

| Cột | Kiểu | Ràng buộc | Ghi chú |
| --- | --- | --- | --- |
| `id` | uuid | PK | |
| `project_id`, `owner_id` | uuid | not null, FK cascade | |
| `client_request_id` | uuid | not null, unique `(owner_id, client_request_id)` | chống bấm trùng; gửi lại thì trả dòng cũ |
| `voice_id` | uuid | null, FK `voices` set null | |
| `audio_id` | uuid | null, FK `overlay_audios` set null | lúc tạo: đúng một trong `voice_id`/`audio_id` (kiểm ở dịch vụ) |
| `subtitle_file_id` | uuid | null, FK `subtitle_files` set null | |
| `source_names` | jsonb | not null | `{ voice, subtitle }`, hiển thị sau khi nguồn bị xóa |
| `config` | jsonb | not null | bản chốt |
| `cues` | jsonb | not null | `AppliedCue[]` đã chốt (engine §2); không trả trong danh sách |
| `engine_version` | integer | not null | phiên bản bộ dựng hình lúc chốt |
| `format` | enum `overlay_format` | not null | `mp4`, `mov`, `webm` |
| `width`, `height` | integer | not null | suy ra từ tỉ lệ |
| `duration_ms` | integer | not null, > 0 | thời lượng voice |
| `estimated_bytes` | bigint | not null | dùng giữ chỗ hạn mức |
| `warnings` | jsonb | not null, mặc định `[]` | cảnh báo về mốc và màu do máy chủ tính lúc tạo. Cảnh báo cần đo chữ (`CUE_SHRUNK`, `MISSING_GLYPH`) không lưu ở đây: giao diện hiện trước khi xuất, worker ghi vào nhật ký |
| `status` | enum `job_status` (có sẵn) | not null, mặc định `queued` | |
| `progress_percent` | integer | not null, 0–100 | |
| `error_code` | text | null | chữ hiển thị tra theo i18n |
| `cancel_requested` | boolean | not null, mặc định false | |
| `attempt` | integer | not null, mặc định 0 | tổng số lần nhận việc, chỉ để nhật ký |
| `interruptions` | integer | not null, mặc định 0 | số lần gián đoạn trong lượt chạy hiện tại; > 3 thì `RENDER_CRASHED`; về 0 khi chạy lại |
| `heartbeat_at`, `created_at`, `started_at`, `finished_at` | timestamptz | | |
| `output_storage_key` | text | null | `users/{u}/overlay/video/{id}.{ext}` khi `completed` |
| `output_size_bytes` | bigint | null, > 0 | tính hạn mức |

Ràng buộc: `status = 'completed'` ⇔ `output_storage_key` và `output_size_bytes` khác NULL.

Chỉ mục: `(project_id, created_at)`, `(owner_id, status)`, `(status, heartbeat_at)`, `(status, created_at)` cho hàng chờ.

### Chuyển trạng thái

```text
queued ──nhận──▶ running ──xong──▶ completed
  │                │ ├─ lỗi ─────▶ failed
  │ dừng           │ ├─ dừng ────▶ stopped
  └──▶ stopped     │ └─ mất nhịp tim ▶ interrupted ──xếp lại──▶ running
                   │                        └─ quá 3 lần ▶ failed (RENDER_CRASHED)
failed | stopped ──chạy lại──▶ queued   (giữ config, cues; xóa lỗi, tiến độ 0, interruptions 0; kiểm lại hạn mức, giới hạn, nguồn còn)
```

"Đang hoạt động" = `queued`, `running`, `interrupted`: dùng cho giới hạn 2 mỗi User và tổng ước tính.

Mã lỗi: `SOURCE_DELETED`, `QUOTA_EXCEEDED`, `TOO_LONG`, `AUDIO_UNREADABLE`, `RENDER_FAILED`, `RENDER_CRASHED`, `RENDER_STALLED`, `DISK_FULL`, `STORAGE_UNAVAILABLE`, `INTERNAL`. Tạm thời (thử lại): `RENDER_FAILED`, `RENDER_STALLED`, `STORAGE_UNAVAILABLE`. Các mã còn lại không thử lại.

## 4. `overlay_job_logs` — nhật ký (FR-039)

Như `stt_job_logs`: `id` bigserial PK, `job_id` FK cascade, `ts`, `level` (`log_level`), `message_key` (khóa i18n `overlay.log.*`), `params` jsonb. Chỉ mục `(job_id, id)`. Đi qua `redactDeep`.

## 5. Cài đặt hệ thống mới (`SETTING_DEFAULTS`)

| Khóa | Mặc định | Khoảng | FR |
| --- | --- | --- | --- |
| `maxOverlayJobsPerUser` | 2 | 1–20 | FR-040 |
| `maxConcurrentOverlayJobs` | 1 | 1–10 | FR-041 |
| `overlayMaxMinutes` | 60 | 1–180 | FR-006 |
| `overlayMaxMinutesTransparent` | 10 | 1–60 | FR-006 |

## 6. Khóa lưu trữ (`storageKeys`)

| Khóa | Đường dẫn | Tính hạn mức |
| --- | --- | --- |
| `overlayVideo` | `users/{u}/overlay/video/{jobId}.{ext}` | Có |
| `overlayAudio` | `users/{u}/overlay/audio/{audioId}.mp3` | Có |
| `overlayAudioTemp` | `users/{u}/overlay-tmp/{audioId}/source.{ext}` | Không |

Tất cả nằm dưới tiền tố User nên xóa User vẫn xóa hết. Video đang dựng nằm ở đĩa tạm của worker (`os.tmpdir()/submaker-overlay-*`), dọn khi kết thúc và khi worker khởi động. Một lần ghi đối tượng tối đa 5 GB. Khóa video và âm thanh cố định theo id: ghi đối tượng trước, trừ hạn mức và chuyển trạng thái trong một giao dịch sau (research R11); mọi kết thúc khác và mọi thao tác xóa đều xóa đối tượng ở khóa đó dù cột khóa còn NULL.

## 7. Tác động lên mã có sẵn

| Nơi | Thay đổi |
| --- | --- |
| `src/lib/projects/delete.ts` | dừng tiến trình overlay và chờ dừng, thu thập khóa video/âm thanh/tạm trước khi xóa, trả dung lượng |
| `src/worker/jobs/delete-user.ts`, `src/lib/jobs/control.ts` | `stopAllForUser` gồm cả overlay (khóa và xóa User), chờ overlay `running` dừng hẳn |
| `src/worker/jobs/reconcile-storage.ts` | trừ `overlay-tmp/`; User có overlay đang hoạt động hoặc âm thanh `processing` là bận |
| `src/worker/sweeper.ts` | quét `overlay_jobs`, `overlay_audios` |
| `src/lib/settings-defaults.ts`, `admin/settings` | 4 khóa mới |
| Xóa voice, xóa kịch bản | không chặn; FK đặt NULL, tiến trình đang hoạt động tự chuyển `failed` `SOURCE_DELETED` |

## 8. Kiểu dữ liệu không lưu bảng

- `AppliedCue`: `{ i, startMs, endMs, readEndMs, text, origin: 'voice' | 'file' }`.
- `WordSpan`: `{ startMs, endMs, text }`, tính lại từ `AppliedCue` khi cần (không lưu, vì là ước lượng và tính lại luôn cho cùng kết quả).
