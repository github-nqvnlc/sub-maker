-- Spec 004: STT Soniox, Custom AI Providers, nhật ký STT, usage theo giây âm thanh, voice job dùng Custom Provider.
-- Lưu ý: so sánh enum qua ::text vì giá trị enum mới (0006, 0007) chưa được commit khi mọi migration chạy chung một giao dịch.
ALTER TYPE "public"."provider_type" ADD VALUE IF NOT EXISTS 'soniox';--> statement-breakpoint
CREATE TYPE "public"."stt_job_status" AS ENUM('queued', 'extracting', 'uploading', 'transcribing', 'formatting', 'completed', 'failed', 'interrupted');--> statement-breakpoint
CREATE TYPE "public"."provider_access_mode" AS ENUM('public', 'restricted', 'private');--> statement-breakpoint
CREATE TABLE "stt_provider_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"base_url" text NOT NULL,
	"api_key_enc" bytea NOT NULL,
	"api_key_hint" text NOT NULL,
	"default_model" text DEFAULT 'stt-async-v6' NOT NULL,
	"enable_diarization" boolean DEFAULT false NOT NULL,
	"price_per_audio_hour_usd" numeric,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_test_at" timestamp with time zone,
	"last_test_ok" boolean,
	"last_test_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stt_provider_configs_provider_unique" UNIQUE("provider")
);--> statement-breakpoint
CREATE TABLE "custom_ai_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"base_url" text NOT NULL,
	"api_key_enc" bytea NOT NULL,
	"api_key_hint" text NOT NULL,
	"models" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"default_model" text,
	"default_voice" text,
	"access_mode" "provider_access_mode" DEFAULT 'private' NOT NULL,
	"assigned_user_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"price_per_million_chars" numeric,
	"last_test_at" timestamp with time zone,
	"last_test_ok" boolean,
	"last_test_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "custom_ai_name_len" CHECK (char_length(btrim("name")) between 1 and 100)
);--> statement-breakpoint
CREATE INDEX "custom_ai_access_mode_idx" ON "custom_ai_providers" USING btree ("access_mode");--> statement-breakpoint
CREATE TABLE "stt_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
	"owner_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"original_file_name" text NOT NULL,
	"media_type" text NOT NULL,
	"file_size_bytes" integer NOT NULL,
	"temp_storage_key" text,
	"target_format" text DEFAULT 'srt' NOT NULL,
	"target_file_name" text NOT NULL,
	"language" text DEFAULT 'auto' NOT NULL,
	"enable_diarization" boolean DEFAULT false NOT NULL,
	"status" "stt_job_status" DEFAULT 'queued' NOT NULL,
	"progress_percent" integer DEFAULT 0 NOT NULL,
	"stage_message" text,
	"error_code" text,
	"error_message" text,
	"soniox_file_id" text,
	"soniox_transcription_id" text,
	"audio_duration_ms" integer,
	"model" text,
	"result_subtitle_file_id" uuid REFERENCES "subtitle_files"("id") ON DELETE set null,
	"attempt" integer DEFAULT 0 NOT NULL,
	"heartbeat_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX "stt_jobs_project_idx" ON "stt_jobs" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "stt_jobs_owner_status_idx" ON "stt_jobs" USING btree ("owner_id","status");--> statement-breakpoint
CREATE INDEX "stt_jobs_status_heartbeat_idx" ON "stt_jobs" USING btree ("status","heartbeat_at");--> statement-breakpoint
CREATE TABLE "stt_job_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"stt_job_id" uuid NOT NULL REFERENCES "stt_jobs"("id") ON DELETE cascade,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"level" "log_level" NOT NULL,
	"message_key" text NOT NULL,
	"params" jsonb
);--> statement-breakpoint
CREATE INDEX "stt_job_logs_job_ts_idx" ON "stt_job_logs" USING btree ("stt_job_id","id");--> statement-breakpoint
ALTER TABLE "voice_jobs" ADD COLUMN "custom_provider_id" uuid REFERENCES "custom_ai_providers"("id") ON DELETE set null;--> statement-breakpoint
CREATE INDEX "voice_jobs_custom_provider_idx" ON "voice_jobs" USING btree ("custom_provider_id");--> statement-breakpoint
ALTER TABLE "usage_records" ALTER COLUMN "units_chars" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_records" ADD COLUMN "units_audio_seconds" integer;--> statement-breakpoint
ALTER TABLE "usage_records" ADD COLUMN "stt_job_id" uuid REFERENCES "stt_jobs"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_units_present" CHECK ("units_chars" is not null or "units_audio_seconds" is not null);--> statement-breakpoint
-- Data-model §7 bước 6: cấu hình openai_compatible CHUNG chuyển sang custom_ai_providers (giữ nguyên id, chế độ public
-- để User đang dùng không mất quyền); voice job đang trỏ tới nó chuyển sang custom_provider_id.
INSERT INTO "custom_ai_providers" ("id", "name", "base_url", "api_key_enc", "api_key_hint", "models", "default_model", "default_voice",
	"access_mode", "enabled", "price_per_million_chars", "last_test_at", "last_test_ok", "last_test_message", "created_at", "updated_at")
SELECT "id", left(coalesce(nullif(btrim("name"), ''), 'OpenAI Compatible'), 100), "base_url", "api_key_enc", "api_key_hint",
	CASE WHEN "default_model" IS NOT NULL THEN jsonb_build_array("default_model") ELSE '[]'::jsonb END,
	"default_model", "default_voice", 'public', "enabled", "price_per_million_chars", "last_test_at", "last_test_ok", "last_test_message",
	"created_at", "updated_at"
FROM "ai_provider_configs" WHERE "scope" = 'global' AND "type"::text = 'openai_compatible';--> statement-breakpoint
UPDATE "voice_jobs" SET "custom_provider_id" = "config_id", "config_id" = NULL
WHERE "config_id" IN (SELECT "id" FROM "custom_ai_providers");--> statement-breakpoint
DELETE FROM "ai_provider_configs" WHERE "scope" = 'global' AND "type"::text = 'openai_compatible';--> statement-breakpoint
ALTER TABLE "voice_jobs" ADD CONSTRAINT "voice_jobs_one_config" CHECK ("config_id" is null or "custom_provider_id" is null);
