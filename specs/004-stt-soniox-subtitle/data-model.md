# Mô hình dữ liệu (Phase 1): STT Soniox & Cấu hình AI Provider Quản Trị

**Ngày**: 2026-11-23 | **Spec**: [spec.md](./spec.md) | **Nghiên cứu**: [research.md](./research.md)

Migration `0007_stt_and_custom_ai_providers.sql` bổ sung 2 nhóm bảng:
1. Bảng quản lý tiến trình STT: `stt_jobs`
2. Bảng quản lý Custom AI Providers chuẩn OpenAI: `custom_ai_providers` và cập nhật cấu hình Core Providers (FPT.AI, Soniox, ShopAIKey).

---

## 1. Bảng `stt_jobs` (Quản lý tiến trình phiên âm)

```sql
CREATE TYPE stt_job_status AS ENUM (
  'queued',        -- Đang xếp hàng chờ worker tiếp nhận
  'extracting',    -- Đang dùng FFmpeg bóc tách audio từ video
  'uploading',     -- Đang tải tệp audio lên Soniox Files API
  'transcribing',  -- Soniox AI đang nhận diện giọng nói
  'formatting',    -- Đang gom nhóm token thành câu và tạo file phụ đề (.srt/.txt/.md)
  'completed',     -- Đã hoàn thành và nạp vào subtitle_files
  'failed',        -- Gặp lỗi trong quá trình xử lý
  'interrupted'    -- Worker khởi động lại khi job đang chạy; sweeper xếp hàng lại (FR-019)
);
-- Trạng thái "đang chờ/đang chạy" dùng để đếm giới hạn maxSttJobsPerUser (FR-017):
-- queued, extracting, uploading, transcribing, formatting, interrupted.

CREATE TABLE stt_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  
  -- Thông tin tệp media đầu vào
  original_file_name VARCHAR(255) NOT NULL,
  media_type VARCHAR(20) NOT NULL, -- 'audio' | 'video'
  file_size_bytes BIGINT NOT NULL,
  temp_storage_key TEXT,            -- Khóa tạm trên MinIO: users/{userId}/stt-tmp/{jobId}/source.{ext} (storageKeys.sttTemp), để xóa User theo tiền tố cũng xóa file này
  
  -- Thiết lập phiên âm
  target_format VARCHAR(10) NOT NULL DEFAULT 'srt', -- 'srt' | 'txt' | 'md'
  target_file_name VARCHAR(255) NOT NULL,          -- Tên file phụ đề kết quả
  language VARCHAR(20) NOT NULL DEFAULT 'auto',     -- 'auto' | 'vi' | 'en'
  enable_diarization BOOLEAN NOT NULL DEFAULT false,-- Tách người nói
  
  -- Trạng thái tiến trình
  status stt_job_status NOT NULL DEFAULT 'queued',
  progress_percent INT NOT NULL DEFAULT 0,
  stage_message TEXT,                              -- Thông điệp giai đoạn hiện tại (i18n key)
  error_message TEXT,                              -- Chi tiết lỗi nếu thất bại
  
  -- Thông tin trả về từ Soniox
  soniox_file_id VARCHAR(100),
  soniox_transcription_id VARCHAR(100),
  audio_duration_seconds INT,
  
  -- Kết quả liên kết
  result_subtitle_file_id UUID REFERENCES subtitle_files(id) ON DELETE SET NULL,
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_stt_jobs_project_id ON stt_jobs(project_id);
CREATE INDEX idx_stt_jobs_owner_id ON stt_jobs(owner_id);
CREATE INDEX idx_stt_jobs_status ON stt_jobs(status);

-- Nhật ký chi tiết của STT job (FR-020, Hiến pháp III). Bảng job_logs hiện có chỉ trỏ tới voice_jobs.
CREATE TABLE stt_job_logs (
  id BIGSERIAL PRIMARY KEY,
  stt_job_id UUID NOT NULL REFERENCES stt_jobs(id) ON DELETE CASCADE,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  level VARCHAR(10) NOT NULL,     -- 'info' | 'warn' | 'error'
  message_key TEXT NOT NULL,      -- khóa i18n
  params JSONB                    -- tham số hiển thị; MUST NOT chứa khóa API hay URL có khóa
);

CREATE INDEX idx_stt_job_logs_job_ts ON stt_job_logs(stt_job_id, ts);
```

**Xóa dữ liệu (FR-021)**: `stt_jobs` và `stt_job_logs` bị xóa theo `ON DELETE CASCADE` khi xóa Project hoặc User. File tạm được xóa theo `temp_storage_key` (khi xóa Project, lấy danh sách khóa trước khi xóa trong DB) hoặc theo tiền tố `users/{userId}/` (khi xóa User).

---

