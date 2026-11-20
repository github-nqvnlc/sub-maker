# Nghiên cứu (Phase 0): Voice khớp mốc phụ đề, đa ngôn ngữ, Sáng/Tối, font tiếng Việt

**Ngày**: 2026-11-20 | **Spec**: [spec.md](./spec.md)

Không còn mục "NEEDS CLARIFICATION" nào trong Technical Context. Các quyết định dưới đây dựa trên đọc mã hiện có và số liệu đo thật (nêu rõ nguồn).

## R1. Phân tích cue SRT và chuẩn hóa

- **Quyết định**: thêm `parseSrtCues(text)` trong `src/lib/parsing/srt.ts` (cạnh `srtToParagraphs` hiện có, giữ nguyên hành vi "Đọc liên tục"). Mỗi cue → `{ n, startMs, endMs, text }`; mốc theo `hh:mm:ss,mmm` (chấp nhận dấu `.`); số thứ tự chỉ để đối chiếu, không dùng để đọc; làm sạch thẻ `<i>`, `{\an8}`, `[hh:mm:ss]`; nối các dòng của một cue bằng khoảng trắng; chuẩn hóa NFC.
- **Chuẩn hóa mốc bất thường** (mỗi lần xảy ra tạo một cảnh báo `{cue, code}`, tối đa 200 cảnh báo được lưu):
  - `end < start` hoặc `end == start` → bỏ cue (`BAD_RANGE`).
  - Cue ngoài thứ tự → sắp theo `startMs` (`OUT_OF_ORDER`).
  - Chồng lấn → khe thời gian của cue bị giới hạn bởi `startMs` của cue sau (`OVERLAP`).
  - Cue không có chữ đọc được (♪, `[Music]`, dòng rỗng) → giữ vị trí im lặng, không gửi yêu cầu (`NO_SPEECH`).
- **Phát hiện "có mốc hợp lệ"**: tệp `.srt` có ít nhất một cue hợp lệ ⇒ `hasTimecodes = true`; ngược lại chỉ cho "Đọc liên tục".
- **Lý do**: tái dùng bộ đọc đã được kiểm thử; thêm đường đọc cue mà không đổi đường cũ.
- **Phương án đã loại**: thư viện phân tích SRT bên thứ ba (thêm phụ thuộc cho phép toán ~40 dòng; cần kiểm soát từng loại cảnh báo).

## R2. Đơn vị đọc (ghép cue cùng câu)

- **Quyết định** (FR-007): hàm thuần `buildReadingUnits(cues, { merge, maxChars, maxGapMs })`.
  - `merge = true` (mặc định): gom cue liên tiếp cho đến cue kết thúc bằng `. ? ! … :` (bỏ qua ngoặc/nháy đóng ở cuối). Cắt nhóm sớm khi: khoảng nghỉ giữa hai cue liền nhau > `maxGapMs` (mặc định 1000 ms — người nói đã ngắt hơi, ghép sẽ lệch mốc), hoặc tổng ký tự vượt `maxChars` của nhà cung cấp (lấy từ `catalog.maxCharsPerRequest`; nhóm quá dài tách theo mệnh đề bằng `splitLongSentence` hiện có, thời gian chia theo tỷ lệ ký tự).
  - `merge = false`: mỗi cue một đơn vị.
- **Số liệu trên tệp mẫu** (đo bằng script trên `docs/example/tham-quyen-2026.srt`): 244 cue → **204 đơn vị** khi ghép theo `. ? ! … :` (tối đa 4 cue/nhóm); 167 đơn vị nếu không coi `:` là dấu kết câu (tối đa 5 cue). Chọn có `:` để giữ ngắt hơi tự nhiên sau "Bốn nguyên tắc:".
- **Mốc nội bộ** của từng cue trong đơn vị: chia theo tỷ lệ số ký tự trên thời lượng thực của đơn vị đã đặt mốc; chỉ dùng cho highlight, không dùng để cắt audio.
- **Đơn vị là đơn vị của cache** (`audio_cache.content_hash` đã gồm văn bản + giọng + model + tốc độ), nên bật/tắt ghép chỉ tạo lại các đơn vị có văn bản thay đổi (FR-009).

## R3. Thuật toán đặt mốc, nén nhẹ và "trượt nhẹ" (FR-004, FR-006)

