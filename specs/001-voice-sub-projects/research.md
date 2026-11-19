# Nghiên cứu (Phase 0): Quản lý Project tạo Voice từ Subtitle

**Ngày**: 2026-11-19 | **Spec**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md)

Mọi điểm "NEEDS CLARIFICATION" của Technical Context được giải quyết ở đây. Phiên bản thư viện cụ thể
được chốt khi khởi tạo dự án (dùng bản ổn định mới nhất lúc đó); tài liệu này chỉ chốt *lựa chọn*.

## Độ tin cậy

| Ký hiệu | Nghĩa |
| :-: | --- |
| 📘 | Lấy từ tài liệu nhà cung cấp trong `docs/` hoặc hành vi chuẩn của công nghệ |
| 🔧 | Quyết định thiết kế của dự án |
| ⚠️ | Chưa kiểm chứng, phải thử thật (xem "Spike" cuối tài liệu) |

---

## R1. Ngôn ngữ và kiến trúc tổng thể

- **Decision** 🔧: TypeScript trên Node.js LTS, **một kho mã, một ảnh Docker, hai tiến trình**:
  `web` (Next.js: giao diện + API bằng Route Handlers) và `worker` (tiến trình nền tạo voice).
- **Rationale**: Frontend đã bắt buộc Next.js; dùng cùng ngôn ngữ cho backend giảm số công nghệ,
  chia sẻ kiểu dữ liệu/validation (Zod) giữa giao diện, API và worker. Tách `worker` là bắt buộc để
  thỏa Nguyên tắc III (chạy nền độc lập, chịu khởi động lại web, giới hạn đồng thời): tiến trình tạo
  voice không được sống trong vòng đời một request.
- **Alternatives**: (a) backend riêng NestJS/FastAPI: thêm một codebase và một lớp hợp đồng API, không
  có lợi ích cho quy mô này. (b) Chạy việc nền trong chính tiến trình Next.js: mất việc khi redeploy,
  không có giới hạn đồng thời tách biệt. Bị loại.

## R2. Cơ sở dữ liệu

- **Decision** 🔧: **PostgreSQL** (+ phần mở rộng `unaccent`, `pg_trgm`), truy cập bằng **Drizzle ORM**,
  migration bằng drizzle-kit.
- **Rationale**: Cần quan hệ chặt (User → Project → File/Job/Voice), cascade xóa (FR-004, FR-037),
  tìm kiếm không dấu (FR-006) và thống kê gộp theo ngày/User (FR-038/039). Postgres đáp ứng cả ba mà
  không cần thêm dịch vụ. Drizzle gọn, kiểu an toàn, SQL gần với thực tế.
- **Alternatives**: SQLite (một ghi tại một thời điểm, khó chia sẻ giữa web và worker trong hai
  container, không có `unaccent`); MongoDB (mất ràng buộc và join cho thống kê). Bị loại.

## R3. Hàng đợi tiến trình nền

- **Decision** 🔧: **pg-boss** (hàng đợi chạy trên chính PostgreSQL), không dùng Redis.
- **Rationale**: Bền vững qua khởi động lại, có retry/backoff, giới hạn đồng thời theo hàng đợi,
  và một nơi lưu dữ liệu duy nhất để sao lưu. Bớt một dịch vụ (Redis) trong Docker Compose.
- **Bổ sung** 🔧: trạng thái nghiệp vụ nằm ở bảng `voice_jobs` (không chỉ trong hàng đợi); worker ghi
  `heartbeat_at` mỗi vài giây. Lúc khởi động, worker "dọn": job `running` có heartbeat quá hạn →
  chuyển `interrupted` rồi đưa lại hàng đợi để **tiếp tục từ đoạn chưa xong** (Nguyên tắc III).
- **Alternatives**: BullMQ + Redis (mạnh hơn nhưng thêm dịch vụ, không cần ở quy mô này); tự viết
  hàng đợi bằng bảng (tái phát minh).

## R4. Xác thực và phân quyền

- **Decision** 🔧: **Better Auth** (email + mật khẩu, session cookie, plugin quản trị/vai trò), lưu trong
  Postgres chung. Vai trò `admin`/`user` kiểm tra ở máy chủ bằng một lớp `requireUser()/requireAdmin()`
  dùng cho **mọi** Route Handler và Server Action. Truy vấn dữ liệu luôn lọc theo `owner_id`.