## 2. Bảng `custom_ai_providers` (CRUD nhiều Provider chuẩn OpenAI)

Chỉ dành cho provider do Admin tạo (nhiều provider, có phân quyền). Cấu hình AI riêng của User (`canUseCustomAi = true`) **không** nằm ở bảng này: tiếp tục lưu trong `ai_provider_configs` với `scope = 'user'` như cơ chế hiện có (`/api/me/ai-config`), để chỉ có một nơi lưu cấu hình riêng.

```sql
CREATE TYPE provider_access_mode AS ENUM ('public', 'restricted', 'private');

CREATE TABLE custom_ai_providers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  name VARCHAR(100) NOT NULL,
  base_url TEXT NOT NULL,
  api_key_enc BYTEA NOT NULL,                  -- Khóa lưu mã hóa AES-256-GCM
  api_key_hint VARCHAR(30) NOT NULL,            -- 4 ký tự cuối
  
  models JSONB NOT NULL DEFAULT '[]',          -- Danh sách models hỗ trợ
  default_model VARCHAR(100),                  -- Model mặc định
  default_voice VARCHAR(100),                  -- Giọng mặc định (nếu có TTS)
  
  access_mode provider_access_mode NOT NULL DEFAULT 'private',
  assigned_user_ids JSONB NOT NULL DEFAULT '[]', -- Danh sách User UUIDs khi access_mode = 'restricted'
  
  enabled BOOLEAN NOT NULL DEFAULT true,
  price_per_million_chars NUMERIC,
  
  last_test_at TIMESTAMPTZ,
  last_test_ok BOOLEAN,
  last_test_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_custom_ai_access_mode ON custom_ai_providers(access_mode);
```

---

## 3. Cấu hình Core Providers (FPT.AI, SONIOX, ShopAIKey)

**Quyết định khi triển khai (2026-11-23, người dùng chọn):** giữ nguyên tên kiểu nội bộ `fpt_marketplace`, `shopaikey_openai`, `shopaikey_minimax`, `openai_compatible` (chúng chọn adapter TTS cho Project, voice job, cache và usage ở ~50 tệp). Giao diện Admin hiển thị theo tên nhà cung cấp: FPT.AI, SONIOX, ShopAIKey.

- **FPT.AI** (`ai_provider_configs.type = 'fpt_marketplace'`): vốn đã là 1 bản ghi chung cho mọi model FPT → 1 token.
- **ShopAIKey** (`shopaikey_openai` + `shopaikey_minimax`): vẫn 2 bản ghi (2 adapter), nhưng lưu cấu hình chung của một bên sẽ đồng bộ khóa, địa chỉ gốc và trạng thái bật sang bên kia (`SHOPAIKEY_TYPES` trong `config-service.ts`); xóa một bên là xóa cả hai → 1 token. Model/giọng mặc định vẫn riêng theo adapter.
- **SONIOX**: bảng riêng `stt_provider_configs` (một dòng mỗi nhà cung cấp, `provider = 'soniox'`) thay vì `ai_provider_configs`, để các kiểu TTS không lẫn với STT:
  - `base_url`, `api_key_enc`, `api_key_hint`, `default_model` (mặc định `stt-async-v6`; từ chối `stt-rt-*` — FR-010), `enable_diarization`, `price_per_audio_hour_usd` (NULL = không ước tính chi phí — FR-018), `enabled`, `last_test_*`.
  - Model hiển thị: `stt-async-v6` (khuyến nghị), `stt-async-v5` (nhãn "Bản cũ"), `stt-rt-v6` (hiển thị, không chọn được), hoặc tự nhập model async.
- Enum `provider_type` chỉ thêm giá trị `soniox` (dùng cho `usage_records`); các cột TTS khai báo kiểu `TtsProviderType` nên không nhận `soniox`.

---

## 4. Bảng phân quyền & Truy vấn nhà cung cấp khả dụng cho User

Danh sách này chỉ dùng để chọn nhà cung cấp khi tạo Voice. STT luôn dùng Soniox, không chọn từ danh sách này (FR-003).

```sql
-- Danh sách Provider khả dụng cho User $userId:
-- 1. Các Core Providers TTS (fpt_marketplace, shopaikey_openai, shopaikey_minimax) đang bật
-- 2. Custom Providers do Admin tạo có access_mode = 'public'
-- 3. Custom Providers do Admin tạo có access_mode = 'restricted' VÀ assigned_user_ids chứa $userId
-- 4. Cấu hình riêng của $userId trong ai_provider_configs (scope = 'user'), nếu user có quyền canUseCustomAi
--    (truy vấn riêng qua cơ chế /api/me/ai-config hiện có)
SELECT * FROM custom_ai_providers
WHERE enabled = true
  AND (
    access_mode = 'public'
    OR (access_mode = 'restricted' AND assigned_user_ids @> to_jsonb($userId::text))
  );
```

