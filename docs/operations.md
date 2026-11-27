# Vận hành Sub Maker (production)

Tài liệu cho người triển khai/quản trị hệ thống. Cách dùng ứng dụng nằm ở [README](../README.md); thiết kế nằm ở
[specs/001-voice-sub-projects/](../specs/001-voice-sub-projects/).

## 1. Kiến trúc triển khai

```
Internet ──► Cloudflare ──► cloudflared ──► web:3000 ──► postgres:5432
                                   │            │  └────► minio:9000
                                   │          worker ──► nhà cung cấp AI (FPT.AI, ShopAIKey)
```

| Dịch vụ | Vai trò | Mạng |
| --- | --- | --- |
| `postgres` | Dữ liệu ứng dụng **và** hàng đợi pg-boss | chỉ `internal` |
| `minio` | Lưu kịch bản, voice, cache audio, avatar, video overlay và âm thanh tải lên (bucket riêng tư) | chỉ `internal` |
| `migrate` | Chạy migration một lần rồi thoát | `internal` |
| `web` | Giao diện + API (Next.js standalone) | `internal` + `egress` |
| `worker` | Tạo voice nền, xuất video overlay, dọn dẹp, đối soát dung lượng (có `ffmpeg`) | `internal` + `egress` |
| `cloudflared` | Cổng vào duy nhất từ Internet | `egress` + `internal` |

Mạng `internal` được đặt `internal: true` nên `postgres`/`minio` không có đường ra Internet và **không công bố cổng nào ra host**.
Không có dịch vụ nào dùng `ports:`; kiểm tra bằng `docker compose -f docker/compose.prod.yml config | grep -n ports` (kết quả rỗng).

## 2. Lần triển khai đầu tiên

Cách nhanh (khuyến nghị) — dùng `scripts/deploy.sh` (Linux, macOS hoặc Git Bash trên Windows; cần `docker`, `curl`, và `jq` nếu dùng `--setup-tunnel`):

```bash
./scripts/deploy.sh --init --domain voice.example.com          # tạo .env.production với bí mật ngẫu nhiên
./scripts/deploy.sh --setup-tunnel --domain voice.example.com  # tạo tunnel + DNS qua Cloudflare API (xem §8)
./scripts/deploy.sh                                            # build + khởi động
```

Chi tiết cách dùng script và các lần cập nhật sau: xem **§8**. Nếu muốn làm thủ công:

1. Sao chép `.env.example` thành `.env.production` rồi điền (không commit). Gợi ý sinh giá trị:
   `openssl rand -base64 32` (APP_ENCRYPTION_KEY), `openssl rand -base64 48` (AUTH_SECRET),
   `openssl rand -hex 24` (POSTGRES_PASSWORD — dùng chuỗi URL-an toàn vì nó nằm trong `DATABASE_URL`).
2. Đặt `APP_URL` đúng địa chỉ công khai (ví dụ `https://voice.example.com`). Ứng dụng so khớp `Origin` với giá trị này (chống CSRF).
3. Đặt `ADMIN_EMAIL` và `ADMIN_PASSWORD` (≥ 10 ký tự, không toàn số, không phải mật khẩu phổ biến). Administrator được tạo lúc khởi động;
   đổi `ADMIN_PASSWORD` trong file rồi deploy lại sẽ đồng bộ mật khẩu mới.
4. Giữ `ALLOW_INSECURE_PROVIDER_URLS=false` (compose production đã cố định giá trị này).
5. Chạy:

   ```bash
   docker compose --env-file .env.production -f docker/compose.prod.yml up -d --build
   docker compose --env-file .env.production -f docker/compose.prod.yml ps
   ```

## 3. Gắn tên miền qua Cloudflare Tunnel

1. Cloudflare Zero Trust → **Networks → Tunnels → Create a tunnel** (loại *Cloudflared*). Sao chép **token** vào `CLOUDFLARE_TUNNEL_TOKEN` trong `.env`.
2. Trong tab **Public Hostname** của tunnel: Subdomain/Domain = tên miền của bạn, **Service = `HTTP` → `web:3000`**.
3. `docker compose ... up -d` để `cloudflared` kết nối. Kiểm tra: mở `https://<tên-miền>/login`.
4. Không cần mở cổng trên router/tường lửa. Không bật "Disable chunked encoding" — luồng log SSE cần phản hồi chunked.