- **Administrator cấp sẵn**: lúc khởi động, bước seed idempotent tạo/đồng bộ tài khoản admin từ biến
  `ADMIN_EMAIL`, `ADMIN_PASSWORD` (đăng ký công khai không bao giờ tạo được admin).
- **Giới hạn tốc độ** 🔧: giới hạn đăng nhập/đăng ký theo IP + tài khoản, lưu bền trong DB (không in-memory,
  để không reset khi khởi động lại). Phía sau Cloudflare Tunnel, IP thật lấy từ `CF-Connecting-IP`
  và **chỉ tin** header này khi request đến từ tunnel.
- **Rủi ro** ⚠️: Better Auth phải được kiểm tra đúng API ở task khởi tạo. **Phương án dự phòng**: Auth.js
  (Credentials) hoặc tự viết session (argon2id + bảng `sessions`) — hợp đồng nội bộ `requireUser()` giữ
  nguyên nên đổi không ảnh hưởng phần còn lại.
- **Mật khẩu** 📘: băm bằng thuật toán chuẩn (argon2id hoặc scrypt) có muối, theo Nguyên tắc I. Chính sách (đã chốt): 10–128 ký tự, không toàn chữ số, không nằm trong danh sách mật khẩu phổ biến.
- **Phạm vi tài khoản v1** 🔧 (đã chốt): không xác minh email, không đăng nhập qua bên thứ ba, không quên mật khẩu tự phục vụ; Administrator đặt lại mật khẩu. Rủi ro chấp nhận: có thể đăng ký bằng email không thuộc quyền sở hữu của mình; giảm nhẹ bằng giới hạn tốc độ đăng ký (xem trên) và việc Administrator khóa User.
- **Chống CSRF** 🔧: mọi `POST/PUT/PATCH/DELETE` dùng cookie phiên MUST kiểm tra `Origin`/`Host` khớp `APP_URL` (sai → 403), cộng với cookie `SameSite=Lax`, `HttpOnly`, `Secure`.
- **Alternatives**: Clerk/Auth0 (dịch vụ ngoài, chi phí và dữ liệu rời hệ thống); NextAuth cũ (kém
  phù hợp đăng ký mật khẩu tự quản).

## R5. Lưu trữ file (MinIO)

- **Decision** 🔧: MinIO qua **S3 API** (`@aws-sdk/client-s3`), một bucket **riêng tư** duy nhất. Khóa đối tượng
  theo cấu trúc `users/{userId}/...` để xóa User = xóa theo tiền tố.
  Máy chủ phát file **qua proxy xác thực** (Route Handler có hỗ trợ `Range`), không dùng liên kết ký
  công khai và không mở cổng MinIO ra Internet (Nguyên tắc I và ràng buộc triển khai).
- **Rationale**: Tunnel chỉ trỏ vào `web`; muốn nghe/tua audio an toàn thì proxy chuyển tiếp `Range`
  từ MinIO. Tải audio qua proxy tốn băng thông web nhưng ở quy mô này chấp nhận được.
- **Cấu trúc khóa**:
  - `users/{uid}/subtitles/{fileId}/original` (file gốc)
  - `users/{uid}/cache/{hash}.wav` (audio từng đoạn, PCM chuẩn hóa)
  - `users/{uid}/voices/{voiceId}.mp3` (voice hoàn chỉnh)
  - `users/{uid}/avatar`
- **Alternatives**: presigned URL công khai (cần mở MinIO ra ngoài hoặc qua tunnel thứ hai); lưu file trong
  DB (phình DB, không tua tốt).

## R6. Xử lý kịch bản: .txt, .md, .skt

