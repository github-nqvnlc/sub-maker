-- Dịch video tự động và gắn đè phụ đề (spec 006, data-model). Viết tay như 0006–0008.
CREATE TYPE "public"."video_job_status" AS ENUM('waiting_media', 'queued', 'preparing', 'translating', 'segmenting', 'review_ready', 'failed', 'stopped', 'interrupted');--> statement-breakpoint
CREATE TYPE "public"."video_export_status" AS ENUM('queued', 'running', 'completed', 'failed', 'stopped', 'interrupted', 'expired');--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "can_translate_video" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "video_used_bytes" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_video_storage_nonneg" CHECK ("users"."video_used_bytes" >= 0);--> statement-breakpoint
CREATE TABLE "video_project_settings" (
	"project_id" uuid PRIMARY KEY NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
	"owner_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"direction" text DEFAULT 'to_vi' NOT NULL,
	"glossary" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"style" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "video_project_settings_direction" CHECK ("video_project_settings"."direction" in ('to_vi','vi_to_en'))
);--> statement-breakpoint
CREATE TABLE "video_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
	"owner_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"original_file_name" text NOT NULL,
	"ext" text NOT NULL,
	"file_size_bytes" bigint NOT NULL,
	"fingerprint" text NOT NULL,
	"direction" text NOT NULL,
	"glossary" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"client_audio" boolean DEFAULT false NOT NULL,
	"audio_mismatch" boolean DEFAULT false NOT NULL,
	"source_state" text DEFAULT 'uploading' NOT NULL,
	"source_key" text,
	"source_expires_at" timestamp with time zone,
	"source_lease_until" timestamp with time zone,
	"media" jsonb,
	"audio_temp_key" text,
	"preview_state" text DEFAULT 'none' NOT NULL,
	"preview_key" text,
	"preview_bytes" bigint,
	"preview_heartbeat_at" timestamp with time zone,
	"preview_attempt" integer DEFAULT 0 NOT NULL,
	"status" "video_job_status" DEFAULT 'waiting_media' NOT NULL,
	"progress_percent" integer DEFAULT 0 NOT NULL,
	"stage_key" text,
	"error_code" text,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"interruptions" integer DEFAULT 0 NOT NULL,
	"heartbeat_at" timestamp with time zone,
	"soniox_file_id" text,
	"soniox_transcription_id" text,
	"model" text,
	"translation_run" integer DEFAULT 1 NOT NULL,
	"billed_run" integer DEFAULT 0 NOT NULL,
	"cue_run" integer DEFAULT 0 NOT NULL,
	"cue_revision" integer DEFAULT 0 NOT NULL,
	"cue_count" integer DEFAULT 0 NOT NULL,
	"script_bytes" bigint DEFAULT 0 NOT NULL,
	"style" jsonb,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "video_jobs_name_len" CHECK (char_length("video_jobs"."original_file_name") between 1 and 255),
	CONSTRAINT "video_jobs_ext" CHECK ("video_jobs"."ext" in ('mp4','mov','mkv','webm','avi','flv','m4v')),
	CONSTRAINT "video_jobs_size_pos" CHECK ("video_jobs"."file_size_bytes" >= 1),
	CONSTRAINT "video_jobs_direction" CHECK ("video_jobs"."direction" in ('to_vi','vi_to_en')),
	CONSTRAINT "video_jobs_source_state" CHECK ("video_jobs"."source_state" in ('uploading','checking','ready','deleted','rejected')),
	CONSTRAINT "video_jobs_preview_state" CHECK ("video_jobs"."preview_state" in ('none','pending','ready','failed')),
	CONSTRAINT "video_jobs_progress_range" CHECK ("video_jobs"."progress_percent" between 0 and 50),
	CONSTRAINT "video_jobs_script_nonneg" CHECK ("video_jobs"."script_bytes" >= 0),
	CONSTRAINT "video_jobs_cue_count_range" CHECK ("video_jobs"."cue_count" between 0 and 20000)
);--> statement-breakpoint
CREATE INDEX "video_jobs_project_idx" ON "video_jobs" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "video_jobs_owner_status_idx" ON "video_jobs" USING btree ("owner_id","status");--> statement-breakpoint
CREATE INDEX "video_jobs_status_heartbeat_idx" ON "video_jobs" USING btree ("status","heartbeat_at");--> statement-breakpoint
CREATE INDEX "video_jobs_source_expires_idx" ON "video_jobs" USING btree ("source_expires_at");--> statement-breakpoint
CREATE TABLE "video_uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL REFERENCES "video_jobs"("id") ON DELETE cascade,
	"owner_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"kind" text NOT NULL,
	"storage_upload_id" text NOT NULL,
	"key" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"part_size" integer NOT NULL,
	"part_count" integer NOT NULL,
	"fingerprint" text NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "video_uploads_kind" CHECK ("video_uploads"."kind" in ('source','client_audio')),
	CONSTRAINT "video_uploads_state" CHECK ("video_uploads"."state" in ('active','completing','completed','aborted')),
	CONSTRAINT "video_uploads_size_pos" CHECK ("video_uploads"."size_bytes" >= 1),
	CONSTRAINT "video_uploads_parts_range" CHECK ("video_uploads"."part_count" between 1 and 10000 and "video_uploads"."part_size" > 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX "video_uploads_open_uq" ON "video_uploads" USING btree ("job_id","kind") WHERE "video_uploads"."state" in ('active','completing');--> statement-breakpoint
CREATE INDEX "video_uploads_owner_state_idx" ON "video_uploads" USING btree ("owner_id","state");--> statement-breakpoint
CREATE INDEX "video_uploads_state_expires_idx" ON "video_uploads" USING btree ("state","expires_at");--> statement-breakpoint
CREATE TABLE "video_upload_parts" (
	"upload_id" uuid NOT NULL REFERENCES "video_uploads"("id") ON DELETE cascade,
	"n" integer NOT NULL,
	"size" integer NOT NULL,
	"etag" text NOT NULL,
	"sha256" text NOT NULL,
	CONSTRAINT "video_upload_parts_pk" PRIMARY KEY("upload_id","n"),
	CONSTRAINT "video_upload_parts_n" CHECK ("video_upload_parts"."n" between 1 and 10000)
);--> statement-breakpoint
CREATE TABLE "video_cues" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL REFERENCES "video_jobs"("id") ON DELETE cascade,
	"start_ms" integer NOT NULL,
	"end_ms" integer NOT NULL,
	"timing" text NOT NULL,
	"source_text" text DEFAULT '' NOT NULL,
	"target_text" text DEFAULT '' NOT NULL,
	"source_lang" text,
	"speaker" text,
	"flags" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "video_cues_pk" PRIMARY KEY("job_id","id"),
	CONSTRAINT "video_cues_time" CHECK ("video_cues"."start_ms" >= 0 and "video_cues"."end_ms" - "video_cues"."start_ms" >= 100),
	CONSTRAINT "video_cues_timing" CHECK ("video_cues"."timing" in ('measured','estimated','manual')),
	CONSTRAINT "video_cues_text_len" CHECK (char_length("video_cues"."source_text") <= 2000 and char_length("video_cues"."target_text") <= 2000)
);--> statement-breakpoint
CREATE INDEX "video_cues_job_start_idx" ON "video_cues" USING btree ("job_id","start_ms");--> statement-breakpoint
CREATE TABLE "video_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL REFERENCES "video_jobs"("id") ON DELETE cascade,
	"owner_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"kind" text NOT NULL,
	"format" text NOT NULL,
	"style" jsonb NOT NULL,
	"cues" jsonb NOT NULL,
	"cue_revision" integer NOT NULL,
	"status" "video_export_status" DEFAULT 'queued' NOT NULL,
	"progress_percent" integer DEFAULT 50 NOT NULL,
	"estimated_bytes" bigint NOT NULL,
	"output_bytes" bigint,
	"output_key" text,
	"duration_ms" integer NOT NULL,
	"error_code" text,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"interruptions" integer DEFAULT 0 NOT NULL,
	"heartbeat_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"download_lease_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "video_exports_kind" CHECK ("video_exports"."kind" in ('burn','layer')),
	CONSTRAINT "video_exports_format" CHECK ("video_exports"."format" in ('mp4','mov') and ("video_exports"."kind" <> 'burn' or "video_exports"."format" = 'mp4')),
	CONSTRAINT "video_exports_progress_range" CHECK ("video_exports"."progress_percent" between 50 and 100),
	CONSTRAINT "video_exports_estimate_pos" CHECK ("video_exports"."estimated_bytes" > 0),
	CONSTRAINT "video_exports_duration_pos" CHECK ("video_exports"."duration_ms" > 0),
	CONSTRAINT "video_exports_output_pos" CHECK ("video_exports"."output_bytes" is null or "video_exports"."output_bytes" > 0),
	CONSTRAINT "video_exports_completed_has_output" CHECK ("video_exports"."status" <> 'completed' or ("video_exports"."output_key" is not null and "video_exports"."output_bytes" is not null and "video_exports"."expires_at" is not null))
);--> statement-breakpoint
CREATE UNIQUE INDEX "video_exports_open_uq" ON "video_exports" USING btree ("job_id") WHERE "video_exports"."status" in ('queued','running','interrupted');--> statement-breakpoint
CREATE INDEX "video_exports_job_idx" ON "video_exports" USING btree ("job_id","created_at");--> statement-breakpoint
CREATE INDEX "video_exports_owner_status_idx" ON "video_exports" USING btree ("owner_id","status");--> statement-breakpoint
CREATE INDEX "video_exports_status_heartbeat_idx" ON "video_exports" USING btree ("status","heartbeat_at");--> statement-breakpoint
CREATE INDEX "video_exports_status_expires_idx" ON "video_exports" USING btree ("status","expires_at");--> statement-breakpoint
CREATE TABLE "video_job_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"job_id" uuid NOT NULL REFERENCES "video_jobs"("id") ON DELETE cascade,
	"export_id" uuid REFERENCES "video_exports"("id") ON DELETE cascade,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"level" "log_level" NOT NULL,
	"message_key" text NOT NULL,
	"params" jsonb
);--> statement-breakpoint
CREATE INDEX "video_job_logs_job_idx" ON "video_job_logs" USING btree ("job_id","id");--> statement-breakpoint
ALTER TABLE "usage_records" ADD COLUMN "video_job_id" uuid REFERENCES "video_jobs"("id") ON DELETE set null;
