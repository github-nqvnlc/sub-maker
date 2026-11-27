# Research: Dịch video tự động và gắn đè phụ đề

**Date**: 2026-11-26 | **Spec**: [spec.md](./spec.md)

Số đo trong tài liệu này lấy trên máy dev: Windows 10, Intel i3-12100 (8 luồng), ffmpeg 8.1.1, nguồn giả `testsrc2` + tiếng sin. Đây là **phép đo thử**, không phải cam kết: ảnh worker dùng Debian bookworm (ffmpeg 5.1) và video thật khó nén hơn, nên phải đo lại ở bước 0 (xem [plan.md](./plan.md)). Thông tin Soniox và thư viện đọc từ tài liệu chính thức ngày 2026-11-26; **chưa gọi Soniox thật** vì mỗi lần gọi có phí.

## R1. Cách gắn cứng phụ đề

- **Decision**: Dùng lại bộ vẽ Canvas của spec 005. Tiến trình con vẽ **chỉ dải ngang chứa chữ** (RGBA, alpha nhân sẵn), đẩy vào `stdin` của ffmpeg; ffmpeg giải mã video nguồn, ghép bằng bộ lọc `overlay` và mã hóa. Khung trùng khóa với khung trước thì gửi lại bộ đệm cũ. Dải chữ là hợp của mọi khối chữ cộng viền, bóng và quãng chuyển động của hiệu ứng; dải cao hơn 60% khung thì vẽ cả khung.
- **Rationale**: FR-036 và SC-009 đòi xem trước giống thành phẩm; cùng một bộ vẽ cho kết quả giống nhau do cấu tạo, và spec 005 đã đo độ rộng chữ giữa Chrome và `@napi-rs/canvas` lệch 0 px. Số đo phần ffmpeg (khung chữ giả, CRF 20 `veryfast`):

  | Cách làm | 1080p30 (60 s) | 4K30 (20 s) |
  | --- | --- | --- |
  | Chỉ mã hóa lại (mốc so sánh) | 7,0 s (8,6×) | 9,1 s (2,2×) |
  | libass, hiện dứt khoát | 9,0 s (6,7×) | 9,6 s (2,1×) |
  | `overlay` cả khung | 22,6 s (2,7×) | 25,8 s (0,78×) |
  | `overlay` dải 30%, đổi mỗi 2,5 s | 10,4 s (5,8×) | 16,4 s (1,2×) |
  | `overlay` dải 30%, đổi mọi khung | 10,5 s (5,7×) | 14,7 s (1,4×) |

  Bảng **chưa gồm thời gian vẽ chữ** (máy dev chưa cài `@napi-rs/canvas`, xem R15). Spec 005 đo vẽ + đọc khung + mã hóa 1080×1920 nhanh hơn thời gian thực 2,1–3,9 lần cho cả khung, nên với dải chữ, SC-010 (10 phút 1080p trong 20 phút, tức 0,5×) còn dư địa lớn. Video 4K dài 180 phút có thể mất vài giờ; giao diện phải hiện thời gian ước tính.
- **Đo lại trong ảnh worker (T003, 2026-11-26)** bằng `scripts/video-bench.ts`: gồm **cả vẽ chữ** (bộ vẽ của spec 005, `@napi-rs/canvas`), ffmpeg 5.1.9 (Debian bookworm), cùng máy i3-12100, ffmpeg dùng 6 luồng, tham số đúng contracts/render-and-media.md §3. Có đủ `zscale`, `tonemap`, `overlay=alpha=premultiplied`, bộ tách `mov`, `matroska`, `avi`, `flv`, bộ mã `libx264`, `aac`, `libmp3lame`. **Cổng ĐẠT** (cần 1080p ≥ 0,5×).

  | Khung | Cảnh | Tốc độ | Trong đó vẽ chữ | Dải chữ |
  | --- | --- | --- | --- | --- |
  | 1080p30, 60 s | chữ đứng yên | 4,85× | 2,2 s / 12,4 s | 1920×272 |
  | 1080p30, 60 s | karaoke (đổi mọi khung) | 4,05× | 6,9 s / 14,8 s | 1920×272 |
  | 4K30, 20 s | chữ đứng yên | 1,33× | 1,1 s / 15,0 s | 3840×544 |
  | 4K30, 20 s | karaoke | 1,18× | 7,6 s / 16,9 s | 3840×544 |

  Ở 4K bài đo vẽ chữ ở 1080p rồi phóng dải lên (bộ vẽ lúc đo chưa vẽ thẳng ở cỡ đích); nguồn giả `testsrc2` dễ nén hơn video thật nên SC-010 vẫn phải đo lại trên video thật (T139).
