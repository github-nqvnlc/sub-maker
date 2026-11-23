# Implementation Plan: STT Soniox & Tái Cấu Trúc Cấu Hình AI Provider Quản Trị

**Branch**: `004-stt-soniox-subtitle` | **Date**: 2026-11-23 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/004-stt-soniox-subtitle/spec.md` và tài liệu giải pháp tại [docs/todo/requirements/req-02/solution.md](../../docs/todo/requirements/req-02/solution.md)

---

## Summary

Dự án này triển khai 2 nội dung lớn:
1. **Tính năng STT (Speech-to-Text)**:
   - Tiếp nhận file âm thanh (`.mp3`, `.wav`, `.m4a`,...) hoặc file video (`.mp4`, `.mov`,...).
   - Bóc tách âm thanh qua FFmpeg thành MP3 16kHz mono (giảm 95% dung lượng tải lên Soniox, chỉ mất 1–3s).
   - Tích hợp Soniox Async Transcription REST API (`POST /v1/files`, `POST /v1/transcriptions`, polling `GET /v1/transcriptions/{id}`) để nhận diện giọng nói chính xác với mốc thời gian từng từ (*token-level timestamps*).
   - Thuật toán gom nhóm từ thành Cue phụ đề chuẩn (`Subtitle Chunking Engine`) xuất ra file `.srt`, `.txt`, `.md`.
   - Nạp trực tiếp vào Project (bảng `subtitle_files` và `subtitle_cues`) để hiển thị ở danh sách kịch bản và sẵn sàng cho TTS.
2. **Tái cấu trúc Cấu hình AI Provider trong Cài đặt Admin (`/admin/ai-configs`)**:
   - **FPT.AI** (Mặc định 1): Cố định 1 token/API Key duy nhất dùng chung cho toàn bộ model (VITs, TTS-pro, TTS-ultra và các model mở rộng sau này ngoài TTS).
   - **SONIOX** (Mặc định 2): Cố định 1 token/API Key duy nhất dùng cho toàn bộ model Async STT (`stt-async-v6`), Real-time STT (`stt-rt-v6`) và Translation sau này. Trong task này khuyến nghị sử dụng model `stt-async-v6`.
   - **ShopAIKey** (Tùy chọn đặc biệt): 1 token/API Key duy nhất dùng cho toàn bộ model OpenAI, Minimax và các model khác đã đăng ký.
   - **Custom AI Providers chuẩn OpenAI (Tùy chọn thêm)**:
     - Admin có thể tạo nhiều nhà cung cấp chuẩn OpenAI (bảng quản lý CRUD: Thêm, Sửa, Xóa, Test kết nối).
     - Hỗ trợ 3 chế độ phân quyền sử dụng: **Công khai** (mọi User được dùng), **Chỉ định User** (chọn danh sách cụ thể các User), hoặc **Chỉ Admin**.
     - User có cờ `canUseCustomAi = true` có thể cấu hình AI Provider chuẩn OpenAI của riêng mình tại `/settings/ai`.

---

## Technical Context

- **Language/Version**: TypeScript 5.9 (strict), Node.js 22
- **Primary Dependencies**: Next.js 16 (App Router), React 19, Tailwind CSS 4, shadcn/ui, Drizzle ORM, pg-boss, FFmpeg (sử dụng tiện ích `runFfmpeg` đã có sẵn), `@tanstack/react-query`.
- **Storage**: PostgreSQL 16 (bảng mới `stt_jobs`, bảng mới `custom_ai_providers`), MinIO (lưu file media tạm và dọn dẹp ngay sau khi xử lý).
- **Testing**: Vitest (unit, integration, mock contract) với dữ liệu kiểm thử audio ngắn $\le 10$ giây.
- **Target Platform**: Web application (Next.js client + background worker pg-boss).
- **Performance Goals**: Trích xuất âm thanh từ video 10 phút dưới 5 giây; toàn bộ tiến trình STT cho 10 phút audio hoàn tất dưới 45 giây; chuyển đổi giữa các tab cấu hình AI dưới 200ms.
- **Constraints**: 
  - Khóa API của mọi nhà cung cấp (FPT, Soniox, ShopAIKey, Custom OpenAI) đều phải được mã hóa bằng AES-256-GCM tại máy chủ, không bao giờ lộ ra client.
  - Phụ đề sinh ra phải có mốc thời gian hợp lệ để tương thích 100% với chế độ khớp mốc phụ đề (Spec 003).
  - Tự động xóa tệp media tạm sau khi phiên âm xong để bảo vệ hạn mức lưu trữ quota của người dùng.
- **Scale/Scope**: Tệp video tối đa 500 MB, tệp audio tối đa 100 MB, thời lượng tối đa 60 phút (đo bằng ffprobe trong worker). File media tạm không tính vào hạn mức lưu trữ của User. Quản lý không giới hạn số lượng Custom AI Provider.
- **Dùng lại thành phần sẵn có**:
  - `recordUsage` (`src/lib/usage/record.ts`) để ghi usage cho Soniox (FR-018); bảng `usage_records` thêm `units_audio_seconds` và `stt_job_id` (data-model §5).
  - `sweepStaleJobs` (`src/worker/sweeper.ts`) mở rộng cho `stt_jobs`: job chạy quá hạn chuyển `interrupted` rồi xếp hàng lại (FR-019).
  - `backoffMs` (`src/worker/pipeline/synthesize-segment.ts`) cho retry lỗi tạm thời của Soniox (FR-019).
  - Cài đặt hệ thống mới `maxSttJobsPerUser` (mặc định 2, Admin chỉnh được), cùng cách với `maxJobsPerUser` của voice job (FR-017).
  - Cấu hình AI riêng của User giữ trong `ai_provider_configs` (`scope = 'user'`, `/api/me/ai-config`); bảng `custom_ai_providers` chỉ chứa provider do Admin tạo.
  - Migration 0007 (`0007_stt_and_custom_ai_providers.sql`, viết tay như 0006) tạo bảng mới, thêm giá trị enum `soniox` và chuyển cấu hình `openai_compatible` chung sang `custom_ai_providers` theo data-model §7. Tên kiểu TTS nội bộ được giữ nguyên (quyết định của người dùng khi triển khai, data-model §3).
  - `resolveConfigForJob` (`src/lib/providers/config-service.ts`) thêm nhánh cho voice job có `custom_provider_id`: kiểm tra lại quyền truy cập và `enabled` lúc worker nhận job, rồi dùng adapter `openai_compatible` với `base_url` và khóa của provider đó (data-model §8, FR-022).
  - Nhật ký STT ghi vào bảng mới `stt_job_logs` (data-model §1), vì `job_logs` chỉ trỏ tới `voice_jobs` (FR-020).
  - File media tạm đặt tại `users/{userId}/stt-tmp/{jobId}/source.{ext}` (thêm `storageKeys.sttTemp` vào `src/lib/storage/keys.ts`), để xóa User theo tiền tố cũng xóa được; xóa Project dọn file tạm theo `temp_storage_key`, cùng cách `src/lib/storage/cleanup.ts` làm cho voice job (FR-021).
  - Worker `transcribe-media` đăng ký với `localConcurrency: 2`; phần vượt mức nằm chờ trong hàng đợi (Hiến pháp III).
  - Model Soniox mặc định cho tạo phụ đề chỉ nhận model async (`stt-async-*`).
  - File audio và bản phiên âm trên Soniox bị xóa (`deleteTranscription`, `deleteFile`) khi job kết thúc và khi xóa Project/User, theo `contracts/soniox-client.md` (FR-021).
  - API tạo voice job có sẵn (`createJobSchema` trong `src/lib/jobs/service.ts`) thêm trường `customProviderId` (FR-022, `contracts/openapi-delta.yaml`).

---

## Constitution Check

*GATE: Đánh giá tuân thủ Hiến pháp dự án Sub Maker.*

| Nguyên tắc | Đánh giá | Chi tiết phương án |
| :--- | :---: | :--- |
| **I. Bảo mật và cô lập dữ liệu** | ✅ Đạt | Mọi API endpoint (`/api/projects/{projectId}/stt`, `/api/stt/{jobId}`, `/api/admin/custom-ai-providers`) đều kiểm tra quyền nghiêm ngặt. User chỉ thấy và dùng các Custom Provider được công khai hoặc chỉ định cho chính mình. |
| **II. Bảo vệ khóa API & Bí mật** | ✅ Đạt | Tất cả các khóa (FPT 1 token, Soniox 1 token, ShopAIKey 1 token, Custom Providers) đều được mã hóa AES-256-GCM trong PostgreSQL. Frontend chỉ nhận dạng che (`...xxxx`). |
| **III. Tiến trình nền bền vững** | ✅ Đạt | STT xử lý qua hàng đợi `transcribe-media` của `pg-boss`. Đóng trình duyệt không làm mất tiến trình. |
| **IV. Kiểm soát chi phí & Hạn mức** | ✅ Đạt | Bóc tách âm thanh sang MP3 16kHz mono trước khi gửi Soniox để giảm 95% băng thông. Tự động xóa file media tạm trên MinIO sau khi hoàn tất. |
| **V. Kiểm thử trước khi phát hành** | ✅ Đạt | Mock Soniox Client cho kiểm thử tự động. Mock endpoint kiểm tra Custom OpenAI Provider. Dữ liệu kiểm thử $\le 10$ giây. |
| **VI. Giao diện nhất quán, tiếng Việt** | ✅ Đạt | Giao diện tiếng Việt chuẩn, bổ sung từ điển `vi.ts` và `en.ts`, vượt qua kiểm tra `npm run check:i18n`. Sử dụng thành phần chuẩn shadcn/ui. |

**Kết luận cổng**: ĐẠT 100% các tiêu chí Hiến pháp.

---

## Project Structure

### Documentation (this feature)

```text
specs/004-stt-soniox-subtitle/
├── plan.md              # Kế hoạch triển khai (Tệp này)
├── research.md          # Nghiên cứu kỹ thuật (Phase 0: R1-R6)
├── data-model.md        # Mô hình dữ liệu stt_jobs & custom_ai_providers (Phase 1)
├── quickstart.md        # Hướng dẫn kiểm thử nhanh (Phase 1)
├── contracts/
│   ├── openapi-delta.yaml   # Hợp đồng API endpoints STT & Custom AI CRUD
│   └── soniox-client.md     # Interface Soniox Client & Mock
└── checklists/
    └── requirements.md  # Tiêu chí đánh giá chất lượng đặc tả
