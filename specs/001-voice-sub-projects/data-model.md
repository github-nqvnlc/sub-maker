# Mô hình dữ liệu (Phase 1): Quản lý Project tạo Voice từ Subtitle

**Spec**: [spec.md](spec.md) | **Nghiên cứu**: [research.md](research.md)

CSDL: PostgreSQL. Mọi bảng dữ liệu người dùng có `owner_id`/`user_id`; mọi truy vấn từ API MUST lọc theo chủ sở hữu
(Nguyên tắc I). Khóa chính dùng UUID (v7) trừ `job_logs.id` (bigserial, cần thứ tự cho con trỏ SSE).
Bảng xác thực (`session`, `account`, `verification`, …) do thư viện xác thực quản lý và không liệt kê chi tiết ở đây.

## Sơ đồ quan hệ

```text
users 1──* projects 1──* subtitle_files 1──* segments
  │            │
  │            ├──* voice_jobs 1──* job_segments ──> audio_cache
  │            │        │ 1──* job_logs
  │            │        └ 0..1 ──1 voices
  │            └──* voices
  ├──* ai_provider_configs  (scope = 'user')
  ├──* audio_cache
  └──* usage_records  (user_id → NULL khi xóa User)
ai_provider_configs (scope = 'global')  ← do Administrator quản lý
system_settings
```

## Bảng

### users (mở rộng bảng người dùng của thư viện xác thực)

| Trường | Kiểu | Ghi chú |
| --- | --- | --- |
| id | uuid PK | |
| email | text unique | Đăng nhập; chuẩn hóa chữ thường |
| username | text unique null | Tùy chọn |
| display_name | text | Cá nhân hóa (FR-035), 1–60 ký tự |
| bio | text null | Tối đa 500 ký tự |
| avatar_key | text null | Khóa MinIO `users/{id}/avatar` |
| role | enum `admin`, `user` | Mặc định `user`; `admin` chỉ tạo bằng seed cấu hình |
| status | enum `active`, `banned`, `deleting` | `banned` không đăng nhập được; `deleting` đang xóa |
| can_use_custom_ai | boolean | Mặc định **false** (FR-042). Đây là "Danh sách User được dùng cấu hình AI riêng" |
| storage_used_bytes | bigint | Đối soát định kỳ (R16) |
| last_active_at | timestamptz null | Cho thống kê Administrator |
| created_at, updated_at | timestamptz | |

Quy tắc: không thể đặt `can_use_custom_ai = true` cho `admin` vì không cần; không thể xóa/khóa chính tài khoản admin cấp sẵn.

### ai_provider_configs

| Trường | Kiểu | Ghi chú |
| --- | --- | --- |
| id | uuid PK | |
| scope | enum `global`, `user` | |
| owner_user_id | uuid null FK users, cascade | NULL khi `global`; bắt buộc khi `user` |
| type | enum `fpt_marketplace`, `shopaikey_openai`, `shopaikey_minimax` (đã gỡ `fpt_speech`, migration 0003) | Loại adapter |
| name | text | Tên hiển thị |
| base_url | text | https, qua kiểm tra SSRF (R9) |
| api_key_enc | bytea | AES-256-GCM, khóa chủ từ `APP_ENCRYPTION_KEY` |
| api_key_hint | text | Vài ký tự cuối để hiển thị |
| default_model | text null | Ví dụ `FPT.AI-VITs`, `tts-1` |
| default_voice | text null | |
| default_speed | numeric null | Thang theo adapter |
| max_chars_per_request | int | Mặc định theo adapter |
| price_per_million_chars | numeric null | Để tính chi phí ước tính; trống = không ước tính |
| enabled | boolean | |
| disabled_reason | enum null `owner_removed_from_list`, `admin_disabled` | |
| last_test_at, last_test_ok, last_test_message | | Kết quả kiểm tra kết nối |
| created_at, updated_at | | |

Ràng buộc: duy nhất `(scope, coalesce(owner_user_id, zero-uuid), type)` ⇒ mỗi loại có một cấu hình chung và mỗi User một
cấu hình riêng. Khóa API **không bao giờ** trả về qua API (chỉ `api_key_hint`).

**Chọn cấu hình lúc bắt đầu job** (FR-043/044): với `project.provider_type = T`, nếu `user.can_use_custom_ai` và tồn tại cấu hình
`scope='user'`, `type=T`, `enabled` ⇒ dùng nó; ngược lại dùng cấu hình `global` loại `T` đang `enabled`; không có ⇒ lỗi
`PROVIDER_NOT_CONFIGURED`. Lỗi của cấu hình riêng **không** rơi về cấu hình chung (Nguyên tắc IV).
Khi gỡ User khỏi danh sách: cấu hình riêng đặt `enabled = false`, `disabled_reason = 'owner_removed_from_list'`, giữ nguyên.

### projects

