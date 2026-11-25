# Việc cần bạn thực hiện: Video overlay phụ đề (spec 005)

**Ngày lập**: 2026-11-25. Mã đã hoàn tất và đã push lên `main`. Dưới đây là những task không thể tự động hóa hoặc cần bạn cho phép. Mỗi mục nêu cách làm, tiêu chuẩn đạt và chỗ ghi kết quả. Làm xong bạn chỉ cần nhắn kết quả (hoặc ảnh chụp), tôi sẽ ghi vào tài liệu và sửa nếu có mục không đạt.

| Task | Việc | Thời gian ước chừng | Bắt buộc trước khi dùng thật? |
| --- | --- | --- | --- |
| T054 | Mở `.mp4` phông xanh trong 4 phần mềm dựng phim, xóa phông | 20–30 phút | Nên làm trước |
| T088 | Mở `.mov` và `.webm` trong suốt, cùng một tệp thử Animation | 30 phút | Nên làm nếu bạn dùng nền trong suốt |
| T098 | Cho vài người dùng thử tự làm | 15 phút mỗi người | Không |
| T074 | Đo độ khớp từng từ bằng Soniox (**tốn phí**) | Bạn chỉ cần đồng ý | Không |
| Thêm | So khớp xem trước trên Firefox và WebKit (cần tải trình duyệt) | 10 phút | Không |

## Chuẩn bị tệp mẫu

Bốn tệp mẫu 10 giây đã được tạo sẵn ở `tmp/overlay-samples/` (thư mục này không đưa vào git). Nếu chưa có, chạy trong PowerShell tại thư mục dự án:

```powershell
npx tsx scripts/overlay-samples.ts
```

| Tệp | Nội dung |
| --- | --- |
| `1-phong-xanh-la.mp4` | chữ trắng viền đen trên phông xanh lá `#00FF00`, có tiếng |
| `2-trong-suot-prores.mov` | ProRes 4444, chữ trắng, bóng mờ, hộp nền xanh dương 50% |
| `3-trong-suot.webm` | VP9 trong suốt, cùng nội dung với tệp 2 |
| `4-trong-suot-animation.mov` | tệp thử QuickTime Animation, cùng nội dung với tệp 2 |

Bạn cũng có thể tự xuất từ ứng dụng: mở một Project có voice, tab **Video Overlay**, bấm **Xuất Video Overlay**.

## T054: kiểm `.mp4` trong phần mềm dựng phim (SC-006, SC-007)

Làm lần lượt với từng phần mềm bạn có. Không có phần mềm nào thì ghi "không có".

1. Tạo dự án khung dọc 1080×1920, đặt một video hoặc ảnh bất kỳ làm nền (nên có vùng sáng và vùng tối).
2. Kéo `1-phong-xanh-la.mp4` lên lớp phía trên.
3. Xóa phông bằng thiết lập **mặc định**:
   - **CapCut**: chọn clip → Cắt (Cutout) → Khóa sắc độ (Chroma key) → dùng ống hút chấm vào phông xanh.
   - **Premiere**: hiệu ứng **Ultra Key** → Key Color chấm vào phông xanh.
   - **DaVinci Resolve**: trang Fusion dùng **Delta Keyer**, hoặc trang Edit dùng **3D Keyer** → chấm vào phông xanh.
   - **After Effects**: hiệu ứng **Keylight** → Screen Colour chấm vào phông xanh (ở phần mềm này chỉ bắt buộc mở được tệp).
4. Phóng to 200% và xem ở giây 2, 6 và 9.

**Đạt khi**: tệp mở được; sau khi xóa phông không còn mảng xanh nhìn thấy được, chữ không bị thủng, viền đen còn nguyên, tiếng khớp chữ.

**Nếu không đạt**: chụp màn hình lúc phóng to và cho biết tên, phiên bản phần mềm.

## T088: kiểm nền trong suốt (SC-007)

1. Như trên nhưng kéo `2-trong-suot-prores.mov` lên lớp trên, **không** dùng hiệu ứng xóa phông.
2. Xem ba điểm: ngoài chữ phải thấy rõ video nền; hộp xanh dương phải nhìn xuyên được khoảng một nửa và đúng màu xanh; quanh chữ và bóng không có viền đen hoặc viền trắng lạ.
3. Làm lại với `3-trong-suot.webm` và `4-trong-suot-animation.mov`.