- **Quyết định**: hàm thuần `placeUnits(units, params)` trong `src/lib/audio/placement.ts` (không I/O, kiểm thử bằng số). Mọi phép tính theo **số mẫu PCM** như `TimelineBuilder` hiện có (24 kHz, 16-bit).
- **Trước khi đo**: cắt khoảng lặng đầu/cuối audio nhà cung cấp trả (ngưỡng −45 dB, giữ lại 30 ms) để thời lượng đọc phản ánh lời thật. *Giả thuyết cần kiểm chứng ở quickstart*: các số đo 27% cue tràn khe ở mục "Kết quả điều tra" của spec là **thời lượng thô** có thể gồm vài trăm ms im lặng của nhà cung cấp, nên tỷ lệ tràn thật có thể thấp hơn.
- **Với từng đơn vị i** (theo thứ tự), `S_i` là mốc bắt đầu của cue đầu đơn vị, `S_{i+1}` của đơn vị kế tiếp (hoặc +∞ với đơn vị cuối), `cursor` là mẫu kết thúc của đơn vị trước, `minGap = 60 ms`:
  1. `start = max(S_i, cursor + minGapSamples)`; `slip = start − S_i`. `cursor` khởi tạo bằng `−minGap` để đơn vị đầu bắt đầu đúng `S_0` (kể cả `S_0 = 0`).
  2. `avail = S_{i+1} − minGap − start` (mượn toàn bộ khoảng nghỉ liền sau, không lấn sang mốc của đơn vị kế).
  3. Nếu `audio ≤ avail`: không nén. Ngược lại `f = audio / avail`; nếu `f ≤ maxCompress` (mặc định 1,25): nén bằng `atempo=f` (giữ cao độ) cho vừa khít; nếu `f > maxCompress`: nén `maxCompress`, phần còn lại tràn qua `S_{i+1}` và **được chuyển thành độ trễ** của đơn vị kế (bước 1 lần sau). Đây chính là "trượt nhẹ".
  4. Độ trễ tự giảm dần vì `start = max(S_i, …)`: gặp khoảng nghỉ đủ dài thì `slip` về 0.
  5. Nếu `slip > maxSlip` (mặc định 500 ms) → đánh dấu `overflow` kèm số cue (cảnh báo), **vẫn đặt đơn vị** ở vị trí không chồng tiếng và chạy tiếp (không dừng tiến trình, không cắt lời).
- **Đầu ra**: danh sách `{ idx, startMs, endMs, slipMs, compress, overflow }` và số mẫu im lặng phải ghi trước mỗi đơn vị. Voice dài bằng mốc kết thúc cue cuối hoặc lâu hơn nếu cue cuối tràn.
- **Nén bằng ffmpeg** (đã có trong worker): `ffmpeg -f s16le -ar 24000 -ac 1 -i - -filter:a atempo=f -f s16le -` trên PCM từng đơn vị (một tiến trình ngắn mỗi đơn vị cần nén); `atempo` nhận 0,5–2 nên 1,25 nằm trong dải an toàn; nén chỉ khi cần.
- **Lý do chọn trượt nhẹ thay vì tạo lại ở tốc độ cao**: quyết định của người dùng (Q1-A): giữ giọng tự nhiên, không tốn thêm lần gọi, chi phí ước tính chính xác.
- **Phương án đã loại**: tạo lại cue ở `speed` cao (tốn tiền, giọng nhanh bất thường, phá cache); cắt bớt lời (mất nội dung).

## R4. Chia phần cho phụ đề dài, tiếp tục không làm lại (FR-012, FR-014)