- **Decision** 🔧: một bộ phân tích theo định dạng, đầu ra là danh sách đoạn văn bản "nói được":
  1. Kiểm tra: đuôi `.txt/.md/.skt`, ≤ 2 MB, **UTF-8 hợp lệ** (BOM được bỏ), không rỗng, không chứa byte nhị phân.
  2. `.md`: bóc ký hiệu (tiêu đề, danh sách, nhấn mạnh, liên kết, khối mã bị bỏ) bằng bộ phân tích Markdown.
  3. `.skt` (và `.srt`): coi là văn bản; nhận diện và bỏ dòng số thứ tự + dòng mốc thời gian
     (`HH:MM:SS,mmm --> HH:MM:SS,mmm`), thẻ `<...>`/`{...}`. Mốc thời gian bị bỏ qua (spec, Assumptions).
  4. Chuẩn hóa NFC, gộp khoảng trắng, loại emoji và URL dài (đã khuyến nghị ở `docs/fpt-ai-voice-guide.md` §6).
  5. Tách câu bằng `Intl.Segmenter('vi', 'sentence')` kèm quy tắc bổ sung cho dấu ba chấm, viết tắt, số thập phân;
     gộp câu ngắn thành đoạn ≤ `maxCharsPerSegment` (mặc định 400, luôn ≤ giới hạn nhà cung cấp, vd 5.000 FPT Speech,
     4.096 OpenAI TTS). **Ranh giới highlight là đoạn** (một hoặc vài câu liền nhau, đã nêu ở Assumptions).
- **Rationale**: Mốc thời gian chính xác theo đoạn đòi hỏi sinh từng đoạn riêng (nhà cung cấp không trả
  mốc thời gian, `docs/fpt-ai-voice-guide.md` §7.4). Đoạn nhỏ cũng cho phép tiếp tục từ chỗ dở và cache chi tiết.
- **Xem trước** (FR-011): API trả danh sách đoạn trước khi chạy; giao diện cho xem.

## R7. Tạo voice: pipeline từng đoạn, ghép, mốc thời gian

- **Decision** 🔧: Với mỗi job:
  1. Với từng đoạn, tính `hash = sha256(userId | providerType | model | voice | speed | format | textNFC)`.
     Có trong `audio_cache` → dùng lại (không gọi nhà cung cấp, không ghi usage). Chưa có → gọi nhà cung cấp
     (song song có giới hạn, mặc định 3 đoạn/job), giải mã về **PCM 24 kHz mono 16-bit** bằng ffmpeg, lưu
     `cache/{hash}.wav`, ghi `usage_records`.
  2. Ghép PCM các đoạn theo thứ tự, chèn khoảng lặng theo dấu câu cuối đoạn (gợi ý ở `docs/fpt-ai-voice-guide.md` §7.2:
     ~380 ms sau `. ! ?`, ~220 ms sau `, ; :`). **Mốc bắt đầu/kết thúc từng đoạn tính bằng số mẫu PCM**, nên chính xác,
     không phụ thuộc bộ mã hóa.
  3. Mã hóa một lần thành **MP3** (mặc định 128 kbps) cho phát và tải về; lưu `voices.timeline` = mảng `{idx, startMs, endMs}`.
- **Rationale**: Đạt SC-004 (lệch ≤ 0,3 s). Bộ đệm theo User + theo nội dung đạt FR-017/SC-008. Giải mã mp3 từng đoạn
  rồi ghép tránh tiếng lách tách do khác tần số/kênh (`docs/fpt-ai-voice-guide.md` §10).
- **Cache theo User, không dùng chung giữa User** 🔧: tránh lộ việc ai đã sinh nội dung nào và tránh tính chi phí
  lẫn giữa cấu hình chung/riêng (Nguyên tắc I, IV). Cấu hình chung/riêng không nằm trong hash vì kết quả âm thanh theo
  (model, voice, speed) là như nhau; tuy nhiên bản ghi usage chỉ phát sinh khi thực sự gọi nhà cung cấp.
- **Phát hiện chặn nội dung** 📘 (`docs/shopaikey-guide.md` §16): lỗi 400 "content management policy" → đoạn `failed`
  không retry; job ghi `failed` kèm danh sách đoạn lỗi.
- **Alternatives**: gửi cả kịch bản một lần rồi căn chỉnh bằng forced alignment (nặng, phức tạp, ngoài phạm vi);
  mã hóa mp3 từng đoạn rồi ghép (lệch do độ trễ bộ mã hóa).

## R8. Lớp nhà cung cấp AI (adapter)

