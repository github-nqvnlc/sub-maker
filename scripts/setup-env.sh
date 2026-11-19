#!/usr/bin/env bash
# Kiểm tra và cài môi trường Linux cho Sub Maker: docker (+compose), curl, jq, git, ffmpeg, nvm, node, yarn.
#
# Chạy:  ./scripts/setup-env.sh           # kiểm tra → hỏi xác nhận → cài phần thiếu
#        ./scripts/setup-env.sh --check   # chỉ kiểm tra, KHÔNG cài gì (thoát mã 1 nếu còn thiếu)
#        ./scripts/setup-env.sh --yes     # không hỏi (dùng cho CI/máy chủ mới)
#
# Tùy chọn:
#   --check            chỉ in bảng trạng thái
#   -y, --yes          trả lời "có" cho mọi câu hỏi
#   --project          sau khi cài công cụ: chạy `npm ci` trong thư mục dự án
#   --e2e              cài trình duyệt + thư viện hệ thống cho Playwright (E2E)
#   --no-yarn          không cài yarn (dự án dùng npm; yarn chỉ cài để tiện, không dùng cho dự án này)
#   --skip-docker      không kiểm tra/cài docker (ví dụ máy chỉ dùng để build, hoặc dùng Docker Desktop/WSL)
#   --skip-ffmpeg      không kiểm tra/cài ffmpeg (chỉ cần khi chạy worker trực tiếp trên máy; production dùng ffmpeg trong image)
#   --node-major N     phiên bản Node chính cần cài qua nvm (mặc định: lấy từ package.json engines, hiện là 22)
#   -h, --help         xem hướng dẫn này
#
# Hỗ trợ: Debian/Ubuntu (apt), Fedora/RHEL/Rocky/Alma/CentOS (dnf/yum), Arch (pacman), openSUSE (zypper).
set -Eeuo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

NVM_VERSION="v0.40.3"
CHECK_ONLY=0 ASSUME_YES=0 DO_PROJECT=0 DO_E2E=0 WITH_YARN=1 SKIP_DOCKER=0 SKIP_FFMPEG=0
NODE_MAJOR=""

if [[ -t 1 ]]; then C_STEP=$'\033[36m' C_OK=$'\033[32m' C_WARN=$'\033[33m' C_ERR=$'\033[31m' C_OFF=$'\033[0m'; else C_STEP="" C_OK="" C_WARN="" C_ERR="" C_OFF=""; fi
step() { printf '%s==> %s%s\n' "$C_STEP" "$*" "$C_OFF"; }
ok() { printf '%s    ✓ %s%s\n' "$C_OK" "$*" "$C_OFF"; }
warn() { printf '%s    ! %s%s\n' "$C_WARN" "$*" "$C_OFF" >&2; }
die() { printf '%sLỖI: %s%s\n' "$C_ERR" "$*" "$C_OFF" >&2; exit 1; }
usage() { sed -n '2,/^set -Eeuo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; }

while (($#)); do
  case "$1" in
    --check) CHECK_ONLY=1; shift ;;
    -y | --yes) ASSUME_YES=1; shift ;;
    --project) DO_PROJECT=1; shift ;;
    --e2e) DO_E2E=1; shift ;;
    --no-yarn) WITH_YARN=0; shift ;;
    --skip-docker) SKIP_DOCKER=1; shift ;;
    --skip-ffmpeg) SKIP_FFMPEG=1; shift ;;
    --node-major) NODE_MAJOR="${2:?thiếu giá trị cho --node-major}"; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *) die "Tùy chọn không hợp lệ: $1 (xem --help)" ;;
  esac
done

# Locale UTF-8 để printf căn cột đúng với chữ tiếng Việt (nếu hệ thống không có thì tự lùi về mặc định, chỉ lệch cột)
export LC_ALL=C.UTF-8 2>/dev/null || true

[[ $(uname -s) == Linux ]] || die "Script này dành cho Linux (đang chạy trên $(uname -s)). Trên Windows hãy dùng WSL2 (Ubuntu) rồi chạy lại trong đó."

have() { command -v "$1" >/dev/null 2>&1; }
ver_ge() { [[ $(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1) == "$2" ]]; } # ver_ge A B: A >= B
first_ver() { grep -oE '[0-9]+(\.[0-9]+)+' | head -n1; }

# ---------- phiên bản Node yêu cầu (đọc từ package.json) ----------
REQ_NODE=$(sed -nE 's/.*"node"[[:space:]]*:[[:space:]]*">=?[[:space:]]*([0-9]+(\.[0-9]+)*)".*/\1/p' package.json 2>/dev/null | head -n1 || true)
REQ_NODE=${REQ_NODE:-22.12.0}
[[ -n $NODE_MAJOR ]] || NODE_MAJOR=${REQ_NODE%%.*}

