# Research: Video overlay phụ đề chạy đồng bộ với voice

**Date**: 2026-11-25 | **Spec**: [spec.md](./spec.md)

Số đo trong tài liệu này lấy trên máy dev: Windows, Ryzen 5 2600X (12 luồng), Node 22.14, ffmpeg 8.1, `@napi-rs/canvas` 1.2.0, chữ Arial Bold 72 px, phụ đề mẫu `docs/example/tham-quyen-2026.srt` (244 cue), khung 1080×1920, 30 hình/giây, 60 giây, **chưa có tiếng**. Đây là **phép đo thử**, không phải cam kết: ảnh worker dùng Debian bookworm (ffmpeg 5.1) và máy production có thể chậm hơn, nên phải đo lại trong ảnh Docker ở task đầu tiên.

## R1. Cách dựng hình chữ

- **Decision**: Một bộ dựng hình duy nhất viết bằng TypeScript trên API Canvas 2D, dùng chung: trình duyệt vẽ lên `<canvas>` cho xem trước; worker vẽ bằng `@napi-rs/canvas` (Skia) rồi đẩy khung RGBA thô vào ffmpeg. Hàm vẽ là hàm thuần theo `(thời điểm, cấu hình, bố cục)`.
- **Rationale**: FR-031 và SC-005 đòi xem trước giống video. Cùng mã và cùng họ engine (Skia) nên giống nhau do cấu tạo. Đo `measureText` của 244 cue giữa Chrome 156 và `@napi-rs/canvas`: **lệch tối đa 0 px**. Lưu ý: độ mờ bóng **không** co theo `ctx.scale` (đo: ở tỉ lệ 0,25 vùng bóng rộng 232 thay vì 116 đơn vị), nên xem trước phải vẽ ở đúng kích thước xuất rồi co bằng CSS. Chrome vẽ một khung 1080×1920 khoảng 1 ms nên làm được. Tốc độ toàn tuyến (vẽ + đọc khung + mã hóa):

  | Cảnh | Định dạng | Thời gian cho 60 s video | Dung lượng |
  | --- | --- | --- | --- |
  | Hiện dứt khoát | mp4 | 15,1 s | 0,74 MB |
  | Bung ra + bóng | mp4 | 16,4 s | 1,58 MB |
  | Karaoke phóng từ + viền + bóng | mp4 | 26,2 s | 2,95 MB |
  | Phát sáng | mp4 | 27,4 s | 1,89 MB |
  | Nhòe, bộ lọc blur từng từ trên cả khung | mp4 | 114,7 s | 1,63 MB |
  | Karaoke | webm trong suốt | 30,5 s | 4,90 MB |
  | Karaoke | mov trong suốt | 21,9 s | 206 MB |

  Như vậy SC-009 (5 phút video trong 5 phút) đạt với dư địa khoảng 2–4 lần trên máy dev.
- **Alternatives considered**: libass (tệp `.ass`): mã hóa nhanh tương đương (14,4 s) nhưng xem trước phải chạy libass bản WebAssembly, và hộp nền bo góc, quét màu, phát sáng khó làm giống. Chromium không giao diện chụp khung: giống tuyệt đối với xem trước nhưng ảnh worker tăng hàng trăm MB và chậm. Vẽ bằng `MediaRecorder` ở trình duyệt: trái FR-035 (chạy nền).

## R2. Hiệu ứng nhòe

- **Decision**: Chữ của câu được vẽ một lần lên lớp phụ cắt vừa khối chữ; nhòe bằng cách thu nhỏ rồi phóng to lớp đó, không dùng `filter: blur()` mỗi từ.
- **Rationale**: Đo: `blur()` một lớp 33,8 ms/khung, thu-phóng 16,8 ms/khung, so với khoảng 535 ms/khung khi lọc từng từ. Chỉ áp dụng trong 100–600 ms đầu câu. Cũng tránh phụ thuộc `ctx.filter` (Safari cũ không có).
- **Alternatives considered**: giữ `ctx.filter` (chậm, không đồng đều giữa trình duyệt).

## R3. Khung lặp