- **Quyết định**: "phần" là khái niệm **suy ra**, không có bảng riêng. `planParts(units, windowMs = 10 phút)` chọn điểm cắt là **khoảng nghỉ dài nhất** nằm trong ±20% quanh mỗi mốc `k·windowMs`; mỗi phần là dải đơn vị liền nhau. Trạng thái bền vững vẫn ở mức đơn vị (`job_segments`) cộng cache, nên tiếp tục sau gián đoạn bỏ qua mọi đơn vị đã `done` và phần suy ra sẽ tự báo "đã xong".
- **Ghép**: không tạo từng tệp phần rồi mới ghép; đơn vị được ghi **tuần tự vào một tệp PCM** theo mốc tuyệt đối (như `mergeAndSave` hiện có, không giữ toàn bộ PCM trong RAM). Vì mốc tuyệt đối neo lại ở mỗi đơn vị và `slip` về 0 tại khoảng nghỉ lớn, sai lệch không cộng dồn (SC-003); điểm cắt phần chọn ở khoảng nghỉ lớn nên `slip` luôn về 0 ở đó.
- **Điều phối**: các phần được xử lý lần lượt theo thứ tự (mỗi phần chạy đơn vị song song theo `segmentConcurrency`); log ghi theo phần ("Phần 3/18 — 204–260/…") thay vì từng đơn vị khi số đơn vị > 200; tiến độ hiển thị theo phần và theo đơn vị.
- **Lý do**: giữ nguyên mô hình `job_segments` + cache đã được kiểm thử; không thêm bảng và không thêm tệp tạm trên MinIO.
- **Phương án đã loại**: bảng `job_parts` với tệp audio từng phần (thêm trạng thái phải đồng bộ, tốn dung lượng gấp đôi trên MinIO); chia theo số ký tự rồi căn chỉnh lại (lỗi cộng dồn).

## R5. Giới hạn tốc độ nhà cung cấp và thời gian chờ

- **Dữ kiện**: docs FPT AI ghi gói Thường (FPT.AI-VITs) ~30 yêu cầu/phút/khóa. Pipeline hiện chỉ thử lại khi gặp 429 (backoff + `Retry-After`).
- **Quyết định**: thêm bộ giới hạn **chủ động** theo cấu hình AI (token bucket trong bộ nhớ worker) đọc `requestsPerMinute` từ catalog (giá trị mặc định ghi rõ là *ước tính theo tài liệu*, Administrator ghi đè bằng cài đặt hệ thống `rpmFptMarketplace`, `rpmShopaikeyOpenai`, `rpmShopaikeyMinimax` (0 = theo catalog; không cần migration), đúng Nguyên tắc IV "không hard-code như sự thật cố định"). 429 vẫn xử lý bằng backoff như cũ.
- **Ước tính thời gian** (FR-008): `ceil(requestsPhaiGoi / rpm)` phút + thời gian xử lý ngoài; hiển thị là "khoảng".

## R6. Ước tính trước khi tạo voice (FR-008, FR-013)

- **Quyết định**: endpoint `POST /api/files/{fileId}/estimate` (chủ sở hữu tệp) nhận `{ model, voice, speed, timing }`, trả: số cue, số đơn vị, số ký tự đọc (đã bỏ số thứ tự/mốc), số đơn vị đã có trong cache (so `content_hash` theo user), số yêu cầu phải gọi, thời lượng voice ước tính (chế độ "Đọc liên tục": `ký tự / 14,5` giây — số đo thật 15,5 ký tự/s của giọng và 14,0 của phụ đề; chế độ khớp mốc: **bằng `subtitle_files.duration_ms`** vì voice dài đúng bằng phụ đề), dung lượng MP3 ước tính (thời lượng × 16 KB/s ở 128 kbps), so sánh với hạn mức còn lại, thời gian xử lý ước tính (R5), và số tiền nếu `price_per_million_chars` của cấu hình đã có (không có → `priceConfigured:false`, không bịa số).
- **Chặn**: nếu dung lượng ước tính vượt hạn mức còn lại → `quotaOk:false` và API tạo job từ chối (`QUOTA_EXCEEDED`) kèm số byte cần giải phóng; kiểm tra ở máy chủ (Nguyên tắc IV).
- **Ngoài phạm vi** (không còn thuộc spec này): ngưỡng xác nhận chi phí/trần chi phí 50 USD của spec 002 bị xóa.

## R7. Điều khiển giới hạn của đặt mốc bằng cài đặt hệ thống

- **Quyết định**: thêm khóa số vào bảng cài đặt hiện có (`SETTING_DEFAULTS` + màn hình Cài đặt hệ thống): `timingMaxSlipMs` (500), `timingMaxCompressPct` (125), `timingPartMinutes` (10), `timingMergeGapMs` (1000) và ba khóa `rpm*` (0 = theo catalog, R5). Không cần migration (bảng cài đặt là khóa–giá trị số).

## R8. Kiến trúc đa ngôn ngữ (FR-020…FR-025)