- **Alternatives considered**: libass (`.ass`): nhanh hơn khoảng 1,2–1,7 lần nhưng xem trước phải chạy libass bản WebAssembly, và hộp nền bo góc, karaoke phóng từ, phát sáng khó làm giống; phải viết lại mọi hiệu ứng. Dựng ở trình duyệt bằng WebCodecs: trái FR-047 (chạy nền). Vẽ cả khung: chậm hơn 2–3 lần.

## R2. Bố cục theo khung chuẩn và phần mở rộng của bộ vẽ

- **Decision**: Bố cục tính trong **khung chuẩn có cạnh ngắn 1080** (giữ tỉ lệ video); khi vẽ, mọi thông số điểm ảnh (cỡ chữ, viền, độ mờ và khoảng cách bóng, bo góc, quãng chuyển động, tọa độ) nhân hệ số `k = cạnh ngắn đích / 1080`. Cách xuống dòng chỉ phụ thuộc khung chuẩn nên khung xem trước và thành phẩm giống nhau ở mọi độ phân giải. Bộ vẽ nhận thêm: kích thước khung bất kỳ (không chỉ ba tỉ lệ), khoảng cách và độ đậm của bóng, độ đậm 600, phông Oswald và Open Sans, ngắt dòng bắt buộc theo `\n`, và **hai khối chữ** cho chế độ song ngữ.
- **Rationale**: FR-027, FR-028, FR-029, FR-026. Spec 005 ghi nhận `shadowBlur` không co theo `ctx.scale`, nên phải nhân từng thông số.
- **Ràng buộc**: tab Video Overlay không đổi. Mọi trường mới có mặc định bằng hành vi hiện tại; kiểm thử khung hình của spec 005 phải vẫn đạt và `ENGINE_VERSION` giữ nguyên. Danh sách phông và độ đậm của tab Video Overlay lọc về bộ cũ.
- **Phông chữ cần thêm**: Oswald (400, 600, 700), Open Sans (400, 600, 700, 800) và bản 600 của Be Vietnam Pro, Roboto, Montserrat, Inter. Oswald không có 800, Arimo không có 800 (bản 600 phải kiểm khi lấy tệp). Tải tệp phông chữ giấy phép OFL **cần người dùng đồng ý** khi triển khai.
- **Alternatives considered**: bộ vẽ thứ hai riêng cho dịch video (hai nơi phải sửa, dễ lệch); `ctx.scale` (sai bóng).

## R3. Chuẩn hóa hình và tham số mã hóa thành phẩm

- **Decision**:
  - Hình: H.264 `yuv420p`, CRF 20, `veryfast`, kèm trần bitrate `maxrate = max(1,3 × bitrate hình nguồn, sàn theo độ phân giải)`, `bufsize = 2 × maxrate`, `+faststart`. Sàn: 720p 4 Mbps, 1080p 8 Mbps, 4K 24 Mbps.
  - Tốc độ khung hình: `-fps_mode passthrough`, giữ mốc khung của nguồn; lớp chữ vẽ ở `min(fps nguồn, 60)`.
  - Tiếng: chép nguyên khi là AAC, MP3, AC-3 hoặc E-AC-3; còn lại chuyển AAC 192 kbps. Chọn luồng tiếng mặc định của tệp, không có cờ thì luồng đầu.
  - Cờ xoay: để ffmpeg tự xoay; kích thước hiển thị tính sau xoay. Điểm ảnh không vuông: co về vuông. Kích thước lẻ: làm tròn xuống số chẵn.
  - HDR (`smpte2084`, `arib-std-b67`): chuyển về SDR BT.709 bằng `zscale` + `tonemap`, cảnh báo trước khi xuất. Nguồn SD BT.601 giữ ma trận màu của nguồn.