- **Decision**: Hàm vẽ trả "khóa khung"; khung có khóa trùng khung trước thì gửi lại bộ đệm cũ, không vẽ và không đọc điểm ảnh.
- **Rationale**: Cảnh "hiện dứt khoát" chỉ phải đọc 41/1800 khung, "bung ra" 190/1800. Đọc khung là phần tốn nhất (6–12 ms với cảnh đổi liên tục).
- **Alternatives considered**: chỉ gửi dải chữ rồi ffmpeg đệm nền (giảm băng thông khoảng 3 lần). Để dành: làm khi đo trong Docker không đạt SC-009.

## R4. Tiến trình dựng hình tách riêng

- **Decision**: Worker `fork` một tiến trình con cho mỗi lần xuất (`src/worker/render/main.ts`), hạ độ ưu tiên CPU, giao tiếp qua IPC; ffmpeg là con của tiến trình này. Cha giữ nhịp tim, tiến độ, hủy.
- **Rationale**: Vẽ là việc đồng bộ nặng; chạy trong tiến trình worker sẽ làm trễ nhịp tim (quá hạn 30 s) và tiến trình voice/STT (FR-041, SC-011). Tiến trình con còn cô lập lỗi bộ nhớ của thư viện gốc và dừng ngay được bằng tín hiệu.
- **Alternatives considered**: `worker_threads` (lỗi gốc làm chết cả worker); dịch vụ Docker riêng (thêm vận hành, chưa cần; hàng đợi riêng nên tách sau được).

## R5. Định dạng và tham số mã hóa

- **Decision**:
  - Phông màu: `.mp4`, H.264 `yuv420p` CRF 18 `veryfast`, gắn thẻ BT.709, `faststart`; tiếng AAC 192 kbps.
  - Trong suốt mặc định: `.mov` ProRes 4444 (`prores_ks`, `qscale 11`, `alpha_bits 8`), tiếng AAC.
  - Trong suốt gọn: `.webm` VP9 `yuva420p`, CRF 24, tiếng Opus.
- **Rationale**: Đo màu nền sau giải mã: xanh lá `(0,253,0)` ở đủ 40 000 điểm ảnh lấy mẫu (đồng nhất tuyệt đối), xanh dương `(0,0,251)`, đen `(0,0,0)`. Lệch do làm tròn YUV, vì vậy kiểm thử FR-009 dùng dung sai 4 mức mỗi kênh. Dung lượng 60 s chữ bung ra (libass, dùng để so bộ mã hóa):

  | Cách mã hóa trong suốt | Thời gian | Dung lượng/phút |
  | --- | --- | --- |
  | ProRes 4444 mặc định | 114,4 s | 226 MB |
  | ProRes 4444 `qscale 11`, alpha 8 bit | 24,5 s | 139 MB |
  | ProRes 4444 `qscale 30` | 24,9 s | 117 MB |
  | ProRes 4444, khung trống hoàn toàn | 14,3 s | 53 MB |
  | QuickTime Animation (`qtrle`) | 15,9 s | 26 MB |
  | PNG trong MOV | 16,6 s | 96 MB |
  | VP9 alpha thời gian thực | 27,3 s | 1,3 MB |

  ProRes 4444 được chọn vì REQ-005 nêu tên và vì tương thích rộng; phần khung trống đã tốn 53 MB/phút nên giảm chất lượng thêm không giúp nhiều.
- **Hệ quả với hạn mức (FR-043)**: với 500 MB, `.mov` chỉ chứa khoảng **2–3,5 phút**; `.webm` 10 phút khoảng 65 MB; `.mp4` 60 phút khoảng 270 MB kèm tiếng (theo mức ước tính ở R11). Video trong suốt dưới 1 phút (117–226 MB) **vẫn vừa hạn mức**, nên điều kiện "xem lại FR-043" trong Assumptions **không xảy ra**. Giao diện phải nói rõ và gợi ý `.webm`.
- **Alternatives considered**: `qtrle` nhỏ hơn 5–8 lần. Chưa chọn vì chưa kiểm được Premiere, DaVinci Resolve, After Effects có giữ kênh trong suốt không; là phép thử tay trong [quickstart.md](./quickstart.md) §6, đạt cả ba thì đổi sang `qtrle`.

