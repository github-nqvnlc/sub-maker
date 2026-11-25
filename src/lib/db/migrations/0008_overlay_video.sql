-- Video overlay phụ đề (spec 005, data-model). Viết tay như 0006/0007; không sửa bảng có sẵn.
CREATE TYPE "public"."overlay_audio_status" AS ENUM('processing', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "public"."overlay_format" AS ENUM('mp4', 'mov', 'webm');--> statement-breakpoint
CREATE TABLE "overlay_configs" (
	"project_id" uuid PRIMARY KEY NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
	"owner_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"config" jsonb NOT NULL,
	"source" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "overlay_audios" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
	"owner_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"original_name" text NOT NULL,
	"status" "overlay_audio_status" DEFAULT 'processing' NOT NULL,
	"temp_storage_key" text,
	"storage_key" text,
	"size_bytes" bigint DEFAULT 0 NOT NULL,
	"duration_ms" integer,
	"error_code" text,
	"interruptions" integer DEFAULT 0 NOT NULL,
	"heartbeat_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "overlay_audios_name_len" CHECK (char_length("overlay_audios"."original_name") between 1 and 255),
	CONSTRAINT "overlay_audios_size_nonneg" CHECK ("overlay_audios"."size_bytes" >= 0),
	CONSTRAINT "overlay_audios_duration_pos" CHECK ("overlay_audios"."duration_ms" is null or "overlay_audios"."duration_ms" > 0),
	CONSTRAINT "overlay_audios_ready" CHECK ("overlay_audios"."status" <> 'ready' or ("overlay_audios"."duration_ms" is not null and "overlay_audios"."storage_key" is not null))
);--> statement-breakpoint
CREATE INDEX "overlay_audios_project_idx" ON "overlay_audios" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "overlay_audios_owner_status_idx" ON "overlay_audios" USING btree ("owner_id","status");--> statement-breakpoint
CREATE TABLE "overlay_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
	"owner_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"client_request_id" uuid NOT NULL,
	"voice_id" uuid REFERENCES "voices"("id") ON DELETE set null,
	"audio_id" uuid REFERENCES "overlay_audios"("id") ON DELETE set null,
	"subtitle_file_id" uuid REFERENCES "subtitle_files"("id") ON DELETE set null,
	"source_names" jsonb NOT NULL,
	"config" jsonb NOT NULL,
	"cues" jsonb NOT NULL,
	"engine_version" integer NOT NULL,
	"format" "overlay_format" NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"duration_ms" integer NOT NULL,
	"estimated_bytes" bigint NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"progress_percent" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"interruptions" integer DEFAULT 0 NOT NULL,
	"heartbeat_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"output_storage_key" text,
	"output_size_bytes" bigint,
	CONSTRAINT "overlay_jobs_duration_pos" CHECK ("overlay_jobs"."duration_ms" > 0),
	CONSTRAINT "overlay_jobs_estimate_pos" CHECK ("overlay_jobs"."estimated_bytes" > 0),
	CONSTRAINT "overlay_jobs_progress_range" CHECK ("overlay_jobs"."progress_percent" between 0 and 100),
	CONSTRAINT "overlay_jobs_output_pos" CHECK ("overlay_jobs"."output_size_bytes" is null or "overlay_jobs"."output_size_bytes" > 0),
	CONSTRAINT "overlay_jobs_completed_has_output" CHECK (("overlay_jobs"."status" = 'completed') = ("overlay_jobs"."output_storage_key" is not null and "overlay_jobs"."output_size_bytes" is not null))
);--> statement-breakpoint
CREATE UNIQUE INDEX "overlay_jobs_owner_request_uq" ON "overlay_jobs" USING btree ("owner_id","client_request_id");--> statement-breakpoint
CREATE INDEX "overlay_jobs_project_idx" ON "overlay_jobs" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "overlay_jobs_owner_status_idx" ON "overlay_jobs" USING btree ("owner_id","status");--> statement-breakpoint
CREATE INDEX "overlay_jobs_status_heartbeat_idx" ON "overlay_jobs" USING btree ("status","heartbeat_at");--> statement-breakpoint
CREATE INDEX "overlay_jobs_status_created_idx" ON "overlay_jobs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "overlay_jobs_voice_idx" ON "overlay_jobs" USING btree ("voice_id");--> statement-breakpoint
CREATE INDEX "overlay_jobs_audio_idx" ON "overlay_jobs" USING btree ("audio_id");--> statement-breakpoint
CREATE INDEX "overlay_jobs_file_idx" ON "overlay_jobs" USING btree ("subtitle_file_id");--> statement-breakpoint
CREATE TABLE "overlay_job_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"job_id" uuid NOT NULL REFERENCES "overlay_jobs"("id") ON DELETE cascade,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"level" "log_level" NOT NULL,
	"message_key" text NOT NULL,
	"params" jsonb
);--> statement-breakpoint
CREATE INDEX "overlay_job_logs_job_idx" ON "overlay_job_logs" USING btree ("job_id","id");
