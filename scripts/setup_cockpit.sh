#!/bin/bash

# Manual infrastructure provisioning; not part of AI service startup/deployment.

# Usage:
#   chmod +x setup_cockpit.sh
#   sudo ./setup_cockpit.sh [domain]
# Ví dụ:
#   sudo ./setup_cockpit.sh yourdomain.com     # Cấu hình với domain system.yourdomain.com
#   sudo ./setup_cockpit.sh                    # Nhấn Enter để bỏ qua domain, chỉ dùng IP
# ==============================================================================
# Script tự động cài đặt và cấu hình Cockpit trên Ubuntu Server
# ==============================================================================

set -e

# ------------------------------------------------------------------------------
# 0. Nhập Domain (tùy chọn; để trống sẽ chỉ cấu hình IP)
# ------------------------------------------------------------------------------
INPUT_DOMAIN="$1"
if [ -z "$INPUT_DOMAIN" ]; then
    read -p "👉 Nhập domain (ví dụ: yourdomain.com - hoặc nhấn [Enter] để bỏ qua chỉ dùng IP): " INPUT_DOMAIN
fi

# Làm sạch input: loại bỏ https://, http://, dấu / ở cuối và khoảng trắng
CLEAN_DOMAIN=$(echo "$INPUT_DOMAIN" | sed -e 's|^https\?://||' -e 's|/.*||' | tr -d ' ')

# Lấy địa chỉ IP của máy chủ
SERVER_IP=$(hostname -I | awk '{print $1}')

if [ -n "$CLEAN_DOMAIN" ]; then
    # Đảm bảo subdomain luôn là system.<domain> nếu người dùng nhập domain
    if [[ "$CLEAN_DOMAIN" =~ ^system\. ]]; then
        FULL_DOMAIN="$CLEAN_DOMAIN"
    else
        FULL_DOMAIN="system.${CLEAN_DOMAIN}"
    fi
    ORIGINS_LINE="Origins = https://${FULL_DOMAIN} https://${SERVER_IP}:9090 http://127.0.0.1:9090 http://localhost:9090"
else
    FULL_DOMAIN=""
    ORIGINS_LINE="Origins = https://${SERVER_IP}:9090 http://127.0.0.1:9090 http://localhost:9090"
fi

echo "=============================================================================="
echo " Cấu hình Cockpit:"
if [ -n "$FULL_DOMAIN" ]; then
    echo " - Subdomain & Domain: https://${FULL_DOMAIN}"
else
    echo " - Chế độ:             Chỉ dùng IP máy chủ (Bỏ qua domain)"
fi
echo " - Server IP:          ${SERVER_IP}"
echo "=============================================================================="

echo "=== 1. Cập nhật danh sách gói phần mềm ==="
sudo NEEDRESTART_MODE=a DEBIAN_FRONTEND=noninteractive apt update -y

echo "=== 2. Cài đặt Cockpit & Plugin PCP (Lưu lịch sử hiệu năng) ==="
sudo NEEDRESTART_MODE=a DEBIAN_FRONTEND=noninteractive apt install -y -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confold" cockpit cockpit-pcp sscg
sudo systemctl enable --now pcp pmcd pmlogger 2>/dev/null || true

echo "=== 3. Cấu hình Cockpit Reverse Proxy & Origins ==="
sudo mkdir -p /etc/cockpit
sudo tee /etc/cockpit/cockpit.conf > /dev/null << EOF
[WebService]
${ORIGINS_LINE}
ProtocolHeader = X-Forwarded-Proto
ForwardedForHeader = X-Forwarded-For
AllowUnencrypted = true
EOF

# Cho phép root đăng nhập nếu cần (bỏ chặn trong disallowed-users)
if [ -f /etc/cockpit/disallowed-users ]; then
    sudo sed -i 's/^root/#root/' /etc/cockpit/disallowed-users
fi

echo "=== 4. Kích hoạt và khởi động lại dịch vụ Cockpit ==="
sudo systemctl enable --now cockpit.socket
sudo systemctl restart cockpit.socket cockpit.service

echo "=== 5. Cấu hình Firewall (UFW) ==="
if command -v ufw &> /dev/null && sudo ufw status | grep -q "active"; then
    echo "Phát hiện UFW đang bật. Đang mở cổng 9090/tcp..."
    sudo ufw allow 9090/tcp
    sudo ufw reload
else
    echo "UFW chưa kích hoạt hoặc không tồn tại. Bỏ qua bước mở cổng firewall."
fi

echo "=== 6. Kiểm tra trạng thái dịch vụ ==="
systemctl is-active --quiet cockpit.socket && echo "STATUS: Cockpit socket đang chạy (Active)!" || echo "STATUS: Có lỗi xảy ra với Cockpit socket."

echo ""
echo "=============================================================================="
echo " CHÚC MỪNG! Quá trình cài đặt và cấu hình Cockpit đã hoàn tất."
echo " Bạn có thể truy cập Cockpit từ trình duyệt theo:"
if [ -n "$FULL_DOMAIN" ]; then
    echo " 🌐 Domain Tunnel: https://${FULL_DOMAIN}"
fi
echo " 🔒 Direct IP:     https://${SERVER_IP}:9090"
echo "=============================================================================="