**Đạt khi**: tệp 2 trong suốt đúng ở **Premiere, DaVinci Resolve và After Effects**. Các ô khác chỉ cần ghi lại có mở được, có trong suốt hay không.

**Việc tôi cần biết thêm**: tệp 4 nhỏ hơn tệp 2 khoảng 3,5 lần (18 MB so với 61 MB). Nếu tệp 4 chạy đúng ở cả bốn phần mềm, có thể đổi định dạng `.mov` sang Animation để tiết kiệm dung lượng; tôi sẽ hỏi lại bạn trước khi đổi.

### Bảng ghi kết quả (T054 và T088)

Điền "đạt", "không đạt" hoặc "không có phần mềm":

| Tệp | CapCut | Premiere | DaVinci Resolve | After Effects |
| --- | --- | --- | --- | --- |
| 1 `.mp4` phông xanh lá | | | | |
| 2 `.mov` ProRes 4444 | | | | |
| 3 `.webm` | | | | |
| 4 `.mov` Animation (thử) | | | | |

## T098: người dùng thử (SC-001, SC-013)

Cần ít nhất 5 người chưa dùng tính năng này (càng nhiều càng tốt); mỗi người có sẵn một Project với voice và `.srt`.

1. Đưa máy, chỉ nói: "Hãy xuất một video phụ đề từ Project này". Không hướng dẫn gì thêm.
2. Bấm giờ từ lúc mở tab **Video Overlay** tới lúc bấm **Xuất Video Overlay**.
3. Sau đó nhờ họ làm một video **đúng ý họ** (đổi kiểu chữ, màu, hiệu ứng tùy thích) và đếm số lần xuất tới khi hài lòng.

| Người thử | Thời gian tới lần bấm xuất đầu tiên | Số lần xuất tới khi đúng ý | Chỗ bị vướng |
| --- | --- | --- | --- |
| 1 | | | |
| 2 | | | |
| 3 | | | |
| 4 | | | |
| 5 | | | |

**Đạt khi**: ai cũng bấm được xuất trong dưới 1 phút (SC-001); ít nhất 90% làm được video đúng ý ở lần xuất thứ nhất hoặc thứ hai (SC-013).

## T074: đo độ khớp từng từ (SC-008), có tính phí

Chế độ **Theo từng từ** và **Karaoke** dùng nhịp từng từ **ước lượng** theo độ dài chữ. Để biết ước lượng có đạt 80% số từ lệch không quá 300 ms hay không, cần phiên âm lại 3 voice (mỗi voice không quá 10 giây) bằng Soniox, tức khoảng 30 giây âm thanh. Đây là lần gọi nhà cung cấp AI thật nên tôi không tự chạy.

**Bạn cần làm**: nhắn "cho phép T074" và cho biết 3 voice tiếng Việt khớp mốc nào được dùng (tên Project và tên voice). Tôi sẽ viết script đo, chạy, ghi số liệu vào `research.md` R8 và chỉnh hệ số nếu chưa đạt.

## Thêm: so khớp xem trước trên Firefox và WebKit

Đã tự động so khớp trên Chromium tại 20 thời điểm: vùng chữ trùng 95,5–99,1%. Firefox và WebKit chưa đo vì phải tải trình duyệt của Playwright (khoảng 200 MB) và cần bạn đồng ý. Nếu muốn đo:

```powershell
npx playwright install chromium firefox webkit
```

```powershell
$env:E2E_BROWSERS='firefox,webkit'; npx playwright test overlay-parity
```

Xem dòng `[parity firefox]` và `[parity webkit]` trong kết quả. Nếu WebKit trên Windows không phát được MP3 thì ghi lại là không đo được.

## Ghi kết quả ở đâu

Sau khi bạn nhắn kết quả, tôi sẽ: điền bảng ở `quickstart.md` §6, đánh dấu T054, T074, T088, T098 trong `tasks.md`, sửa các mục không đạt, rồi commit và push.