| Trường | Kiểu | Ghi chú |
| --- | --- | --- |
| id | uuid PK | |
| owner_id | uuid FK users, cascade | |
| name | text | 1–120 ký tự, bắt buộc; có thể trùng |
| description | text null | ≤ 2000 ký tự |
| provider_type | enum như `ai_provider_configs.type` | Nhà cung cấp mặc định |
| search_text | text generated | `immutable_unaccent(lower(name ‖ ' ' ‖ description))`, GIN trgm. `unaccent` gốc chỉ STABLE nên không dùng được trong cột sinh/chỉ mục; migration tạo hàm bọc `immutable_unaccent` khai báo IMMUTABLE (chuẩn hóa từ điển `unaccent`) |
| voice_count | int | Số voice (đếm sẵn) |
| created_at, updated_at | timestamptz | `updated_at` đổi khi có file/job/voice mới |

Chỉ mục: `(owner_id, updated_at desc)`, `(owner_id, name)`, `(owner_id, provider_type)`, GIN trgm `search_text`.

### subtitle_files

| Trường | Kiểu | Ghi chú |
| --- | --- | --- |
| id | uuid PK | |
| project_id | uuid FK, cascade | |
| owner_id | uuid FK | Lặp lại để kiểm tra quyền nhanh |
| original_name | text | |
| ext | enum `txt`, `md`, `skt` | |
| size_bytes | int | ≤ `max_file_bytes` |
| storage_key | text | File gốc trong MinIO |
| content_hash | text | sha256 văn bản đã chuẩn hóa |
| char_count | int | Ký tự có thể đọc |
| segment_count | int | |
| created_at | timestamptz | |

Bất biến sau khi tạo (sửa nội dung trong ứng dụng ngoài phạm vi).

### segments

| Trường | Kiểu | Ghi chú |
| --- | --- | --- |
| id | uuid PK | |
| subtitle_file_id | uuid FK, cascade | |
| idx | int | Thứ tự từ 0; unique cùng file |
| text | text | Đoạn đã chuẩn hóa NFC, là nội dung sẽ được đọc |
| char_count | int | Số ký tự Unicode |

### voice_jobs (Voice Job)

| Trường | Kiểu | Ghi chú |
| --- | --- | --- |
| id | uuid PK | |
| project_id, owner_id, subtitle_file_id | FK | |
| status | enum | Xem máy trạng thái |
| provider_type | enum | |
| config_id | uuid null FK ai_provider_configs, set null | Cấu hình đã dùng lúc bắt đầu |
| config_scope | enum `global`,`user` | Nguồn cấu hình, cho thống kê (FR-045) |
| settings | jsonb | `{model, voice, speed, maxCharsPerSegment, pauseMs}` |
| progress_done, progress_total | int | Đoạn xong / tổng |
| error_code, error_message | text null | Thông điệp thân thiện (SC-010) |
| cancel_requested | boolean | Worker kiểm tra giữa các đoạn |
| attempt | int | Số lần worker nhận job |
| heartbeat_at | timestamptz null | Worker ghi định kỳ |
| queue_job_id | text null | Tham chiếu pg-boss |
| created_at, started_at, finished_at | timestamptz | |

**Máy trạng thái**

```text
queued ──> running ──> completed
   ^          ├──> failed        (lỗi vĩnh viễn hoặc hết lần thử)
   │          ├──> stopped       (người dùng dừng; giữ phần đã xong)
   │          └──> interrupted   (worker mất/khởi động lại)
   └── resume (stopped | failed | interrupted → queued, cùng job, tiếp tục đoạn chưa xong)
```

- "Chạy lại với thiết lập mới" tạo **job mới**; đoạn trùng được lấy từ `audio_cache` (FR-022, FR-017).
- Khi `settings` thay đổi, đặt lại toàn bộ `job_segments` về `pending` và `progress_done = 0` (đoạn có cùng hash vẫn được lấy từ `audio_cache`, nên không tốn phí lặp), để mọi đoạn của một voice luôn cùng một thiết lập.
- Chỉ sửa `settings` khi `stopped|failed|interrupted` (phải dừng trước nếu đang `queued|running`); job `completed` không sửa được vì voice đã sinh gắn với thiết lập cũ, muốn đổi thì chạy lại để tạo job mới (FR-022). Xóa job `running` bị chặn hoặc dừng trước (FR-023).
- `interrupted` được hệ thống tự đưa lại `queued` khi worker khởi động; log ghi rõ việc tiếp tục.

### job_segments

| Trường | Kiểu | Ghi chú |
| --- | --- | --- |
| job_id | uuid FK, cascade | |
| idx | int | Khóa chính `(job_id, idx)` |
| status | enum `pending`,`running`,`done`,`failed` | |
| cache_hit | boolean | |
| audio_cache_id | uuid null FK | |
| duration_ms | int null | |
| attempts | int | |
| error_code | text null | Ví dụ `CONTENT_BLOCKED`, `QUOTA`, `TIMEOUT` |