- **Rationale**: Đo: 150 khung tốc độ thay đổi qua `overlay` giữ nguyên toàn bộ mốc khung (trùng mã băm) và thời lượng; video có cờ xoay 90° cho thành phẩm 360×640 đúng chiều; ffmpeg dev có `zscale`, `tonemap` và bộ tách `mov`, `matroska`, `avi`, `flv`. CRF 20 nằm trong khoảng 18–22 của REQ-006; trần bitrate làm dung lượng ước tính được (FR-042, FR-053).
- **Chưa đo**: FR-038 (không phân biệt được bằng mắt) phải so khung trên video thật ([quickstart.md](./quickstart.md) §8).
- **Alternatives considered**: CRF 18 không trần (thành phẩm có thể gấp 2–3 lần nguồn, vượt hạn mức); giữ đúng bitrate nguồn (mất nét ở nguồn nén kỹ); `preset medium` (chậm khoảng 2 lần).

## R4. Tách âm thanh và độ lệch đầu luồng

- **Decision**: Tách MP3 mono 16 kHz với `-af aresample=async=1:first_pts=0` để khoảng lệch đầu luồng và các quãng hở thành im lặng; mốc Soniox trả về khớp dòng thời gian của video.
- **Rationale**: Đo với video 10 s có tiếng bắt đầu ở giây 1,5 (`.mp4` và `.mkv`): lệnh đang dùng (`extractAudioToMp3File`) cho âm thanh dài 3,0 s, tiếng bắt đầu ngay giây 0, tức **mọi mốc phụ đề sớm 1,5 s**; thêm bộ lọc trên thì tiếng bắt đầu ở 1,499–1,500 s. Lỗi này cũng ảnh hưởng spec 004 và **đã được sửa ngày 2026-11-26** (commit `b417ce0`, đã kiểm trên ffmpeg 8.1 và 5.1); tính năng này gọi lại `extractAudioToMp3File`, chỉ thêm tham số chọn luồng tiếng.
- **Alternatives considered**: cộng bù `start_time` vào mốc sau khi dịch (không xử lý được quãng hở giữa luồng).

## R5. Gọi Soniox

- **Decision**: Mở rộng `SonioxSttClient.startTranscription` với `translation: { type: 'one_way', target_language }`, `context.translation_terms`, `enable_language_identification`, `enable_speaker_diarization`. Hướng "Mọi ngôn ngữ → Việt": đích `vi`, không gợi ý ngôn ngữ. "Việt → Anh": đích `en`, `language_hints: ['vi']`. Mô hình lấy từ cấu hình chung (`stt-async-v6`). Cặp "giữ nguyên" gửi `target = source`. Dùng lại khuôn mẫu thử lại, tiếp tục theo `soniox_file_id`/`soniox_transcription_id` và dọn dữ liệu của spec 004. Thứ tự sau khi Soniox xong: lấy kết quả → **lưu bản token thô thành tệp tạm** → ghi bản ghi sử dụng → gom và lưu cue → xóa dữ liệu ở Soniox → xóa tệp token. Dừng hoặc lỗi vĩnh viễn khi nhà cung cấp đã có kết quả thì cũng lưu tệp token trước khi xóa. Lỗi ở bước gom thì chạy lại đọc tệp token, không gọi lại và không tính phí lần hai (FR-016, FR-017, SC-011).
- **Rationale**: Tài liệu xác nhận: dịch bất đồng bộ hỗ trợ `stt-async-v6`; mỗi tệp tối đa 300 phút; tổng 10 GB tệp lưu và tự xóa sau 30 ngày; ngữ cảnh tối đa khoảng 8.000 token (khoảng 10.000 ký tự), quá thì trả `invalid_request`; **token dịch không có mốc**, đi theo cụm ngay sau cụm lời gốc.
- **Chi phí**: giá công bố khoảng 0,10 USD mỗi giờ âm thanh bất đồng bộ, tính theo token (vào 1,50 và ra 3,50 USD mỗi triệu); trang giá ghi dịch được bao gồm, nhưng chữ dịch vẫn là token đầu ra nên chi phí thật có thể cao hơn phiên âm thuần. Ước tính dùng đơn giá theo giờ do Administrator nhập (đã có). Mỗi lần dịch thành công ghi một bản ghi tính phí (`ok = true`), mỗi lần gọi Soniox lỗi ghi một bản ghi `ok = false` chi phí 0 (như spec 004); đều gắn `video_job_id`.
- **Chưa kiểm chứng (cần một lần gọi thật)**: thứ tự cụm token trong kết quả bất đồng bộ đúng như ví dụ; `translation_status: none` ở chế độ một chiều cho đoạn đã ở ngôn ngữ đích; giới hạn 200 cặp / 8.000 ký tự có vừa giới hạn ngữ cảnh sau khi đóng gói JSON; giới hạn dung lượng mỗi tệp âm thanh. Không đạt thì chỉnh giá trị mặc định của cài đặt giới hạn hoặc bộ gom token.
- **Alternatives considered**: dịch hai chiều (spec chỉ cần một đích); dịch bằng LLM riêng sau khi phiên âm (thêm nhà cung cấp và chi phí).

