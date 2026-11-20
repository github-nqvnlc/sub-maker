# Mô hình dữ liệu: Voice khớp mốc phụ đề, đa ngôn ngữ, Sáng/Tối

**Ngày**: 2026-11-20 | **Spec**: [spec.md](./spec.md) | **Nghiên cứu**: [research.md](./research.md)

Mọi thay đổi là **bổ sung** lên mô hình của spec 001; migration `0005_subtitle_cues_and_preferences.sql` (Drizzle, đánh số tiếp sau `0004_rename_skt_to_srt`). Không xóa/đổi tên cột hiện có.

## Thay đổi bảng hiện có

### `subtitle_files` (thêm cột)

| Cột | Kiểu | Ràng buộc | Ghi chú |
|-----|------|-----------|---------|
| `has_timecodes` | boolean | `NOT NULL DEFAULT false` | `true` khi `.srt` có ≥ 1 cue hợp lệ (FR-001). `.txt/.md` luôn `false`. |
| `cue_count` | integer | `NULL`, `CHECK (cue_count IS NULL OR cue_count >= 0)` | số cue hợp lệ sau chuẩn hóa |
| `duration_ms` | integer | `NULL`, `CHECK (duration_ms IS NULL OR duration_ms >= 0)` | `end_ms` của cue cuối |
| `cue_warnings` | jsonb | `NOT NULL DEFAULT '[]'` | `[{ cue: number, code: 'BAD_RANGE'\|'OUT_OF_ORDER'\|'OVERLAP'\|'NO_SPEECH' }]`, **tối đa 200 phần tử**; số lượng thật nằm ở `cue_warning_count` |
| `cue_warning_count` | integer | `NOT NULL DEFAULT 0` | tổng số cảnh báo (kể cả phần bị cắt khỏi `cue_warnings`) |

Hàng cũ giữ `has_timecodes = false` (không có cue được lưu) ⇒ chỉ dùng "Đọc liên tục"; muốn khớp mốc thì tải lại tệp. Tệp `.srt` cũ đã đổi tên từ `skt` (migration 0004) cũng vậy.

### `users` (thêm cột)

| Cột | Kiểu | Ràng buộc | Ghi chú |
|-----|------|-----------|---------|
| `locale` | text | `NOT NULL DEFAULT 'vi'`, `CHECK (locale IN ('vi','en'))` | ngôn ngữ giao diện (FR-021); thêm ngôn ngữ = nới `CHECK` bằng migration |
| `theme` | text | `NOT NULL DEFAULT 'system'`, `CHECK (theme IN ('light','dark','system'))` | FR-016/017 |

### `voice_jobs.settings` (jsonb `JobSettings`, không đổi cột)

Thêm trường tùy chọn (hàng cũ không có trường này ⇒ chế độ `continuous`):

```ts
timing?: {
  mode: 'timed';          // vắng mặt ⇒ 'continuous' (như hiện nay)
  mergeCues: boolean;     // "Ghép cue cùng câu" (mặc định true)
  params: {               // chốt tại lúc tạo job từ cài đặt hệ thống → kết quả tái lập được
    maxSlipMs: number;        // mặc định 500
    maxCompressPct: number;   // mặc định 125 (= 1,25×)
    mergeGapMs: number;       // mặc định 1000
    partMinutes: number;      // mặc định 10
  };
}
```

### `voice_jobs` / `job_segments` (không đổi cột)

- Ở chế độ `timed`, `job_segments.idx` là chỉ số **đơn vị đọc** (0…N−1) tính lại xác định từ `subtitle_cues` + `timing`; `progress_total` = số đơn vị. Đơn vị `done` + cache còn ⇒ bỏ qua khi tiếp tục (FR-014).
- `job_segments.duration_ms` lưu thời lượng thô **sau khi cắt lặng đầu/cuối**, trước khi nén.
- **Đoạn bị chặn nội dung** (`CONTENT_BLOCKED`): hàng `job_segments` giữ `status = 'failed'`, `error_code = 'CONTENT_BLOCKED'`; job kết thúc `completed` (không `failed`) và `GET /api/jobs/{id}` vẫn trả `failedSegments` như spec 001; phần tử `timeline` tương ứng có `failed: true`. Các lỗi khác vẫn đặt job `failed` như hiện nay.
- **Sửa thiết lập rồi tiếp tục** (`src/lib/jobs/manage.ts`): nếu `settings.timing` đổi (chế độ hoặc `mergeCues`), xóa và tạo lại toàn bộ `job_segments` theo danh sách đơn vị mới và đặt lại `progress_done`/`progress_total`; nếu không đổi thì giữ hành vi cũ (đưa mọi đoạn về `pending` khi đổi giọng/model/tốc độ).

### `voices.timeline` (jsonb)

Mở rộng phần tử (chế độ `continuous` giữ nguyên `{ idx, startMs, endMs }`):

```ts
type TimelineEntry = {
  idx: number; startMs: number; endMs: number;
  // chỉ có ở voice khớp mốc:
  text?: string;                 // văn bản của đơn vị (để trình phát hiển thị không cần bảng khác)
  slipMs?: number;               // độ trễ so với mốc phụ đề (≥ 0)
  compress?: number;             // hệ số nén đã áp dụng (1 = không nén)
  overflow?: boolean;            // true khi slipMs > maxSlipMs
  failed?: boolean;              // true khi đoạn bị nhà cung cấp từ chối nội dung: khe im lặng, không có audio
  cues?: Array<{ n: number; text: string; startMs: number; endMs: number }>; // mốc nội bộ chia theo ký tự + chữ của từng cue (highlight theo cue)
};
```