### audio_cache

| Trường | Kiểu | Ghi chú |
| --- | --- | --- |
| id | uuid PK | |
| owner_id | uuid FK, cascade | Cache **theo User** (R7) |
| content_hash | text | `sha256(userId ‖ type ‖ model ‖ voice ‖ speed ‖ format ‖ textNFC)`; unique cùng `owner_id` |
| storage_key | text | `users/{uid}/cache/{hash}.wav` |
| duration_ms, size_bytes | int | |
| chars | int | |
| provider_type, model, voice, speed | | Mô tả |
| created_at, last_used_at | timestamptz | `last_used_at` hỗ trợ dọn dẹp sau này |

### job_logs

| Trường | Kiểu | Ghi chú |
| --- | --- | --- |
| id | bigserial PK | Con trỏ cho SSE/`Last-Event-ID` |
| job_id | uuid FK, cascade | Chỉ mục `(job_id, id)` |
| ts | timestamptz | |
| level | enum `info`,`warn`,`error` | |
| code | text | Mã sự kiện, ví dụ `FILE_PARSED`, `SEGMENT_DONE`, `RETRY`, `JOB_STOPPED` |
| message | text | Tiếng Việt, **không chứa khóa API/URL có khóa** |
| meta | jsonb null | `{idx, done, total, chars, attempt}` |

### voices

| Trường | Kiểu | Ghi chú |
| --- | --- | --- |
| id | uuid PK | |
| project_id, owner_id | FK | |
| job_id | uuid FK, **unique** | Mỗi job hoàn tất cho đúng một voice |
| subtitle_file_id | uuid FK | Để lấy văn bản đoạn |
| title | text | Mặc định từ tên file và giọng |
| storage_key | text | `users/{uid}/voices/{id}.mp3` |
| format | text | `mp3` |
| duration_ms, size_bytes | int | |
| timeline | jsonb | `[{idx, startMs, endMs}]`, chính xác theo mẫu PCM |
| created_at | timestamptz | |

### usage_records

| Trường | Kiểu | Ghi chú |
| --- | --- | --- |
| id | bigserial PK | |
| ts | timestamptz | |
| user_id | uuid null FK users, **set null** | Ẩn danh hóa khi xóa User (FR-037) |
| project_id, job_id | uuid null, set null | |
| provider_type, config_scope | enum | Phân biệt chi phí hệ thống/người dùng (FR-045) |
| model, voice | text null | |
| units_chars | int | Ký tự thực gửi |
| units_tokens | int null | Chỉ khi nhà cung cấp trả |
| cost_estimate_usd | numeric null | Từ `price_per_million_chars`; NULL nếu không có giá |
| ok | boolean | Lần gọi thành công hay lỗi (lỗi không tính phí nhưng vẫn ghi để chẩn đoán) |

Chỉ ghi khi **thực sự gọi** nhà cung cấp (cache hit không ghi, FR-040). Chỉ mục `(user_id, ts)`, `(ts)`.

### system_settings

`key text PK, value jsonb, updated_at, updated_by`. Khóa: `max_file_bytes` (2097152), `user_quota_bytes` (524288000),
`max_concurrent_jobs` (mặc định 3), `max_jobs_per_user` (mặc định 2), `segment_concurrency` (3).

## Quy tắc xác thực dữ liệu (từ yêu cầu)

| Quy tắc | Nguồn |
| --- | --- |
| Tên Project 1–120 ký tự, không toàn khoảng trắng | FR-001, edge case |
| Tệp: `.txt/.md/.skt`, UTF-8, ≤ 2 MB, không rỗng sau chuẩn hóa | FR-009 |
| Tổng `storage_used_bytes` ≤ hạn mức; chặn upload và tạo job mới khi vượt; worker ghi cache theo chế độ mềm nên job đang chạy luôn được hoàn tất | FR-046 |
| `base_url` hợp lệ và qua kiểm tra SSRF; khóa API không rỗng khi tạo | FR-041/043, R9 |
| Chỉ User có `can_use_custom_ai` mới tạo/sửa được cấu hình `scope='user'` | FR-043 |
| Khi đổi thiết lập job, mọi `job_segments` về `pending` (không trộn giọng/tốc độ trong một voice) | FR-022 |
| Chỉ sửa thiết lập job khi `stopped`, `failed` hoặc `interrupted`; job `completed` chạy lại bằng job mới | FR-022 |
| Xóa User: cascade DB + xóa `users/{id}/` trên MinIO, `usage_records` giữ ẩn danh | FR-037 |

## Cô lập dữ liệu (kiểm thử bắt buộc)

Với mọi bảng có `owner_id`, API không bao giờ nhận `owner_id` từ client; luôn lấy từ session. Tài nguyên thuộc người khác trả **404**,
không phải 403. Bộ kiểm thử cô lập duyệt toàn bộ endpoint của `contracts/openapi.yaml` (Nguyên tắc V, SC-011).
