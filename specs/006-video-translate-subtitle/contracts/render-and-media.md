# Hợp đồng: bộ vẽ, dựng hình, ffmpeg, tải lên phía trình duyệt

## 1. Bộ vẽ dùng chung (`src/lib/overlay/`)

- `createScene` nhận `SceneStyle` (kích thước khung chuẩn, hệ số `k`, kiểu chữ, hiệu ứng) thay cho chỉ `OverlayConfig`; `OverlayConfig` được đổi sang `SceneStyle` bằng một hàm với `k = 1`. `VideoStyle` đổi sang `SceneStyle` bằng hàm ở `src/lib/video/style.ts`.
- Cue song ngữ: `AppliedCue.secondary?: string`. Khối gốc nằm trên, khối dịch dưới, cùng canh lề; vị trí tính theo tâm của cả cụm; cụm luôn nằm trọn trong khung (thu nhỏ cùng tỉ lệ khi cần).
- Hiệu ứng theo từ và karaoke chỉ áp dụng cho khối chính. `readEndMs = endMs`.
- Chữ chỉ đi vào `fillText`/`strokeText`; không thẻ nào được diễn giải.
- `sceneBand(scene)` → `{ y, height }` (chẵn): hợp mọi khối chữ + viền + bóng + quãng chuyển động; > 60% khung thì cả khung. **Bất biến kiểm thử**: không khung nào có điểm ảnh khác trong suốt ngoài dải.
- Video Overlay (spec 005): kết quả vẽ không đổi một điểm ảnh nào với mọi cấu hình mẫu.

## 2. Tiến trình con (`src/worker/render/`)

`ParentMessage` thêm:

```ts
type BurnTask = {
  type: 'burn';
  cues: AppliedCue[];
  style: SceneStyle;
  source: { path: string; demuxer: 'mov'|'matroska'|'avi'|'flv'; audioIndex: number; width: number; height: number;
            fps: number; durationMs: number; hdr: boolean; matrix: 'bt709'|'bt601'; copyAudio: boolean };
  maxrate: number; outPath: string; maxBytes: number; threads: number; fontDir: string;
};
```

Thông điệp trả về, mã lỗi, hủy, theo dõi đứng khung và biến môi trường tối thiểu giữ nguyên; thêm mã `SOURCE_UNREADABLE`. Lớp phụ đề (`layer`) dùng tác vụ `render` hiện có với kích thước bất kỳ và không tiếng.

## 3. Tham số ffmpeg gắn cứng (mảng cố định, không qua shell)

```text
-protocol_whitelist file -f {demuxer} -i {source}
-protocol_whitelist pipe -f rawvideo -pix_fmt rgba -s {W}x{bandH} -r {overlayFps} -i pipe:0
-filter_complex "[0:v:0]{chuẩn hóa: tonemap nếu HDR, điểm ảnh vuông, kích thước chẵn}[base];
                 [1:v]scale=out_color_matrix={matrix}:out_range=tv,format=yuva420p[sub];
                 [base][sub]overlay=0:{bandY}:alpha=premultiplied:eof_action=pass[v]"
-map [v] -map 0:{audioIndex} -fps_mode passthrough
-c:v libx264 -preset veryfast -crf 20 -maxrate {maxrate} -bufsize {2·maxrate} -pix_fmt yuv420p
-c:a copy | -c:a aac -b:a 192k
-movflags +faststart -map_metadata -1 -threads {n} {out}.mp4
```

Không có chữ do người dùng nhập trong tham số. Tên tệp trên đĩa do hệ thống đặt.

## 4. Đo, tách âm thanh, bản xem trước (worker)

- `probeVideo`: ffprobe với `-protocol_whitelist file` và ép bộ tách; trả `media` ([data-model.md](../data-model.md) §1.2). Từ chối: không đọc được, không có hình, không có tiếng, dài quá giới hạn, cạnh dài > 4096 hoặc cạnh ngắn > 2304.
- Tách âm thanh: `-vn -map 0:{audioIndex} -af aresample=async=1:first_pts=0 -ac 1 -ar 16000 -c:a libmp3lame -q:a 4`.
- Bản xem trước: 720p (cạnh ngắn), H.264 CRF 28 `veryfast`, khung khóa mỗi 2 giây, AAC 96 kbps, `faststart`.

## 5. Trình duyệt

- **Tải lên** (`upload-client.ts`): trạng thái `idle → uploading ⇄ paused → completing → done`; 3 phần song song; lỗi mạng, 429, 5xx thử lại với 1, 2, 4, 8, 16 giây rồi chuyển `paused`; 401 → `paused` kèm yêu cầu đăng nhập; 403/404/409 → dừng và báo. Tốc độ lấy trung bình 10 giây gần nhất.
- **Lấy âm thanh** (`extract-audio.worker.ts`): vào `File`; ra `{ ok: true, blob, mime, startMs, durationMs }` hoặc `{ ok: false, reason }`. Mọi `ok: false` được bỏ qua trong im lặng và gọi `client-audio/skip`. Trả `ok: false` ngay khi tệp không có luồng hình hoặc vượt 4096×2304 (FR-003).
- **Xem trước**: `<video>` (hoặc `<audio>` khi chưa có hình) + `<canvas>` phủ lên, vẽ lại theo `requestVideoFrameCallback` (không có thì `requestAnimationFrame`), chỉ vẽ khi khóa khung đổi; `k` theo kích thước hiển thị. Khung vùng an toàn là lớp DOM riêng, không bao giờ vào bộ vẽ.
- Vùng an toàn (`safe-zones.ts`): hình chữ nhật theo phần trăm khung 9:16 cho TikTok, Shorts, Reels; là **mô phỏng gần đúng** và giao diện ghi rõ.