### Kiểm tra SSE qua tunnel (spike S4)

Ứng dụng đã đặt sẵn các tiêu đề giúp luồng log không bị đệm: `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`,
`X-Accel-Buffering: no`, và gửi dòng `: keep-alive` mỗi ~15 giây (Cloudflare ngắt kết nối nhàn rỗi sau 100 giây). Trình duyệt tự nối lại
bằng `Last-Event-ID` nên không mất dòng log nào; nếu SSE không chạy được, giao diện tự chuyển sang hỏi định kỳ.

> **Trạng thái: CHƯA XÁC MINH trên tunnel thật** (cần tên miền và tunnel của bạn). Sau khi triển khai, kiểm tra một lần:
>
> 1. Tạo một voice dài (≥ 20 đoạn) rồi mở trang tiến trình; dòng log phải xuất hiện từng dòng trong ≤ 2 giây, không dồn cục.
> 2. Trong DevTools → Network, yêu cầu `.../events` phải ở trạng thái *pending* và nhận sự kiện liên tục (không bị đệm tới khi kết thúc).
> 3. Nếu bị đệm: thử tắt chế độ nén/"Rocket Loader"/"Auto Minify" cho tên miền; ghi kết quả vào mục này.
>
> Kết quả: _chưa có_

## 4. Sao lưu và khôi phục

Dữ liệu nằm ở hai nơi: volume `pgdata` (PostgreSQL) và `miniodata` (MinIO). **Phải sao lưu cả hai** cùng thời điểm gần nhau.

### PostgreSQL

`scripts/deploy.sh` tự sao lưu vào `backups/` (giữ 10 bản mới nhất) trước mỗi lần deploy. Thủ công:

```bash
DC="docker compose --env-file .env.production -f docker/compose.prod.yml"

# Sao lưu (nén, định dạng custom). Dùng bash/Git Bash: PowerShell 5.1 làm hỏng dữ liệu nhị phân khi dùng '>'.
$DC exec -T postgres pg_dump -U submaker -Fc submaker > "backups/manual-$(date +%Y%m%d-%H%M%S).dump"

# Khôi phục (dừng web/worker trước)
$DC stop web worker
$DC exec -T postgres pg_restore -U submaker -d submaker --clean --if-exists < backups/FILE.dump
$DC start web worker
```

### MinIO

Sao lưu bằng cách sao chép volume `miniodata` khi dịch vụ `minio` đã dừng, hoặc dùng `mc mirror` từ một container tạm cùng mạng `internal`:

```powershell
docker compose --env-file .env.production -f docker/compose.prod.yml stop minio
docker run --rm -v submaker_miniodata:/data -v ${PWD}/backup:/backup alpine tar czf /backup/minio-$(Get-Date -Format yyyyMMdd).tgz -C /data .
docker compose --env-file .env.production -f docker/compose.prod.yml start minio
```

Sau khi khôi phục, worker tự đối soát bộ đếm dung lượng mỗi ngày lúc 03:17 (bù chênh lệch giữa MinIO và CSDL, ghi log `reconcile-storage`).

## 5. Khóa bí mật: đổi và xử lý khi nghi lộ

| Khóa | Dùng cho | Hậu quả khi đổi |
| --- | --- | --- |
| `AUTH_SECRET` | Ký phiên đăng nhập | Mọi người dùng phải đăng nhập lại. Không mất dữ liệu. |
| `APP_ENCRYPTION_KEY` | Mã hóa khóa API nhà cung cấp trong CSDL (AES-256-GCM) | Các khóa API đã lưu **không giải mã được nữa** → phải nhập lại. |
| `POSTGRES_PASSWORD` / `MINIO_ROOT_*` | Truy cập hạ tầng nội bộ | Đổi trong `.env` **và** trong dịch vụ tương ứng, rồi khởi động lại. |
| `CLOUDFLARE_TUNNEL_TOKEN` | Tunnel | Tạo lại token ở Cloudflare (revoke token cũ). |

