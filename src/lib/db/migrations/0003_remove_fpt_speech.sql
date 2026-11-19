-- Gỡ nhà cung cấp FPT.AI Speech (chỉ giữ FPT AI Marketplace + ShopAIKey).
-- Dữ liệu cũ: Project chuyển sang Marketplace (giữ nguyên kịch bản); cấu hình, tiến trình, cache, usage của FPT Speech bị xóa
-- vì không còn adapter để chạy/hiển thị (FPT Speech chưa từng tạo được voice thành công ở môi trường thật).
UPDATE "projects" SET "provider_type" = 'fpt_marketplace' WHERE "provider_type" = 'fpt_speech';--> statement-breakpoint
DELETE FROM "voice_jobs" WHERE "provider_type" = 'fpt_speech';--> statement-breakpoint
DELETE FROM "audio_cache" WHERE "provider_type" = 'fpt_speech';--> statement-breakpoint
DELETE FROM "usage_records" WHERE "provider_type" = 'fpt_speech';--> statement-breakpoint
DELETE FROM "ai_provider_configs" WHERE "type" = 'fpt_speech';--> statement-breakpoint
ALTER TABLE "ai_provider_configs" ALTER COLUMN "type" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "provider_type" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "audio_cache" ALTER COLUMN "provider_type" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "voice_jobs" ALTER COLUMN "provider_type" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "usage_records" ALTER COLUMN "provider_type" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."provider_type";--> statement-breakpoint
CREATE TYPE "public"."provider_type" AS ENUM('fpt_marketplace', 'shopaikey_openai', 'shopaikey_minimax');--> statement-breakpoint
ALTER TABLE "ai_provider_configs" ALTER COLUMN "type" SET DATA TYPE "public"."provider_type" USING "type"::"public"."provider_type";--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "provider_type" SET DATA TYPE "public"."provider_type" USING "provider_type"::"public"."provider_type";--> statement-breakpoint
ALTER TABLE "audio_cache" ALTER COLUMN "provider_type" SET DATA TYPE "public"."provider_type" USING "provider_type"::"public"."provider_type";--> statement-breakpoint
ALTER TABLE "voice_jobs" ALTER COLUMN "provider_type" SET DATA TYPE "public"."provider_type" USING "provider_type"::"public"."provider_type";--> statement-breakpoint
ALTER TABLE "usage_records" ALTER COLUMN "provider_type" SET DATA TYPE "public"."provider_type" USING "provider_type"::"public"."provider_type";