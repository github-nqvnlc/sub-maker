# Contract: Bộ dựng hình overlay (`src/lib/overlay/`)

Mã thuần TypeScript, không phụ thuộc DOM, Node hay CSDL; dùng chung cho trình duyệt và tiến trình dựng hình. Mọi hàm tất định: không `Math.random`, không đọc đồng hồ. Đổi hành vi nhìn thấy được thì tăng `ENGINE_VERSION`.

## 1. `OverlayConfig` (Zod `.strict()`)

Điểm ảnh tính trên khung xuất ra. Màu là `#RRGGBB`.

| Trường | Giá trị | Mặc định |
| --- | --- | --- |
| `aspect` | `9:16` \| `16:9` \| `1:1` | `9:16` |
| `background` | `green` \| `blue` \| `black` \| `transparent` | `green` |
| `format` | `mp4` khi nền màu; `mov` \| `webm` khi trong suốt | `mp4` |
| `includeAudio` | boolean | `true` |
| `font.family` | `be-vietnam-pro` \| `roboto` \| `montserrat` \| `inter` \| `arimo` | `be-vietnam-pro` |
| `font.size` | 24–160, nguyên | 72 |
| `font.weight` | 400 \| 700 \| 800 (800 không hợp lệ với `arimo`) | 700 |
| `text.color` | màu | `#FFFFFF` |
| `stroke` | `{ enabled, color, width: 1–20 }` | bật, `#000000`, 6 |
| `shadow` | `{ enabled, color, blur: 0–40 }` | tắt, `#000000`, 8 |
| `box` | `{ enabled, color, radius: 0–60, opacity: 0–100 }` | tắt, `#000000`, 16, 100 |
| `position.anchor` | `bottom` \| `center` \| `top` | `bottom` |
| `position.y` | 0–100 (% chiều cao, tâm khối chữ) | 82 |
| `align` | `center` \| `left` \| `right` | `center` |
| `maxWidthPct` | 40–100 | 90 |
| `sync` | `cue` \| `word` \| `karaoke` | `cue` |
| `enter` | xem §5, chỉ với `cue` và `karaoke` | `cut` |
| `wordEffect` | `word`: `cut` \| `pop` \| `typewriter`; `karaoke`: `active` \| `wipe`; `cue`: không có | theo chế độ: `cut`, `active` |
| `exit` | `cut` \| `fade` \| `slideDown` | `cut` |
| `effectMs` | 100–600, bước 10 | 250 |
| `intensity` | `low` \| `medium` \| `high` | `medium` |
| `highlightColor` | màu | `#FFE600` |
| `shakeScope` | `exclaim` \| `all` | `exclaim` |

Chọn `anchor` đặt `y` lần lượt 82, 50, 18; người dùng chỉnh `y` tiếp. Bộ dựng kẹp để khối chữ luôn nằm trọn khung. `normalizeConfig(config)` sửa tổ hợp không hợp lệ về mặc định của chế độ và trả danh sách trường đã sửa (FR-028). Máy chủ chỉ nhận cấu hình đã hợp lệ (422 nếu không). `applyBackground(config, background)` đổi nền và định dạng; chuyển sang `black` khi viền đang bật với màu mặc định `#000000` thì tắt viền và trả trường đã sửa để giao diện báo.

## 2. `applyTiming({ fileCues, source, voiceTimeline, voiceDurationMs }) → { cues: AppliedCue[], warnings }`

`source`: `'timed'` (voice khớp mốc từ chính tệp), `'continuous'` (voice đọc liên tục từ chính tệp), `'otherFile'` (voice từ tệp khác, mọi chế độ), `'uploaded'` (âm thanh tải lên). Chỉ `'timed'` dùng `voiceTimeline`.