- **Decision** 🔧: giao diện chung `TtsProvider.synthesize({ text, voice, model, speed }) → { audio, mime, units }`
  (`contracts/tts-provider.md`). Phiên bản đầu có ba adapter:

  | Adapter (`type`) | Dịch vụ | Cách chạy | Nguồn |
  | --- | --- | --- | --- |
  | ~~`fpt_speech`~~ *(đã gỡ 2026-11-19: chỉ dùng FPT AI Marketplace)* | FPT.AI Speech `POST {base}/hmi/tts/v5` | Bất đồng bộ: trả link, **polling** có backoff tối đa ~150 s, hoặc callback | 📘 `docs/fpt-ai-voice-guide.md` §3 |
  | `fpt_marketplace` | FPT AI Marketplace `POST {base}/v1/audio/speech` | Đồng bộ, trả nhị phân, `response_format: wav` | 📘/✅ §4 |
  | `shopaikey_openai` | ShopAIKey `POST {base}/tts/openai/speech` | Trả JSON chứa **URL audio** (S3) → tải về | 📘 `docs/shopaikey-guide.md` §11.1 |

  | `shopaikey_minimax` | ShopAIKey `POST {base}/tts/minimax/t2a_v2` | Đồng bộ, audio dạng **hex** trong JSON; lỗi nghiệp vụ nằm trong `base_resp` (HTTP vẫn 200) | ✅ khóa thật 2026-11-19 |

  Gemini TTS của ShopAIKey (§11.2) để giai đoạn sau (đang 503 quá tải khi thử).
- **Xác thực khác nhau**: Marketplace và ShopAIKey dùng `Authorization: Bearer`. (FPT Speech, dùng header `api_key`, đã bị gỡ.)
- **Giọng đọc**: danh sách theo adapter (FPT Speech v5: `banmai, thuminh, leminh, giahuy, myan, lannhi, linhsan`;
  Marketplace theo model: VITs/pro/ultra, **voice không dùng chéo model**; OpenAI TTS: `alloy…shimmer`) lưu ở danh mục trong
  mã, hiển thị ở giao diện; lỗi "voice không hợp lệ" của Marketplace trả danh sách hợp lệ nên được dùng để cập nhật.
- **Lỗi và retry** 🔧: bảng phân loại lỗi dùng chung (xem `contracts/tts-provider.md`): 429/5xx/timeout → thử lại
  có backoff + jitter, tối đa 4 lần; 400/401/403/404 → vĩnh viễn, không thử lại; 403 "quota" → thông báo hết hạn mức;
  400 "policy" → nội dung bị chặn.
- **Đo mức sử dụng**: đơn vị là **số ký tự Unicode** (`[...text].length`). `units_tokens` chỉ điền khi nhà cung cấp trả (TTS
  hiện không trả) → thống kê hiển thị ký tự và không bịa token (Nguyên tắc IV).
  Chi phí ước tính = ký tự × đơn giá / 1.000.000 theo bảng giá **nằm trong cấu hình** (Administrator nhập), mặc định để trống.
- **Alternatives**: một adapter OpenAI-compatible chung cho cả FPT Marketplace và ShopAIKey: hai bên khác endpoint
  (`/v1/audio/speech` trả nhị phân; `/tts/openai/speech` trả URL) nên giữ tách.

## R9. Bảo vệ khỏi SSRF khi người dùng nhập địa chỉ gốc

- **Vấn đề** 🔧: User trong danh sách được phép nhập `baseUrl` riêng, và adapter còn tải file từ URL do nhà cung cấp trả về.
  Nếu không chặn, một User có thể buộc máy chủ gọi vào mạng nội bộ (PostgreSQL, MinIO, metadata hạ tầng).
- **Decision**: mọi lệnh gọi ra ngoài đi qua một lớp `safeFetch`:
  chỉ `https` (cho phép `http` khi biến `ALLOW_INSECURE_PROVIDER_URLS=true` dùng ở dev), phân giải DNS rồi **từ chối địa chỉ
  loopback, riêng tư, link-local, đa hướng, `169.254.0.0/16`** và tên nội bộ trong Docker; ghim địa chỉ đã kiểm tra khi kết nối
  (chống DNS rebinding); **không theo chuyển hướng** sang đích khác; giới hạn kích thước và thời gian phản hồi.
  Áp dụng cho cả cấu hình chung của Administrator (cùng một lớp, tin tưởng nhiều hơn nhưng vẫn chặn mạng nội bộ).
- **Rationale**: tuân thủ Nguyên tắc II ("chỉ User trong danh sách… máy chủ từ chối") và Nguyên tắc I.

## R10. Truyền log thời gian thực