## R6. Căn khung với thời gian

- **Decision**: Số khung `N = round(durationMs × 30 / 1000)`; khung `k` đại diện thời điểm `(k + 0,5)/30` giây; câu hiện khi thời điểm nằm trong `[bắt đầu, kết thúc)`. Tính từ chỉ số khung, không cộng dồn. Tiếng được đệm/cắt đúng `N/30` giây.
- **Rationale**: Lệch tối đa 16,7 ms (SC-002 cho 50 ms), thời lượng lệch tối đa 16,7 ms (SC-003), không trôi ở phút 60.
- **Alternatives considered**: lấy thời điểm đầu khung (lệch tới 33 ms); khung hình biến thiên (phần mềm dựng phim xử lý kém).

## R7. Mốc áp dụng của câu (FR-004)

- **Decision**: Nếu voice do tiến trình khớp mốc tạo từ đúng tệp đã chọn, ghép theo **chuỗi chữ bỏ khoảng trắng**: nối `text` của mọi mục `voices.timeline` (kể cả mục bị tách hoặc `failed`) phải bằng nối chữ của mọi cue có chữ trong tệp. Mỗi cue ứng với một dải ký tự; mốc đầu và cuối dải được nội suy tuyến tính theo ký tự trong mục chứa nó (đầu dải trùng ranh giới thì lấy đầu mục sau, cuối dải lấy cuối mục trước). Cue chạm mục `failed` dùng mốc tệp; các cue khác vẫn dùng mốc voice. Chuỗi không bằng nhau thì cả tệp dùng mốc tệp kèm cảnh báo. Sau đó kẹp: `start` không sớm hơn `start` cue trước cộng 34 ms (một khung), ẩn tại `min(max(đọc xong, kết thúc trong tệp), cue kế hiện, hết voice)`.
- **Rationale**: Voice khớp mốc có thể trễ tới 0,5 s so với tệp; dùng mốc thật thì chữ theo đúng tiếng. Mã hiện tại (`merge-timed.ts`) không ghi `cues` cho câu dài bị tách và cho mục `failed`, nên ghép theo số cue sẽ hỏng cả tệp chỉ vì một câu. Đã chạy `buildReadingUnits` trên tệp mẫu 244 cue với 4 giới hạn ký tự (400, 200, 60, 30) và hai chế độ ghép: chuỗi chữ bỏ khoảng trắng bằng nhau ở cả 8 trường hợp, kể cả khi 366 đơn vị bị tách. Kịch bản bất biến sau khi tạo. Kẹp cần có vì cue dùng mốc voice có thể trễ hơn cue dùng mốc tệp đứng sau nó.
- **Alternatives considered**: ghép theo `timeline[].cues` và số cue (hỏng khi có câu bị tách hoặc lỗi); dựng lại đơn vị đọc từ thiết lập job (phụ thuộc giới hạn nhà cung cấp lúc đó); luôn dùng mốc tệp (lệch với tiếng).

## R8. Ước lượng mốc từng từ (FR-024, FR-025)

- **Decision**: Chia khoảng đọc theo trọng số: từ thường `3 + số ký tự chữ`, chữ số tính `4` mỗi chữ số, từ chỉ có ký hiệu `1`; quãng nghỉ sau `, ; :` bằng 0,5 và sau `. ! ? …` bằng 0,8 trọng số trung bình của câu (không tính cuối câu, tổng nghỉ ≤ 25% khoảng đọc). Mốc tính bằng cộng dồn trọng số rồi làm tròn nên không trôi và luôn nằm trong khoảng.
- **Rationale**: Tiếng Việt đơn âm tiết, thời gian mỗi tiếng gần đều nên phần hằng số lớn hơn phần theo độ dài. Hàm thuần, cùng đầu vào cho cùng kết quả.
- **Chưa đo**: SC-008 (80% từ trong 300 ms). Không có mốc chuẩn từng từ ở máy dev mà không gọi nhà cung cấp tính phí. Cách đo ở [quickstart.md](./quickstart.md) §7; hệ số nằm trong một hằng số để chỉnh sau khi đo.
- **Alternatives considered**: chia đều theo từ; chia theo ký tự (từ ngắn lướt quá nhanh).