- **Dữ kiện**: toàn bộ chữ nằm trong `src/lib/i18n/vi.ts` (448 dòng, không có hàm), được import trực tiếp ở 37 module (client, server, zod, worker, lỗi API); `html lang="vi"` cố định; `check-i18n.ts` chặn chuỗi tiếng Việt cứng. Có sẵn `next-themes` nhưng chưa có `ThemeProvider`.
- **Quyết định**: tự xây lớp mỏng, **giữ cú pháp truy cập thuộc tính có kiểm tra kiểu**, không dùng next-intl:
  - `src/lib/i18n/index.ts`: `type Dict = typeof vi`; `en.ts` khai báo `export const en: DeepStrings<Dict> = {…}` ⇒ **thiếu khóa là lỗi biên dịch** (FR-023); `getDict(locale)`.
  - **Client**: `I18nProvider` (nhận `locale` + từ điển từ layout gốc) và hook `useT()` trả về từ điển hiện tại; **Server component/route**: `getT()` đọc cookie `locale` (hoặc `users.locale` của người dùng đã đăng nhập).
  - **Ngoài React** (zod, `HttpError`, worker): lỗi mang **khóa** (`messageKey: 'errors.NOT_FOUND'`) và bộ bao `route()` dịch khi trả lời theo ngôn ngữ của yêu cầu; schema zod dùng khóa thay vì chuỗi (`validation.passwordMin`) và dịch ở tầng trả lỗi.
  - **Log tiến trình** là chuỗi đã lưu trong DB: giao diện dựng lại câu theo `code` + `meta` từ từ điển khi có mẫu, không có mẫu thì hiển thị chuỗi tiếng Việt đã lưu (log cũ không mất).
  - Định dạng ngày/giờ/số/tiền dùng `Intl` theo locale (`vi-VN`/`en-US`) qua `useFormat()`.
  - Thêm ngôn ngữ thứ ba = thêm một tệp từ điển + một mục trong danh sách locale (FR-025).
- **Lý do không dùng next-intl**: mã dùng từ điển cả ngoài React (zod, worker, `HttpError`) nên phải tự lo phần đó dù dùng thư viện nào; thư viện thêm cú pháp khóa dạng chuỗi (mất kiểm tra kiểu theo thuộc tính hiện có) và định tuyến/plugin chưa cần. Tự xây giữ việc chuyển đổi 37 module ở mức thay `vi.` bằng `t.`.
- **Phương án đã loại**: tiền tố ngôn ngữ trên URL (`/en/...`) — đổi toàn bộ địa chỉ, ảnh hưởng guard/E2E, không cần cho ứng dụng sau đăng nhập.

> **Ghi chú triển khai R8**: lỗi API và thông báo máy chủ không mang `messageKey` mà được **dịch ở ranh giới trả lời** bằng bảng ánh xạ câu tiếng Việt → câu đích (`src/lib/i18n/server-messages.ts`: tự động cho `vi.errors`/`vi.validation`, thủ công/mẫu cho các câu viết trực tiếp), vì cách này không phải đụng ~35 chỗ tạo lỗi và vẫn giữ `code` ổn định. Test `tests/unit/i18n-dict.test.ts` quét mã nguồn để bảo đảm mọi câu tiếng Việt trong lời gọi tạo lỗi đều có bản dịch. Nhật ký tiến trình dựng lại theo `code` + `meta` (`src/lib/i18n/job-log.ts`).

## R9. Lưu lựa chọn theme/ngôn ngữ, không nhấp nháy (FR-016, FR-017, FR-021)

- **Quyết định**:
  - **Theme**: bọc `ThemeProvider` của `next-themes` (`attribute="class"`, `defaultTheme="system"`, `enableSystem`, `storageKey="theme"`) — script nội tuyến của thư viện đặt lớp `dark` trước khi vẽ nên không nhấp nháy sai theme; `html` đã có `suppressHydrationWarning`.
  - **Ngôn ngữ**: cookie `locale` (`Path=/; SameSite=Lax; Max-Age` 1 năm; không chứa dữ liệu nhạy cảm nên không cần HttpOnly) quyết định `<html lang>` và từ điển khi render ở máy chủ.
  - **Theo tài khoản**: thêm cột `users.locale` (`vi|en`, mặc định `vi`) và `users.theme` (`light|dark|system`, mặc định `system`); `PATCH /api/me` nhận thêm hai trường; khi đăng nhập, giá trị của tài khoản ghi đè cookie/localStorage nếu khác. Trình duyệt chặn lưu trữ → vẫn chạy với mặc định.