- **Decision** 🔧: **Server-Sent Events** `GET /api/jobs/{id}/events`, mỗi sự kiện mang `id` = `job_logs.id`.
  Máy chủ truy vấn `job_logs` theo con trỏ mỗi ~1 s (SC-002: ≤ 2 s) và đẩy bản ghi mới, kèm bình luận
  keep-alive mỗi 15 s. Khi kết nối lại, trình duyệt gửi `Last-Event-ID` → **không mất log** (FR-019, edge case mất kết nối).
  Dự phòng: giao diện tự chuyển sang polling `GET /api/jobs/{id}/logs?after=` nếu SSE bị chặn.
- **Rationale**: Đơn giản, không cần LISTEN/NOTIFY hay broker; hoạt động qua Cloudflare Tunnel (SSE được hỗ trợ khi đặt
  `Cache-Control: no-cache`, `Content-Type: text/event-stream`, tắt nén/đệm). Tương lai có thể thay vòng truy vấn
  bằng LISTEN/NOTIFY mà không đổi hợp đồng. ⚠️ xác nhận độ trễ thực qua tunnel trong Spike S4.
- **Alternatives**: WebSocket (cần máy chủ riêng cho Next.js), polling thuần (độ trễ và tải cao hơn).

## R11. Đồng bộ văn bản với audio khi phát

- **Decision** 🔧: ở client, `HTMLAudioElement` + `requestAnimationFrame`; mỗi khung hình đọc `audio.currentTime`, tìm đoạn đang đọc
  bằng **tìm nhị phân** trên `timeline`, bỏ qua nếu không đổi; đổi đoạn → thêm lớp highlight và `scrollIntoView({block:'center'})`
  có điều kiện (không giật nếu người dùng đang tự cuộn). Sự kiện `seeked`/`timeupdate` cập nhật khi tua; bấm vào đoạn → đặt
  `currentTime = startMs/1000`.
- **Rationale**: đạt SC-004/SC-005 (≤ 0,3 s; ≤ 0,5 s); `Range` bắt buộc ở proxy audio để tua chính xác.

## R12. Tìm kiếm, lọc, sắp xếp Project

- **Decision** 🔧: cột sinh `search_text` = `immutable_unaccent(lower(name || ' ' || description))`, chỉ mục GIN `pg_trgm`; từ khóa cũng
  được chuẩn hóa bằng cùng hàm rồi `ILIKE`. Lưu ý: `unaccent` gốc của Postgres chỉ ở mức STABLE nên không dùng được trực tiếp trong cột sinh
  hoặc chỉ mục; migration phải tạo hàm bọc `immutable_unaccent` khai báo IMMUTABLE. ⚠️ Cần kiểm thử riêng việc "đ/Đ" được đổi thành "d"
  (ví dụ "đường", "Đức"); nếu chưa, hàm bọc phải thay thêm. Lọc theo `provider_type` và theo trạng thái tổng hợp (`has_running`, `has_failed`, `no_jobs`) tính từ
  bảng job; sắp xếp theo `name`, `created_at`, `updated_at`, `voice_count` (đếm sẵn bằng cột đếm cập nhật trong cùng giao dịch hoặc
  truy vấn tổng hợp có chỉ mục). Phân trang theo trang (offset) kèm giới hạn kích thước trang.
- **Rationale**: SC-007 (200 Project < 1 s) dễ đạt với chỉ mục.

## R13. Giao diện

- **Decision** 🔧: Next.js (App Router) + Tailwind CSS + shadcn/ui. Cài theme bằng lệnh registry của shadcn trỏ tới
  `https://tweakcn.com/themes/cmmdxhg6d000804l5f6xlcbh3` (dạng `npx shadcn add <url registry của tweakcn>`; ⚠️ URL registry chính xác kiểm tra
  ở task khởi tạo, Spike S6). Biểu đồ Dashboard dùng thành phần Chart của shadcn. Quản lý dữ liệu phía client: TanStack Query.
  Bảng danh sách: shadcn Table + chọn nhiều + hộp xác nhận. Giao diện tiếng Việt (chuỗi tập trung, không rải trong thành phần).

## R14. Triển khai