**Khi nghi lộ `APP_ENCRYPTION_KEY` hoặc CSDL:**

1. Đổi `APP_ENCRYPTION_KEY` (và `AUTH_SECRET`), khởi động lại `web` và `worker`.
2. **Thu hồi (revoke) toàn bộ khóa API** đã nhập ở nhà cung cấp (FPT.AI, ShopAIKey) và cấp khóa mới — khóa cũ nằm trong CSDL/bản sao lưu được coi là đã lộ.
3. Vào **Quản trị → Cấu hình AI chung** nhập lại khóa mới; yêu cầu người dùng có cấu hình riêng nhập lại ở **Cài đặt → Cấu hình AI**
   (cấu hình đã lưu bằng khóa cũ không giải mã được nên không dùng được; tiến trình dùng cấu hình đó sẽ lỗi cho tới khi nhập lại khóa).
4. Xem lại Quản trị → Người dùng để khóa tài khoản đáng ngờ (khóa tài khoản cũng thu hồi phiên và dừng tiến trình đang chạy).

Khóa API không bao giờ được ghi vào log, phản hồi API hay giao diện (chỉ hiện 4 ký tự cuối); `tests/integration/log-secrets.test.ts` kiểm tra điều này.

## 6. Giám sát và xử lý sự cố

- Xem log: `docker compose -f docker/compose.prod.yml logs -f web worker`.
- **Tiến trình tạo voice bị kẹt** sau khi worker chết: tự phục hồi — worker khởi động lại quét tiến trình mất heartbeat, đánh dấu
  `Bị gián đoạn` rồi xếp hàng lại, bỏ qua các đoạn đã xong.
- **Worker dừng êm** (`docker compose stop worker`): chờ tối đa 60 giây để job đang chạy ghi trạng thái.
- **Quên mật khẩu**: v1 chưa có email; Administrator đặt lại ở Quản trị → Người dùng. Quên mật khẩu Administrator: đổi `ADMIN_PASSWORD` rồi khởi động lại `web`.
- **Hết dung lượng**: chỉnh hạn mức ở Quản trị → Cài đặt hệ thống hoặc mở rộng volume.
- **Cập nhật phiên bản**: `git pull` rồi `docker compose ... up -d --build`; dịch vụ `migrate` áp dụng migration trước khi web/worker khởi động.

## 7. Danh sách kiểm tra bảo mật trước khi mở công khai

- [ ] `docker compose config | grep ports` không có kết quả (không cổng nào công bố ra host).
- [ ] `.env` không nằm trong git; quyền đọc chỉ cho tài khoản vận hành.
- [ ] `APP_URL` là `https://…` đúng tên miền; `ALLOW_INSECURE_PROVIDER_URLS=false`.
- [ ] Đã đổi `ADMIN_PASSWORD` khỏi giá trị mẫu; Cloudflare Access/WAF (tùy chọn) bảo vệ thêm `/admin`.
- [ ] Đã chạy kiểm tra SSE ở mục 3 và ghi kết quả.
- [ ] Đã thử khôi phục bản sao lưu ít nhất một lần.

## 8. Cập nhật code mới bằng `scripts/deploy.sh`

Mỗi lần có code mới (đã chép/`git pull` vào thư mục dự án trên máy chủ):

```bash
./scripts/deploy.sh            # hoặc: ./scripts/deploy.sh --pull  (git pull --ff-only trước khi build)
```

Script làm theo thứ tự và **dừng ngay khi có lỗi**:

1. Kiểm tra `.env.production` (đủ biến, `APP_URL` là `https://`, mật khẩu hợp lệ) và `docker compose config`.
2. Sao lưu PostgreSQL vào `backups/` (bỏ qua ở lần đầu hoặc khi dùng `--skip-backup`).
3. **Build image trước** — nếu build lỗi, container đang chạy không bị đụng tới, bản cũ vẫn phục vụ.
4. `up -d`: dịch vụ `migrate` chạy migration trước, rồi mới tới `web`/`worker`.
5. Chờ `web` khỏe; nếu migration thất bại thì in log và dừng (web/worker không khởi động với CSDL dở dang).
6. Kiểm tra `cloudflared` đã đăng ký kết nối tới Cloudflare (cảnh báo nếu chưa).
7. Dọn image cũ không còn dùng.

