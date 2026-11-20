# Hợp đồng: tùy chọn giao diện (theme, ngôn ngữ, font, viền ô nhập, tab quản trị)

## Cookie và lưu trữ

| Khóa | Nơi | Giá trị | Ai đọc |
|------|-----|---------|--------|
| `theme` | `localStorage` (do `next-themes`) | `light` \| `dark` \| `system` | script nội tuyến trước khi vẽ (không nhấp nháy) |
| `locale` | cookie, `Path=/; SameSite=Lax; Max-Age=31536000` | `vi` \| `en` | máy chủ khi render (`<html lang>`, từ điển) và client |
| `users.theme`, `users.locale` | DB | như trên | `GET/PATCH /api/me`; khi đăng nhập ghi đè giá trị cục bộ nếu khác |

Quy tắc đồng bộ: người dùng đổi trên giao diện → cập nhật cục bộ ngay (không chờ mạng) → nếu đã đăng nhập thì `PATCH /api/me` nền; thất bại không chặn giao diện. Chưa có cookie/DB → mặc định `vi` và `system`. Trình duyệt chặn lưu trữ → dùng mặc định, không lỗi.

## Từ điển

- `vi.ts` là nguồn khóa (`type Dict = typeof vi`); `en.ts` khai báo `export const en: DeepStrings<Dict>` ⇒ thiếu hoặc thừa khóa là lỗi biên dịch.
- `scripts/check-i18n.ts` mở rộng: (1) không còn chuỗi tiếng Việt cứng ngoài `vi.ts`; (2) mọi khóa có ở cả hai từ điển và không có chuỗi rỗng; (3) đếm giữ chỗ (`{n}`) giống nhau giữa hai ngôn ngữ.
- Giữ chỗ dạng `{name}` thay bằng hàm `fmt(template, values)`; số nhiều dùng khóa riêng (`one`/`other`) cho các chuỗi có số đếm.

## Lỗi API

`HttpError` và zod mang `messageKey` (ví dụ `errors.NOT_FOUND`, `validation.passwordMin`) thay vì chuỗi; bộ bao `route()` dịch theo ngôn ngữ của yêu cầu và trả `{ error: { code, message, fields } }` đúng hợp đồng cũ. `code` không đổi theo ngôn ngữ (client dựa vào `code`).

## Log tiến trình

`GET /jobs/{id}/logs` và SSE vẫn trả `{ code, message, meta }` (message tiếng Việt như đã lưu). Giao diện dựng câu theo `code` + `meta` từ `dict.jobLog[code]` khi có mẫu, ngược lại hiển thị `message` đã lưu.

## Font

- `Be Vietnam Pro` qua `next/font/google`: `subsets ['latin','latin-ext','vietnamese']`, `weight ['400','500','600','700']`, `display 'swap'`, `variable '--font-be-vietnam'`.
- `--font-sans: var(--font-be-vietnam), system-ui, "Segoe UI", Roboto, "Noto Sans", sans-serif;`; `--font-heading` trỏ cùng font; `body { line-height: 1.5 }`; tiêu đề `line-height ≥ 1.25`.

## Token viền ô nhập

| Token | Sáng | Tối | Tương phản |
|-------|------|-----|------------|
| `--field-border` | `oklch(0.55 0 0)` | `oklch(0.62 0 0)` | ≥ 3:1 với `--background`, `--card`, `--input` (đo ở research R11) |
| viền khi focus | `--ring` + vòng 2 px (`ring-2`) | như trên | rõ hơn trạng thái thường |
| viền lỗi | `--destructive` | như trên | giữ nguyên |

Áp dụng một lần trong `src/components/ui/{input,textarea,select,popover-trigger,…}.tsx` (`border-input` → `border-field-border`); không sửa từng màn hình.

## Tab quản trị

`AdminNav` (client): tab đang chọn khi `pathname === href || pathname.startsWith(href + '/')`; thuộc tính `aria-current="page"`; kiểu đang chọn `bg-primary/10 font-semibold border-b-2 border-primary text-foreground`, kiểu thường `text-muted-foreground hover:bg-accent`; đúng một tab đang chọn; nhãn lấy từ từ điển.