- **Decision** 🔧: Docker Compose gồm `postgres`, `minio`, `migrate` (một lần), `web`, `worker`, `cloudflared`.
  **Chỉ** `cloudflared` có đường ra Internet; `web` lắng nghe trong mạng Docker nội bộ và tunnel trỏ `http://web:3000`;
  `postgres`/`minio` không công bố cổng ra host trong cấu hình production. Volume bền cho `postgres` và `minio`.
  Bí mật qua file `.env` không commit (`.env.example` có cấu trúc, không có giá trị thật). Ảnh `worker` cài `ffmpeg`.
  Tên miền được gắn trong bảng điều khiển Cloudflare Zero Trust (Public Hostname → `http://web:3000`) hoặc cấu hình tunnel.
- **Sao lưu** 🔧: tài liệu hóa lệnh sao lưu `pg_dump` và đồng bộ bucket MinIO (ngoài phạm vi tự động hóa phiên bản đầu).
- **Tiếp tục sau khởi động lại**: `restart: unless-stopped`; worker dọn job treo lúc khởi động (R3).

## R15. Kiểm thử

- **Decision** 🔧: **Vitest** (đơn vị + tích hợp với Postgres và MinIO thật chạy bằng Docker Compose của test), **Playwright** (E2E
  các user story), **máy chủ giả nhà cung cấp** (HTTP mock chạy trong kiểm thử) cho mọi adapter — kiểm tra thành công, async
  polling, 429/5xx, 403 hết quota, 400 chặn nội dung, chậm/timeout (Nguyên tắc V). Một bộ kiểm thử "cô lập dữ liệu" gọi mọi
  endpoint bằng User B với tài nguyên của User A và kỳ vọng 404.

## R16. Hạn mức lưu trữ và cài đặt hệ thống

- **Decision** 🔧: bảng `system_settings` (khóa/giá trị) giữ `max_file_bytes` (2 MB), `user_quota_bytes` (500 MB), `max_concurrent_jobs`,
  `max_jobs_per_user`. `users.storage_used_bytes` được cập nhật trong cùng giao dịch khi thêm/xóa file, audio cache, voice, avatar;
  một công việc định kỳ đối soát với tổng thực tế. Kiểm tra ở máy chủ trước khi nhận file và trước khi worker ghi audio mới.

## R17. Xóa dữ liệu

- **Decision** 🔧: Xóa Project/Job/Voice: dừng job → xóa bản ghi DB bằng cascade → xóa đối tượng MinIO theo tiền tố/khóa.
  Xóa User: đặt `status = 'deleting'` (chặn đăng nhập), dừng job, xóa MinIO `users/{uid}/`, rồi xóa bản ghi; `usage_records.user_id`
  và `project_id` được đặt NULL (giữ số liệu thống kê tổng hợp ẩn danh theo spec). Công việc xóa là job pg-boss **idempotent, thử lại**
  tới khi không còn dữ liệu mồ côi (edge case "xóa thất bại giữa chừng").

---

## Rủi ro và Spike (phải làm sớm)

| ID | Việc cần thử thật | Vì sao | Khi nào |
| --- | --- | --- | --- |
| S1 | Gọi thật 3 adapter với cùng một câu tiếng Việt; nghe thử chất lượng; ghi tốc độ, định dạng, kích thước | Chất lượng tiếng Việt và hành vi thật chưa kiểm chứng (`docs/*` §12/§21) | Trước adapter |
| S2 | FPT Speech: link `async` trả gì trước khi sẵn sàng; cấu trúc callback | Chưa tài liệu hóa | Cùng S1 |
| S3 | Marketplace: `speed` hợp lệ, hỗ trợ `mp3`, giới hạn ký tự/lần | Chưa kiểm chứng | Cùng S1 |
| S4 | SSE qua Cloudflare Tunnel: độ trễ và việc đệm | SC-002 ≤ 2 s | Khi làm log thời gian thực |
| S5 | Better Auth: email+mật khẩu, vai trò, khóa tài khoản, giới hạn tốc độ bền | Chọn thư viện dựa trên hiểu biết, chưa chạy | Task khởi tạo |
| S6 | Cài theme tweakcn vào shadcn/ui | URL registry chưa kiểm tra | Task khởi tạo |
| S7 | Đoạn tối ưu (độ dài) cho chất lượng/ngữ điệu và số lần gọi | Ảnh hưởng chi phí và chất lượng | Sau S1 |

Không có mục nào chặn việc thiết kế; mọi rủi ro đều có phương án dự phòng hoặc được cô lập sau một giao diện.