## R6. Gom token thành cue song ngữ

- **Decision**: Ba bước thuần (hợp đồng ở [contracts/subtitle-pipeline.md](./contracts/subtitle-pipeline.md)): (1) token → **cụm** gồm lời gốc và lời dịch đi liền sau; (2) cụm → **câu**, ngắt tại dấu kết câu, đổi người nói, quãng nghỉ > 300 ms, chỉ ở ranh giới cụm; (3) câu → **cue** tối đa 24 từ (2 dòng × 12 từ), ưu tiên ranh giới cụm (mốc đo thật), cụm quá dài mới chia theo trọng số chữ rồi hút về ranh giới từ gốc gần nhất (mốc ước lượng).
- **Rationale**: FR-014, FR-015, FR-018. Ưu tiên ranh giới cụm giúp phần lớn mốc là mốc đo (SC-004).
- **Alternatives considered**: căn từng từ dịch với từng từ gốc (tài liệu nói không khớp một-một); dùng `stt-chunker` hiện có (bỏ token dịch).

## R7. Tải lên từng phần qua ứng dụng

- **Decision**: S3 multipart do máy chủ điều khiển. Phần 16 MB, trình duyệt gửi tối đa 3 phần cùng lúc bằng `XMLHttpRequest` (có tiến độ tải lên để tính MB/s và thời gian còn lại). Mỗi phần: `PUT` thân thô, kèm `x-part-sha256`; máy chủ kiểm quyền, độ dài, mã băm rồi `UploadPart` và ghi `etag`. Tiếp tục: hỏi máy chủ các phần đã có. Nhận diện đúng tệp: dung lượng + SHA-256 của ba đoạn 1 MB (đầu, giữa, cuối). Phiên hết hạn sau 48 giờ không hoạt động. Máy chủ giữ tối đa 8 phần trong bộ nhớ cùng lúc (128 MB), quá thì trả 429 kèm `Retry-After`.
- **Rationale**: FR-004 đến FR-006, SC-001 (mất tối đa 16 MB mỗi phần dở). 10 GB là 640 phần, dưới giới hạn 10.000 phần. 16 MB dưới giới hạn thân yêu cầu 100 MB của đường hầm. Dự án không có middleware nên Route Handler không bị giới hạn thân mặc định. Giữ một phần trong bộ nhớ giúp kiểm mã băm và tránh giới hạn khối của MinIO đã gặp ở spec 004.
- **Chưa kiểm chứng**: thông lượng thật qua đường hầm; **điều khoản dịch vụ của Cloudflare về truyền video và tệp lớn** cần người vận hành đọc trước khi mở tính năng ra Internet.
- **Alternatives considered**: URL ký thẳng tới MinIO (đã loại ở Clarifications); giao thức tus (thêm máy chủ và phụ thuộc, vẫn phải gắn quyền và hạn mức).

## R8. Lấy âm thanh ngay trong trình duyệt

