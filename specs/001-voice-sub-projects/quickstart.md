# Quickstart: Chạy và kiểm chứng từ đầu đến cuối

Hướng dẫn chạy và kiểm tra, không chứa mã triển khai. Chi tiết: [data-model.md](data-model.md),
[contracts/openapi.yaml](contracts/openapi.yaml), [contracts/job-events.md](contracts/job-events.md),
[contracts/tts-provider.md](contracts/tts-provider.md).

## Yêu cầu

- Docker và Docker Compose; Node.js LTS (chạy kiểm thử ngoài container); ffmpeg (nằm sẵn trong ảnh `worker`).
- Cho **dev**: không cần Cloudflare. Cho **production**: tài khoản Cloudflare có tên miền và một Tunnel (token).
- Khóa API của ít nhất một nhà cung cấp (FPT.AI hoặc ShopAIKey) cho kiểm tra thủ công. Kiểm thử tự động dùng máy chủ giả, không cần khóa.

## 1. Cấu hình môi trường

Sao chép `.env.example` thành `.env` (không commit) và điền:

| Biến | Ý nghĩa |
| --- | --- |
| `DATABASE_URL`, `POSTGRES_PASSWORD` | PostgreSQL |
| `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, `S3_BUCKET` | MinIO và bucket riêng tư |
| `APP_ENCRYPTION_KEY` | Khóa 32 byte (base64) để mã hóa khóa API nhà cung cấp |
| `AUTH_SECRET`, `APP_URL` | Bí mật phiên và địa chỉ công khai |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Tài khoản Administrator được seed lúc khởi động |
| `CLOUDFLARE_TUNNEL_TOKEN` | Chỉ production |
| `ALLOW_INSECURE_PROVIDER_URLS` | Chỉ dev, cho phép `http` tới máy chủ giả; production luôn `false` |

## 2. Chạy ở máy dev

```powershell
docker compose -f compose.dev.yml up -d postgres minio
npm run db:migrate
npm run dev          # web
npm run worker:dev   # worker
```

Mở `http://localhost:3000`, đăng nhập bằng `ADMIN_EMAIL`/`ADMIN_PASSWORD`.

## 3. Kịch bản kiểm chứng (khớp "Independent Test" của spec)

| # | Kịch bản | Kết quả mong đợi | Spec |
| --- | --- | --- | --- |
| 1 | Admin vào Cài đặt AI, nhập cấu hình chung (loại, địa chỉ gốc, khóa), bấm Kiểm tra kết nối | "Thành công"; khóa hiển thị dạng che, không xem lại được | US9, FR-041 |
| 2 | Đăng ký User A; tạo Project (tên, mô tả, nhà cung cấp) | Project xuất hiện trong danh sách; tạo voice được ngay không cần duyệt | US7, US1, FR-034 |
| 3 | A upload file `.txt` ngắn, xem trước các đoạn, bấm tạo voice | Log đầu tiên ≤ 2 s; log chi tiết cập nhật theo thời gian thực; kết thúc `completed` | US1, SC-002 |
| 4 | Trong lúc chạy, đóng tab, mở lại sau vài phút | Tiến trình vẫn chạy hoặc đã xong; log đầy đủ, không mất, không trùng | US2, SC-003 |
| 5 | Mở voice: phát, tua, bấm vào một câu | Đoạn đang đọc được làm nổi bật và tự cuộn; tua thì nhảy đúng đoạn; bấm câu thì phát từ đó | US3, SC-004/005 |
| 6 | Dừng một tiến trình đang chạy, sửa giọng, chạy lại | Dừng giữ phần đã xong; chạy lại tái sử dụng các đoạn trùng (log `SEGMENT_CACHE_HIT`) | US4, SC-008 |
| 7 | Chọn nhiều tiến trình rồi xóa; chọn nhiều Project rồi xóa | Có hộp xác nhận nêu số lượng; dữ liệu và file trên MinIO biến mất | US4, US5, SC-009 |
| 8 | Tạo vài Project; tìm kiếm không dấu ("kich ban"), sắp xếp, lọc | Kết quả đúng, kết hợp được; trạng thái rỗng hợp lý | US6, SC-007 |
| 9 | User B truy cập địa chỉ Project/Voice/Job/audio của A | Luôn 404; không tải được audio | US7, SC-011 |
| 10 | Admin thêm A vào danh sách dùng cấu hình riêng; A nhập cấu hình riêng và tạo voice; Admin gỡ A | A thấy mục cấu hình riêng chỉ khi trong danh sách; usage ghi `user`; sau khi gỡ, job mới dùng cấu hình chung, cấu hình riêng bị vô hiệu nhưng còn | US9, FR-042..045 |
| 11 | Dashboard của A và trang thống kê của Admin | Số liệu khớp dữ liệu; chung/riêng tách riêng; User thường vào trang Admin nhận 404 | US8, SC-012 |
| 12 | Admin khóa rồi xóa A | Khóa: A không đăng nhập được, tiến trình dừng; xóa: dữ liệu và file bị xóa, còn thống kê ẩn danh | US7, FR-037 |
| 13 | Upload file 3 MB; vượt 500 MB lưu trữ; file `.pdf`; file không phải UTF-8 | Bị từ chối kèm lý do rõ, không tạo tiến trình | FR-009/046, US1.4 |
| 14 | Khởi động lại container `worker` giữa lúc chạy | Job `interrupted` rồi tự tiếp tục từ đoạn chưa xong và hoàn tất | Nguyên tắc III |

## 4. Kiểm thử tự động

```powershell
npm run test            # Vitest: đơn vị + tích hợp (Postgres/MinIO test + máy chủ nhà cung cấp giả)
npm run test:e2e        # Playwright: các kịch bản 2-12 ở trên
npm run test:isolation  # Bộ kiểm thử cô lập: User B gọi mọi endpoint bằng ID của User A, kỳ vọng 404
```

Phải xanh trước khi coi một user story là xong (Nguyên tắc V).

## 5. Kiểm tra thủ công với nhà cung cấp thật (có chủ đích, tốn phí)

Thực hiện Spike S1–S3 ([research.md](research.md)) bằng một câu tiếng Việt ngắn cho từng adapter; ghi lại chất lượng, độ trễ, định dạng.
Không đưa khóa vào mã nguồn, log hay ảnh chụp màn hình.

## 6. Triển khai production

```powershell
docker compose -f compose.prod.yml up -d --build
```

- Chỉ `cloudflared` ra Internet; `web` lắng nghe trong mạng Docker (`http://web:3000`).
- Trong Cloudflare Zero Trust → Tunnels → Public Hostname: trỏ tên miền tới `http://web:3000`.
- Xác nhận: từ ngoài, cổng của `postgres` và `minio` không truy cập được; `https://<tên-miền>` đăng nhập được;
  luồng log SSE hoạt động qua tunnel (Spike S4).
- Sao lưu: `pg_dump` PostgreSQL và đồng bộ bucket MinIO theo lịch.