```

### Source Code Impact

```text
src/
├── lib/
│   ├── audio/
│   │   ├── ffmpeg.ts                     # Thêm extractAudioFromMedia
│   │   └── media-detect.ts               # Phân biệt tệp audio vs video
│   ├── parsing/
│   │   └── stt-chunker.ts                # Thuật toán gom nhóm Tokens -> Cues (.srt/.txt/.md)
│   ├── providers/
│   │   ├── catalog.ts                    # Cập nhật danh mục: FPT (1 token), Soniox (1 token), ShopAIKey (1 token)
│   │   ├── custom-provider-service.ts    # Logic CRUD và phân quyền Custom AI Providers
│   │   └── adapters/
│   │       ├── soniox.ts                 # SonioxSttClient (gọi API Soniox thật, testConnection)
│   │       └── soniox-types.ts           # Types của Soniox API
│   ├── db/schema/
│   │   ├── ai-config.ts                  # Schema Custom AI Providers & phân quyền User
│   │   ├── index.ts                      # Export stt_jobs và custom_ai_providers schema
│   │   └── stt-jobs.ts                   # Định nghĩa bảng stt_jobs
│   └── i18n/
│       ├── vi.ts                         # Thêm từ khóa tiếng Việt cho STT & Admin AI Config
│       └── en.ts                         # Thêm từ khóa tiếng Anh cho STT & Admin AI Config
├── worker/
│   ├── queues.ts                         # Thêm QUEUES.transcribeMedia
│   ├── handlers.ts                       # Đăng ký handler xử lý STT
│   └── jobs/
│       └── transcribe-media.ts           # Logic worker: extract -> upload Soniox -> poll -> chunk -> save
├── components/
│   ├── settings/
│   │   ├── ai-config-manager.tsx         # Tái cấu trúc 4 tab: FPT, Soniox, ShopAIKey, Custom OpenAI
│   │   ├── custom-provider-table.tsx     # Bảng danh sách CRUD Custom Providers
│   │   ├── custom-provider-dialog.tsx    # Dialog thêm/sửa Provider kèm phân quyền User
│   │   └── user-assignment-picker.tsx    # Bộ chọn danh sách User được cấp quyền
│   └── projects/
│       ├── stt-dialog.tsx                # Hộp thoại tải lên Audio/Video và theo dõi tiến trình
│       └── project-detail.tsx            # Nút mở STT Dialog trong danh sách kịch bản
└── app/
    └── api/
        ├── admin/
        │   └── custom-ai-providers/      # CRUD API routes cho Custom AI Providers
        │       ├── route.ts              # GET (danh sách), POST (tạo mới)
        │       └── [providerId]/
        │           ├── route.ts          # PUT (sửa), DELETE (xóa)
        │           └── test/route.ts     # POST (kiểm tra kết nối)
        ├── projects/[projectId]/stt/route.ts # POST tạo STT job, GET danh sách job
        └── stt/[jobId]/route.ts              # GET chi tiết & tiến độ job