Kích thước ước tính: ~250 byte/đơn vị cộng chữ của từng cue (văn bản được lưu hai lần: ở `text` và ở `cues[].text`) ⇒ 3 giờ phụ đề (~3.000 đơn vị) ≈ 1,2 MB jsonb, chấp nhận được (đọc một lần khi mở voice). `text` của đơn vị dùng khi hiển thị theo đoạn; `cues[].text` dùng khi bôi theo cue.

## Bảng mới

### `subtitle_cues`

| Cột | Kiểu | Ràng buộc | Ghi chú |
|-----|------|-----------|---------|
| `id` | uuid | PK, `defaultRandom` | |
| `subtitle_file_id` | uuid | `NOT NULL`, FK → `subtitle_files(id)` `ON DELETE CASCADE` | xóa tệp/Project/User kéo theo xóa cue (Nguyên tắc V: xóa sạch dữ liệu) |
| `idx` | integer | `NOT NULL`, `CHECK (idx >= 0)` | thứ tự sau chuẩn hóa, từ 0 |
| `n` | integer | `NOT NULL` | số thứ tự gốc trong tệp (chỉ để đối chiếu/hiển thị, không dùng để đọc) |
| `start_ms` | integer | `NOT NULL`, `CHECK (start_ms >= 0)` | |
| `end_ms` | integer | `NOT NULL`, `CHECK (end_ms > start_ms)` | sau chuẩn hóa chồng lấn (đã giới hạn bởi cue sau) |
| `text` | text | `NOT NULL` | chữ đọc đã làm sạch, NFC; rỗng khi `speakable = false` |
| `speakable` | boolean | `NOT NULL DEFAULT true` | `false` ⇒ không gửi nhà cung cấp (`NO_SPEECH`) |
| `char_count` | integer | `NOT NULL`, `CHECK (char_count >= 0)` | số ký tự tính phí (code point, NFC) |

Ràng buộc: `UNIQUE (subtitle_file_id, idx)`; chỉ mục `(subtitle_file_id, start_ms)`. **Bất biến** sau khi tạo (như `segments`). Cô lập: không có cột `owner_id` riêng; quyền truy cập luôn qua `subtitle_files.owner_id` (như `segments`), được đưa vào kiểm thử cô lập.

Chèn theo lô (1.000 dòng/lô, như `SEGMENT_CHUNK` của `createJob`).

## Thực thể logic (không có bảng)

- **Đơn vị đọc (ReadingUnit)**: `{ idx, cueFrom, cueTo, text, startMs (của cue đầu), slotEndMs (cuối cue cuối), chars }` — suy ra từ `subtitle_cues` + `timing` bằng `buildReadingUnits`; xác định (cùng đầu vào ⇒ cùng đơn vị) nên tiếp tục job không cần lưu lại.
- **Phần (Part)**: `{ n, fromUnit, toUnit, startMs, endMs }` — `planParts`; chỉ phục vụ log/tiến độ và điểm cắt.
- **Bản ước tính (Estimate)**: kết quả `POST /api/files/{fileId}/estimate`; không lưu.

## Quan hệ và vòng đời

```
users 1─n subtitle_files 1─n subtitle_cues        (xóa tệp ⇒ xóa cue)
subtitle_files 1─n voice_jobs 1─n job_segments    (idx = đơn vị đọc khi timing.mode = 'timed')
voice_jobs 1─1 voices (timeline mở rộng)
audio_cache (không đổi): khóa = userId | provider | model | voice | speed | format | văn bản đơn vị
```

- **Tải lên `.srt`**: phân tích → ghi `subtitle_files` (+ `has_timecodes`, `cue_*`) và `subtitle_cues` trong **một giao dịch**; vẫn ghi `segments` như hiện nay (đường "Đọc liên tục").
- **Hạn mức**: `subtitle_cues` không tính vào hạn mức byte (dữ liệu cấu trúc của tệp đã tính).
- **Xóa**: Project/User/tệp xóa kéo theo cue qua `ON DELETE CASCADE`; `reconcile-storage` không cần đổi (cue không có đối tượng MinIO).

## Quy tắc kiểm tra (trích từ spec)

| Quy tắc | Nguồn |
|---------|-------|
| `.srt` chỉ chấp nhận khi có ≥ 1 cue hợp lệ cho chế độ khớp mốc; ngược lại `has_timecodes=false` | FR-001, FR-003 |
| Số thứ tự và dòng mốc không nằm trong `text`, không tính vào `char_count` | FR-002, SC-002 |
| `end_ms > start_ms` và cue không chồng lấn sau chuẩn hóa | FR-005 |
| Đơn vị đọc ≤ `maxCharsPerRequest` của nhà cung cấp | FR-007 |
| `slip` ≤ `maxSlipMs`, nếu vượt ⇒ `overflow = true` + cảnh báo | FR-006 |
| `locale ∈ {vi,en}`, `theme ∈ {light,dark,system}` | FR-016, FR-020 |
