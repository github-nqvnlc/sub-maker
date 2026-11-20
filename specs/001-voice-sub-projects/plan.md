# Implementation Plan: Quản lý Project tạo Voice từ Subtitle (CRUDS)

**Branch**: `001-voice-sub-projects` | **Date**: 2026-11-19 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/001-voice-sub-projects/spec.md`

## Summary

Ứng dụng web nhiều người dùng: User tự đăng ký, tạo Project, upload kịch bản `.txt/.md/.srt`, hệ thống tách thành đoạn, gọi nhà
cung cấp TTS (FPT.AI, ShopAIKey) từng đoạn, ghép thành một voice kèm mốc thời gian chính xác theo đoạn, và cho nghe với việc làm nổi bật
đúng câu đang đọc. Administrator cấp sẵn qua cấu hình, quản lý User, cấu hình AI chung, danh sách User được dùng cấu hình AI riêng và xem
thống kê.

Hướng kỹ thuật (chi tiết ở [research.md](research.md)): **TypeScript một kho mã, một ảnh Docker, hai tiến trình**: `web` (Next.js +
Route Handlers) và `worker` (pg-boss). **PostgreSQL** cho dữ liệu, hàng đợi và xác thực; **MinIO** cho file, phát qua proxy có kiểm tra
quyền và hỗ trợ `Range`; log thời gian thực bằng **SSE** có con trỏ; cache audio theo User; lớp **adapter** nhà cung cấp với bảng phân loại lỗi
chung; lớp `safeFetch` chống SSRF. Triển khai Docker Compose, chỉ `cloudflared` ra Internet.

## Technical Context

**Language/Version**: TypeScript (strict) trên Node.js LTS; phiên bản thư viện chốt lúc khởi tạo dự án

**Primary Dependencies**: Next.js (App Router), React, Tailwind CSS, shadcn/ui (theme tweakcn), TanStack Query, Zod, Better Auth
(dự phòng Auth.js), Drizzle ORM + drizzle-kit, pg-boss, `@aws-sdk/client-s3`, ffmpeg (trong ảnh worker), bộ phân tích Markdown (unified/remark)

**Storage**: PostgreSQL (dữ liệu, hàng đợi, xác thực, thống kê; mở rộng `unaccent`, `pg_trgm`); MinIO S3 (file gốc, audio cache, voice, avatar)

**Testing**: Vitest (đơn vị + tích hợp), Playwright (E2E), máy chủ nhà cung cấp giả cho mọi adapter, bộ kiểm thử cô lập dữ liệu

**Target Platform**: Linux container (Docker Compose), truy cập qua Cloudflare Tunnel + tên miền; trình duyệt hiện đại trên máy tính và điện thoại

**Project Type**: web-service (ứng dụng web full-stack kèm worker nền)

**Performance Goals**: log đầu tiên ≤ 2 s và mỗi sự kiện ≤ 2 s (SC-002); lệch chuyển câu ≤ 0,3 s, tua ≤ 0,5 s (SC-004/005);
kịch bản ~5.000 ký tự ra voice ≤ 5 phút (SC-006); tìm/lọc/sắp xếp 200 Project < 1 s (SC-007); xóa 10 mục < 5 s (SC-009)

**Constraints**: file ≤ 2 MB, 500 MB lưu trữ/User (Administrator chỉnh được); MinIO/Postgres không mở cổng ra Internet; khóa API mã hóa và không rời
máy chủ; phát audio qua proxy xác thực; số tiến trình đồng thời có giới hạn (mặc định 3 toàn hệ thống, 2 mỗi User)

**Scale/Scope**: vài chục đến vài trăm User, 200+ Project/User, 3 tiến trình đồng thời; khoảng 20 màn hình (đăng nhập/đăng ký, danh sách Project,
chi tiết Project + trình phát, tạo voice + log, Dashboard, hồ sơ/cài đặt cá nhân, và nhóm màn hình Administrator: User, cấu hình AI, danh sách dùng cấu hình riêng, thống kê, cài đặt hệ thống)

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.* Nguồn: [.specify/memory/constitution.md](../../.specify/memory/constitution.md) v1.0.0.

| Nguyên tắc | Cách kế hoạch tuân thủ | Trước R | Sau thiết kế |
| --- | --- | :-: | :-: |
| I. Bảo mật và cô lập dữ liệu | `requireUser()/requireAdmin()` cho mọi Route Handler; mọi truy vấn lọc `owner_id` lấy từ session; tài nguyên người khác trả 404 (OpenAPI, data-model); audio phát qua proxy kiểm tra quyền (R5); băm mật khẩu và giới hạn tốc độ bền trong DB (R4); Admin không có endpoint đọc nội dung Project | ✅ | ✅ |
| II. Bảo vệ khóa API | AES-256-GCM (`APP_ENCRYPTION_KEY`), chỉ `api_key_hint` ra API, không ghi log; `safeFetch` chống SSRF cho `baseUrl` người dùng nhập (R9); cấu hình riêng chỉ cho `can_use_custom_ai` | ✅ | ✅ |
| III. Tiến trình nền bền vững | `worker` riêng + pg-boss, `heartbeat_at`, dọn job treo thành `interrupted` rồi tiếp tục; SSE có `Last-Event-ID`; giới hạn đồng thời; phân loại lỗi tạm thời/vĩnh viễn (R3, R10, tts-provider) | ✅ | ✅ |
| IV. Kiểm soát chi phí | `audio_cache` theo hash nội dung; `usage_records` ghi mỗi lần gọi thật kèm nguồn cấu hình; không hard-code giá (`price_per_million_chars` trong cấu hình); cấu hình riêng lỗi không rơi về cấu hình chung; hạn mức 2 MB/500 MB ở máy chủ (R7, R16) | ✅ | ✅ |
| V. Kiểm thử trước khi phát hành | Vitest + Playwright + máy chủ giả + bộ cô lập dữ liệu; kịch bản kiểm chứng khớp "Independent Test" ([quickstart](quickstart.md)) | ✅ | ✅ |
| VI. Giao diện nhất quán | shadcn/ui + theme tweakcn, chuỗi tiếng Việt tập trung, đủ trạng thái tải/rỗng/lỗi, responsive, xác nhận khi xóa, tìm không dấu (R12, R13) | ✅ | ✅ |
| Ràng buộc kỹ thuật và triển khai | Next.js + Tailwind + shadcn; MinIO riêng tư; Docker + Cloudflare Tunnel; volume bền; adapter nhà cung cấp; NFC/UTF-8 (R5, R6, R14) | ✅ | ✅ |

Không có vi phạm cần biện minh; bảng Complexity Tracking để trống. Việc tách `worker` thành tiến trình riêng không phải vi phạm mà là hệ quả trực tiếp
của Nguyên tắc III.

**Điểm cần theo dõi** (không phải vi phạm): (1) Better Auth chưa được chạy thử → Spike S5, có phương án dự phòng; (2) phát audio qua proxy tốn băng thông
web nhưng bắt buộc để không mở MinIO ra ngoài.

## Project Structure

### Documentation (this feature)

```text
specs/001-voice-sub-projects/
├── plan.md              # Tệp này
├── research.md          # Phase 0: quyết định, lý do, phương án khác, Spike
├── data-model.md        # Phase 1: bảng, quan hệ, máy trạng thái, quy tắc xác thực
├── quickstart.md        # Phase 1: chạy và kiểm chứng
├── contracts/
│   ├── openapi.yaml     # API HTTP giữa giao diện và máy chủ
│   ├── job-events.md    # Hợp đồng luồng SSE log/tiến độ
│   └── tts-provider.md  # Giao diện adapter nhà cung cấp và phân loại lỗi
├── checklists/requirements.md
└── tasks.md             # Phase 2 (/speckit-tasks), KHÔNG tạo ở bước này
```

### Source Code (repository root)

```text
src/
├── app/                          # Next.js App Router (giao diện + Route Handlers)
│   ├── (auth)/                   # đăng nhập, đăng ký
│   ├── (app)/                    # khu vực đã đăng nhập
│   │   ├── dashboard/            # thống kê cá nhân
│   │   ├── projects/             # danh sách; [id]/ chi tiết, trình phát, tạo voice, log
│   │   └── settings/             # hồ sơ, đổi mật khẩu, cấu hình AI riêng (chỉ User được phép)
│   ├── (admin)/admin/            # users, ai-configs, custom-ai-users, stats, settings
│   └── api/                      # Route Handlers theo contracts/openapi.yaml
│       ├── projects/ files/ jobs/ voices/ providers/ me/ dashboard/ admin/
├── components/                   # shadcn/ui + thành phần dùng chung (player, log-viewer, data-table, confirm-dialog) (ui/, shared/, auth/, app/, projects/, jobs/, player/)
├── lib/
│   ├── auth/                     # cấu hình xác thực, requireUser/requireAdmin, seed admin
│   ├── db/                       # schema Drizzle, migration, truy vấn theo chủ sở hữu
│   ├── storage/                  # client MinIO, khóa đối tượng, proxy Range
│   ├── security/                 # safeFetch (SSRF), mã hóa khóa API, giới hạn tốc độ
│   ├── parsing/                  # đọc .txt/.md/.srt, chuẩn hóa NFC, tách đoạn
│   ├── providers/                # adapter fpt_marketplace, shopaikey_openai, shopaikey_minimax, catalog, phân loại lỗi
│   ├── audio/                    # giải mã/ghép PCM, khoảng lặng, mã hóa mp3, tính timeline
│   ├── usage/                    # ghi usage, tổng hợp thống kê
│   ├── i18n/                     # chuỗi tiếng Việt tập trung
│   ├── users/                    # dịch vụ hồ sơ User và thao tác quản trị User
│   ├── jobs/                     # điều khiển tiến trình (dừng/tiếp tục), xóa job
│   ├── projects/                 # xóa Project và dữ liệu liên quan
│   ├── player/                   # logic tìm đoạn đang đọc (hàm thuần)
│   ├── hooks/                    # hook phía client (luồng SSE, polling dự phòng)
│   └── schemas/                  # Zod dùng chung cho API, giao diện, worker
├── worker/                       # tiến trình nền (pg-boss): jobs/ (generate-voice, delete-user, reconcile-storage), pipeline/ (cache, synthesize-segment), sweeper.ts
└── instrumentation/              # khởi động: migrate/seed admin

