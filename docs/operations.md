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
| `minio` | Lưu kịch bản, voice, cache audio, avatar (bucket riêng tư) | chỉ `internal` |
| `migrate` | Chạy migration một lần rồi thoát | `internal` |
| `web` | Giao diện + API (Next.js standalone) | `internal` + `egress` |
| `worker` | Tạo voice nền, dọn dẹp, đối soát dung lượng (có `ffmpeg`) | `internal` + `egress` |
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