Tùy chọn khác: `--no-cache` (build sạch), `--timeout 400` (chờ web lâu hơn), `--env-file FILE`, `--help`.

**Quay lại bản cũ:** chạy lại với code của bản trước (`git checkout <commit>` rồi `./scripts/deploy.sh`). Migration không tự hoàn tác;
nếu bản mới đã đổi cấu trúc CSDL thì khôi phục từ file trong `backups/` (§4) cùng lúc với việc quay lại code.

### Gắn tên miền tự động (`--setup-tunnel`)

Cần **Cloudflare API token** (tạo ở Cloudflare → My Profile → API Tokens → Create Token → *Create Custom Token*) với hai quyền:

- **Account → Cloudflare Tunnel → Edit**
- **Zone → DNS → Edit** (giới hạn vào zone chứa tên miền của bạn)

Tên miền phải đã được thêm vào Cloudflare (nameserver đã trỏ về Cloudflare). Chạy:

```bash
export CLOUDFLARE_API_TOKEN=...    # hoặc để script hỏi (nhập ẩn). Token KHÔNG được lưu vào file.
./scripts/deploy.sh --setup-tunnel --domain voice.example.com
```

Script sẽ: tìm zone → tạo (hoặc dùng lại) tunnel tên `submaker` → đặt Public Hostname `voice.example.com → http://web:3000`
→ tạo bản ghi DNS CNAME (bật proxy) → lưu `CLOUDFLARE_TUNNEL_TOKEN`, `CLOUDFLARE_TUNNEL_ID`, `APP_URL` vào `.env.production`.
Chạy lại an toàn (idempotent). Nếu tên miền đã có bản ghi DNS **không phải của tunnel** (ví dụ bản ghi A), script từ chối ghi đè.
Thêm tên miền phụ thứ hai: sửa Public Hostname trực tiếp trên Cloudflare Zero Trust.

> Lưu ý: luồng `--setup-tunnel` đã được kiểm tra bằng phản hồi API giả, **chưa chạy với tài khoản Cloudflare thật**. Lần đầu hãy theo dõi
> kết quả trên Cloudflare Zero Trust → Networks → Tunnels.

## 9. Font chữ tiếng Việt và giao diện Sáng/Tối (spec 003)

- **Font**: giao diện dùng **Be Vietnam Pro** (có đủ bộ ký tự tiếng Việt; Outfit trước đây chỉ có latin/latin-ext). `next/font` tải font từ Google Fonts **một lần lúc build** rồi phục vụ cùng ứng dụng, nên **máy build cần ra được Internet** (Docker build, `npm run build`); lúc chạy không gọi dịch vụ bên thứ ba. Nếu build ngoại tuyến, tải tệp font về repo và dùng `next/font/local` thay cho `next/font/google` ở `src/app/layout.tsx`.
- **Trang kiểm thử chữ** `/dev/typography` chỉ bật khi `NODE_ENV !== 'production'` hoặc `E2E_MODE=1`; môi trường thật trả 404.
- **Build thiếu bộ nhớ**: nếu `next build` báo `JavaScript heap out of memory` ở bước "Collecting page data" (máy ít RAM/đang chạy nhiều tiến trình), giảm số worker: `NEXT_BUILD_CPUS=2 npm run build`.
- **Theme**: lựa chọn Sáng/Tối/Theo hệ thống lưu ở trình duyệt (khóa `theme` trong localStorage) và, khi đã đăng nhập, ở tài khoản (`users.theme`).

## 10. Voice khớp mốc thời gian phụ đề (spec 003): cài đặt hệ thống

Chỉnh ở **Quản trị → Cài đặt hệ thống** (có hiệu lực ngay cho tiến trình tạo sau đó; tiến trình đã tạo giữ tham số đã chốt lúc tạo):