## R9. Phông chữ

- **Decision**: Đóng gói TTF tĩnh 400/700/800 của Be Vietnam Pro, Roboto, Montserrat, Inter và Arimo (400/700, thay Arial) vào `public/fonts/overlay/`; trình duyệt nạp bằng `FontFace`, worker nạp bằng `GlobalFonts`. Kèm Noto Sans làm phông chữ thay thế. Bảng ký tự hỗ trợ sinh sẵn (`coverage.json`) để cảnh báo ký tự thiếu. Chữ chuẩn hóa NFC.
- **Rationale**: Cùng tệp phông chữ là điều kiện để R1 đúng. Đều có giấy phép mở (OFL/Apache, lưu kèm tệp giấy phép); Arial không được phép phân phối nên dùng Arimo có cùng độ rộng chữ. CSP hiện có `font-src 'self'` nên phải tự phục vụ.
- **Việc kèm theo**: `docker/Dockerfile` tầng `web` hiện **không** chép `public/`, nên phải thêm `COPY public`; tầng `worker` thêm `COPY public/fonts/overlay`.
- **Alternatives considered**: `next/font` (tên họ phông chữ bị băm, worker không dùng được); Google Fonts lúc chạy (CSP chặn); phông chữ emoji màu (10 MB, hình khác nhau giữa máy; chọn cảnh báo thiếu ký tự).

## R10. Tệp âm thanh tải lên

- **Decision**: Web nhận tệp vào vùng tạm, việc nền `prepare-overlay-audio` đo và chuyển thành MP3 192 kbps có thẻ Xing rồi mới tính hạn mức; trạng thái `processing → ready | failed`. Kiểm đuôi tệp và ép bộ tách tương ứng (`-f mp3|wav|mov`, `-protocol_whitelist file`).
- **Rationale**: Ảnh `web` không có ffmpeg nên không đo được thời lượng tại chỗ. Chuyển về một dạng giúp tua chính xác trong trình duyệt (MP3 VBR thiếu chỉ mục và ALAC không đáng tin) và WAV 100 MB thành khoảng 14 MB trong hạn mức.
- **Rủi ro đã biết**: Cloudflare Tunnel giới hạn thân yêu cầu theo gói (thường 100 MB với gói miễn phí), nên tệp sát 100 MB có thể bị chặn trước khi tới ứng dụng; giống giới hạn đang có ở spec 004.
- **Alternatives considered**: giữ nguyên tệp gốc; đo thời lượng ở trình duyệt (không tin được ở máy chủ).

## R11. Hạn mức lưu trữ (FR-043, FR-044)

- **Decision**: Lưu `estimated_bytes` ở tiến trình; khi tạo, trong giao dịch có khóa tư vấn theo User, kiểm `đã dùng + Σ ước tính tiến trình đang chờ/chạy + ước tính mới ≤ hạn mức`. Không cộng ước tính vào `storage_used_bytes`. Khi xong, ghi đối tượng vào khóa cố định theo id trước, rồi trong **một giao dịch** vừa `reserveBytes` chặt theo dung lượng thật vừa chuyển `completed`; vượt hoặc job không còn `running` thì xóa đối tượng (báo `QUOTA_EXCEEDED` nếu vượt). Worker chết giữa chừng thì lần chạy sau ghi đè cùng khóa và hạn mức chưa hề bị trừ. Mọi đường kết thúc khác `completed` đều xóa đối tượng ở khóa đó. Khi đang xuất, tiến trình con dừng sớm nếu tệp tạm đã lớn hơn chỗ còn lại. Tệp tạm `overlay-tmp/` bị trừ khỏi đối soát, User có tiến trình overlay được coi là bận.
- **Ước tính MB/phút** (khung 1080×1920, kèm tiếng 1,4): mp4 4,5; webm 6,5; mov 212. Khung vuông nhân 0,6. Nằm trong một bảng hằng ghi rõ là ước tính.
- **Rationale**: Số trên Dashboard luôn là dung lượng thật (SC-014); không tiến trình nào làm vượt hạn mức kể cả khi nhiều việc cùng lúc.
- **Alternatives considered**: cộng trước ước tính vào bộ đếm (Dashboard sai, phải hoàn lại khi sự cố).

