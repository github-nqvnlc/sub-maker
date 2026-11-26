# Hợp đồng: token → cue, sửa cue, tìm thay, từ điển, xuất tệp

Mọi hàm trong tài liệu này là **hàm thuần** ở `src/lib/video/`, không đọc CSDL hay mạng, kiểm thử bằng dữ liệu cố định.

## 1. Token → cụm (`segmentation.ts`)

Đầu vào: `SonioxToken[]` theo đúng thứ tự trả về.

1. Bỏ token `is_audio_event`.
2. Gom dãy liên tiếp token lời gốc (`translation_status` là `original`, `none` hoặc vắng) cùng người nói thành phần gốc của một cụm.
3. Dãy `translation` ngay sau đó là phần dịch của cụm đó. Dãy dịch không có phần gốc đứng trước thì nối vào cụm trước.
4. Cụm `none` (đã ở ngôn ngữ đích): phần dịch = phần gốc, cờ `sameLanguage`.
5. Cụm `original` không nhận được phần dịch: phần dịch rỗng, cờ `untranslated`; cue giữ câu gốc và dùng câu gốc làm câu hiển thị.
6. Mốc cụm = `start_ms` token gốc đầu, `end_ms` token gốc cuối. Token dịch **không** có mốc.
7. Token dưới từ được ghép theo khoảng trắng đầu token (cùng quy tắc `stt-chunker`); chữ chuẩn hóa NFC.

## 2. Cụm → câu → cue

- Ngắt câu **chỉ ở ranh giới cụm**, khi: phần dịch kết thúc bằng `. ! ? …` (hoặc dạng toàn rộng); đổi người nói; khoảng nghỉ giữa hai cụm > 300 ms; hoặc câu đã dài quá 7 giây.
- Giới hạn một cue: câu dịch ≤ 24 từ; chuỗi không có khoảng trắng (`zh`, `ja`, `th`) ≤ 84 ký tự. Mục tiêu 5–14 từ.
- Câu vượt giới hạn: cắt tại ranh giới cụm gần nhất với dấu ngắt nhịp (`, ; :`) → `timing = measured`. Một cụm tự vượt giới hạn: cắt phần dịch tại dấu câu hoặc giữa, chia thời gian theo trọng số chữ (`wordWeight`), hút mốc cắt về ranh giới từ gốc gần nhất; phần gốc chia theo mốc đó → `timing = estimated`.
- Cue có hơn 12 từ được chèn một `\n` cân hai dòng (ưu tiên sau dấu câu), mỗi dòng ≤ 12 từ (42 ký tự với chuỗi không khoảng trắng).
- Thời lượng tối thiểu 700 ms: kéo dài cuối cue vào khoảng trống, không chồng cue sau, không vượt thời lượng video.
- Chồng mốc (người nói chen nhau): cắt cue trước tại đầu cue sau; cue còn dưới 100 ms thì gộp vào cue sau. Nếu gộp sẽ vượt giới hạn chữ thì giữ cue trước ở 100 ms và lùi đầu cue sau (làm rõ khi cài đặt T042).
- `flags.fast` khi tốc độ đọc câu dịch > 21 ký tự mỗi giây.

**Bất biến kiểm thử**: nối phần dịch của mọi cue (bỏ khoảng trắng) bằng nối mọi token dịch và `none`; tương tự phần gốc; cue tăng dần, không chồng, `end − start ≥ 100`; cùng đầu vào cho cùng đầu ra.

## 3. Lô thao tác sửa cue (`cue-ops.ts`, dùng chung trình duyệt và máy chủ)

```ts
type CueOp =
  | { type: 'update'; id: string; patch: Partial<Pick<Cue, 'startMs'|'endMs'|'sourceText'|'targetText'>> }
  | { type: 'insert'; cue: Cue }          // id do trình duyệt sinh (uuid) để hoàn tác được
  | { type: 'delete'; id: string };
type CueBatch = { baseRevision: number; ops: CueOp[] };   // 1–20.000 thao tác
```

- `applyOps(cues, ops, durationMs)` trả danh sách mới và lô nghịch đảo, hoặc lỗi nêu cue vi phạm; áp dụng **tất cả hoặc không**.
- Gộp = `update` cue đầu + `delete` cue sau (nối chữ bằng khoảng trắng). Tách = `update` + `insert`, mốc tách mặc định tại vị trí con trỏ chữ theo trọng số.
- Sửa mốc đặt `timing = manual`.
- Dịch mốc ±100/±500 ms bị kẹp để không vượt cue liền kề.

## 4. Tìm và thay thế (`find-replace.ts`)

`find(cues, { query, column: 'target'|'source', caseSensitive, wholeWord, matchDiacritics })` → `{ cueId, start, end, matched }[]` theo vị trí trong chuỗi NFC.

- Mặc định `matchDiacritics = false` khi từ tìm không có dấu, `true` khi có dấu. So không dấu: tách NFD, bỏ dấu tổ hợp, `đ → d`, giữ bảng ánh xạ về vị trí gốc để không cắt giữa ký tự.
- `wholeWord`: hai đầu không kề chữ cái hoặc chữ số Unicode.
- `variants(matches)` → các dạng khớp khác nhau kèm số lượng; nhiều hơn một dạng khác dấu thì giao diện phải xác nhận trước "Thay tất cả" (FR-025).
- `replaceOps(cues, matches, replacement)` → một `CueBatch`; vị trí không còn khớp bị bỏ qua và không được đếm.

## 5. Từ điển (`glossary.ts`)

- Dán hàng loạt: mỗi dòng một cặp; dòng có `->` thì tách tại `->` đầu tiên, không thì tại dấu phẩy đầu tiên. `target` bằng `source` hoặc để chọn "giữ nguyên" → `keep`.
- Lỗi theo dòng: thiếu vế, quá 100 ký tự mỗi vế, trùng `source`. Dòng hợp lệ vẫn được thêm.
- Giới hạn lấy từ cài đặt, truyền vào hàm, không viết cứng: `videoGlossaryMaxPairs` (mặc định 200), `videoGlossaryMaxChars` (tổng ký tự hai vế, mặc định 8.000). Xem lại mặc định sau lần gọi thật.
- Gửi Soniox: `context.translation_terms = [{ source, target }]`.

## 6. Xuất `.srt`, `.vtt` (`subtitle-files.ts`)

- `content`: `target` (mặc định), `source`, `bilingual` (dòng gốc trên, dịch dưới). Cue có chuỗi rỗng bị bỏ và số thứ tự liên tục.
- `.srt`: `hh:mm:ss,mmm`. `.vtt`: dòng đầu `WEBVTT`, `hh:mm:ss.mmm`, thoát `&`, `<`, `>`.
- Dòng trống trong chữ bị bỏ để không vỡ cấu trúc tệp; chuỗi `-->` trong chữ được thay bằng `→`.
- UTF-8, NFC. Tên tệp: tên video bỏ đuôi + `.{ngôn ngữ}.{srt|vtt}`.
