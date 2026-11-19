CREATE TYPE "public"."user_role" AS ENUM('admin', 'user');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'banned', 'deleting');--> statement-breakpoint
CREATE TYPE "public"."config_scope" AS ENUM('global', 'user');--> statement-breakpoint
CREATE TYPE "public"."config_disabled_reason" AS ENUM('owner_removed_from_list', 'admin_disabled');--> statement-breakpoint
CREATE TYPE "public"."provider_type" AS ENUM('fpt_speech', 'fpt_marketplace', 'shopaikey_openai');--> statement-breakpoint
CREATE TYPE "public"."subtitle_ext" AS ENUM('txt', 'md', 'skt');--> statement-breakpoint
CREATE TYPE "public"."job_segment_status" AS ENUM('pending', 'running', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('queued', 'running', 'completed', 'failed', 'stopped', 'interrupted');--> statement-breakpoint
CREATE TYPE "public"."log_level" AS ENUM('info', 'warn', 'error');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" bigint NOT NULL,
	CONSTRAINT "rate_limits_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" uuid NOT NULL,
	CONSTRAINT "sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"display_name" text NOT NULL,
	"image" text,
	"bio" text,
	"avatar_key" text,
	"role" "user_role" DEFAULT 'user' NOT NULL,
	"status" "user_status" DEFAULT 'active' NOT NULL,
	"can_use_custom_ai" boolean DEFAULT false NOT NULL,
	"storage_used_bytes" bigint DEFAULT 0 NOT NULL,
	"last_active_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_name_len" CHECK (char_length("users"."display_name") between 1 and 60),
	CONSTRAINT "users_bio_len" CHECK ("users"."bio" is null or char_length("users"."bio") <= 500),
	CONSTRAINT "users_storage_nonneg" CHECK ("users"."storage_used_bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_provider_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" "config_scope" NOT NULL,
	"owner_user_id" uuid,
	"type" "provider_type" NOT NULL,
	"name" text NOT NULL,
	"base_url" text NOT NULL,
	"api_key_enc" "bytea" NOT NULL,
	"api_key_hint" text NOT NULL,
	"default_model" text,
	"default_voice" text,
	"default_speed" numeric,
	"max_chars_per_request" integer NOT NULL,
	"price_per_million_chars" numeric,
	"enabled" boolean DEFAULT true NOT NULL,
	"disabled_reason" "config_disabled_reason",
	"last_test_at" timestamp with time zone,
	"last_test_ok" boolean,
	"last_test_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_config_owner_scope" CHECK (("ai_provider_configs"."scope" = 'global' and "ai_provider_configs"."owner_user_id" is null) or ("ai_provider_configs"."scope" = 'user' and "ai_provider_configs"."owner_user_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"provider_type" "provider_type" NOT NULL,
	"voice_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_name_len" CHECK (char_length(btrim("projects"."name")) between 1 and 120),
	CONSTRAINT "projects_desc_len" CHECK ("projects"."description" is null or char_length("projects"."description") <= 2000),
	CONSTRAINT "projects_voice_count_nonneg" CHECK ("projects"."voice_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "segments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subtitle_file_id" uuid NOT NULL,
	"idx" integer NOT NULL,
	"text" text NOT NULL,
	"char_count" integer NOT NULL,
	CONSTRAINT "segments_file_idx_uq" UNIQUE("subtitle_file_id","idx"),
	CONSTRAINT "segments_idx_nonneg" CHECK ("segments"."idx" >= 0)
);
--> statement-breakpoint
CREATE TABLE "subtitle_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"original_name" text NOT NULL,
	"ext" "subtitle_ext" NOT NULL,
	"size_bytes" integer NOT NULL,
	"storage_key" text NOT NULL,
	"content_hash" text NOT NULL,
	"char_count" integer NOT NULL,
	"segment_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audio_cache" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"content_hash" text NOT NULL,
	"storage_key" text NOT NULL,
	"duration_ms" integer NOT NULL,
	"size_bytes" integer NOT NULL,
	"chars" integer NOT NULL,
	"provider_type" "provider_type" NOT NULL,
	"model" text,
	"voice" text NOT NULL,
	"speed" numeric,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"job_id" uuid NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"level" "log_level" NOT NULL,
	"code" text NOT NULL,
	"message" text NOT NULL,
	"meta" jsonb
);
--> statement-breakpoint
CREATE TABLE "job_segments" (
	"job_id" uuid NOT NULL,
	"idx" integer NOT NULL,
	"status" "job_segment_status" DEFAULT 'pending' NOT NULL,
	"cache_hit" boolean DEFAULT false NOT NULL,
	"audio_cache_id" uuid,
	"duration_ms" integer,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	CONSTRAINT "job_segments_job_id_idx_pk" PRIMARY KEY("job_id","idx")
);
--> statement-breakpoint
CREATE TABLE "voice_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"subtitle_file_id" uuid NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"provider_type" "provider_type" NOT NULL,
	"config_id" uuid,
	"config_scope" "config_scope" NOT NULL,
	"settings" jsonb NOT NULL,
	"progress_done" integer DEFAULT 0 NOT NULL,
	"progress_total" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"error_message" text,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"heartbeat_at" timestamp with time zone,
	"queue_job_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "voices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"subtitle_file_id" uuid NOT NULL,
	"title" text NOT NULL,
	"storage_key" text NOT NULL,
	"format" text DEFAULT 'mp3' NOT NULL,
	"duration_ms" integer NOT NULL,
	"size_bytes" integer NOT NULL,
	"timeline" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "system_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "usage_records" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid,
	"project_id" uuid,
	"job_id" uuid,
	"provider_type" "provider_type" NOT NULL,
	"config_scope" "config_scope" NOT NULL,
	"model" text,
	"voice" text,
	"units_chars" integer NOT NULL,
	"units_tokens" integer,
	"cost_estimate_usd" numeric,
	"ok" boolean NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_provider_configs" ADD CONSTRAINT "ai_provider_configs_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segments" ADD CONSTRAINT "segments_subtitle_file_id_subtitle_files_id_fk" FOREIGN KEY ("subtitle_file_id") REFERENCES "public"."subtitle_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subtitle_files" ADD CONSTRAINT "subtitle_files_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subtitle_files" ADD CONSTRAINT "subtitle_files_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audio_cache" ADD CONSTRAINT "audio_cache_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_logs" ADD CONSTRAINT "job_logs_job_id_voice_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."voice_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_segments" ADD CONSTRAINT "job_segments_job_id_voice_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."voice_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_segments" ADD CONSTRAINT "job_segments_audio_cache_id_audio_cache_id_fk" FOREIGN KEY ("audio_cache_id") REFERENCES "public"."audio_cache"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_jobs" ADD CONSTRAINT "voice_jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_jobs" ADD CONSTRAINT "voice_jobs_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_jobs" ADD CONSTRAINT "voice_jobs_subtitle_file_id_subtitle_files_id_fk" FOREIGN KEY ("subtitle_file_id") REFERENCES "public"."subtitle_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_jobs" ADD CONSTRAINT "voice_jobs_config_id_ai_provider_configs_id_fk" FOREIGN KEY ("config_id") REFERENCES "public"."ai_provider_configs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voices" ADD CONSTRAINT "voices_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voices" ADD CONSTRAINT "voices_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voices" ADD CONSTRAINT "voices_job_id_voice_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."voice_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voices" ADD CONSTRAINT "voices_subtitle_file_id_subtitle_files_id_fk" FOREIGN KEY ("subtitle_file_id") REFERENCES "public"."subtitle_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_settings" ADD CONSTRAINT "system_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_job_id_voice_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."voice_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_user_idx" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_uq" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "users_status_idx" ON "users" USING btree ("status");--> statement-breakpoint
CREATE INDEX "users_created_idx" ON "users" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_config_scope_owner_type_uq" ON "ai_provider_configs" USING btree ("scope",coalesce("owner_user_id", '00000000-0000-0000-0000-000000000000'::uuid),"type");--> statement-breakpoint
CREATE INDEX "ai_config_owner_idx" ON "ai_provider_configs" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "subtitle_files_project_idx" ON "subtitle_files" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "subtitle_files_owner_idx" ON "subtitle_files" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "audio_cache_owner_hash_uq" ON "audio_cache" USING btree ("owner_id","content_hash");--> statement-breakpoint
CREATE INDEX "job_logs_job_id_idx" ON "job_logs" USING btree ("job_id","id");--> statement-breakpoint
CREATE INDEX "job_segments_cache_idx" ON "job_segments" USING btree ("audio_cache_id");--> statement-breakpoint
CREATE INDEX "voice_jobs_project_idx" ON "voice_jobs" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "voice_jobs_owner_status_idx" ON "voice_jobs" USING btree ("owner_id","status");--> statement-breakpoint
CREATE INDEX "voice_jobs_status_heartbeat_idx" ON "voice_jobs" USING btree ("status","heartbeat_at");--> statement-breakpoint
CREATE UNIQUE INDEX "voices_job_uq" ON "voices" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "voices_project_idx" ON "voices" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "usage_user_ts_idx" ON "usage_records" USING btree ("user_id","ts");--> statement-breakpoint
CREATE INDEX "usage_ts_idx" ON "usage_records" USING btree ("ts");