tests/
├── unit/                         # parsing, audio timeline, phân loại lỗi, safeFetch, mã hóa
├── integration/                  # DB + MinIO thật, máy chủ nhà cung cấp giả, worker
├── contract/                     # bộ kiểm thử hợp đồng adapter, khớp openapi.yaml
├── isolation/                    # User B gọi mọi endpoint với ID của User A
└── e2e/                          # Playwright: các kịch bản của quickstart
mock-provider/                    # máy chủ nhà cung cấp giả dùng trong kiểm thử
scripts/                          # spike-providers.ts, check-i18n.ts
docs/                             # hướng dẫn nhà cung cấp (đã có), provider-spikes.md, operations.md

docker/
├── Dockerfile                    # một ảnh; lệnh khởi động khác nhau cho web và worker; worker có ffmpeg
├── compose.dev.yml
└── compose.prod.yml              # postgres, minio, migrate, web, worker, cloudflared
.env.example                      # cấu trúc biến, không có giá trị thật
```

**Structure Decision**: Một ứng dụng TypeScript duy nhất (không tách `frontend/` và `backend/`), vì backend là Route Handlers của Next.js và
worker dùng chung `lib/`. Hai tiến trình cùng một ảnh Docker, chạy bằng hai lệnh khởi động khác nhau. Lý do: giảm lặp kiểu/validation, một nơi
cấu hình, đủ cho quy mô (R1). Nếu sau này cần mở rộng worker độc lập, có thể tách ảnh mà không đổi mã vì ranh giới `lib/` ↔ `worker/` đã rõ.

## Delivery Order (gợi ý chia giai đoạn cho `/speckit-tasks`)

| Giai đoạn | Nội dung | Phụ thuộc | Spec |
| --- | --- | --- | --- |
| 0 | Khung dự án, Docker Compose dev, theme tweakcn, CSDL + migration, MinIO, Spike S5/S6 | — | — |
| 1 | Xác thực, vai trò, seed Administrator, hồ sơ, cô lập dữ liệu + bộ kiểm thử cô lập | 0 | US7 |
| 2 | Cấu hình AI chung/riêng, danh sách User được phép, `safeFetch`, mã hóa khóa, adapter + máy chủ giả; Spike S1–S3 | 1 | US9 |
| 3 | Project CRUD + danh sách tìm/sắp xếp/lọc, upload + phân tích + xem trước | 1 | US1 (một phần), US6 |
| 4 | Worker, pipeline tạo voice, cache, ghép, timeline, SSE log, chạy nền, dừng/tiếp tục | 2, 3 | US1, US2 |
| 5 | Trình phát + highlight đồng bộ, proxy audio có Range | 4 | US3 |
| 6 | Sửa/chạy lại/xóa nhiều tiến trình, xóa nhiều Project | 4 | US4, US5 |
| 7 | Usage, Dashboard cá nhân, thống kê Administrator, quản lý User, xóa User | 4 | US8, US7 |
| 8 | Triển khai production (Compose + Cloudflare Tunnel), E2E toàn bộ, sao lưu tài liệu | tất cả | — |

MVP có giá trị sau giai đoạn 5 (đăng nhập → tạo Project → upload → voice → nghe có highlight).

## Complexity Tracking

Không có vi phạm Constitution cần biện minh.