- **Decision**: Thư viện `mediabunny` (MPL-2.0, bản 1.66.4) chạy trong Web Worker: chép luồng tiếng sang `.m4a`, `.webm` hoặc `.mp3` **không mã hóa lại**; luồng AC-3, PCM… hoặc bản chép ước tính > 150 MB thì mã hóa mono 64 kbps bằng WebCodecs nếu trình duyệt làm được. Chỉ thử với `.mp4`, `.m4v`, `.mov`, `.mkv`, `.webm`; `.avi`, `.flv` đi luồng máy chủ. Điều kiện: có `Worker`; `navigator.deviceMemory` (nếu có) ≥ 4; không có thì cần ≥ 4 luồng CPU. Không dùng luồng nhanh khi trình duyệt đọc thấy không có hình hoặc vượt 4096×2304. Lỗi hoặc quá 5 phút thì bỏ qua, không báo lỗi.
- **Rationale**: FR-010; thư viện đọc tệp theo đoạn nên không nạp 10 GB vào bộ nhớ, không cần WebAssembly hay đổi CSP. 180 phút mono 64 kbps khoảng 86 MB.
- **Kiểm âm thanh của trình duyệt (FR-011)**: máy chủ xem là dữ liệu không tin cậy, đo bằng ffprobe và chuyển về MP3 16 kHz trước khi gửi Soniox. Khi video tải xong: so **thời lượng và mốc bắt đầu với luồng tiếng của video nguồn** (không so với thời lượng hình, vì tiếng có thể ngắn hơn hình một cách hợp lệ). Lệch mốc bắt đầu > 100 ms thì dời mọi cue; lệch thời lượng > 1 s thì đánh dấu và chờ người dùng xác nhận dịch lại.
- **Kết quả đo trên trình duyệt (T129, 27/11/2026 — Playwright Chromium và Microsoft Edge trên Windows)**:
  - Chrome & Edge chạy qua Web Worker của ứng dụng đạt cả 5 định dạng nhanh: `.mp4` (AAC → `.m4a` 27.670 B), `.m4v` (AAC → `.m4a` 27.670 B), `.mov` (AAC → `.m4a` 27.572 B), `.mkv` (Opus → `.webm` 33.098 B; AAC → `.m4a` 28.668 B), `.webm` (VP9/Opus → `.webm` 33.169 B); `.avi` (MPEG-4/MP3) và `.flv` (FLV1/AAC) đi luồng máy chủ (`clientAudio: false`).
  - Mốc bắt đầu lệch (`-itsoffset 1,5s` trên `.mp4` 1476 ms, `.mkv` 1501 ms, `.webm` 1501 ms): `Conversion.init` cắt từ `trim.start = startSec` (cần thiết cho Opus có gói khởi động `-0,007s` ở WebM) nên âm thanh gửi lên bắt đầu ở `0 ms` với đúng thời lượng luồng tiếng (`2523`/`2507 ms`); khi nguồn tải xong, `probeVideo` đo đúng `audioStartMs` (`1476`/`1501 ms`) và `audioDurationMs` (`2523`/`2507 ms`) nên `runCheck` dời cue bù lệch (`shiftJobCues`, không dịch lại) và không báo nhầm lệch thời lượng.
- **Chưa kiểm chứng**: Firefox và Safari (máy Windows không có Safari và chưa cài Firefox Playwright); ghi vào `user-tasks.md`. Thử lại hai trình duyệt này khi có môi trường; nếu định dạng nào không đạt thì đưa vào danh sách đi luồng máy chủ.
- **Alternatives considered**: `ffmpeg.wasm` (lõi khoảng 30 MB, giới hạn bộ nhớ, giấy phép GPL, phải nới CSP); `mp4box.js` (chỉ họ MP4).

## R9. Trạng thái, hàng đợi, đồng thời