```

---

## Lộ trình triển khai 4 giai đoạn

### Giai đoạn 1: Tái cấu trúc Cấu hình AI Provider Quản trị
- Cập nhật database schema: Bảng `custom_ai_providers` kèm trường `access_mode` và `assigned_user_ids`.
- Chuẩn hóa FPT.AI (1 token), Soniox (1 token), ShopAIKey (1 token) trong catalog và CSDL.
- Viết API routes CRUD cho Custom AI Providers (`/api/admin/custom-ai-providers`).
- Xây dựng giao diện 4 tab tại `/admin/ai-configs`: Form cấu hình 1 token cho từng core provider và bảng quản lý CRUD Custom Providers có phân quyền User.

### Giai đoạn 2: Soniox STT Adapter & FFmpeg Extractor
- Cài đặt `extractAudioFromMedia` (FFmpeg) trích xuất âm thanh nén 16kHz mono.
- Cài đặt `SonioxSttClient` đầy đủ (Upload file, khởi tạo async job với model `stt-async-v6`, polling status, lấy transcript).
- Viết mock client trong `tests/mocks/soniox-mock.ts`.

### Giai đoạn 3: Subtitle Chunker & Background Worker
- Xây dựng thuật toán gom nhóm tokens `chunkTokensToSrt` và bộ unit test kiểm tra mốc thời gian.
- Tạo migration CSDL cho bảng `stt_jobs`.
- Đăng ký hàng đợi `transcribe-media` trong `pg-boss`, hoàn thiện handler worker kết nối với `uploadScript`.
- Tạo các API route `/api/projects/[projectId]/stt` và `/api/stt/[jobId]`.

### Giai đoạn 4: UI STT, Phân quyền & Đa ngôn ngữ (i18n)
- Xây dựng `SttDialog` tích hợp vào màn hình Project Detail tại tab Kịch bản.
- Lọc danh sách Provider theo quyền truy cập của User.
- Bổ sung từ điển đa ngôn ngữ (`vi.ts` / `en.ts`), kiểm tra `npm run check:i18n`.
- Chạy toàn bộ test suites (`npm run test:unit`, `npx tsc --noEmit`, `npm run build`) và xác minh chất lượng.