## R12. Hàng đợi và đồng thời

- **Decision**: Hàng đợi `render-overlay` (retry 0, `localConcurrency: 10` bằng mức tối đa của cài đặt; giới hạn thật do bước nhận việc) và `prepare-overlay-audio` (`localConcurrency: 2`). Nhận việc có khóa tư vấn như `generate-voice`: đếm tiến trình `running` < `maxConcurrentOverlayJobs` và ưu tiên việc tạo trước. Nhịp tim 2 s, sweeper 30 s chuyển `interrupted` và xếp lại; gián đoạn quá 3 lần trong một lượt chạy thì `failed` (`RENDER_CRASHED`); đếm ở cột `interruptions`, đặt về 0 khi người dùng chạy lại. Lỗi tạm thời thử lại tối đa 3 lần với `backoffMs` có sẵn.
- **Rationale**: Dùng lại khuôn mẫu đã kiểm thử; giới hạn riêng nên không đụng chỗ của voice/STT.
- **Alternatives considered**: `localConcurrency` cố định của pg-boss (Administrator không chỉnh được khi đang chạy).

## R13. Cập nhật tiến độ

- **Decision**: Tiến trình con báo mỗi 500 ms, cha ghi CSDL tối đa 1 lần/giây; giao diện hỏi lại mỗi 1 giây khi còn việc chạy.
- **Rationale**: Đạt 2 giây của FR-036 và theo cách STT đang làm (hỏi định kỳ), không thêm SSE mới.
- **Alternatives considered**: SSE riêng (phức tạp hơn, lợi ích nhỏ).

## R14. Bảo mật

- **Decision**: Cấu hình kiểm bằng Zod `.strict()` (màu `#RRGGBB`, số trong khoảng, danh sách đóng); chữ chỉ đi vào `fillText`/`strokeText`, không vào tham số ffmpeg hay HTML; tham số ffmpeg là mảng cố định không qua shell; tên tệp tải về làm sạch như hiện có. Mọi truy vấn kèm `owner_id`; phát qua `serveObject`.
- **Rationale**: FR-045, FR-046, Nguyên tắc I. Cách dựng hình bằng canvas loại bỏ rủi ro chèn lệnh của `drawtext`/`ass`.

## R15. Cảnh báo màu (FR-010, FR-011)

- **Decision**: Chỉ xét màu đang dùng: chữ luôn xét; viền, hộp nền khi bật; màu nổi bật khi `sync = karaoke` hoặc (`sync = cue` và `enter = glow`). Phông xanh: cảnh báo khi sắc độ lệch ≤ 40° và độ bão hòa, độ sáng (HSV) đều ≥ 0,25. Phông đen: cảnh báo khi độ sáng tương đối < 0,02. Hàm thuần dùng chung.
- **Rationale**: Thỏa danh sách của FR-010: `#00FF66` (144°, lệch 24°) bị cảnh báo; `#FFE600` (54°, lệch 66°) và `#FF4500` thì không; trắng có bão hòa 0.

## Ràng buộc kiểm thử

Theo chỉ thị đã có từ spec 003, dữ liệu kiểm thử tự động tối đa 10 giây. Việc không trôi ở 60 phút được kiểm bằng kiểm thử đơn vị trên phép tính khung (R6), không xuất video dài.

## Không còn điểm NEEDS CLARIFICATION

Các điểm chưa đo và nơi xử lý: hiệu năng trong ảnh Docker (task đầu tiên), SC-008 (quickstart §7), độ tương thích phần mềm dựng phim (quickstart §6), Firefox/Safari so với Skia (quickstart §5).