# ---------- hệ điều hành / trình quản lý gói / sudo ----------
OS_ID="" OS_PRETTY="Linux"
if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  OS_ID="${ID:-}"; OS_PRETTY="${PRETTY_NAME:-$OS_ID}"
fi
PM=""
if have apt-get; then PM=apt
elif have dnf; then PM=dnf
elif have yum; then PM=yum
elif have pacman; then PM=pacman
elif have zypper; then PM=zypper
fi
SUDO=""
if ((EUID != 0)); then
  if have sudo; then SUDO="sudo"; else SUDO="__none__"; fi
fi
IS_WSL=0; { [[ -n ${WSL_DISTRO_NAME:-} ]] || [[ -e /proc/sys/fs/binfmt_misc/WSLInterop ]]; } && IS_WSL=1 || true

as_root() { # chạy lệnh với quyền root (sudo nếu cần)
  if [[ $SUDO == "__none__" ]]; then die "Cần quyền root để chạy: $* (không có sudo). Hãy chạy script bằng root hoặc cài sudo."; fi
  if [[ -n $SUDO ]]; then sudo "$@"; else "$@"; fi
}

APT_UPDATED=0
pkg_install() { # pkg_install GÓI... (tên gói theo từng distro do người gọi truyền)
  [[ -n $PM ]] || die "Không nhận ra trình quản lý gói (hỗ trợ apt, dnf, yum, pacman, zypper). Hãy cài thủ công: $*"
  case "$PM" in
    apt)
      if ((!APT_UPDATED)); then as_root env DEBIAN_FRONTEND=noninteractive apt-get update -y; APT_UPDATED=1; fi
      as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$@" ;;
    dnf) as_root dnf install -y "$@" ;;
    yum) as_root yum install -y "$@" ;;
    pacman) as_root pacman -Sy --noconfirm --needed "$@" ;;
    zypper) as_root zypper --non-interactive install "$@" ;;
  esac
}

confirm() { # confirm "câu hỏi" → 0 nếu đồng ý
  ((ASSUME_YES)) && return 0
  if [[ ! -t 0 ]]; then warn "Không có terminal để hỏi. Thêm --yes để tự động đồng ý."; return 1; fi
  local a; read -r -p "$1 [y/N] " a
  [[ $a == [yY] || $a == [yY][eE][sS] ]]
}

# ---------- nvm / node: nạp nvm vào shell hiện tại (nvm.sh không tương thích set -eu) ----------
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
load_nvm() {
  [[ -s $NVM_DIR/nvm.sh ]] || return 1
  set +eu
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
  local rc=$?
  set -eu
  return $rc
}
nvm_run() { set +eu; nvm "$@"; local rc=$?; set -eu; return $rc; }
load_nvm || true

# ---------- kiểm tra từng công cụ ----------
declare -a ROWS=() MISSING=()
add_row() { # add_row TÊN CẦN ĐANG_CÓ TRẠNG_THÁI(ok|missing|old|warn)
  ROWS+=("$1|$2|$3|$4")
  [[ $4 == ok || $4 == warn ]] || MISSING+=("$1")
}

check_all() {
  ROWS=(); MISSING=()
  local v
  # curl / jq / git: cần cho deploy.sh và tải script cài đặt
  for t in curl jq git; do
    if have "$t"; then v=$("$t" --version 2>&1 | first_ver || true); add_row "$t" "bất kỳ" "${v:-có}" ok; else add_row "$t" "bất kỳ" "—" missing; fi
  done
  if ((!SKIP_FFMPEG)); then
    if have ffmpeg; then v=$(ffmpeg -version 2>&1 | head -n1 | first_ver || true); add_row ffmpeg "bất kỳ (chạy worker trên máy)" "${v:-có}" ok
    else add_row ffmpeg "bất kỳ (chạy worker trên máy)" "—" missing; fi
  fi
  if ((!SKIP_DOCKER)); then
    if have docker; then
      v=$(docker --version 2>/dev/null | first_ver || true)
      if docker compose version >/dev/null 2>&1; then
        add_row docker "Engine + Compose v2" "${v:-có}, compose $(docker compose version --short 2>/dev/null || echo ?)" ok
      else add_row docker "Engine + Compose v2" "${v:-có}, THIẾU compose v2" missing; fi
    else add_row docker "Engine + Compose v2" "—" missing; fi
  fi
  if [[ -s $NVM_DIR/nvm.sh ]]; then v=$(nvm_run --version 2>/dev/null | first_ver || true); add_row nvm "bất kỳ" "${v:-có}" ok; else add_row nvm "bất kỳ" "—" missing; fi
  if have node; then
    v=$(node -v | first_ver || true)
    if [[ -n $v ]] && ver_ge "$v" "$REQ_NODE"; then add_row node ">= $REQ_NODE" "$v" ok; else add_row node ">= $REQ_NODE" "${v:-?} (quá cũ)" old; fi
  else add_row node ">= $REQ_NODE" "—" missing; fi
  if have npm; then add_row npm "đi kèm node (dự án dùng npm)" "$(npm -v 2>/dev/null || echo ?)" ok; else add_row npm "đi kèm node (dự án dùng npm)" "—" missing; fi
  if ((WITH_YARN)); then
    if have yarn; then add_row yarn "tùy chọn" "$(yarn --version 2>/dev/null | head -n1 || echo ?)" ok; else add_row yarn "tùy chọn" "—" missing; fi
  fi
}

