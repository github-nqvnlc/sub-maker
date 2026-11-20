CREATE TABLE "subtitle_cues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subtitle_file_id" uuid NOT NULL,
	"idx" integer NOT NULL,
	"n" integer NOT NULL,
	"start_ms" integer NOT NULL,
	"end_ms" integer NOT NULL,
	"text" text NOT NULL,
	"speakable" boolean DEFAULT true NOT NULL,
	"char_count" integer NOT NULL,
	CONSTRAINT "subtitle_cues_idx_nonneg" CHECK ("subtitle_cues"."idx" >= 0),
	CONSTRAINT "subtitle_cues_start_nonneg" CHECK ("subtitle_cues"."start_ms" >= 0),
	CONSTRAINT "subtitle_cues_end_after_start" CHECK ("subtitle_cues"."end_ms" > "subtitle_cues"."start_ms"),
	CONSTRAINT "subtitle_cues_chars_nonneg" CHECK ("subtitle_cues"."char_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "locale" text DEFAULT 'vi' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "theme" text DEFAULT 'system' NOT NULL;--> statement-breakpoint
ALTER TABLE "subtitle_files" ADD COLUMN "has_timecodes" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "subtitle_files" ADD COLUMN "cue_count" integer;--> statement-breakpoint
ALTER TABLE "subtitle_files" ADD COLUMN "duration_ms" integer;--> statement-breakpoint
ALTER TABLE "subtitle_files" ADD COLUMN "cue_warnings" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "subtitle_files" ADD COLUMN "cue_warning_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "subtitle_cues" ADD CONSTRAINT "subtitle_cues_subtitle_file_id_subtitle_files_id_fk" FOREIGN KEY ("subtitle_file_id") REFERENCES "public"."subtitle_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "subtitle_cues_file_idx_uq" ON "subtitle_cues" USING btree ("subtitle_file_id","idx");--> statement-breakpoint
CREATE INDEX "subtitle_cues_file_start_idx" ON "subtitle_cues" USING btree ("subtitle_file_id","start_ms");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_locale_valid" CHECK ("users"."locale" in ('vi','en'));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_theme_valid" CHECK ("users"."theme" in ('light','dark','system'));--> statement-breakpoint
ALTER TABLE "subtitle_files" ADD CONSTRAINT "subtitle_files_cue_count_nonneg" CHECK ("subtitle_files"."cue_count" is null or "subtitle_files"."cue_count" >= 0);--> statement-breakpoint
ALTER TABLE "subtitle_files" ADD CONSTRAINT "subtitle_files_duration_nonneg" CHECK ("subtitle_files"."duration_ms" is null or "subtitle_files"."duration_ms" >= 0);