- **Decision**: Tách **pipeline dịch** (trên việc dịch) và **bản xuất** (bảng riêng, mỗi bản một trạng thái); trạng thái hiển thị của FR-048 suy ra từ hai nơi ([data-model.md](./data-model.md) §3). Bốn hàng đợi mới: `video-prepare` (đo, tách âm thanh), `video-translate`, `video-preview`, `video-render`; thêm lịch `video-retention`. Đồng thời mỗi worker: prepare 1, preview 1; dịch và xuất giới hạn toàn hệ thống theo cài đặt (mặc định 2 và 1) với khóa tư vấn như spec 005. Tiến trình ffmpeg chạy độ ưu tiên thấp, dùng tối đa `số luồng − 2`. Nhịp tim, sweeper, thử lại theo khuôn mẫu hiện có; gián đoạn quá 3 lần thì báo lỗi. Tiến độ và nhật ký chi tiết đẩy qua SSE như tiến trình voice; danh sách hỏi lại mỗi 2 giây khi có việc đang chạy.
- **Rationale**: Một việc có thể dịch một lần và xuất nhiều lần; gộp một trạng thái sẽ mất thông tin. Hàng đợi riêng đáp ứng FR-052. `pg-boss` chặn thời hạn công việc tối đa 24 giờ (đo trong mã thư viện); việc quá hạn đó chỉ bị `pg-boss` đánh dấu, còn phục hồi do nhịp tim trong CSDL quyết định.
- **Alternatives considered**: dùng chung hàng đợi overlay (video lớn chặn overlay của người khác).

## R10. Trình biên tập phụ đề

- **Decision**: Cue lưu trong CSDL; việc dịch giữ `cue_revision`. Mọi thay đổi là **một lô thao tác** (`update`, `insert`, `delete`) kèm `baseRevision`, áp dụng trong một giao dịch; lệch phiên bản trả 409. Trình duyệt tự lưu sau 800 ms ngừng gõ, giữ ngăn xếp hoàn tác bằng lô nghịch đảo. Tìm và thay thế là hàm thuần chạy ở trình duyệt trên toàn bộ cue, kết quả gửi thành một lô nên hoàn tác một lần. Danh sách ảo hóa bằng `@tanstack/react-virtual`.
- **Rationale**: FR-022 đến FR-025, SC-006, SC-007. 3.000 cue khoảng 600 KB JSON, tải một lần được; 3.000 hàng có ô nhập thì phải ảo hóa.
- **Alternatives considered**: lưu cả kịch bản một khối (ghi đè lẫn nhau giữa hai tab); tìm ở máy chủ (chậm khi tô sáng theo phím gõ); `content-visibility` (vẫn tạo đủ 3.000 nút).

## R11. Nguồn phát cho trình xem trước

- **Decision**: Thứ tự: tệp đang có trên máy người dùng nếu trình duyệt phát được → **bản xem trước** 720p H.264 do máy chủ tạo → video nguồn phát qua proxy. Tạo bản xem trước khi nguồn không phải MP4/WebM phát được phổ biến, cao hơn 1080 điểm ảnh hoặc trên 8 Mbps. Phát qua ứng dụng có kiểm quyền, hỗ trợ `Range`, mỗi phản hồi dải mở trả tối đa 8 MB, hủy luồng đọc kho khi trình duyệt ngắt. Khi chưa phát được video, trình biên tập vẫn dùng được với âm thanh đã tách.
- **Rationale**: US2 kịch bản 7; phát nguồn 20 Mbps qua đường hầm rất chậm. `serveObject` hiện nhận `signal` nhưng chưa truyền cho lệnh đọc kho nên phải sửa.
- **Phân loại dung lượng**: bản xem trước và âm thanh tách là **tệp tạm dẫn xuất**, xóa cùng video nguồn, không tính vào hạn mức của User nhưng tính vào trần dung lượng hệ thống (R12). Bản xem trước 180 phút khoảng 1–1,5 GB.
- **Alternatives considered**: luôn tạo bản xem trước (tốn CPU và đĩa); HLS (thêm độ phức tạp).

## R12. Dung lượng