pad() { # pad CHUỖI ĐỘ_RỘNG — căn theo số KÝ TỰ (printf %-Ns của bash đếm byte nên lệch với chữ tiếng Việt)
  local s=$1 n=$2 len=${#1}
  printf '%s' "$s"
  ((len >= n)) || printf '%*s' $((n - len)) ''
}

print_table() {
  printf '
  %s %s %s %s
' "$(pad 'CÔNG CỤ' 8)" "$(pad 'YÊU CẦU' 34)" "$(pad 'ĐANG CÓ' 34)" "TRẠNG THÁI"
  local r name need have_ st label color
  for r in "${ROWS[@]}"; do
    IFS='|' read -r name need have_ st <<<"$r"
    case $st in ok) label="OK"; color=$C_OK ;; old) label="CẦN NÂNG CẤP"; color=$C_WARN ;; *) label="THIẾU"; color=$C_ERR ;; esac
    printf '  %s %s %s %s%s%s
' "$(pad "$name" 8)" "$(pad "$need" 34)" "$(pad "$have_" 34)" "$color" "$label" "$C_OFF"
  done
  echo
}

step "Môi trường: $OS_PRETTY · trình quản lý gói: ${PM:-không rõ} · $( ((EUID == 0)) && echo root || echo "người dùng $(id -un)")"
((IS_WSL)) && warn "Đang chạy trong WSL: nếu dùng Docker Desktop, hãy bật 'WSL integration' thay vì cài Docker Engine ở đây (dùng --skip-docker)."
check_all
print_table

if ((CHECK_ONLY)); then
  if ((${#MISSING[@]})); then warn "Còn thiếu/cũ: ${MISSING[*]}. Chạy ./scripts/setup-env.sh để cài."; exit 1; fi
  ok "Môi trường đã đầy đủ."; exit 0
fi

# ---------- cài đặt ----------
in_list() { local x; for x in "${MISSING[@]}"; do [[ $x == "$1" ]] && return 0; done; return 1; }

install_basic() { # curl jq git (+ ca-certificates)
  local want=() t
  for t in curl jq git; do in_list "$t" && want+=("$t"); done
  ((${#want[@]})) || return 0
  step "Cài gói cơ bản: ${want[*]}"
  case "$PM" in apt) want+=(ca-certificates) ;; esac
  pkg_install "${want[@]}"
}

install_ffmpeg() {
  step "Cài ffmpeg"
  case "$PM" in
    apt | pacman | zypper) pkg_install ffmpeg ;;
    dnf | yum) pkg_install ffmpeg 2>/dev/null || pkg_install ffmpeg-free || warn "Không cài được ffmpeg từ kho mặc định (RHEL/Rocky/Alma cần bật EPEL + RPM Fusion). Chỉ cần khi chạy worker trực tiếp; production dùng ffmpeg trong image Docker." ;;
  esac
}

install_docker() {
  step "Cài Docker Engine + Compose v2"
  if [[ $PM == pacman ]]; then
    pkg_install docker docker-compose
  elif have docker && ! docker compose version >/dev/null 2>&1; then
    # đã có docker nhưng thiếu plugin compose
    case "$PM" in
      apt) pkg_install docker-compose-plugin || pkg_install docker-compose-v2 ;;
      dnf | yum) pkg_install docker-compose-plugin ;;
      zypper) pkg_install docker-compose ;;
    esac
  else
    # Script cài đặt chính thức của Docker (thêm kho apt/dnf của Docker rồi cài engine + compose plugin).
    have curl || die "Cần curl để tải script cài Docker."
    local tmp; tmp=$(mktemp)
    curl -fsSL https://get.docker.com -o "$tmp" || die "Không tải được script cài Docker từ get.docker.com."
    warn "Sẽ chạy script cài đặt chính thức của Docker (get.docker.com) với quyền root."
    as_root sh "$tmp"; rm -f "$tmp"
  fi
  if [[ -d /run/systemd/system ]] && have systemctl; then
    as_root systemctl enable --now docker || warn "Không bật được dịch vụ docker bằng systemctl."
  else
    warn "Không có systemd: hãy tự khởi động docker daemon (ví dụ: sudo dockerd &)."
  fi
  if ((EUID != 0)) && have docker; then
    if ! id -nG | tr ' ' '\n' | grep -qx docker; then
      as_root usermod -aG docker "$(id -un)" && DOCKER_GROUP_ADDED=1
    fi
  fi
}
DOCKER_GROUP_ADDED=0