- **Lý do**: đáp ứng "lưu theo tài khoản khi đã đăng nhập, theo trình duyệt khi chưa" mà không thêm trang đổi ngôn ngữ riêng.

## R10. Font phù hợp tiếng Việt (FR-026…FR-028)

- **Bằng chứng**: dữ liệu font của `next/font/google` trong `node_modules` cho thấy **Outfit chỉ có subset `latin`, `latin-ext`** (không có `vietnamese`), trong khi Be Vietnam Pro, Inter, Noto Sans, Roboto, Open Sans, Lexend đều có `vietnamese`.
- **Quyết định**: **Be Vietnam Pro** (thiết kế riêng cho tiếng Việt, dấu chồng cân đối), `subsets: ['latin','latin-ext','vietnamese']`, weights 400/500/600/700, `display: 'swap'`, `next/font` tự lưu font cùng ứng dụng khi build (không gọi Google lúc chạy) và tự sinh font dự phòng điều chỉnh số đo (`adjustFontFallback`) để giảm nhảy bố cục. Chuỗi dự phòng: `system-ui, "Segoe UI", Roboto, "Noto Sans", sans-serif` (đều có tiếng Việt). Tăng `line-height` nền lên 1,5 và kiểm tra tiêu đề (không đặt `line-height` < 1,25) để dấu chồng không bị cắt. Đổi biến `--font-outfit`/`--font-sans` trong `globals.css`.
- **Kiểm chứng**: trang kiểm thử chữ cái (xem quickstart) + kiểm thử tự động đọc `document.fonts` đảm bảo ký tự có dấu dùng font chính.
- **Lưu ý build**: Docker build cần mạng tới Google Fonts một lần (như Outfit hiện tại), runtime không cần.
- **Phương án đã loại**: Inter (rất phổ biến nhưng dấu chồng ở cỡ nhỏ kém cân đối hơn); font hệ thống (không đồng nhất giữa máy).

## R11. Viền ô nhập nổi bật ở cả hai theme (FR-019)

- **Dữ kiện đo** (WCAG, nền `--background` sáng 0,9911, tối 0,1822): hiện tại ô nhập dùng `border-input`; độ tương phản của `--input` so với nền chỉ **1,08:1 (Sáng)** và **1,21:1 (Tối)**, `--border` chỉ 1,33:1 ⇒ không đạt ≥ 3:1.
- **Quyết định**: thêm token riêng `--field-border` (không sửa `--border` dùng cho thẻ/đường kẻ) trong hai khối `:root` và `.dark` của theme: Sáng `oklch(0.55 0 0)` (≈4,7:1 với nền, ≈4,5:1 với ô điền); Tối `oklch(0.62 0 0)` (≈4,9:1 với nền, ≈4,1:1 với ô điền `--input` tối). Focus dùng `--ring` đậm hơn (vòng 2 px + viền chuyển sang `--ring`); lỗi dùng `--destructive` (đã có). Thêm `--color-field-border` vào `@theme inline`; sửa **một nơi**: các thành phần `input`, `textarea`, `select`, `popover` trigger, ô tìm kiếm trong `src/components/ui/*` đổi `border-input` → `border-field-border` (theo Nguyên tắc VI không sửa từng màn hình).
- **Kiểm thử**: một test đơn vị đọc `globals.css`, chuyển OKLCH → sRGB, tính tương phản và khẳng định ≥ 3:1 với `--background`, `--card` và `--input` ở cả hai theme.
- **Phương án đã loại**: thêm lớp `border-2` tại từng màn hình (vi phạm Nguyên tắc VI, dễ sót).

## R12. Tab quản trị đang chọn (FR-029)

- **Dữ kiện**: `src/app/(admin)/admin/layout.tsx` là server component, render danh sách `Link` không có trạng thái đang chọn.
- **Quyết định**: tách `AdminNav` (client, dùng `usePathname`) đặt `aria-current="page"` cho tab khớp tiền tố đường dẫn; kiểu đang chọn: nền `bg-primary/10`, chữ đậm `font-semibold`, gạch chân `border-b-2 border-primary` (không chỉ dựa vào màu), kiểu thường: `text-muted-foreground hover:bg-accent`. Dùng thành phần/kiểu đã có của hệ thống thiết kế (token `primary`), không tạo màu mới. Văn bản nhãn lấy từ từ điển (R8).