| Khóa | Mặc định | Khoảng | Ý nghĩa |
|------|----------|--------|---------|
| `timingMaxSlipMs` | 500 | 100–2000 | Độ trễ tối đa của một đoạn so với mốc phụ đề; vượt thì đoạn bị đánh dấu cảnh báo (voice vẫn được tạo). |
| `timingMaxCompressPct` | 125 | 100–150 | Mức nén thời lượng tối đa khi lời đọc dài hơn khe (125 = nhanh hơn tối đa 1,25 lần). Nén quá mạnh làm giọng méo; hạ về 115 nếu nghe thấy méo. |
| `timingPartMinutes` | 10 | 1–30 | Cửa sổ chia phần cho phụ đề dài (log và tiến độ theo phần). |
| `timingMergeGapMs` | 1000 | 200–3000 | Khoảng nghỉ tối đa giữa hai cue vẫn được ghép chung một câu. |
| `rpmFptMarketplace`, `rpmShopaikeyOpenai`, `rpmShopaikeyMinimax` | 0 | 0–600 | Giới hạn yêu cầu/phút ghi đè mặc định của catalog (FPT: 30/phút theo tài liệu — chỉ là ước tính). 0 = dùng mặc định. Tiến trình chờ rồi tiếp tục khi chạm giới hạn, không thất bại. |

**Kiểm thử với nhà cung cấp giả**: ngoài các kịch bản lỗi hiện có, địa chỉ gốc nhận thêm thành phần ghép bằng dấu `+`: `ms-<n>` (thời lượng = ký tự × n ms), `pad-<n>` (thêm n ms im lặng ở đầu/cuối), `429-<k>` (k yêu cầu đầu trả 429), `blocked-<từ khóa>` (chặn nội dung có từ khóa) — ví dụ `/s/ms-120+pad-200/v1`.

## 11. Video overlay phụ đề (spec 005)

### Cài đặt hệ thống

Chỉnh ở **Quản trị → Cài đặt hệ thống**, có hiệu lực ngay:

| Khóa | Mặc định | Khoảng | Ý nghĩa |
|------|----------|--------|---------|
| `maxOverlayJobsPerUser` | 2 | 1–20 | Số tiến trình xuất đang chờ, đang chạy hoặc bị gián đoạn của một người; vượt thì bị từ chối kèm thông báo. |
| `maxConcurrentOverlayJobs` | 1 | 1–10 | Số video được dựng cùng lúc toàn hệ thống, tách khỏi voice và phụ đề. Mỗi video dùng khoảng nửa số luồng CPU: chỉ tăng khi máy còn dư. |
| `overlayMaxMinutes` | 60 | 1–180 | Thời lượng voice tối đa với phông màu; cũng là giới hạn của tệp âm thanh tải lên. |
| `overlayMaxMinutesTransparent` | 10 | 1–60 | Thời lượng voice tối đa với nền trong suốt. |

### Dung lượng

Video và tệp âm thanh tải lên tính vào hạn mức lưu trữ của người dùng theo dung lượng thật và được giữ tới khi người dùng xóa. Số dưới đây là **ước tính** cho khung 1080×1920:

| Định dạng | Ước tính mỗi phút (kèm tiếng) | Hạn mức 500 MB chứa được |
|-----------|-------------------------------|---------------------------|
| `.mp4` phông màu | khoảng 2–4,5 MB | hơn 100 phút |
| `.webm` trong suốt | khoảng 3–6,5 MB | hơn 70 phút |
| `.mov` trong suốt | khoảng 120–230 MB | khoảng 2–3,5 phút |

Cần `.mov` dài hơn thì tăng `userQuotaBytes` (hạn mức mỗi người) trước khi tăng `overlayMaxMinutesTransparent`.

### Tài nguyên của worker

- Mỗi lần xuất là một **tiến trình con** (`src/worker/render/main.ts`) có độ ưu tiên CPU thấp hơn worker, cùng một tiến trình `ffmpeg`. Bộ nhớ khoảng 200–350 MB cho mỗi video đang dựng.
- Tệp đang dựng nằm ở **đĩa tạm của container worker** (`/tmp/submaker-overlay-*`), được dọn khi kết thúc và khi worker khởi động. Cần chỗ trống ít nhất bằng 1,2 lần dung lượng ước tính cộng 64 MB; thiếu thì người dùng nhận lỗi "Máy chủ tạm hết chỗ". Một `.mov` 10 phút cần khoảng 2,5 GB.
- Worker khởi động lại giữa lúc xuất: tiến trình được đánh dấu "Bị gián đoạn" rồi tự xuất lại từ đầu; gián đoạn quá 3 lần thì báo lỗi để người dùng chạy lại.