install_nvm() {
  step "Cài nvm $NVM_VERSION"
  have curl || die "Cần curl để tải nvm."
  local tmp; tmp=$(mktemp)
  curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/$NVM_VERSION/install.sh" -o "$tmp" || die "Không tải được script cài nvm."
  bash "$tmp"; rm -f "$tmp"
  load_nvm || die "Cài nvm xong nhưng không nạp được $NVM_DIR/nvm.sh."
}

install_node() {
  step "Cài Node $NODE_MAJOR (qua nvm)"
  load_nvm || die "Chưa có nvm."
  nvm_run install "$NODE_MAJOR" || die "nvm không cài được Node $NODE_MAJOR."
  nvm_run alias default "$NODE_MAJOR" >/dev/null || true
  nvm_run use "$NODE_MAJOR" >/dev/null || true
  hash -r
  [[ -f .nvmrc ]] || { echo "$NODE_MAJOR" >.nvmrc; ok "Đã tạo .nvmrc ($NODE_MAJOR) để nvm tự chọn đúng phiên bản trong dự án."; }
}

install_yarn() {
  step "Cài yarn (npm install -g yarn)"
  npm install -g yarn || warn "Không cài được yarn (npm -g cần quyền ghi). Nếu Node là bản hệ thống, thử: sudo npm install -g yarn"
}

if ((${#MISSING[@]})); then
  confirm "Cài/nâng cấp: ${MISSING[*]} ?" || die "Đã hủy (không cài gì thêm)."
  [[ -n $PM ]] || die "Không nhận ra trình quản lý gói; hãy cài thủ công các mục trên."

  install_basic
  ((SKIP_FFMPEG)) || ! in_list ffmpeg || install_ffmpeg
  ((SKIP_DOCKER)) || ! in_list docker || install_docker
  in_list nvm && install_nvm
  if in_list node || in_list npm; then
    load_nvm || install_nvm
    install_node
  fi
  ((WITH_YARN)) && in_list yarn && have npm && install_yarn
else
  ok "Không có gì cần cài."
fi

# ---------- bước tùy chọn trong dự án ----------
if ((DO_PROJECT)); then
  step "npm ci (cài phụ thuộc của dự án)"
  [[ -f package.json ]] || die "Không thấy package.json trong $(pwd)."
  have npm || die "Chưa có npm."
  npm ci
fi
if ((DO_E2E)); then
  step "Cài trình duyệt Playwright + thư viện hệ thống"
  have npx || die "Chưa có npx."
  [[ -d node_modules/@playwright ]] || npm ci
  npx playwright install --with-deps chromium
fi

# ---------- kiểm tra lại ----------
step "Kiểm tra lại"
load_nvm || true
hash -r
check_all
print_table
if ((${#MISSING[@]})); then
  warn "Vẫn còn thiếu/cũ: ${MISSING[*]}"
  exit 1
fi
ok "Môi trường đã sẵn sàng."

cat <<EOF

Bước tiếp theo:
  • Mở shell mới (hoặc chạy:  source "$NVM_DIR/nvm.sh") để dùng node/nvm/yarn.
EOF
if ((DOCKER_GROUP_ADDED)); then
  cat <<EOF
  • Đã thêm bạn vào nhóm 'docker': ĐĂNG XUẤT rồi đăng nhập lại (hoặc chạy:  newgrp docker) để dùng docker không cần sudo.
EOF
fi
cat <<'EOF'
  • Chạy dev:      cp .env.example .env   # rồi điền giá trị
                   docker compose --env-file .env -f docker/compose.dev.yml up -d
                   npm ci && npm run dev  # và npm run worker:dev ở terminal khác
  • Deploy:        ./scripts/deploy.sh --init --domain <tên-miền>   (xem docs/operations.md)
EOF