## R13. Chiến lược kiểm thử (Nguyên tắc V) và giới hạn dữ liệu thử

- **Chỉ thị của người dùng**: **không** kiểm thử trên cả tệp mẫu (quá dài); mọi kiểm thử dùng đoạn tối đa **10 giây**. Cố định `tests/fixtures/sample-10s.srt` (3 cue đầu của tệp mẫu, kết thúc ở 9,77 giây) và các phụ đề tổng hợp ngắn.
- **Kiểm thử tự động**:
  - Đơn vị: `parseSrtCues` (mốc, cảnh báo), `buildReadingUnits` (ghép theo dấu kết câu, giới hạn khoảng nghỉ và độ dài), `placeUnits` (mượn khoảng nghỉ, nén, trượt nhẹ, cờ `overflow`, bất biến không chồng tiếng, `slip` về 0), `planParts` (cắt ở khoảng nghỉ lớn), tương phản màu (R11), đủ khóa từ điển (R8).
  - Tích hợp: tạo job `timed` với **nhà cung cấp giả** có thể điều khiển thời lượng theo văn bản (mở rộng `mock-provider/server.ts` bằng scenario trên đường dẫn: `ms-<n>` (thời lượng = ký tự × n ms), `pad-<n>`, `429-<k>`, `blocked-<từ khóa>`), kiểm tra mốc trong voice trùng mốc phụ đề trong ±150 ms, tiếp tục không gọi lại, cô lập dữ liệu giữa hai người dùng cho `cues`/`estimate`.
  - E2E (Playwright): chuyển Sáng/Tối/Hệ thống và giữ sau tải lại, đổi English và giữ lại, tab quản trị nổi bật, tạo voice khớp mốc với `sample-10s.srt`.
  - Isolation: hợp nhất các thao tác mới vào `specs/001-voice-sub-projects/contracts/openapi.yaml` (tệp mà `tests/isolation/isolation.test.ts` đọc và kiểm tra **mọi** thao tác).
- **Gọi nhà cung cấp thật**: chỉ thủ công, ≤ 3 cue của `sample-10s.srt`.

## R14. Ghi chú đã hoàn tất trước kế hoạch

- Bỏ `.skt`, chỉ nhận `.srt` (migration `0004_rename_skt_to_srt.sql`, đổi `srt.ts`, test, tài liệu) — làm theo yêu cầu của người dùng trước khi lập kế hoạch này.

## R15. Xử lý đoạn bị chặn nội dung và sửa thiết lập (bổ sung sau phân tích)

- **Hiện trạng** (`src/worker/jobs/generate-voice.ts` dòng 291–298): nếu có đoạn `content_blocked` thì job `failed` và **không** tạo voice; `manage.ts` đưa mọi đoạn về `pending` khi sửa thiết lập nhưng giữ nguyên chỉ số đoạn.
- **Quyết định** (FR-010): ở chế độ `timed`, chỉ loại lỗi `content_blocked` được chuyển thành khe im lặng + `failed: true` trong `timeline`; job kết thúc `completed`; `failedSegments` vẫn do `getJobDetail` trả. Lỗi khác (`auth`, `quota`, `forbidden_model`, `voice_invalid`, `bad_request`, `ssrf_blocked`, `transient` hết lần thử) giữ nguyên nhánh `FATAL_KINDS` → job `failed`, tiếp tục được. Chế độ "Đọc liên tục" **không đổi** (vẫn `failed` khi có đoạn bị chặn) để không hồi quy spec 001.
- **Sửa thiết lập** (`manage.ts`): khi `settings.timing` đổi, tạo lại `job_segments` theo danh sách đơn vị mới (chỉ số đơn vị phụ thuộc `mergeCues`); cache theo văn bản đơn vị bảo toàn những gì tái dùng được.
- **Thuật ngữ giao diện**: nhãn "đoạn" cho đơn vị đọc, "cue" cho dòng phụ đề gốc (giữ nhãn "Đoạn lỗi" của spec 001).