### Tải âm thanh lên qua Cloudflare Tunnel

Tệp tối đa 100 MB. Cloudflare giới hạn thân yêu cầu theo gói (thường 100 MB với gói miễn phí), nên tệp sát 100 MB có thể bị Cloudflare chặn (lỗi 413) trước khi tới ứng dụng. Dùng `.mp3` hoặc `.m4a` thay cho `.wav` là cách đơn giản nhất.

### Phông chữ và giấy phép

Phông chữ của video nằm trong repo ở `public/fonts/overlay/` (Be Vietnam Pro, Roboto, Montserrat, Inter, Arimo và Noto Sans làm phông chữ thay thế), giấy phép SIL Open Font License 1.1 kèm theo trong `public/fonts/overlay/licenses/`. Trình duyệt và worker phải dùng **cùng tệp** thì khung xem trước mới giống video; ảnh `web` và `worker` đều chép thư mục này. Arimo thay cho Arial vì Arial không được phép phân phối lại.

Thêm hoặc đổi phông chữ: chép tệp `.ttf` và giấy phép vào thư mục trên, khai báo ở `src/lib/overlay/fonts.ts`, chạy `npx tsx scripts/build-font-coverage.ts` để cập nhật `coverage.json`, rồi `npx vitest run tests/unit/overlay/font-coverage.test.ts`.

### Đo hiệu năng

```bash
docker build --target worker -t submaker-worker:bench -f docker/Dockerfile .
docker run --rm -v "$PWD/scripts:/app/scripts:ro" -v "$PWD/docs/example:/app/docs/example:ro" submaker-worker:bench \
  npx tsx scripts/overlay-bench.ts docs/example/tham-quyen-2026.srt 60 cut,karaoke,blur mp4,webm,mov
```

Đạt khi thời gian xuất không dài hơn thời lượng video. Số đã đo: `specs/005-subtitle-video-overlay/research.md` R1.

## 12. Dịch video và gắn phụ đề (spec 006)

### Quyền và phạm vi sử dụng

- Tài khoản mới **mặc định không có quyền Dịch Video** (`users.can_translate_video = false`); Administrator luôn được phép và bật/tắt quyền theo từng User ở **Quản trị → Người dùng**.
- Tắt quyền giữa chừng sẽ tự động gắn cờ dừng cho các tiến trình dịch và xuất video đang chạy của tài khoản đó mà không làm mất phụ đề đã lưu.

### Hạn mức video và trần dung lượng toàn hệ thống

- Hạn mức video (`users.video_used_bytes`, mặc định `userVideoQuotaBytes = 30 GB`) **tách riêng** với hạn mức 500 MB thường (chữ phụ đề lưu trong CSDL vẫn tính vào phần `script_bytes` mềm trong 500 MB và không chặn lưu).
- **Trần dung lượng hệ thống** (`videoSystemCapBytes`, mặc định `100 GB`) giới hạn tổng dung lượng video đã lưu + chỗ đang giữ của phiên tải nguồn đang mở & bản xuất đang chạy + dung lượng bản xem trước `preview_bytes` của mọi User.
- **Khuyến nghị chọn trần thấp hơn ổ đĩa thật**: ứng dụng web không truy vấn trực tiếp đĩa trống của MinIO, và các tệp tạm ngắn hạn (`audio.*`, `transcript-*.json`) nằm trong `video-tmp/` trước khi dọn; do đó **luôn đặt `videoSystemCapBytes` tối đa ~70–80% phần dung lượng thực cấp cho volume `miniodata`** (chừa dư ít nhất 20–30 GB cho tệp tạm, metadata S3 và phần dở chưa dọn).

### Đĩa tạm của worker (`/tmp/submaker-video-*`)

