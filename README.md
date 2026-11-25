# Sub Maker

**Sub Maker** là ứng dụng web nhiều người dùng để **chuyển kịch bản/phụ đề thành giọng đọc AI** (text-to-speech). Mỗi người dùng quản lý các
**Project**, tải lên kịch bản (`.txt`, `.md`, `.srt`), chọn nhà cung cấp AI và giọng đọc, rồi hệ thống tạo ra **một file voice hoàn chỉnh (MP3)**
chạy ngầm ở phía máy chủ. Khi nghe lại, văn bản được **làm nổi bật đúng câu đang đọc** và bấm vào câu nào là phát từ câu đó.

Giao diện hoàn toàn bằng tiếng Việt, dùng được trên điện thoại, máy tính bảng và máy tính.

---

## Mục lục

1. [Tính năng](#1-tính-năng)
2. [Cách hoạt động](#2-cách-hoạt-động)
3. [Kiến trúc](#3-kiến-trúc)
4. [Nhà cung cấp AI](#4-nhà-cung-cấp-ai)
5. [Vai trò, quyền và giới hạn](#5-vai-trò-quyền-và-giới-hạn)
6. [Bảo mật](#6-bảo-mật)
7. [Cài đặt môi trường](#7-cài-đặt-môi-trường)
8. [Chạy ở máy dev](#8-chạy-ở-máy-dev)
9. [Cấu hình (biến môi trường)](#9-cấu-hình-biến-môi-trường)
10. [Kiểm thử](#10-kiểm-thử)
11. [Triển khai production](#11-triển-khai-production)
12. [Cấu trúc thư mục](#12-cấu-trúc-thư-mục)
13. [Tổng quan API](#13-tổng-quan-api)
14. [Xử lý sự cố thường gặp](#14-xử-lý-sự-cố-thường-gặp)
15. [Trạng thái dự án và hạn chế đã biết](#15-trạng-thái-dự-án-và-hạn-chế-đã-biết)
16. [Tài liệu liên quan](#16-tài-liệu-liên-quan)

---

## 1. Tính năng

### Dành cho người dùng

| Nhóm | Chi tiết |
| --- | --- |
| **Tài khoản** | Tự đăng ký (dùng ngay, không cần duyệt), đăng nhập, hồ sơ (tên hiển thị, giới thiệu, ảnh đại diện), đổi mật khẩu. Chính sách mật khẩu: 10–128 ký tự, không toàn chữ số, không thuộc danh sách mật khẩu phổ biến. |
| **Project** | Tạo / xem / sửa / xóa (một hoặc nhiều cùng lúc, có hộp xác nhận nêu số lượng và hậu quả). **Tìm kiếm không dấu** (gõ `lich su` ra "Lịch sử"), sắp xếp, lọc theo nhà cung cấp và trạng thái tiến trình, phân trang; bộ lọc nằm trên URL nên làm mới trang vẫn giữ. |
| **Kịch bản** | Tải `.txt`, `.md` (Markdown, giữ đúng thứ tự đoạn), `.srt` (phụ đề SubRip chuẩn; đuôi riêng `.skt` đã bỏ); tối đa 2 MB mỗi tệp (Admin chỉnh được); phải là UTF-8. Xem trước các đoạn sẽ đọc trước khi tạo voice; với `.srt` có thêm tab **Cue và mốc thời gian** (phân trang) kèm cảnh báo chuẩn hóa (mốc ngược, chồng lấn, cue chỉ có ♪/[Music]…). |
| **Voice khớp mốc phụ đề** | Với `.srt` có mốc, hộp thoại "Tạo voice" bật sẵn **Khớp mốc thời gian phụ đề**: số thứ tự và mốc không được đọc, các cue cùng một câu được ghép đọc liền (**Ghép cue cùng câu**, tắt được), mỗi câu được đặt đúng mốc bắt đầu của cue. Cue đọc dài hơn khe thì mượn khoảng nghỉ liền sau → nén ≤ 1,25× → cue kế trượt nhẹ (≤ 0,5 giây, tự bù). Phụ đề dài chia **phần ~10 phút** tại khoảng nghỉ lớn nhất rồi ghép về đúng mốc tuyệt đối thành **một** voice; tiếp tục không tạo lại đoạn đã xong. Có **ước tính** (ký tự, số lần gọi, thời lượng, dung lượng, thời gian xử lý, tiền nếu đã có đơn giá) trước khi bắt đầu. Chi tiết cài đặt: `docs/operations.md` §10. |
| **Giao diện** | **Sáng / Tối / Theo hệ thống** (nút ở mọi màn hình, kể cả đăng nhập; ghi nhớ theo trình duyệt và tài khoản; viền ô nhập tương phản ≥ 3:1), **Tiếng Việt / English** (mặc định tiếng Việt; lỗi API, định dạng ngày/số theo ngôn ngữ), font **Be Vietnam Pro** (đủ bộ ký tự tiếng Việt). |
| **Tạo voice** | Chọn **model, giọng đọc và tốc độ** trong hộp thoại "Tạo voice". Chạy **nền**: đóng trình duyệt, tắt máy vẫn chạy tiếp; worker khởi động lại cũng tự phục hồi. |
| **Theo dõi** | Nhật ký chi tiết **theo thời gian thực** (SSE; tự chuyển sang hỏi định kỳ nếu mất kết nối), thanh tiến độ, danh sách đoạn lỗi, thanh "tiến trình đang chạy" ở đầu trang. Nhiều tab/thiết bị cùng thấy một log. |
| **Quản lý tiến trình** | **Dừng**, **tiếp tục** (bỏ qua các đoạn đã xong), **chạy lại** (tạo tiến trình mới; đoạn trùng được lấy từ cache, không tốn phí lặp), **sửa thiết lập** (model/giọng/tốc độ khi đã dừng hoặc lỗi), xóa một hoặc nhiều. |
| **Nghe voice** | Trình phát có tua, tốc độ phát, âm lượng, tải `.mp3`; **highlight đúng câu đang đọc**, bấm câu để phát từ đó, tự cuộn theo câu đang đọc. |
| **Video Overlay** | Tab riêng trong mỗi Project: xuất video **chỉ có chữ phụ đề** chạy khớp voice, để chèn đè lên video chính trong CapCut, Premiere, DaVinci Resolve, After Effects. Nguồn là voice của Project hoặc tệp `.mp3`/`.wav`/`.m4a` tải lên (≤ 100 MB), cùng kịch bản `.srt` có mốc. Khung 9:16, 16:9, 1:1; phông xanh lá, xanh dương, đen (`.mp4`) hoặc **nền trong suốt** (`.mov` ProRes 4444, `.webm` VP9). 5 phông chữ đủ tiếng Việt, viền, bóng, hộp nền, vị trí; 13 hiệu ứng xuất hiện, 3 cách biến mất, chế độ theo câu, theo từng từ và karaoke (nhịp từng từ là **ước lượng**). **Xem trước ngay trong trình duyệt** bằng cùng bộ vẽ với video xuất ra; cấu hình tự lưu. Xuất chạy nền, có tiến độ, nhật ký, dừng, chạy lại, dùng lại cấu hình, xóa nhiều mục. Vận hành: `docs/operations.md` §11. |
| **Dashboard** | Số Project/voice, tổng thời lượng, ký tự đã gửi tới AI (theo ngày, theo nhà cung cấp, tách cấu hình chung/riêng), chi phí ước tính, dung lượng đã dùng so với hạn mức, lọc theo khoảng ngày. |
| **Cấu hình AI riêng** | Người dùng được Admin cho phép có thể nhập base URL/khóa API riêng để thay cho cấu hình chung (chi phí do tài khoản đó chịu). |

### Dành cho Administrator

- **Quản lý người dùng**: tìm kiếm, khóa / mở khóa (khóa sẽ thu hồi phiên và dừng tiến trình đang chạy), đặt lại mật khẩu, **xóa vĩnh viễn** (xóa toàn bộ dữ liệu của người đó, chỉ giữ thống kê tổng hợp ẩn danh).
- **Cấu hình AI chung**: base URL, khóa API, model/giọng mặc định, giá mỗi 1 triệu ký tự (để ước tính chi phí), kiểm tra kết nối.
- **Danh sách người dùng được dùng cấu hình AI riêng** (mặc định người mới **không** nằm trong danh sách).
- **Thống kê hệ thống**: tổng toàn hệ thống và từng người (Project, voice, ký tự, chi phí, dung lượng, hoạt động gần nhất), tách chung/riêng, sắp xếp được.
- **Cài đặt hệ thống**: kích thước tệp tối đa, hạn mức lưu trữ mỗi người (mặc định 500 MB), số tiến trình chạy đồng thời toàn hệ thống / mỗi người, số đoạn gọi AI song song.
- Administrator **chỉ xem thống kê và quản lý tài khoản**, không có đường nào xem nội dung Project của người dùng.

---

## 2. Cách hoạt động

```
Kịch bản (.txt/.md/.srt)
   │  ① phân tích: giải mã UTF-8, chuẩn hóa ký tự, tách đoạn (≤ 400 ký tự, tách câu biết viết tắt tiếng Việt)
   ▼
Danh sách đoạn ──② mỗi đoạn: tra cache → gọi nhà cung cấp (thử lại khi lỗi tạm thời) → WAV
   │                       (3 đoạn song song mặc định; đoạn đã có trong cache thì không gọi lại, không tính phí)
   ▼
③ giải mã về PCM 24 kHz mono → ghép theo mốc mẫu CHÍNH XÁC, chèn quãng nghỉ theo dấu câu
   (380 ms sau . ! ? …, 220 ms sau , ; :, 300 ms khi không có dấu)
   ▼
④ mã hóa MP3 (ffmpeg) + lưu MinIO + ghi timeline [{idx, startMs, endMs}] cho từng đoạn
   ▼
Trình phát dùng timeline để highlight câu đang đọc
```

Những điểm đáng chú ý:

- **Timeline chính xác theo số mẫu** (không ước lượng): highlight khớp đoạn đang đọc, kiểm thử E2E đối chiếu theo `currentTime` của trình duyệt. Video overlay dùng lại đúng các mốc này.
- **Cache theo người dùng**: khóa cache = `sha256(user | nhà cung cấp | model | giọng | tốc độ | định dạng | văn bản)`. Đổi một câu trong kịch bản chỉ tốn tiền cho câu đó. Cache không bao giờ dùng chung giữa các người dùng.
- **Phân loại lỗi nhà cung cấp**: lỗi tạm thời (timeout, 429, 5xx) thử lại tối đa 4 lần với backoff mũ + jitter, tôn trọng `Retry-After`; lỗi vĩnh viễn (sai khóa, hết hạn mức, sai giọng, nội dung bị chặn) **không thử lại**. Nội dung bị chặn chỉ làm hỏng đúng đoạn đó; các đoạn khác vẫn chạy rồi job báo lỗi kèm danh sách đoạn.
- **Bền vững**: tiến trình có heartbeat; worker chết giữa chừng thì bộ quét đánh dấu "Bị gián đoạn" rồi tự xếp hàng lại, bỏ qua đoạn đã xong. Hàng đợi nằm trong PostgreSQL (pg-boss) nên không mất việc khi khởi động lại.
- **Kiểm soát đồng thời**: giới hạn số tiến trình chạy cùng lúc toàn hệ thống và mỗi người (khóa tư vấn PostgreSQL để không vượt giới hạn khi nhiều worker).
- **Ghi nhận usage theo lần gọi thật**: mỗi lần gọi nhà cung cấp ghi số ký tự thực gửi; lần dùng lại từ cache **không** ghi. Token chỉ hiển thị khi nhà cung cấp trả về (không bịa số); chi phí ước tính = ký tự × giá cấu hình, để trống khi chưa cấu hình giá.

---

## 3. Kiến trúc

```
Trình duyệt ──HTTPS──► Cloudflare ──► cloudflared ──► web (Next.js) ──► PostgreSQL (dữ liệu + hàng đợi pg-boss)
                                                          │  ▲                ▲
                                                          │  └── SSE log ─────┤
                                                          ▼                   │
                                                        MinIO (S3)        worker (tsx)
                                                  kịch bản · voice · cache   ├─ tạo voice (ffmpeg)
                                                  avatar · video overlay     ├─ xuất video overlay (tiến trình con riêng)
                                                  (bucket riêng tư)          ├─ xóa người dùng
                                                                             ├─ bộ quét tiến trình treo
                                                                             └─ đối soát dung lượng (hằng ngày)
                                                                                     │
                                                                                     ▼
                                                                  Nhà cung cấp AI (FPT AI Marketplace, ShopAIKey)
```

- **Một repo, hai tiến trình**: `web` (giao diện + API route handlers) và `worker` (xử lý hàng đợi). Cả hai chạy từ cùng mã nguồn.
- **Không cổng nào mở ra Internet** ngoài tunnel: PostgreSQL và MinIO chỉ nằm trong mạng Docker nội bộ; file audio/kịch bản chỉ phát qua proxy có kiểm tra quyền (hỗ trợ `Range` để tua).
- **Mọi API** đi qua bộ bọc `route()` (kiểm tra `Origin` chống CSRF + ánh xạ lỗi chuẩn) và `requireUser`/`requireAdmin`; truy cập tài nguyên của người khác trả **404** như thể không tồn tại.

### Công nghệ

| Lớp | Công nghệ |
| --- | --- |
| Giao diện | Next.js 16 (App Router, Turbopack) · React 19 · TypeScript (strict) · Tailwind CSS 4 · shadcn/ui (theme tweakcn) · TanStack Query · Recharts |
| Xác thực | Better Auth (email + mật khẩu, phiên cookie, giới hạn tốc độ trong CSDL) |
| Dữ liệu | PostgreSQL 16 (`unaccent`, `pg_trgm`) · Drizzle ORM + drizzle-kit migrations |
| Hàng đợi | pg-boss (trong PostgreSQL) |
| Lưu trữ | MinIO / S3 (`@aws-sdk/client-s3`) |
| Âm thanh | ffmpeg (giải mã, ghép, mã hóa MP3 có tag LAME/Xing) |
| Video overlay | Canvas 2D dùng chung cho xem trước (trình duyệt) và xuất (`@napi-rs/canvas`), mã hóa bằng ffmpeg (H.264, ProRes 4444, VP9) |
| Kiểm thử | Vitest (unit / integration / contract / isolation) · Playwright (desktop + mobile 375 px) |
| Triển khai | Docker Compose · Cloudflare Tunnel |

---

## 4. Nhà cung cấp AI

| Loại (`type`) | Dịch vụ | Cách gọi | Trạng thái kiểm chứng |
| --- | --- | --- | --- |
| `fpt_marketplace` | FPT AI Marketplace | `POST /v1/audio/speech`, Bearer, trả WAV nhị phân; 3 model (`FPT.AI-VITs`, `FPT.TTS-pro`, `FPT.TTS-ultra`), giọng không dùng chéo model; `speed` 0,25–4 | ✅ Chạy trọn đường với khóa thật |
| `shopaikey_minimax` | ShopAIKey → MiniMax TTS | `POST /tts/minimax/t2a_v2`, Bearer, audio dạng hex trong JSON, lỗi nghiệp vụ nằm trong `base_resp`; 18 giọng tiếng Việt, 6 model (`speech-02-hd` mặc định); `speed` 0,5–2 | ✅ Chạy trọn đường với khóa thật |
| `shopaikey_openai` | ShopAIKey → OpenAI TTS | `POST /tts/openai/speech`, Bearer, trả JSON chứa URL audio → tải về qua `safeFetch` | ⚠️ Chỉ kiểm thử bằng máy chủ giả; khóa thử nghiệm thuộc group không có kênh OpenAI TTS |

Mỗi adapter cài giao diện `TtsProvider` chung; danh mục model/giọng/tốc độ nằm ở `src/lib/providers/catalog.ts`. Thêm nhà cung cấp mới =
viết một adapter + mục catalog + bộ kiểm thử hợp đồng dùng lại `tests/contract/adapter-suite.ts`.

**Cấu hình khi tạo tiến trình**: nếu người dùng được phép dùng cấu hình riêng và đã bật → dùng cấu hình riêng; nếu không → dùng cấu hình chung; nếu không có cả hai → báo "chưa cấu hình nhà cung cấp". Lỗi của cấu hình riêng **không** tự chuyển sang cấu hình chung (tránh dùng ngầm tiền của hệ thống).

Chi tiết kiểm chứng và số liệu thực tế: [docs/provider-spikes.md](docs/provider-spikes.md).

---

## 5. Vai trò, quyền và giới hạn

| | Người dùng | Administrator |
| --- | --- | --- |
| Nguồn tài khoản | Tự đăng ký | Tạo/đồng bộ lúc khởi động từ `ADMIN_EMAIL` + `ADMIN_PASSWORD` |
| Dữ liệu Project/voice/log | Chỉ của mình | **Không xem được** (chỉ thống kê tổng hợp) |
| Trang `/admin/*` | 404 | Có |
| Cấu hình AI | Riêng (nếu được phép) | Chung + quản lý danh sách được dùng riêng |

Giới hạn mặc định (Administrator chỉnh trong **Quản trị → Cài đặt hệ thống**, có hiệu lực ngay):

| Giới hạn | Mặc định |
| --- | --- |
| Kích thước mỗi tệp kịch bản | 2 MB |
| Hạn mức lưu trữ mỗi người (kịch bản + voice + cache + avatar + video overlay + âm thanh tải lên) | 500 MB |
| Tiến trình chạy đồng thời toàn hệ thống / mỗi người | 3 / 2 |
| Số đoạn gọi AI song song trong một tiến trình | 3 |
| Xuất video overlay: toàn hệ thống / mỗi người (chờ hoặc chạy) | 1 / 2 |
| Thời lượng voice để xuất video: phông màu / nền trong suốt | 60 phút / 10 phút |
| Đăng nhập / đăng ký | 5 lần mỗi phút / 5 lần mỗi giờ (theo IP) |

---

## 6. Bảo mật

Các ràng buộc này nằm trong "hiến pháp" dự án (`.specify/memory/constitution.md`) và được kiểm thử tự động:

- **Cô lập dữ liệu**: bộ kiểm thử `tests/isolation` đọc `contracts/openapi.yaml` và kiểm tra **mọi thao tác API** — chưa đăng nhập → 401, người khác → 404, người thường vào `/admin/*` → 404. Thao tác mới mà thiếu ca kiểm thử sẽ làm test thất bại.
- **Khóa API nhà cung cấp**: mã hóa AES-256-GCM trong CSDL (`APP_ENCRYPTION_KEY`), **không bao giờ** trả về qua API (chỉ hiện 4 ký tự cuối), không ghi vào log/phản hồi lỗi (`tests/integration/log-secrets.test.ts` quét log, bản ghi, phản hồi API và console).
- **Chống SSRF**: mọi gọi ra nhà cung cấp đi qua `safeFetch` (chỉ HTTPS, chặn dải IP nội bộ/loopback/metadata, kiểm tra lại sau redirect, giới hạn kích thước & thời gian). Production cấm `ALLOW_INSECURE_PROVIDER_URLS`.
- **CSRF**: mọi thao tác ghi kiểm tra `Origin` khớp `APP_URL`. Cookie `HttpOnly`, `SameSite=Lax`, `Secure` ở production.
- **Tiêu đề an toàn**: CSP (chỉ cùng nguồn), `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, HSTS (production).
- **Rà soát tĩnh**: `tests/unit/route-guards.test.ts` bảo đảm mọi route đều bọc `route()`, có `requireUser`/`requireAdmin`, và không nhận `ownerId` từ client.
- **Dựng hình video overlay**: chạy trong tiến trình con chỉ có biến môi trường tối thiểu (không có CSDL, MinIO hay khóa API); chữ phụ đề chỉ đi vào lệnh vẽ chữ, không vào tham số ffmpeg; tệp âm thanh tải lên bị ép bộ tách theo đuôi và chỉ được đọc từ tệp trên đĩa.
- **Xóa dữ liệu**: mọi thao tác xóa đều có hộp xác nhận; xóa người dùng xóa sạch dữ liệu (CSDL + MinIO), giữ thống kê ẩn danh.

---

## 7. Cài đặt môi trường

Yêu cầu: **Node.js ≥ 22.12** và npm, **Docker** (PostgreSQL + MinIO khi phát triển; toàn bộ stack khi deploy), `ffmpeg` (chỉ khi chạy worker trực tiếp trên máy).

Trên **Linux**, script sau kiểm tra và cài phần còn thiếu (docker + compose v2, curl, jq, git, ffmpeg, nvm, node, yarn):

```bash
./scripts/setup-env.sh --check           # chỉ kiểm tra, không cài gì
./scripts/setup-env.sh                   # kiểm tra → hỏi xác nhận → cài
./scripts/setup-env.sh --yes --project   # không hỏi, cài xong chạy luôn `npm ci`
```

Tùy chọn: `--e2e` (cài trình duyệt Playwright), `--no-yarn`, `--skip-docker`, `--skip-ffmpeg`, `--node-major N`. Hỗ trợ apt, dnf/yum, pacman, zypper;
đã chạy thử trên Ubuntu 24.04 (root và người dùng thường dùng sudo) và Fedora 41. Dự án dùng **npm** (`package-lock.json`); yarn chỉ được cài để tiện.
Trên Windows hãy dùng WSL2.

---

## 8. Chạy ở máy dev

```bash
npm install
cp .env.example .env     # điền các giá trị (xem mục 9; KHÔNG commit .env)
docker compose --env-file .env -f docker/compose.dev.yml up -d   # PostgreSQL + MinIO, chỉ bind 127.0.0.1
npm run dev              # web → http://localhost:3000 (tự migration, tạo bucket, tạo Administrator)
npm run worker:dev       # worker (terminal khác)
```

Windows PowerShell: dùng `Copy-Item .env.example .env` thay cho `cp`.

Sau đó:

1. Mở http://localhost:3000/login, đăng nhập bằng `ADMIN_EMAIL` / `ADMIN_PASSWORD` trong `.env`.
2. **Quản trị → Cấu hình AI chung**: chọn loại nhà cung cấp, nhập base URL (mặc định điền sẵn) và khóa API, bấm **Kiểm tra kết nối**, lưu.
3. Đăng ký một tài khoản thường (hoặc dùng luôn admin), tạo Project, tải kịch bản, bấm **Tạo voice**.

Chưa có khóa thật? Máy chủ nhà cung cấp giả `mock-provider/server.ts` mô phỏng các kịch bản (thành công, chậm, 429, 5xx, lỗi xác thực…); các bộ kiểm thử E2E dùng nó.

---

## 9. Cấu hình (biến môi trường)

Mẫu đầy đủ ở `.env.example`. Ứng dụng kiểm tra các biến bằng zod khi khởi động và báo rõ biến nào sai.

| Biến | Bắt buộc | Ý nghĩa |
| --- | --- | --- |
| `DATABASE_URL` | ✔ | Chuỗi kết nối PostgreSQL |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` | ✔ | MinIO/S3. Bucket riêng tư, ứng dụng tự tạo khi khởi động |
| `APP_ENCRYPTION_KEY` | ✔ | 32 byte mã hóa base64 (`openssl rand -base64 32`) — mã hóa khóa API nhà cung cấp trong CSDL |
| `AUTH_SECRET` | ✔ | Chuỗi ngẫu nhiên ≥ 32 ký tự — ký phiên đăng nhập |
| `APP_URL` | ✔ | Địa chỉ công khai của ứng dụng; dùng để kiểm tra `Origin` |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | ✔ | Tài khoản Administrator (mật khẩu ≥ 10 ký tự) |
| `POSTGRES_PASSWORD`, `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD` | compose dev/prod | Khởi tạo PostgreSQL và MinIO trong Docker |
| `CLOUDFLARE_TUNNEL_TOKEN` | production | Token tunnel cho `cloudflared` |
| `ALLOW_INSECURE_PROVIDER_URLS` | không | `true` chỉ khi dev với máy chủ giả dùng `http`. **Production phải `false`** |
| `RATE_LIMIT_SIGNIN_PER_MIN`, `RATE_LIMIT_SIGNUP_PER_HOUR` | không | Giới hạn tốc độ xác thực (mặc định 5 / 5) |
| `SPIKE_FPT_MARKETPLACE_KEY`, `SPIKE_SHOPAIKEY_KEY` | chỉ khi chạy spike | Khóa thật cho `scripts/spike-providers.ts` và test với nhà cung cấp thật |

Đổi `APP_ENCRYPTION_KEY` = các khóa API đã lưu không giải mã được nữa (phải nhập lại); đổi `AUTH_SECRET` = mọi người phải đăng nhập lại.

---

## 10. Kiểm thử

```bash
npm run lint              # ESLint (có luật cấm chuỗi tiếng Việt cứng trong thành phần giao diện)
npm run check:i18n        # chuỗi tiếng Việt cứng ngoài từ điển + từ điển vi/en đủ khóa, cùng giữ chỗ
npx tsc --noEmit          # kiểm tra kiểu
npm test                  # unit + integration + contract   (cần PostgreSQL + MinIO dev đang chạy)
npm run test:isolation    # cô lập dữ liệu cho mọi thao tác OpenAPI
npm run test:e2e          # Playwright desktop + mobile; tự dựng web + worker + nhà cung cấp giả
```

| Bộ test | Nội dung chính |
| --- | --- |
| **unit** | Tách đoạn/Markdown/SRT và cue, đơn vị đọc, đặt mốc/nén/trượt (`placeUnits`, `planParts`), cắt lặng, giới hạn yêu cầu/phút, ghép audio theo mẫu, highlight, bộ dựng hình video overlay (bố cục, hiệu ứng, mốc từng từ, màu), mã hóa, `safeFetch`, ẩn bí mật trong log, máy chủ giả, rà soát route, từ điển vi/en, tương phản viền ô nhập |
| **contract** | Cùng một bộ kịch bản (thành công, 429, 5xx, 401, hết hạn mức, nội dung bị chặn, phản hồi hỏng, timeout, hủy giữa chừng, redirect vào mạng nội bộ…) chạy với **từng adapter** |
| **integration** | API thật trên PostgreSQL/MinIO thật: xác thực, file, job, SSE, pipeline tạo voice, phục hồi sau sự cố, đồng thời, xóa, tìm kiếm, thống kê, cài đặt, đối soát dung lượng, xuất video overlay thật (`.mp4`, `.mov`, `.webm`), hiệu năng (SC-006/007/009), không lộ khóa |
| **isolation** | Mọi đường dẫn OpenAPI: 401 / 404 / quyền admin |
| **e2e** | Đăng ký/đăng nhập, tạo voice trọn đường (UI → API → hàng đợi → worker → nhà cung cấp giả), voice khớp mốc từ `.srt`, nghe & highlight, quản lý/xóa tiến trình, tìm kiếm, chạy nền nhiều tab, dashboard, cài đặt, chọn giọng, Sáng/Tối, đổi ngôn ngữ, font tiếng Việt, tab quản trị, video overlay (xem trước, so khớp xem trước với video, quản lý lần xuất) |

**Kiểm thử với nhà cung cấp thật** (tốn phí nhỏ, mặc định bị bỏ qua):

```bash
# đặt SPIKE_FPT_MARKETPLACE_KEY / SPIKE_SHOPAIKEY_KEY trong .env
npx tsx --env-file=.env scripts/spike-providers.ts          # gọi từng adapter một câu tiếng Việt, lưu file nghe thử vào tmp/spike/
REAL_PROVIDER_TESTS=1 node --env-file=.env node_modules/vitest/vitest.mjs run --project integration tests/integration/real-providers.test.ts
```

---

## 11. Triển khai production

Production chạy bằng Docker Compose (`docker/compose.prod.yml`): `postgres`, `minio`, `migrate` (chạy một lần), `web`, `worker`, `cloudflared`.
**Không dịch vụ nào công bố cổng ra host**; mạng `internal` không có đường ra Internet; truy cập công khai chỉ qua Cloudflare Tunnel.

```bash
./scripts/deploy.sh --init --domain voice.example.com          # lần đầu: tạo .env.production với bí mật ngẫu nhiên
./scripts/deploy.sh --setup-tunnel --domain voice.example.com  # lần đầu: tạo tunnel + DNS qua Cloudflare API (cần jq + API token)
./scripts/deploy.sh                                            # mỗi lần có code mới
```

`deploy.sh` kiểm tra cấu hình → (tùy chọn `--pull`) → **sao lưu PostgreSQL** → **build trước** (build lỗi thì bản đang chạy không bị đụng tới) →
`up -d` (migration chạy trước web/worker) → chờ web khỏe → kiểm tra tunnel đã kết nối → dọn image cũ.

Chi tiết (tạo API token Cloudflare, sao lưu/khôi phục, đổi khóa, xử lý khi nghi lộ khóa, danh sách kiểm tra bảo mật): [docs/operations.md](docs/operations.md).

---

## 12. Cấu trúc thư mục

```
src/
├── app/                    Trang giao diện và Route Handler
│   ├── (auth)/             /login, /register
│   ├── (app)/              /projects, /projects/[id] (+ jobs, voices), /dashboard, /settings
│   ├── (admin)/admin/      users, ai-configs, custom-ai-users, stats, settings
│   └── api/                API (xem mục 13)
├── components/             app · auth · projects · jobs · player · dashboard · admin · settings · shared · ui (shadcn)
├── lib/
│   ├── auth/ api/ security/    xác thực, guard, bọc route, mã hóa, safeFetch, che bí mật
│   ├── db/                     schema Drizzle, migrations, seed
│   ├── providers/              adapter nhà cung cấp, catalog, phân loại lỗi, cấu hình
│   ├── parsing/                giải mã UTF-8, Markdown/SRT, tách đoạn
│   ├── audio/                  giải mã PCM, ghép theo mẫu, mã hóa MP3
│   ├── overlay/                video overlay: cấu hình, mốc, bố cục, hiệu ứng, bộ vẽ dùng chung, dịch vụ
│   ├── projects/ jobs/ voices/ users/ usage/ storage/ player/
│   └── i18n/vi.ts              TOÀN BỘ chuỗi tiếng Việt của giao diện
├── worker/                 Tiến trình nền: tạo voice, xuất video overlay (`render/` là tiến trình con), xóa người dùng, đối soát dung lượng, bộ quét tiến trình treo
└── instrumentation.ts      Khởi động web: migration, tạo bucket, tạo Administrator
mock-provider/              Máy chủ nhà cung cấp AI giả dùng cho kiểm thử
tests/                      unit · integration · contract · isolation · e2e
scripts/                    setup-env.sh · deploy.sh · spike-providers.ts · check-i18n.ts · e2e-up.ts
docker/                     Dockerfile (web, worker), compose.dev.yml, compose.prod.yml
docs/                       operations.md · provider-spikes.md · tài liệu nhà cung cấp
specs/001-voice-sub-projects/   spec, plan, data-model, contracts, quickstart, tasks
```

---

## 13. Tổng quan API

Toàn bộ nằm dưới `/api`, trả JSON; lỗi có dạng `{ error: { code, message, fields? } }` với thông điệp tiếng Việt. Đặc tả đầy đủ:
`specs/001-voice-sub-projects/contracts/openapi.yaml`.

| Nhóm | Điểm cuối |
| --- | --- |
| Xác thực | `/auth/*` (Better Auth: đăng ký, đăng nhập, đăng xuất, phiên) |
| Cá nhân | `GET/PATCH /me`, `/me/avatar`, `POST /me/password`, `/me/ai-config[/{type}[/test]]`, `GET /providers`, `GET /dashboard` |
| Project | `GET/POST /projects`, `GET/PATCH/DELETE /projects/{id}`, `POST /projects/bulk-delete` |
| Kịch bản | `GET/POST /projects/{id}/files`, `GET/DELETE /files/{id}`, `GET /files/{id}/raw`, `GET /files/{id}/cues` (phân trang), `POST /files/{id}/estimate` |
| Tiến trình | `GET/POST /projects/{id}/jobs`, `GET /jobs`, `GET/PATCH/DELETE /jobs/{id}`, `POST /jobs/{id}/stop`, `/resume`, `/rerun`, `POST /jobs/bulk-delete` |
| Log thời gian thực | `GET /jobs/{id}/logs` (phân trang), `GET /jobs/{id}/events` (SSE, hỗ trợ `Last-Event-ID` để nối lại không mất dòng) |
| Voice | `GET /voices/{id}`, `GET /voices/{id}/audio` (hỗ trợ `Range`, tải về) |
| Video Overlay | `GET/PUT /projects/{id}/overlay`, `GET …/overlay/timeline`, `GET/POST …/overlay/audios`, `GET/POST …/overlay/jobs`, `GET /overlay/jobs/{id}`, `POST …/stop`, `/rerun`, `GET …/video`, `POST /overlay/jobs/bulk-delete`, `GET /overlay/audios/{id}/stream`, `POST /overlay/audios/bulk-delete` (đặc tả: `specs/005-subtitle-video-overlay/contracts/`) |
| Quản trị | `/admin/users[/{id}[/reset-password]]`, `/admin/ai-configs[/{type}[/test]]`, `/admin/custom-ai-users[/{id}]`, `/admin/stats`, `/admin/settings` |

Mô hình dữ liệu (rút gọn): `users` · `ai_provider_configs` (chung/riêng, khóa đã mã hóa) · `projects` · `subtitle_files` · `segments` · `voice_jobs` ·
`job_segments` · `job_logs` · `voices` (kèm timeline) · `audio_cache` · `usage_records` (ẩn danh khi xóa người dùng) · `overlay_configs` · `overlay_audios` · `overlay_jobs` · `overlay_job_logs` · `system_settings`. Chi tiết:
`specs/001-voice-sub-projects/data-model.md`.

---

## 14. Xử lý sự cố thường gặp

| Hiện tượng | Nguyên nhân / cách xử lý |
| --- | --- |
| "Chưa có cấu hình nhà cung cấp AI khả dụng" | Administrator chưa nhập cấu hình chung (hoặc đã tắt). Vào **Quản trị → Cấu hình AI chung**. |
| Tiến trình mãi ở "Đang chờ" | Worker chưa chạy (`npm run worker:dev` hoặc dịch vụ `worker`), hoặc đã đạt giới hạn tiến trình đồng thời. |
| Lỗi "Khóa API không hợp lệ" ngay đoạn đầu | Khóa sai loại nhà cung cấp hoặc đã bị thu hồi. Dùng **Kiểm tra kết nối** trong trang cấu hình. |
| ShopAIKey báo 404/503 "No available channel" | Khóa thuộc group không có model đó. Đổi group ở shopaikey.com → API Keys, hoặc dùng loại MiniMax nếu khóa dùng được. |
| Đoạn bị "Nội dung bị từ chối" | Nhà cung cấp chặn theo chính sách an toàn; sửa câu đó rồi chạy lại (các đoạn đã xong được dùng lại từ cache). |
| 403 "FORBIDDEN_ORIGIN" khi gọi API | `APP_URL` không khớp địa chỉ đang truy cập (kể cả `http`/`https`, cổng). |
| Không đăng nhập được sau nhiều lần sai | Giới hạn tốc độ theo IP; đợi một lúc. |
| Hết dung lượng ("QUOTA_EXCEEDED") | Xóa bớt voice/Project, hoặc Administrator tăng hạn mức. |
| Xuất video báo "Máy chủ tạm hết chỗ" | Đĩa tạm của worker đầy. Video nền trong suốt `.mov` cần nhiều chỗ nhất (khoảng 120–230 MB mỗi phút). Xem [docs/operations.md](docs/operations.md) §11. |
| Cần đặt lại mật khẩu | v1 chưa có email: Administrator đặt lại ở Quản trị → Người dùng; quên mật khẩu admin thì đổi `ADMIN_PASSWORD` rồi khởi động lại. |

---

## 15. Trạng thái dự án và hạn chế đã biết

Phiên bản đầu (v1) đã hoàn thiện theo đặc tả: 9 user story, toàn bộ test tự động xanh. Các giới hạn và việc chưa làm:

- **Không có xác minh email / quên mật khẩu tự phục vụ** (Administrator đặt lại mật khẩu).
- **Chưa tính phí người dùng**: hệ thống chỉ ghi nhận usage và ước tính chi phí; thanh toán theo mức dùng thuộc giai đoạn sau.
- **Luồng SSE qua Cloudflare Tunnel chưa kiểm chứng trên tunnel thật** (đã đặt tiêu đề chống đệm và keep-alive; nếu bị đệm, giao diện tự chuyển sang hỏi định kỳ). Cách kiểm tra: [docs/operations.md](docs/operations.md) §3.
- `--setup-tunnel` của `deploy.sh` chưa chạy với tài khoản Cloudflare thật (đã kiểm tra bằng phản hồi API giả).
- Adapter ShopAIKey OpenAI TTS chưa kiểm chứng bằng khóa thật; Gemini TTS của ShopAIKey chưa có adapter.
- Chưa có chính sách tự xóa cache audio (cache chỉ bị dọn khi xóa tiến trình/Project/người dùng; vượt hạn mức thì chặn tạo mới).
- **Video overlay**: nhịp từng từ là ước lượng theo độ dài chữ (chưa đo độ chính xác bằng nhận dạng giọng nói); chưa kiểm tay trong CapCut, Premiere, DaVinci Resolve, After Effects; khung xem trước mới so khớp với video trên Chromium. Một lần xuất bị gián đoạn sẽ xuất lại từ đầu. Với hạn mức 500 MB, `.mov` trong suốt chỉ dài được khoảng 2–3,5 phút (dùng `.webm` nếu cần tệp gọn).
- Chất lượng giọng tiếng Việt của từng nhà cung cấp cần nghe thử và chọn theo cảm nhận (mẫu từ spike nằm ở `tmp/spike/`).

---

## 16. Tài liệu liên quan

| Tài liệu | Nội dung |
| --- | --- |
| [specs/001-voice-sub-projects/spec.md](specs/001-voice-sub-projects/spec.md) | Yêu cầu, user story, tiêu chí nghiệm thu |
| [specs/001-voice-sub-projects/plan.md](specs/001-voice-sub-projects/plan.md) | Kế hoạch kỹ thuật, kiến trúc |
| [specs/001-voice-sub-projects/research.md](specs/001-voice-sub-projects/research.md) | Các quyết định kỹ thuật và lý do |
| [specs/001-voice-sub-projects/data-model.md](specs/001-voice-sub-projects/data-model.md) | Mô hình dữ liệu |
| [specs/001-voice-sub-projects/contracts/](specs/001-voice-sub-projects/contracts/) | OpenAPI, sự kiện log SSE, hợp đồng adapter TTS |
| [specs/001-voice-sub-projects/quickstart.md](specs/001-voice-sub-projects/quickstart.md) | Các kịch bản kiểm chứng |
| [specs/001-voice-sub-projects/tasks.md](specs/001-voice-sub-projects/tasks.md) | Danh sách task và trạng thái |
| [specs/005-subtitle-video-overlay/](specs/005-subtitle-video-overlay/) | Video overlay phụ đề: yêu cầu, kế hoạch, quyết định kỹ thuật, hợp đồng, kịch bản kiểm chứng |
| [docs/operations.md](docs/operations.md) | Vận hành production: tên miền, sao lưu, đổi khóa, deploy |
| [docs/provider-spikes.md](docs/provider-spikes.md) | Kết quả kiểm chứng nhà cung cấp bằng khóa thật |
| [docs/fpt-ai-voice-guide.md](docs/fpt-ai-voice-guide.md), [docs/shopaikey-guide.md](docs/shopaikey-guide.md) | Tài liệu tham khảo của nhà cung cấp |
| `.specify/memory/constitution.md` | Các ràng buộc của dự án (bảo mật, cô lập dữ liệu, độ bền tiến trình, tiếng Việt…) |
