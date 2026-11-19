# Hợp đồng luồng sự kiện tiến trình (SSE)

`GET /api/jobs/{jobId}/events` — `Content-Type: text/event-stream`, yêu cầu đăng nhập; job của người khác trả 404.
Triển khai và lý do: [research.md R10](../research.md).

## Header phản hồi

```
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache, no-transform
X-Accel-Buffering: no
```

Không bật nén phản hồi cho luồng này.

## Tiếp tục sau khi mất kết nối

Mỗi sự kiện `log` có `id:` = `job_logs.id`. Khi trình duyệt tự kết nối lại, nó gửi `Last-Event-ID: <id cuối>` và máy chủ
trả tiếp các log có `id` lớn hơn. Không có `Last-Event-ID` → bắt đầu từ log đầu tiên (hoặc `?after=` để chỉ định).

## Sự kiện

| `event:` | Khi nào | `data:` (JSON) |
| --- | --- | --- |
| `log` | Có dòng log mới | `{ "id", "ts", "level": "info|warn|error", "code", "message", "meta": { "idx", "done", "total" } }` |
| `progress` | Tiến độ thay đổi (gộp, tối đa 1 lần/giây) | `{ "status", "done", "total", "percent" }` |
| `status` | Đổi trạng thái tiến trình | `{ "status": "queued|running|completed|failed|stopped|interrupted", "errorCode", "errorMessage", "voiceId" }` |
| `end` | Tiến trình ở trạng thái kết thúc (`completed|failed|stopped`) và đã gửi hết log | `{ "status" }` — sau đó máy chủ đóng luồng |
| `: keep-alive` | Mỗi 15 giây khi không có gì mới | (dòng bình luận SSE, không có `data`) |

`interrupted` không phải trạng thái kết thúc: luồng vẫn mở vì hệ thống sẽ tự đưa job vào hàng đợi lại.

## Mã log (`code`) tiêu biểu

| code | Ý nghĩa |
| --- | --- |
| `JOB_QUEUED`, `JOB_STARTED`, `JOB_RESUMED` | Vòng đời |
| `PROVIDER_SELECTED` | Cấu hình đã chọn (chỉ nêu chung/riêng, loại, model, giọng; **không** khóa hay URL có khóa) |
| `FILE_PARSED` | Đã đọc và tách `meta.total` đoạn |
| `SEGMENT_CACHE_HIT`, `SEGMENT_REQUEST`, `SEGMENT_DONE` | Từng đoạn |
| `RETRY` | Thử lại lỗi tạm thời (`meta.attempt`, lý do ngắn) |
| `SEGMENT_FAILED` | Đoạn lỗi vĩnh viễn (`CONTENT_BLOCKED`, `QUOTA`, `AUTH`, `VOICE_INVALID`…) |
| `MERGING`, `ENCODING`, `VOICE_SAVED` | Ghép và mã hóa |
| `JOB_STOP_REQUESTED`, `JOB_STOPPED` | Dừng |
| `JOB_INTERRUPTED` | Worker bị gián đoạn, sẽ tiếp tục |
| `JOB_FAILED`, `JOB_COMPLETED` | Kết thúc |

## Dự phòng

Nếu EventSource không kết nối được hoặc bị ngắt liên tục, giao diện chuyển sang polling
`GET /api/jobs/{jobId}/logs?after=<id>` mỗi 2 giây với cùng con trỏ.

## Yêu cầu kiểm thử

- Sự kiện log đầu tiên đến trong ≤ 2 giây sau khi job bắt đầu; mỗi sự kiện mới đến trong ≤ 2 giây (SC-002).
- Ngắt kết nối giữa chừng rồi nối lại: không mất và không trùng log (so khớp theo `id`).
- Hai tab cùng xem một job nhận cùng chuỗi log.
- User khác kết nối luồng của job không thuộc mình nhận 404.