- Worker tải video nguồn về đĩa tạm, tách âm thanh / dựng bản xem trước / mã hóa video thành phẩm (tới 10 GB) rồi đẩy lên MinIO theo từng phần (multipart upload), không giữ video lớn trong RAM.
- Trước mỗi tác vụ nặng (`video-prepare`, `video-preview`, `video-render`), worker kiểm tra chỗ trống đĩa tạm bằng `statfs`: cần ít nhất **dung lượng nguồn + dung lượng ước tính thành phẩm + 1 GB dự phòng** (`DISK_MARGIN`). Với video nguồn 10 GB, container `worker` cần tối thiểu **~22–25 GB trống** ở vùng lưu tạm (`/tmp`); xuất lớp phụ đề `.mov` trong suốt 10 phút cần thêm khoảng 2,5 GB. Thiếu đĩa sẽ báo lỗi sạch để không làm sập tiến trình.
- Tệp nguồn không tin cậy luôn được đọc từ đĩa với `-protocol_whitelist file` và ép bộ tách theo đuôi; tiến trình `ffmpeg` chạy ở mức ưu tiên thấp (`PRIORITY_BELOW_NORMAL`), tối đa `max(1, CPU - 2)` luồng.

### Tự xóa theo hạn và thẻ giữ lượt tải

- Lịch `video-retention` chạy mỗi **10 phút**:
  - **Video nguồn**: xóa sau `videoSourceRetainHours` (mặc định **48 giờ**) kể từ lần xuất thành công gần nhất; nếu việc chưa xuất lần nào (chờ duyệt, đã dừng, lỗi) thì xóa sau `videoIdleRetainDays` (mặc định **7 ngày**) không hoạt động. Người dùng vẫn tải được tệp phụ đề và có thể tải lại đúng video gốc (so kích thước + dấu vân tay 3 đoạn 1 MB) để xuất tiếp.
  - **Video thành phẩm & lớp phụ đề**: xóa sau `videoOutputRetainDays` (mặc định **7 ngày**) kể từ lúc hoàn tất.
  - **Tệp tạm & phiên tải dở**: phần tải lên dở quá **48 giờ**, bản âm thanh/xem trước của nguồn đã xóa và bản token thô quá hạn được tự động dọn sạch (hủy cả multipart upload trong MinIO theo bản ghi CSDL).
- **Bảo vệ khi đang phát/tải**: đường phát/tải gia hạn `download_lease_until` mỗi 60 giây trong lúc truyền; tệp đến hạn sẽ được bỏ qua cho tới lượt dọn sau khi kết thúc tải/xuất.

### Tải lên tệp lớn qua Cloudflare Tunnel

- Tệp nguồn được chia từng phần **16 MB** (`SHA-256` từng phần, tối đa 3 phần song thời từ trình duyệt) nên mỗi yêu cầu đều nằm dưới ngưỡng thân yêu cầu 100 MB của gói Cloudflare miễn phí. Máy chủ giới hạn tối đa **8 phần giữ đồng thời trong RAM (128 MB)** trên toàn hệ thống, vượt quá sẽ trả `429 Retry-After` để trình duyệt tự chờ và tiếp tục.
- **Điều khoản sử dụng (ToS) của Cloudflare**: gói Cloudflare Tunnel/CDN phổ thông hạn chế phân phối hoặc truyền lượng lớn nội dung video qua proxy HTTP chuẩn. Người vận hành **cần rà soát gói dịch vụ / điều khoản Cloudflare hiện hành** (và chạy kiểm thử tải 10 GB thật trên đường hầm đích trong [user-tasks.md](../specs/006-video-translate-subtitle/user-tasks.md)) trước khi mở tính năng cho người dùng Internet rộng rãi.

### Đo hiệu năng trong ảnh worker

```bash
docker build --target worker -t submaker-worker:bench -f docker/Dockerfile .
docker run --rm -v "$PWD/scripts:/app/scripts:ro" submaker-worker:bench npx tsx scripts/video-bench.ts 60 20 cut,karaoke
```

Kết quả đo và đánh dấu đồng hồ trên ảnh worker: xem `specs/006-video-translate-subtitle/research.md`.
