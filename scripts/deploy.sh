#!/usr/bin/env bash
# Deploy Sub Maker bằng Docker Compose và (tùy chọn) gắn tên miền qua Cloudflare Tunnel.
#
# Mỗi lần có code mới chỉ cần:             ./scripts/deploy.sh
# Lần đầu (tạo cấu hình + tunnel + domain): ./scripts/deploy.sh --init --domain voice.example.com
#                                           ./scripts/deploy.sh --setup-tunnel --domain voice.example.com
#                                           ./scripts/deploy.sh
#
# Các bước deploy: kiểm tra cấu hình → (git pull) → sao lưu PostgreSQL → build image → up -d (dịch vụ `migrate`
# chạy migration trước web/worker) → chờ web khỏe → kiểm tra cloudflared đã kết nối → dọn image cũ.
# Build lỗi thì DỪNG trước khi đụng tới container đang chạy (bản cũ vẫn phục vụ).
#
# Tùy chọn:
#   --env-file FILE     file cấu hình production (mặc định .env.production, KHÔNG commit)
#   --init              tạo file cấu hình với bí mật ngẫu nhiên (cần --domain); không ghi đè file đã có
#   --domain NAME       tên miền công khai, ví dụ voice.example.com
#   --setup-tunnel      dùng Cloudflare API: tạo tunnel (nếu chưa có), Public Hostname -> http://web:3000, DNS CNAME,
#                       lưu token tunnel vào file cấu hình (cần `jq` và API token: docs/operations.md §8)
#   --pull              git pull --ff-only trước khi build (nếu là repo git)
#   --skip-backup       bỏ qua sao lưu PostgreSQL trước khi deploy
#   --no-cache          build không dùng cache
#   --timeout SECONDS   thời gian tối đa chờ web khỏe (mặc định 240)
#   -h, --help          xem hướng dẫn này
set -Eeuo pipefail

# Git Bash trên Windows tự đổi đường dẫn kiểu /tmp/... thành C:/...; tắt để lệnh docker nhận đúng.
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'

cd "$(dirname "${BASH_SOURCE[0]}")/.."

COMPOSE_FILE="docker/compose.prod.yml"
BACKUP_DIR="backups"
KEEP_BACKUPS=10

ENV_FILE=".env.production"
DO_INIT=0 DO_TUNNEL=0 DO_PULL=0 SKIP_BACKUP=0 NO_CACHE=0
DOMAIN=""
HEALTH_TIMEOUT=240

if [[ -t 1 ]]; then C_STEP=$'\033[36m' C_OK=$'\033[32m' C_WARN=$'\033[33m' C_OFF=$'\033[0m'; else C_STEP="" C_OK="" C_WARN="" C_OFF=""; fi
step() { printf '%s==> %s%s\n' "$C_STEP" "$*" "$C_OFF"; }
ok() { printf '%s    %s%s\n' "$C_OK" "$*" "$C_OFF"; }
warn() { printf '%s    ! %s%s\n' "$C_WARN" "$*" "$C_OFF" >&2; }
die() { printf 'LỖI: %s\n' "$*" >&2; exit 1; }
usage() { sed -n '2,/^set -Eeuo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; }

while (($#)); do
  case "$1" in
    --env-file) ENV_FILE="${2:?thiếu giá trị cho --env-file}"; shift 2 ;;
    --init) DO_INIT=1; shift ;;
    --domain) DOMAIN="${2:?thiếu giá trị cho --domain}"; shift 2 ;;
    --setup-tunnel) DO_TUNNEL=1; shift ;;
    --pull) DO_PULL=1; shift ;;
    --skip-backup) SKIP_BACKUP=1; shift ;;
    --no-cache) NO_CACHE=1; shift ;;
    --timeout) HEALTH_TIMEOUT="${2:?thiếu giá trị cho --timeout}"; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *) die "Tùy chọn không hợp lệ: $1 (xem --help)" ;;
  esac
done

dc() { docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }

