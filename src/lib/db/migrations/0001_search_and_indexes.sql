-- Tìm kiếm Project không dấu (FR-006) + chỉ mục cho danh sách (R12).
-- `unaccent` gốc chỉ ở mức STABLE nên không dùng được trong cột sinh/chỉ mục:
-- bọc thành hàm IMMUTABLE, đồng thời chuyển rõ ràng đ/Đ → d/D.
CREATE EXTENSION IF NOT EXISTS unaccent;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE OR REPLACE FUNCTION immutable_unaccent(text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  AS $$ SELECT translate(public.unaccent('public.unaccent'::regdictionary, $1), 'đĐ', 'dD') $$;--> statement-breakpoint
ALTER TABLE "projects"
  ADD COLUMN "search_text" text GENERATED ALWAYS AS (
    immutable_unaccent(lower("name" || ' ' || coalesce("description", '')))
  ) STORED;--> statement-breakpoint
CREATE INDEX "projects_search_trgm_idx" ON "projects" USING gin ("search_text" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "projects_owner_updated_idx" ON "projects" ("owner_id", "updated_at" DESC);--> statement-breakpoint
CREATE INDEX "projects_owner_name_idx" ON "projects" ("owner_id", "name");--> statement-breakpoint
CREATE INDEX "projects_owner_provider_idx" ON "projects" ("owner_id", "provider_type");