- Bỏ cue không có chữ (`speakable = false`). Ghép với mốc voice theo [research R7](../research.md#r7-mốc-áp-dụng-của-câu-fr-004).
- `startMs`: lúc voice đọc, hoặc mốc tệp. `readEndMs`: lúc đọc xong, hoặc mốc kết thúc trong tệp. `endMs = min(max(readEndMs, kết thúc trong tệp), startMs cue kế, voiceDurationMs)`; `readEndMs` kẹp trong `(startMs, endMs]`.
- Kẹp thứ tự trước khi tính `endMs`: theo thứ tự trong tệp, `startMs = max(startMs, startMs cue trước + MIN_CUE_MS)`, `MIN_CUE_MS = 34`.
- `AppliedCue.origin` là `voice` hoặc `file` theo mốc gốc đã dùng.
- Cue có `startMs ≥ voiceDurationMs` bị bỏ.
- Cảnh báo: `NOT_TIMED_VOICE` (`source = 'continuous'`), `OTHER_FILE` (`source = 'otherFile'`), `LENGTH_MISMATCH { diffMs, droppedCues, cutCues }` (lệch > 2 s, hoặc có cue bị bỏ hay bị cắt ở cuối voice; mọi loại nguồn), `TIMELINE_FALLBACK` (chuỗi chữ của voice và tệp không bằng nhau). Nguồn `'uploaded'` không phát hai cảnh báo đầu.

Bất biến: `0 ≤ startMs < endMs ≤ voiceDurationMs`; không chồng lấn; tăng dần.

## 3. `wordSpans(cue) → WordSpan[]`

Theo [research R8](../research.md#r8-ước-lượng-mốc-từng-từ-fr-024-fr-025). Bất biến (FR-025): từ đầu bắt đầu đúng `startMs`; từ cuối kết thúc ≤ `readEndMs`; không chồng lấn, tăng dần; một từ thì chiếm trọn. Khi khoảng đọc (ms) nhỏ hơn số từ, nhiều từ có thể dài 0 ms và hiện cùng lúc. Nối `text` bằng một dấu cách phải ra lại chữ của cue.

Từ đang đọc tại `t`: từ cuối cùng có `startMs ≤ t` và `t < readEndMs`; sau `readEndMs` không có từ nào.

## 4. `layoutCue(cue, config, measure) → CueLayout`

- Chữ NFC. Xuống dòng tham lam tại khoảng trắng theo `maxWidthPct`; chỉ ngắt trong từ (theo cụm ký tự hiển thị) khi một từ dài hơn cả dòng.
- Chiều cao dòng 1,3 × cỡ chữ. Khối (gồm viền, bóng, hộp) không vừa khung thì giảm cỡ riêng câu đó tới cỡ lớn nhất vừa khung, không có mức sàn (FR-015), và cảnh báo `CUE_SHRUNK { cue, size }`.
- `measure` do môi trường cung cấp (đo ở cỡ xuất ra, không đo ở cỡ màn hình) nên xuống dòng không phụ thuộc kích thước khung xem trước.
- Ký tự không có trong phông chữ và phông chữ thay thế: cảnh báo `MISSING_GLYPH { cue, chars }`.

## 5. `drawFrame(ctx, tMs, scene) → string | null`

Trả khóa khung (hai khung cùng khóa khác `null` thì giống hệt nhau). Luôn vẽ ở kích thước xuất; xem trước đặt `<canvas>` đúng kích thước đó rồi co bằng CSS, **không** dùng `ctx.scale` vì độ mờ bóng không co theo (research R1). Máy yếu thì giảm số khung vẽ mỗi giây, không giảm kích thước.

Với câu dài `D`, hiệu ứng vào `e` và ra `x` (bằng 0 nếu `cut`): nếu `e + x > D` thì nhân cả hai với `D / (e + x)` (FR-027). `p` chạy 0→1 trong thời gian hiệu ứng.

| `enter` | Vẽ |
| --- | --- |
| `cut` | đầy đủ ngay |
| `fade` | độ đục `p` |
| `pop` | tỉ lệ 80% → 100% ease-out; đỉnh 100% / 102% / 104% theo `intensity` rồi về 100% |
| `bounce` | 80% → đỉnh → 100%; đỉnh 103% / 105% / 110% theo `intensity` |
| `slideUp` | từ dưới 0,8 × cỡ chữ, ease-out, kèm độ đục |
| `slideLeft`, `slideRight` | từ ngoài cạnh trái / phải khung vào |
| `dropDown` | từ trên xuống, dằn nhẹ |
| `blurIn` | nhòe → nét (R2) kèm độ đục |
| `glitch` | 100 ms đầu: bản đỏ và lam lệch ±, theo bước 33 ms tất định; bỏ qua `effectMs` |
| `glow` | viền sáng màu nổi bật mạnh rồi dịu |
| `flip3d` | co dọc theo `cos`, 90° → 0° quanh trục ngang |
| `shake` | lệch nhỏ tất định theo (câu, bước 33 ms) trong suốt câu, theo `shakeScope` |

`exit`: `fade` giảm độ đục, `slideDown` trượt xuống kèm độ đục; tại `endMs` đã ẩn hẳn. `enter = fade` mà `exit = cut` thì giao diện tự đổi `exit` thành `fade` (REQ: "mờ dần vào và ra"), người dùng đổi lại được.

| `wordEffect` | Vẽ |
| --- | --- |
| `word/cut` | từ hiện tại `startMs` của từ |
| `word/pop` | như trên, kèm bung theo `intensity`; từ ngắn hơn `effectMs` thì rút ngắn |
| `word/typewriter` | hiện dần từng cụm ký tự trong khoảng của từ |
| `karaoke/active` | từ đang đọc phóng 115% / 118% / 120% theo `intensity`, màu nổi bật; không làm đổi bố cục |
| `karaoke/wipe` | màu nổi bật quét trái sang phải qua từng từ theo tiến độ của từ; từ đã đọc giữ màu |

Ở chế độ `word`, chỗ của từ chưa hiện vẫn được giữ (chữ không nhảy dòng).

## 6. `colorWarnings(config) → Warning[]`

`KEYED_COLOR { field }` và `SOFT_EDGE` theo [research R15](../research.md#r15-cảnh-báo-màu-fr-010-fr-011). `SOFT_EDGE` một lần cho mỗi cấu hình. Màu nổi bật chỉ được xét khi `sync = karaoke`, hoặc `sync = cue` và `enter = glow`.

## 7. `estimate(config, durationMs) → { bytes }`

Bảng hằng ở [research R11](../research.md#r11-hạn-mức-lưu-trữ-fr-043-fr-044). Máy chủ luôn tính lại.

## 8. Tiến trình dựng hình (`src/worker/render/`)

- Cha `fork` `main.ts`, gửi `{ cues, config, durationMs, audioPath | null, outPath, maxBytes, threads }`. Con gửi `{ type: 'progress', frame, total }` mỗi 500 ms, `{ type: 'warning', code, params }` cho `CUE_SHRUNK` và `MISSING_GLYPH`, rồi `{ type: 'done', bytes }` hoặc `{ type: 'error', code }`.
- Con không nhận biến môi trường bí mật (CSDL, MinIO, khóa): `env` chỉ gồm `PATH`, `FFMPEG_PATH`, thư mục tạm.
- Dừng: cha gửi `SIGTERM`, quá 5 giây thì `SIGKILL`; ffmpeg chết theo. Không có tiến độ trong 60 giây: `RENDER_STALLED`.
- Tham số ffmpeg: `-f rawvideo -pix_fmt rgba -s WxH -r 30 -i -`, tiếng `-protocol_whitelist file -i audioPath` (nếu có) kèm `apad` và `-t N/30`, rồi theo định dạng ở [research R5](../research.md#r5-định-dạng-và-tham-số-mã-hóa).
- Tôn trọng áp lực ngược của `stdin`; không giữ quá 2 khung trong bộ nhớ.