- **Decision**:
  - `users.video_used_bytes` là bộ đếm riêng; chỗ giữ trước suy ra từ phiên tải đang mở và bản xuất đang chờ/chạy. Kiểm và tạo trong một giao dịch có khóa tư vấn theo User.
  - **Trần hệ thống** `videoSystemCapBytes` (cài đặt, mặc định 100 GB): tổng đã dùng + đang giữ + bản xem trước của mọi User không vượt trần; đây là cách đáp ứng "dung lượng máy chủ" của FR-007 vì ứng dụng web không đọc được đĩa của kho lưu tệp. Worker kiểm thêm đĩa tạm bằng `statfs` trước khi tải nguồn và trước khi xuất (nguồn + ước tính + 1 GB).
  - Ước tính thành phẩm gắn cứng: `thời lượng × (maxrate + tiếng) / 8 × 1,05`; lớp phụ đề dùng bảng ước tính của spec 005 nhân theo diện tích khung. Hạn mức trừ theo dung lượng thật; thành phẩm thật vượt chỗ còn lại thì không lưu.
  - Thành phẩm có thể trên 5 GB nên worker **tải lên kho bằng multipart** từ tệp trên đĩa.
  - Đối soát hằng ngày: bộ đếm 500 MB **loại** tiền tố `video/` và `video-tmp/`, **cộng** `script_bytes` của việc dịch; thêm đối soát riêng cho bộ đếm video.
- **Rationale**: FR-053, FR-055. Mã đối soát hiện tại cộng mọi đối tượng dưới tiền tố User nên nếu không sửa sẽ tính video vào 500 MB và xóa mất phần chữ phụ đề lưu trong CSDL.
- **Alternatives considered**: đọc dung lượng đĩa qua API quản trị của kho (ứng dụng phải gọi API quản trị bằng khóa gốc); gắn ổ dữ liệu của kho vào web (phá cô lập).

## R13. Vòng đời và dọn dẹp

- **Decision**: Lịch `video-retention` mỗi 10 phút: xóa video quá hạn (nguồn, bản xem trước, âm thanh tạm, thành phẩm), hủy phiên tải quá 48 giờ, dọn dữ liệu Soniox còn sót. Không xóa khi có tiến trình đang dùng hoặc **thẻ giữ lượt tải** còn hạn (đường phát/tải gia hạn mỗi 60 giây khi luồng còn chạy). Xóa Project/User phải hủy phiên multipart theo bản ghi CSDL vì phần dở không hiện khi liệt kê đối tượng. Tiến trình con chỉ đọc tệp trên đĩa (`-protocol_whitelist file`, ép bộ tách theo đuôi) để tệp độc hại không mở được kết nối mạng.
- **Rationale**: FR-054, FR-057, SC-013 (trễ tối đa 10 phút, yêu cầu 1 giờ).
- **Alternatives considered**: quy tắc vòng đời của kho (không biết "lần xuất gần nhất" hay lượt tải); cho ffmpeg đọc URL ký của kho (mở giao thức mạng cho tệp không tin cậy).

## R14. Quyền, cài đặt, quản trị

- **Decision**: Cột `users.can_translate_video` (mặc định tắt; Administrator luôn được phép) bật tắt trong trang người dùng. Một hàm kiểm quyền dùng chung cho tạo việc, tải phần, hoàn tất, dịch, xuất, chạy lại; thu hồi quyền thì đặt cờ dừng cho tiến trình đang chạy. Cài đặt hệ thống mới có giá trị mặc định theo spec ([data-model.md](./data-model.md) §4).
- **Rationale**: FR-008, Nguyên tắc I; theo khuôn mẫu `canUseCustomAi` đã có.

## R15. Còn phải kiểm trước và trong khi triển khai

| Việc | Khi nào | Không đạt thì |
| --- | --- | --- |
| Ảnh worker: ffmpeg 5.1 có `zscale`, `tonemap`, `overlay=alpha=premultiplied`, đủ bộ tách; đo R1 gồm cả vẽ chữ | bước 0 | xem lại R1, R3 |
| Một lần gọi Soniox thật (**có phí, cần người dùng đồng ý**) | trước bước 4 | chỉnh R5, R6 |
| `mediabunny` trên các trình duyệt | bước 8 | thu hẹp danh sách luồng nhanh |
| Tải lên 10 GB qua đường hầm thật; điều khoản Cloudflare | trước khi phát hành | đổi cách công bố hoặc hạ giới hạn |
| SC-003, SC-004, SC-005, SC-010 và FR-038 trên video thật, máy triển khai | cuối | chỉnh tham số hoặc quay lại spec |