---

## 5. Thay đổi bảng `usage_records` (FR-018)

Bảng hiện có chỉ đo theo ký tự và có `job_id` trỏ tới `voice_jobs`, nên chưa ghi được lần gọi Soniox:

```sql
ALTER TABLE usage_records ALTER COLUMN units_chars DROP NOT NULL;
ALTER TABLE usage_records ADD COLUMN units_audio_seconds INT;  -- lấy từ audio_duration_ms Soniox trả về, không tự tính
ALTER TABLE usage_records ADD COLUMN stt_job_id UUID REFERENCES stt_jobs(id) ON DELETE SET NULL;
ALTER TABLE usage_records ADD CONSTRAINT usage_units_present
  CHECK (units_chars IS NOT NULL OR units_audio_seconds IS NOT NULL);
```

- Mỗi lần phiên âm hoàn tất ghi đúng 1 bản ghi: `provider_type = 'soniox'`, `config_scope = 'global'`, `units_audio_seconds`, `stt_job_id`, `ok = true`, `cost_estimate_usd = units_audio_seconds / 3600 * pricePerAudioHourUsd` (NULL nếu chưa cấu hình đơn giá).
- Mỗi lần gọi Soniox thất bại ghi 1 bản ghi `ok = false`, `cost_estimate_usd = 0`.
- Upload file và các lần poll trạng thái không ghi.
- Voice job dùng Custom Provider ghi như voice job hiện nay, với `provider_type = 'openai_compatible'`, `config_scope = 'global'`.

---

## 6. Cài đặt hệ thống mới

- `maxSttJobsPerUser` (trong `system_settings`, mặc định `2`, Admin chỉnh được): số STT job tối đa ở trạng thái đang chờ/đang chạy của mỗi User (FR-017).

---

## 7. Chuyển đổi dữ liệu cũ (migration `0007_stt_and_custom_ai_providers.sql`)

Migration 0006 đã có sẵn trong dự án (`0006_add_openai_compatible.sql`), nên phần của spec này là 0007, viết tay (như 0006) và đăng ký trong `meta/_journal.json`. Theo quyết định giữ tên kiểu nội bộ (mục 3), KHÔNG đổi tên hay gộp giá trị enum:

1. Thêm giá trị `soniox` vào enum `provider_type` (chỉ cho `usage_records`).
2. Tạo `stt_provider_configs`, `custom_ai_providers`, `stt_jobs`, `stt_job_logs`; thêm `voice_jobs.custom_provider_id`; đổi `usage_records` theo mục 5.
3. Các câu so sánh enum dùng `"type"::text` vì trên CSDL mới mọi migration chạy chung một giao dịch, khi đó giá trị enum mới chưa được commit.
4. Mỗi bản ghi `ai_provider_configs` có `scope = 'global'` và `type = 'openai_compatible'` được chuyển sang `custom_ai_providers` (giữ tên, `base_url`, khóa đã mã hóa, model, giá; `access_mode = 'public'` để User đang dùng không mất quyền), rồi xóa bản ghi gốc. Các `voice_jobs` đang trỏ `config_id` tới bản ghi đó được chuyển sang `custom_provider_id` mới. Sau migration, API cấu hình chung từ chối tạo `openai_compatible` với `scope = 'global'`; `openai_compatible` với `scope = 'user'` giữ nguyên.

---

## 8. Thay đổi bảng `voice_jobs` (FR-022)

Để voice job dùng được provider trong `custom_ai_providers`:

```sql
ALTER TABLE voice_jobs ADD COLUMN custom_provider_id UUID
  REFERENCES custom_ai_providers(id) ON DELETE SET NULL;
ALTER TABLE voice_jobs ADD CONSTRAINT voice_jobs_one_config
  CHECK (config_id IS NULL OR custom_provider_id IS NULL);
CREATE INDEX idx_voice_jobs_custom_provider ON voice_jobs(custom_provider_id);
```

- Khi worker nhận job có `custom_provider_id`: kiểm tra lại provider còn `enabled` và User còn quyền (`public`, hoặc `restricted` có User trong `assigned_user_ids`). Provider bị tắt thì job `failed` với "Nhà cung cấp đã bị xóa hoặc tắt"; User không còn quyền thì job `failed` với "Bạn không còn quyền dùng nhà cung cấp này". Áp dụng cho cả job chưa bắt đầu và job chạy lại sau khi bị gián đoạn; job đang chạy không bị kiểm tra lại giữa chừng.
- Job có `custom_provider_id` đã bị đặt NULL do provider bị xóa (và không có `config_id`) cũng chuyển `failed` với cùng thông báo khi chạy lại.