# ---------- đọc/ghi file .env ----------
env_get() { # env_get KEY → in giá trị (bỏ \r và dấu nháy bao ngoài)
  local v
  v=$(grep -E "^[[:space:]]*$1[[:space:]]*=" "$ENV_FILE" | tail -n1 | sed -E 's/^[^=]*=//; s/\r$//; s/^[[:space:]]+//; s/[[:space:]]+$//' || true)
  if [[ ${#v} -ge 2 && ( ( $v == \"*\" ) || ( $v == \'*\' ) ) ]]; then v=${v:1:${#v}-2}; fi
  printf '%s' "$v"
}
env_set() { # env_set KEY VALUE → thay dòng KEY=... hoặc thêm cuối file
  local tmp; tmp=$(mktemp)
  V="$2" awk -v k="$1" 'BEGIN { v = ENVIRON["V"] } $0 ~ "^[ \t]*" k "[ \t]*=" { print k "=" v; f = 1; next } { print } END { if (!f) print k "=" v }' "$ENV_FILE" >"$tmp"
  cat "$tmp" >"$ENV_FILE"; rm -f "$tmp"
}

# ---------- sinh bí mật ngẫu nhiên (từ /dev/urandom) ----------
rand_hex() { od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'; }
rand_b64() { head -c "$1" /dev/urandom | base64 | tr -d '\n'; }
rand_pass() { (set +o pipefail; LC_ALL=C tr -dc 'A-HJ-NP-Za-km-z2-9' </dev/urandom | head -c "$1"); }

# ---------- --init ----------
do_init() {
  [[ -n $DOMAIN ]] || die "Cần --domain (ví dụ: --init --domain voice.example.com)."
  [[ $DOMAIN =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$ && ${#DOMAIN} -le 253 ]] || die "Tên miền '$DOMAIN' không hợp lệ (chỉ gồm chữ thường, số, dấu - và dấu chấm)."
  [[ ! -e $ENV_FILE ]] || die "$ENV_FILE đã tồn tại, không ghi đè. Xóa hoặc đổi tên nếu muốn tạo mới."
  local admin_pass; admin_pass=$(rand_pass 24)
  (umask 077; cat >"$ENV_FILE" <<EOF
# Cấu hình PRODUCTION của Sub Maker. KHÔNG commit file này. Sinh bởi scripts/deploy.sh --init.
POSTGRES_PASSWORD=$(rand_hex 24)
MINIO_ROOT_USER=submaker$(rand_hex 4)
MINIO_ROOT_PASSWORD=$(rand_hex 24)
S3_BUCKET=submaker
S3_REGION=us-east-1

# Khóa mã hóa API key nhà cung cấp trong CSDL và khóa ký phiên. ĐỔI = mất khóa đã lưu / buộc đăng nhập lại (docs/operations.md §5).
APP_ENCRYPTION_KEY=$(rand_b64 32)
AUTH_SECRET=$(rand_b64 48)

APP_URL=https://$DOMAIN

# Administrator được tạo/đồng bộ lúc khởi động. Đổi ADMIN_PASSWORD ở đây rồi deploy lại để đặt mật khẩu mới.
ADMIN_EMAIL=admin@$DOMAIN
ADMIN_PASSWORD=$admin_pass

# Điền bởi --setup-tunnel (hoặc dán token tunnel lấy từ Cloudflare Zero Trust)
CLOUDFLARE_TUNNEL_TOKEN=
EOF
  )
  ok "Đã tạo $ENV_FILE với bí mật ngẫu nhiên (quyền chỉ chủ sở hữu đọc)."
  ok "Tài khoản Administrator: admin@$DOMAIN  (mật khẩu nằm trong $ENV_FILE, mục ADMIN_PASSWORD)"
  warn "Hãy sao lưu $ENV_FILE ở nơi an toàn: mất APP_ENCRYPTION_KEY = mất các API key đã lưu."
}

# ---------- --setup-tunnel (Cloudflare API) ----------
CF_TOKEN=""
cf() { # cf METHOD PATH [JSON_BODY] → in JSON phản hồi; dừng nếu success != true
  local method=$1 path=$2 body=${3:-} resp
  local args=(-sS -X "$method" "https://api.cloudflare.com/client/v4$path" -H 'Content-Type: application/json')
  [[ -z $body ]] || args+=(--data "$body")
  resp=$(curl "${args[@]}" -K <(printf 'header = "Authorization: Bearer %s"\n' "$CF_TOKEN")) || die "Không gọi được Cloudflare API ($method $path)."
  [[ $(jq -r '.success' <<<"$resp" 2>/dev/null) == true ]] || die "Cloudflare API $method $path không thành công: $(jq -c '.errors // .' <<<"$resp" 2>/dev/null || echo "$resp")"
  printf '%s' "$resp"
}

do_tunnel() {
  command -v jq >/dev/null || die "Cần cài 'jq' để dùng --setup-tunnel (Linux: apt install jq · Windows: winget install jqlang.jq)."
  command -v curl >/dev/null || die "Cần cài 'curl'."
  [[ -n $DOMAIN ]] || die "Cần --domain (ví dụ: --setup-tunnel --domain voice.example.com)."
  [[ -f $ENV_FILE ]] || die "Chưa có $ENV_FILE. Chạy trước: ./scripts/deploy.sh --init --domain $DOMAIN"

  CF_TOKEN=${CLOUDFLARE_API_TOKEN:-}
  if [[ -z $CF_TOKEN ]]; then
    read -rsp 'Dán Cloudflare API token (quyền: Account > Cloudflare Tunnel: Edit, Zone > DNS: Edit): ' CF_TOKEN; echo
  fi
  [[ -n $CF_TOKEN ]] || die "Thiếu API token."

  step "Tìm zone chứa tên miền"
  local zones zone_id zone_name account_id
  zones=$(cf GET "/zones?per_page=50&status=active")
  # zone khớp dài nhất (tên miền bằng zone hoặc kết thúc bằng ".zone")
  read -r zone_id zone_name account_id < <(jq -r --arg d "$DOMAIN" '[.result[] | select(. as $z | $d == $z.name or ($d | endswith("." + $z.name)))] | sort_by(.name | length) | reverse | first // empty | "\(.id) \(.name) \(.account.id)"' <<<"$zones") || true
  [[ -n ${zone_id:-} ]] || die "Token không thấy zone nào chứa '$DOMAIN'. Kiểm tra tên miền đã thêm vào Cloudflare và token có quyền Zone > DNS: Edit."
  ok "Zone: $zone_name"

  step "Tạo/tìm tunnel"
  local tunnel_id; tunnel_id=$(env_get CLOUDFLARE_TUNNEL_ID)
  if [[ -z $tunnel_id ]]; then
    tunnel_id=$(jq -r '.result[0].id // empty' <<<"$(cf GET "/accounts/$account_id/cfd_tunnel?name=submaker&is_deleted=false")")
    if [[ -n $tunnel_id ]]; then ok "Dùng lại tunnel 'submaker' ($tunnel_id)"; else
      tunnel_id=$(jq -r '.result.id' <<<"$(cf POST "/accounts/$account_id/cfd_tunnel" '{"name":"submaker","config_src":"cloudflare"}')")
      ok "Đã tạo tunnel 'submaker' ($tunnel_id)"
    fi
  else ok "Dùng tunnel đã lưu ($tunnel_id)"; fi

  step "Trỏ $DOMAIN -> http://web:3000"
  cf PUT "/accounts/$account_id/cfd_tunnel/$tunnel_id/configurations" \
    "$(jq -nc --arg h "$DOMAIN" '{config:{ingress:[{hostname:$h,service:"http://web:3000"},{service:"http_status:404"}]}}')" >/dev/null
  ok "Đã cập nhật Public Hostname của tunnel"

  step "Tạo bản ghi DNS (CNAME, bật proxy)"
  local dns rec_id rec_type rec_content
  dns=$(jq -nc --arg n "$DOMAIN" --arg c "$tunnel_id.cfargotunnel.com" '{type:"CNAME",name:$n,content:$c,proxied:true,ttl:1,comment:"Sub Maker (cloudflared tunnel)"}')
  read -r rec_id rec_type rec_content < <(jq -r '.result[0] // empty | "\(.id) \(.type) \(.content)"' <<<"$(cf GET "/zones/$zone_id/dns_records?name=$DOMAIN")") || true
  if [[ -n ${rec_id:-} ]]; then
    if [[ $rec_type == CNAME && $rec_content == *.cfargotunnel.com ]]; then
      cf PUT "/zones/$zone_id/dns_records/$rec_id" "$dns" >/dev/null; ok "Đã cập nhật bản ghi DNS"
    else
      die "Đã có bản ghi DNS khác cho $DOMAIN ($rec_type -> $rec_content). Script không ghi đè bản ghi không phải của tunnel; hãy xóa tay trên Cloudflare nếu đúng ý bạn rồi chạy lại."
    fi
  else cf POST "/zones/$zone_id/dns_records" "$dns" >/dev/null; ok "Đã tạo bản ghi DNS"; fi

  step "Lấy token tunnel và lưu vào cấu hình"
  local token; token=$(jq -r '.result' <<<"$(cf GET "/accounts/$account_id/cfd_tunnel/$tunnel_id/token")")
  [[ -n $token && $token != null ]] || die "Không lấy được token tunnel."
  env_set CLOUDFLARE_TUNNEL_TOKEN "$token"
  env_set CLOUDFLARE_TUNNEL_ID "$tunnel_id"
  env_set APP_URL "https://$DOMAIN"
  ok "Đã lưu vào $ENV_FILE (CLOUDFLARE_TUNNEL_TOKEN, CLOUDFLARE_TUNNEL_ID, APP_URL)"
  printf '\nXong. Chạy ./scripts/deploy.sh để khởi động; sau đó mở https://%s\n' "$DOMAIN"
}

# ---------- deploy ----------
preflight() {
  step "Kiểm tra cấu hình"
  [[ -f $ENV_FILE ]] || die "Chưa có $ENV_FILE. Chạy: ./scripts/deploy.sh --init --domain <tên-miền>"
  local missing=() k
  for k in POSTGRES_PASSWORD MINIO_ROOT_USER MINIO_ROOT_PASSWORD APP_ENCRYPTION_KEY AUTH_SECRET APP_URL ADMIN_EMAIL ADMIN_PASSWORD CLOUDFLARE_TUNNEL_TOKEN; do
    [[ -n $(env_get "$k") ]] || missing+=("$k")
  done
  if ((${#missing[@]})); then
    local hint=""
    [[ " ${missing[*]} " != *" CLOUDFLARE_TUNNEL_TOKEN "* ]] || hint=" (token tunnel: chạy --setup-tunnel --domain <tên-miền>, hoặc dán từ Cloudflare Zero Trust)"
    die "Thiếu giá trị trong $ENV_FILE: ${missing[*]}$hint"
  fi
  [[ $(env_get APP_URL) == https://* ]] || die "APP_URL phải bắt đầu bằng https:// (đang là '$(env_get APP_URL)')."
  [[ $(env_get POSTGRES_PASSWORD) =~ ^[A-Za-z0-9_.~-]+$ ]] || die "POSTGRES_PASSWORD chỉ nên gồm chữ, số, - _ . ~ (nó nằm trong DATABASE_URL)."
  [[ $(env_get ALLOW_INSECURE_PROVIDER_URLS) != true ]] || die "ALLOW_INSECURE_PROVIDER_URLS=true không được phép ở production."
  (($(env_get ADMIN_PASSWORD | wc -c) > 10)) || die "ADMIN_PASSWORD phải từ 10 ký tự."
  ok "Cấu hình hợp lệ"
  dc config -q
}

backup_db() {
  step "Sao lưu PostgreSQL trước khi deploy"
  local cid; cid=$(dc ps -q postgres 2>/dev/null | head -n1 || true)
  if [[ -z $cid || $(docker inspect --format '{{.State.Running}}' "$cid" 2>/dev/null) != true ]]; then
    ok "PostgreSQL chưa chạy (lần deploy đầu) — bỏ qua sao lưu"; return
  fi
  mkdir -p "$BACKUP_DIR"
  local file; file="$BACKUP_DIR/submaker-$(date +%Y%m%d-%H%M%S).dump"
  dc exec -T postgres pg_dump -U submaker -Fc submaker >"$file" || { rm -f "$file"; die "pg_dump thất bại — dừng deploy."; }
  [[ -s $file ]] || { rm -f "$file"; die "File sao lưu rỗng — dừng deploy."; }
  ok "Đã lưu $file ($(($(wc -c <"$file") / 1024)) KB)"
  # chỉ giữ $KEEP_BACKUPS bản mới nhất
  # shellcheck disable=SC2012
  ls -1t "$BACKUP_DIR"/submaker-*.dump 2>/dev/null | tail -n +$((KEEP_BACKUPS + 1)) | while read -r old; do rm -f "$old"; done
}

wait_web() {
  step "Chờ web khỏe (tối đa ${HEALTH_TIMEOUT} giây)"
  local deadline=$((SECONDS + HEALTH_TIMEOUT)) mig web st h
  while ((SECONDS < deadline)); do
    mig=$(dc ps -a -q migrate 2>/dev/null | head -n1 || true)
    if [[ -n $mig ]]; then
      st=$(docker inspect --format '{{.State.Status}}|{{.State.ExitCode}}' "$mig" 2>/dev/null || true)
      if [[ $st =~ ^exited\|[1-9][0-9]*$ ]]; then
        dc logs --tail 40 migrate || true
        die "Migration thất bại — web/worker KHÔNG được khởi động. Sửa lỗi rồi deploy lại (có thể khôi phục từ thư mục $BACKUP_DIR)."
      fi
    fi
    web=$(dc ps -q web 2>/dev/null | head -n1 || true)
    if [[ -n $web ]]; then
      h=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$web" 2>/dev/null || true)
      if [[ $h == healthy ]]; then ok "web đã khỏe"; return; fi
      [[ $h != unhealthy ]] || break
    fi
    sleep 3
  done
  dc logs --tail 60 web || true
  die "web không khỏe trong thời gian chờ. Xem log ở trên."
}

wait_tunnel() {
  step "Kiểm tra Cloudflare Tunnel"
  local deadline=$((SECONDS + 60)) log
  while ((SECONDS < deadline)); do
    log=$(dc logs --tail 80 cloudflared 2>&1 || true)
    if grep -q 'Registered tunnel connection' <<<"$log"; then ok "cloudflared đã kết nối tới Cloudflare"; return; fi
    grep -qE 'Unauthorized|invalid tunnel|failed to unmarshal' <<<"$log" && break
    sleep 3
  done
  warn "Chưa thấy cloudflared kết nối. Xem: docker compose --env-file $ENV_FILE -f $COMPOSE_FILE logs cloudflared (kiểm tra CLOUDFLARE_TUNNEL_TOKEN)."
}

deploy() {
  docker info >/dev/null 2>&1 || die "Docker chưa chạy. Hãy mở Docker Desktop (hoặc khởi động dịch vụ docker) rồi thử lại."

  if ((DO_PULL)); then
    if [[ -d .git ]]; then step "git pull"; git pull --ff-only || die "git pull thất bại."; else warn "Thư mục này không phải repo git — bỏ qua --pull."; fi
  fi

  preflight
  ((SKIP_BACKUP)) || backup_db

  step "Build image (lỗi ở bước này không ảnh hưởng bản đang chạy)"
  if ((NO_CACHE)); then dc build --no-cache; else dc build; fi

  step "Khởi động / cập nhật dịch vụ (migrate chạy trước web và worker)"
  dc up -d --remove-orphans

  wait_web
  wait_tunnel

  step "Dọn image cũ không còn dùng"
  docker image prune -f >/dev/null || true

  step "Trạng thái"
  dc ps
  printf '\nDeploy xong: %s\n' "$(env_get APP_URL)"
}

if ((DO_INIT)); then do_init; exit 0; fi
if ((DO_TUNNEL)); then do_tunnel; exit 0; fi
deploy
