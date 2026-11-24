# Feature Specification: Video overlay phụ đề chạy đồng bộ với voice

**Feature Branch**: `main` (hiến pháp 1.3.0: triển khai chỉ trên `main`; `005-subtitle-video-overlay` là tên thư mục spec)

**Created**: 2026-11-25

**Status**: Draft

**Input**: User description: "Đọc yêu cầu phát triển tính năng @docs/todo/requirements/req-005/req-005.md" — Tạo video overlay phụ đề chạy đồng bộ thời gian thực với voice trên nền đơn sắc (phông xanh lá, xanh dương, đen) hoặc trong suốt, để tải về và chèn đè lên video chính trong phần mềm dựng phim.

## Bối cảnh

Hiện Project giúp người dùng có kịch bản (`.srt`, `.txt`, `.md`) và voice AI khớp mốc phụ đề. Nhưng khi dựng video, người dùng vẫn phải tự gõ lại hoặc tự canh từng dòng chữ trong CapCut, Premiere, DaVinci Resolve hay After Effects. Tính năng này tạo sẵn một video chỉ có chữ phụ đề chạy khớp với voice trên nền dễ xóa; người dùng chỉ cần tải về, xóa phông và đặt đè lên video chính.

Thuật ngữ dùng trong tài liệu:

- **Cue**: một dòng phụ đề có mốc bắt đầu và kết thúc. "Theo câu" trong tài liệu này nghĩa là theo cue.
- **Từ**: cụm ký tự nằm giữa hai khoảng trắng. Với tiếng Việt, mỗi "từ" như vậy ứng với một âm tiết.
- **Phông**: nền đơn sắc của video để phần mềm dựng phim xóa đi.
- **Video overlay**: tệp video thành phẩm chứa chữ phụ đề trên phông hoặc trên nền trong suốt.

### Hiện trạng có ảnh hưởng tới yêu cầu

- Voice tạo ở chế độ khớp mốc có mốc đọc thật theo từng câu hoặc từng nhóm cue. Khi nhiều cue được ghép thành một câu để đọc liền, mốc của từng cue bên trong câu đó là mốc chia theo số ký tự, không phải mốc đo.
- Voice tạo ở chế độ đọc liên tục không bám mốc của tệp `.srt`, nên ghép với tệp `.srt` gốc sẽ lệch.
- Kịch bản sinh từ audio/video (spec 004) chỉ lưu mốc theo cue, không lưu mốc từng từ.
- Vì vậy hiện **không có nguồn mốc từng từ nào** trong hệ thống; các chế độ theo từ và karaoke dùng mốc ước lượng (FR-024).

### Đối chiếu hiến pháp (phiên bản 1.3.0)

| Nội dung | Kết luận |
| --- | --- |
| Nguyên tắc I (cô lập dữ liệu) | Tuân thủ: FR-045 đến FR-047 |
| Nguyên tắc II (bí mật) | Tuân thủ: tính năng không nhập hay hiển thị khóa nào; FR-039 cấm lộ chi tiết nội bộ trong nhật ký |
| Nguyên tắc III (tiến trình nền) | Tuân thủ: FR-035 đến FR-042 |
| Nguyên tắc IV (chi phí, hạn mức) | Tuân thủ: video và tệp tải lên tính vào hạn mức 500 MB và chặn ở máy chủ (FR-043, FR-044); tính năng không gọi nhà cung cấp AI nên không phát sinh bản ghi sử dụng |
| Nguyên tắc V (kiểm thử) | Mỗi user story có kiểm thử độc lập; FR-049 nêu các hành vi bắt buộc có kiểm thử tự động |
| Nguyên tắc VI (giao diện) | Tuân thủ: FR-048 |
| "Mốc thời gian chuẩn của voice và phụ đề theo câu/đoạn" và "Mốc từng từ trong video overlay" | Tuân thủ: mốc từng từ là ước lượng trong khoảng đọc của câu, chỉ để hiển thị, có ghi chú trên giao diện (FR-024, FR-025) |
| "Highlight theo từng từ trong trình phát voice" thuộc giai đoạn sau | Tuân thủ: spec này chỉ hiển thị theo từ **trong video overlay** và khung xem trước của nó |
| "Phạm vi giai đoạn này" | Tuân thủ: đã gồm tạo video overlay phụ đề |
| "Xuất phụ đề" thuộc giai đoạn sau | Không ảnh hưởng: tính năng này xuất video, không xuất tệp phụ đề |
| "Hoàn tất triển khai trên `main`" | Áp dụng ở bước triển khai, không đổi yêu cầu chức năng; các việc cần người dùng (phần mềm dựng phim, người thử, đo có phí) phải được chốt trước khi push |

Hiến pháp đã được sửa từ 1.1.0 lên 1.2.0 ngày 2026-11-25 cho tính năng này: thêm tạo video overlay phụ đề vào phạm vi, và cho phép mốc từng từ ước lượng chỉ để hiển thị trong video overlay; mốc theo câu/đoạn vẫn là chuẩn cho voice. Bản 1.3.0 cùng ngày thêm quy định commit và push lên `main` khi triển khai xong. Không còn xung đột nào phải xử lý trước khi triển khai.

## Clarifications

### Session 2026-11-25

- Q: Mốc từng từ cho chế độ theo từng từ và karaoke lấy từ đâu? → A: Ước lượng trong khoảng đọc của câu; không gọi nhà cung cấp AI, không tốn phí; giao diện ghi rõ là ước lượng.
- Q: Video thành phẩm và tệp âm thanh tải lên được giữ bao lâu, có tính vào hạn mức 500 MB không? → A: Giữ đến khi người dùng xóa và tính vào hạn mức lưu trữ của User (mặc định 500 MB).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Xuất video overlay theo câu từ voice và phụ đề có sẵn (Priority: P1)

Người làm video đã có voice và tệp `.srt` trong Project. Họ mở tab "Video Overlay", chọn voice, chọn phụ đề, chọn tỉ lệ khung hình và màu phông, bấm "Xuất Video Overlay", theo dõi tiến độ rồi tải tệp `.mp4` về để chèn vào phần mềm dựng phim.

**Why this priority**: Đây là giá trị cốt lõi. Chỉ với luồng này, kiểu chữ mặc định và hiển thị theo câu, người dùng đã bỏ được việc gõ và canh phụ đề bằng tay.

**Independent Test**: Trong Project có một voice khớp mốc và tệp `.srt` của nó, xuất video 9:16 phông xanh lá, tải về, mở bằng phần mềm dựng phim: chữ đúng nội dung, xuất hiện và biến mất đúng mốc, thời lượng bằng voice, xóa phông được.

**Acceptance Scenarios**:

1. **Given** Project có voice và `.srt` có mốc, **When** người dùng mở tab "Video Overlay", **Then** thấy danh sách voice và danh sách kịch bản `.srt` có mốc để chọn; kịch bản `.txt`, `.md` và `.srt` không có cue hợp lệ không chọn được và có lời giải thích.
2. **Given** người dùng chọn một voice được tạo từ một tệp `.srt` trong Project, **When** voice vừa được chọn, **Then** tệp `.srt` đó được chọn sẵn, người dùng đổi được.
3. **Given** đã chọn voice và phụ đề, **When** người dùng chọn 9:16, 16:9 hoặc 1:1 và một màu phông, **Then** video xuất ra có đúng kích thước 1080×1920, 1920×1080 hoặc 1080×1080 và đúng màu phông đã chọn.
4. **Given** cấu hình hợp lệ, **When** người dùng bấm "Xuất Video Overlay", **Then** một tiến trình xuất xuất hiện với trạng thái và tiến độ; đóng trình duyệt rồi quay lại vẫn thấy đúng tiến độ.
5. **Given** tiến trình hoàn tất, **When** người dùng bấm tải về, **Then** nhận tệp `.mp4` phát được, có tiếng của voice (trừ khi đã tắt), thời lượng bằng thời lượng voice.
6. **Given** một cue từ giây 5,2 đến giây 7,8, **When** xem video, **Then** chữ của cue chỉ hiện trong khoảng đó; ngoài mọi cue chỉ còn phông.

---

### User Story 2 - Xem trước thời gian thực và tùy chỉnh kiểu chữ, vị trí (Priority: P1)

Người dùng chỉnh phông chữ, cỡ, độ đậm, màu, viền, bóng, hộp nền, vị trí và canh lề; mỗi thay đổi thấy ngay trên khung xem trước có phát voice, có thanh tua, không cần xuất thử.

**Why this priority**: Mỗi kênh có phong cách chữ riêng. Không có xem trước, người dùng phải xuất nhiều lần mới ra kết quả dùng được.

**Independent Test**: Mở khung xem trước với voice và phụ đề mẫu, đổi lần lượt từng thuộc tính khi đang phát và khi tạm dừng, kiểm tra khung xem trước đổi theo; xuất video rồi so cùng thời điểm với khung xem trước.

**Acceptance Scenarios**:

1. **Given** khung xem trước đang phát, **When** người dùng đổi phông chữ, cỡ, màu, viền, bóng, hộp nền, vị trí hoặc canh lề, **Then** khung xem trước đổi theo ngay, voice không bị ngắt.
2. **Given** khung xem trước đang mở, **When** người dùng kéo thanh tua tới một thời điểm, **Then** chữ và tiếng chuyển đúng tới thời điểm đó.
3. **Given** một câu dài vượt độ rộng tối đa, **When** hiển thị, **Then** câu tự xuống dòng tại khoảng trắng, không cắt giữa từ, không tràn ra ngoài khung hình.
4. **Given** vị trí "Dưới cùng" (mặc định), **When** người dùng kéo thanh độ cao, **Then** chữ di chuyển theo và không ra khỏi khung hình.
5. **Given** cấu hình đã chỉnh, **When** xuất video, **Then** cách xuống dòng, vị trí, màu và cỡ chữ giống khung xem trước.
6. **Given** người dùng đã chỉnh kiểu chữ rồi rời trang, **When** quay lại tab này của cùng Project, **Then** cấu hình lần trước được giữ nguyên.
7. **Given** người dùng chọn màu chữ xanh lá trên phông xanh lá, **When** màu vừa được chọn, **Then** hệ thống cảnh báo chữ sẽ mất khi xóa phông và gợi ý đổi màu chữ hoặc màu phông.

---

### User Story 3 - Hiệu ứng xuất hiện và biến mất theo câu (Priority: P2)

Người dùng chọn hiệu ứng để câu chữ xuất hiện (hiện dứt khoát, mờ dần, bung ra, nảy, trượt lên, lướt ngang, rơi xuống), chỉnh thời lượng, độ nảy, và chọn cách chữ biến mất.

**Why this priority**: Hiệu ứng là thứ làm video ngắn nổi bật, nhưng video vẫn dùng được khi chưa có.

**Independent Test**: Với cùng voice và phụ đề, lần lượt chọn từng hiệu ứng nhóm cơ bản và nhóm động lực, kiểm tra chuyển động trong khung xem trước và trong video xuất ra.

**Acceptance Scenarios**:

1. **Given** chế độ theo câu, **When** chọn "Bung ra" với thời lượng 300 ms, **Then** mỗi câu phóng từ 80% lên 100% trong 300 ms kể từ mốc bắt đầu.
2. **Given** hiệu ứng "Nảy" hoặc "Bung ra", **When** đổi độ nảy Nhẹ, Vừa, Mạnh, **Then** mức vượt cỡ thay đổi; với "Nảy" mức Vừa vượt tới 105%; cả hai kết thúc ở 100%.
3. **Given** cách biến mất "Mờ dần" hoặc "Trượt xuống", **When** câu kết thúc, **Then** chữ biến mất đúng cách đã chọn và đã ẩn hẳn tại mốc kết thúc của câu.
4. **Given** một câu ngắn hơn tổng thời lượng hiệu ứng vào và ra, **When** hiển thị, **Then** hiệu ứng tự rút ngắn để câu vẫn hiện rõ và không lấn sang câu kế tiếp.

---

### User Story 4 - Hiển thị theo từng từ và tô màu karaoke (Priority: P2)

Người làm video ngắn chọn chế độ "Theo từng từ" (từ nảy ra theo nhịp đọc, hoặc chữ gõ dần) hoặc "Karaoke" (cả câu hiện sẵn, từ đang đọc phóng to và đổi màu, hoặc vệt màu quét qua), chọn màu nổi bật.

**Why this priority**: Đây là phong cách phổ biến nhất của video ngắn, nhưng độ khớp của mốc ước lượng phải được đo trước (SC-008).

**Independent Test**: Với một voice khớp mốc tiếng Việt, xem từng chế độ theo từ và karaoke trong khung xem trước và video xuất ra; đối chiếu thời điểm đổi từ với lời đọc trên bộ câu mẫu.

**Acceptance Scenarios**:

1. **Given** chế độ "Theo từng từ", **When** một câu bắt đầu, **Then** từng từ xuất hiện lần lượt đúng thứ tự, từ đầu xuất hiện tại mốc bắt đầu lời đọc của câu, mọi từ đã hiện trước khi câu kết thúc.
2. **Given** chế độ "Karaoke" với hiệu ứng nhấn từ đang đọc, **When** lời đọc đi qua từng từ, **Then** tại mỗi thời điểm nhiều nhất một từ được phóng to 115–120% và đổi màu nổi bật, các từ khác giữ kiểu thường; ở quãng nghỉ giữa câu từ vừa đọc giữ nổi bật tới khi từ kế tiếp bắt đầu.
3. **Given** hiệu ứng quét màu karaoke, **When** câu đang được đọc, **Then** vệt màu chạy liên tục từ trái sang phải theo thứ tự các dòng và phủ hết câu khi đọc xong.
4. **Given** hiệu ứng máy đánh chữ, **When** câu đang được đọc, **Then** ký tự hiện dần theo nhịp đọc, chữ tiếng Việt có dấu hiện trọn ký tự chứ không tách dấu.
5. **Given** người dùng đang chọn một hiệu ứng không hợp với chế độ mới, **When** đổi chế độ, **Then** hệ thống chuyển sang hiệu ứng mặc định của chế độ đó và báo cho người dùng biết.
6. **Given** chọn chế độ "Theo từng từ" hoặc "Karaoke", **When** màn hình cấu hình hiển thị, **Then** có ghi chú nhịp từng từ là ước lượng và có thể lệch khi giọng đọc không đều.

---

### User Story 5 - Dùng voice và phụ đề tải lên từ máy (Priority: P2)

Người dùng đã có sẵn tệp âm thanh thu ngoài và tệp `.srt`, muốn tạo video overlay mà không cần tạo voice trong hệ thống.

**Why this priority**: Mở rộng cho người tự thu giọng; người dùng hiện tại chủ yếu đã có voice trong Project.

**Independent Test**: Trong Project trống, tải lên một tệp `.mp3` và một tệp `.srt`, xem trước rồi xuất video.

**Acceptance Scenarios**:

1. **Given** tab "Video Overlay", **When** tải lên tệp `.mp3`, `.wav` hoặc `.m4a` hợp lệ, **Then** tệp dùng được ngay để xem trước và xuất.
2. **Given** tệp âm thanh sai định dạng, hỏng, quá 100 MB, dài quá giới hạn hoặc vượt chỗ còn lại trong hạn mức, **When** tải lên, **Then** bị từ chối kèm nguyên nhân và cách xử lý.
3. **Given** tải lên tệp `.srt` hợp lệ, **When** tải xong, **Then** tệp xuất hiện trong danh sách kịch bản của Project và được chọn làm phụ đề.
4. **Given** voice tải lên và phụ đề lệch thời lượng, **When** chọn cả hai, **Then** hệ thống cảnh báo phần lệch trước khi xuất nhưng vẫn cho xuất.

---

### User Story 6 - Theo dõi và quản lý các lần xuất video (Priority: P2)

Người dùng xem danh sách các lần xuất của Project, theo dõi tiến độ và nhật ký, dừng, chạy lại, dùng lại cấu hình của một lần xuất cũ, tải về và xóa.

**Why this priority**: Xuất video lâu; người dùng cần biết hệ thống đang làm gì và không mất công khi có sự cố.

**Independent Test**: Xuất ba video, dừng một, để một lỗi rồi chạy lại, xóa hai mục cùng lúc; khởi động lại hệ thống khi đang xuất và kiểm tra tiến trình không mất.

**Acceptance Scenarios**:

1. **Given** tiến trình đang chạy, **When** người dùng bấm dừng, **Then** tiến trình chuyển "đã dừng", không để lại video dở dang tải được.
2. **Given** tiến trình lỗi hoặc đã dừng, **When** bấm chạy lại, **Then** tiến trình chạy lại với đúng cấu hình và nội dung đã chốt lúc bấm xuất.
3. **Given** hệ thống khởi động lại khi đang xuất, **When** hệ thống chạy lại, **Then** tiến trình được xếp hàng lại hoặc báo "bị gián đoạn, có thể chạy lại", không mất âm thầm.
4. **Given** một lần xuất cũ, **When** chọn "Dùng lại cấu hình", **Then** toàn bộ kiểu chữ, khung hình, phông và hiệu ứng của lần đó được nạp vào màn hình cấu hình.
5. **Given** chọn hai video, **When** bấm xóa, **Then** hộp xác nhận nêu số lượng và hậu quả; sau xác nhận cả hai không còn tải được và dung lượng của chúng được trả lại hạn mức.
6. **Given** dung lượng ước tính của video lớn hơn chỗ còn lại trong hạn mức, **When** bấm xuất, **Then** bị chặn với thông báo nêu còn lại bao nhiêu, cần bao nhiêu và lối tới danh sách video, tệp tải lên, voice để xóa bớt.

---

### User Story 7 - Xuất video nền trong suốt (Priority: P3)

Người dựng phim chuyên nghiệp chọn nền trong suốt để đặt thẳng lên video chính mà không cần xóa phông, giữ trọn bóng mờ và viền sáng.

**Why this priority**: Phông màu đã đáp ứng phần lớn người dùng; nền trong suốt tạo tệp lớn và không phải phần mềm nào cũng đọc được.

**Independent Test**: Xuất `.mov` và `.webm` nền trong suốt có bóng mờ và hộp nền 50%, đặt lên video khác và kiểm tra video bên dưới nhìn xuyên qua đúng chỗ.

**Acceptance Scenarios**:

1. **Given** chọn nền trong suốt, **When** mở lựa chọn định dạng, **Then** chỉ có `.mov` và `.webm`; khi chọn phông màu chỉ có `.mp4`.
2. **Given** nền trong suốt, **When** xem trước, **Then** khung xem trước hiện ô bàn cờ để phân biệt vùng trong suốt và ghi rõ ô bàn cờ không nằm trong video.
3. **Given** tệp `.mov` xuất ra, **When** đặt lên video chính, **Then** vùng không có chữ trong suốt hoàn toàn và bóng, hộp nền bán trong suốt hiển thị đúng độ mờ.
4. **Given** cấu hình trong suốt có dung lượng ước tính vượt chỗ còn lại trong hạn mức, **When** bấm xuất, **Then** hệ thống chặn, nêu dung lượng ước tính và gợi ý (giải phóng chỗ, dùng `.webm`, dùng phông màu, hoặc cắt ngắn voice).

---

### User Story 8 - Hiệu ứng điện ảnh và sáng tạo (Priority: P3)

Người dùng chọn các hiệu ứng nhòe tụ nét, giật tách màu, phát sáng neon, lật 3D, rung nhẹ cho video có phong cách riêng.

**Why this priority**: Làm phong phú lựa chọn, không ảnh hưởng luồng chính.

**Independent Test**: Lần lượt chọn từng hiệu ứng, kiểm tra trong khung xem trước và video xuất ra trên phông xanh lá và nền trong suốt.

**Acceptance Scenarios**:

1. **Given** hiệu ứng "Giật tách màu", **When** đổi câu, **Then** chữ tách màu trong khoảng 0,1 giây rồi trở lại bình thường.
2. **Given** hiệu ứng "Rung nhẹ", **When** chọn phạm vi "Chỉ câu cảm thán", **Then** chỉ câu kết thúc bằng dấu chấm than được rung; chọn "Mọi câu" thì mọi câu được rung.
3. **Given** hiệu ứng có vùng mờ (nhòe, phát sáng, tách màu) trên phông xanh lá hoặc xanh dương, **When** chọn, **Then** hệ thống báo mép chữ có thể ám màu phông sau khi xóa và gợi ý nền trong suốt.

---

### Edge Cases

- **Project chưa có voice hoặc chưa có `.srt`**: hiện trạng thái rỗng kèm lối tắt tới tạo voice, tải kịch bản hoặc tải tệp từ máy.
- **Voice ngắn hơn phụ đề**: video dừng tại hết voice; cue bắt đầu sau đó không hiện, cue đang hiện bị cắt tại cuối voice. Hệ thống nêu số cue bị mất trước khi xuất.
- **Voice dài hơn phụ đề**: sau cue cuối chỉ còn phông tới hết voice.
- **Chọn voice đọc liên tục với tệp `.srt`**: cảnh báo voice này không bám mốc phụ đề nên chữ có thể lệch, gợi ý tạo voice khớp mốc.
- **Chọn voice của tệp này với phụ đề của tệp khác**: cho phép, kèm cảnh báo có thể lệch.
- **Đoạn voice im lặng do nhà cung cấp từ chối nội dung**: cue vẫn hiện theo mốc của tệp phụ đề.
- **Cue chồng lấn, sai thứ tự, mốc ngược**: dùng cue đã chuẩn hóa như khi tạo voice; tại mỗi thời điểm chỉ hiện một cue.
- **Cue chỉ có ♪, [Music] hoặc rỗng**: không hiện.
- **Chữ có thẻ định dạng hoặc ký tự đặc biệt**: hiển thị như chữ thường, không bao giờ được hiểu là lệnh hay mã.
- **Ký tự phông chữ không hỗ trợ (biểu tượng cảm xúc, chữ nước ngoài)**: dùng phông chữ thay thế; nếu không phông chữ nào có thì cảnh báo cue bị ảnh hưởng trước khi xuất.
- **Câu quá dài cho cỡ chữ đã chọn**: riêng câu đó được thu nhỏ cho vừa khung và được liệt kê trong cảnh báo.
- **Từ dài hơn độ rộng tối đa (ví dụ liên kết)**: chỉ khi đó mới được ngắt giữa từ.
- **Màu chữ, viền, hộp nền hoặc màu nổi bật gần màu phông**: cảnh báo sẽ mất khi xóa phông; với phông đen, cảnh báo màu tối sẽ biến mất ở chế độ hòa trộn.
- **Hộp nền bán trong suốt, bóng mờ, mờ dần trên phông xanh**: cảnh báo một lần về viền ám màu, vẫn cho xuất.
- **Voice, phụ đề nguồn bị xóa khi tiến trình đang chờ hoặc chạy**: tiến trình chuyển lỗi với lý do "Tệp nguồn đã bị xóa"; video đã xuất xong không bị ảnh hưởng.
- **Project hoặc User bị xóa khi đang xuất**: tiến trình dừng, mọi tệp tạm và video của nó bị xóa. User bị khóa: tiến trình của họ dừng như các tiến trình khác.
- **Video thật lớn hơn ước tính và vượt chỗ còn lại trong hạn mức**: tiến trình dừng ở trạng thái lỗi, dọn phần dở, không trừ hạn mức, nêu cần giải phóng bao nhiêu và cho chạy lại.
- **Administrator hạ hạn mức xuống dưới mức User đang dùng**: video và tệp đã có vẫn giữ và tải được; chỉ chặn tạo mới.
- **Câu chỉ có một từ, hoặc có số, ký hiệu**: một từ chiếm trọn khoảng đọc; cụm số và ký hiệu liền nhau tính là một từ.
- **Câu quá ngắn so với số từ**: các từ vẫn theo thứ tự; từ nào ngắn hơn thời lượng hiệu ứng thì hiệu ứng của từ đó được rút ngắn.
- **Bấm xuất nhiều lần liên tiếp**: không tạo hai tiến trình từ một lần bấm; vượt số tiến trình cho phép thì bị từ chối kèm thông báo.
- **Trình duyệt chặn tự phát tiếng**: khung xem trước chờ người dùng bấm phát.
- **Điện thoại yếu khi xem trước hiệu ứng nặng**: khung xem trước có thể giảm độ mượt nhưng chữ vẫn phải theo đúng thời điểm của voice.

## Requirements *(mandatory)*

### Functional Requirements

**Nguồn voice và phụ đề**

- **FR-001**: Mỗi Project MUST có một tab riêng "Video Overlay", hoạt động độc lập với các tab khác.
- **FR-002**: Người dùng MUST chọn được nguồn voice từ danh sách voice của Project hoặc tải lên một tệp `.mp3`, `.wav`, `.m4a` tối đa 100 MB.
- **FR-003**: Người dùng MUST chọn được phụ đề từ kịch bản `.srt` có mốc của Project hoặc tải lên một tệp `.srt` theo cùng quy tắc kiểm tra và giới hạn như kịch bản hiện có (2 MB, UTF-8); tệp tải lên trở thành kịch bản của Project.
- **FR-004**: Khi voice được chọn là voice khớp mốc tạo từ chính tệp phụ đề được chọn, mỗi cue MUST hiện từ lúc voice bắt đầu đọc cue đó và ẩn tại thời điểm muộn hơn giữa lúc đọc xong và mốc kết thúc trong tệp, nhưng không quá lúc cue kế tiếp hiện. Các trường hợp khác, và cue không có tiếng trong voice, MUST dùng mốc trong tệp phụ đề. Khi hai loại mốc xen kẽ, các cue MUST vẫn theo đúng thứ tự trong tệp, không chồng lấn và mỗi cue hiện ít nhất một khung hình. Mốc tính được gọi là mốc áp dụng; "mốc bắt đầu" và "mốc kết thúc" của câu trong các yêu cầu dưới đây là mốc áp dụng.
- **FR-005**: Hệ thống MUST cảnh báo trước khi xuất khi: voice không khớp mốc với phụ đề đã chọn (đọc liên tục, hoặc thuộc tệp khác), hoặc thời lượng voice và mốc kết thúc của cue cuối lệch nhau quá 2 giây; cảnh báo nêu mức lệch và số cue bị cắt, và không chặn xuất.
- **FR-006**: Thời lượng video MUST bằng thời lượng voice; thời lượng tối đa mặc định là 60 phút với phông màu và 10 phút với nền trong suốt, Administrator chỉnh được; vượt giới hạn MUST bị từ chối ở máy chủ, kèm thông báo.

**Khung hình và nền**

- **FR-007**: Người dùng MUST chọn được tỉ lệ 9:16 (1080×1920, mặc định), 16:9 (1920×1080) hoặc 1:1 (1080×1080).
- **FR-008**: Người dùng MUST chọn được nền xanh lá `#00FF00` (mặc định), xanh dương `#0000FF`, đen `#000000`, hoặc trong suốt.
- **FR-009**: Nền màu MUST đồng nhất trên toàn khung hình và trong suốt thời gian video, trừ vùng có chữ, viền, bóng, hộp nền và hiệu ứng của chúng.
- **FR-010**: Hệ thống MUST cảnh báo khi màu chữ, viền, hộp nền hoặc màu nổi bật đang bật sẽ bị xóa cùng phông. Tối thiểu: phông xanh lá cảnh báo với `#00FF00`, `#00FF66`, `#39FF14`; phông xanh dương với `#0000FF`, `#1E40FF`; phông đen với `#000000`, `#1A1A1A`; và MUST NOT cảnh báo với `#FFFFFF`, `#FFE600`, `#FF4500` trên cả ba phông. Khi người dùng chọn phông đen mà viền đang ở màu đen mặc định, giao diện MUST tự tắt viền và báo cho người dùng.
- **FR-011**: Hệ thống MUST cảnh báo khi cấu hình có vùng bán trong suốt (hộp nền chưa đặc, bóng mờ, mờ dần, nhòe, phát sáng, tách màu) trên phông xanh lá hoặc xanh dương, kèm gợi ý dùng nền trong suốt.

**Kiểu chữ và vị trí**

- **FR-012**: Người dùng MUST chọn được phông chữ từ danh sách có đủ chữ tiếng Việt, tối thiểu Be Vietnam Pro, Roboto, Montserrat, Inter và một phông chữ kiểu Arial; chọn cỡ chữ từ 24 đến 160 điểm ảnh; chọn độ đậm Thường, Đậm, Rất đậm. Độ đậm mà phông chữ không có MUST không chọn được.
- **FR-013**: Người dùng MUST chọn được màu chữ; bật/tắt viền với màu và độ dày 1–20 điểm ảnh; bật/tắt bóng với màu và độ mờ 0–40 điểm ảnh; bật/tắt hộp nền với màu, bo góc 0–60 điểm ảnh và độ đục 0–100%.
- **FR-014**: Người dùng MUST chọn được vị trí Dưới cùng (mặc định), Giữa, Trên cùng; tinh chỉnh độ cao bằng thanh trượt; canh giữa (mặc định), trái, phải; và đặt độ rộng tối đa của dòng từ 40% đến 100% khung hình (mặc định 90%).
- **FR-015**: Câu vượt độ rộng tối đa MUST tự xuống dòng tại khoảng trắng. Chữ MUST luôn nằm trọn trong khung hình khi đứng yên; câu không vừa MUST được thu nhỏ riêng tới khi vừa (kể cả nhỏ hơn cỡ tối thiểu của FR-012) và được báo cho người dùng.
- **FR-016**: Hệ thống MUST tự lưu cấu hình gần nhất của mỗi Project và cho phép đưa về mặc định.

**Chế độ đồng bộ và hiệu ứng**

- **FR-017**: Người dùng MUST chọn được một trong ba chế độ: Theo câu (mặc định), Theo từng từ, Karaoke.
- **FR-018**: Ở chế độ Theo câu, câu MUST hiện từ mốc bắt đầu đến mốc kết thúc và dùng được các hiệu ứng vào nhóm cơ bản, động lực và điện ảnh.
- **FR-019**: Nhóm cơ bản MUST gồm: hiện dứt khoát (mặc định), mờ dần vào và ra.
- **FR-020**: Nhóm động lực MUST gồm: bung ra (80% lên 100%), nảy (vượt cỡ rồi về 100%), trượt lên (chậm dần), lướt ngang từ trái, lướt ngang từ phải, rơi xuống (có dằn).
- **FR-021**: Nhóm điện ảnh MUST gồm: nhòe tụ nét, giật tách màu (khoảng 0,1 giây khi đổi câu), phát sáng neon rồi dịu, lật 3D quanh trục ngang, rung nhẹ với phạm vi "Chỉ câu cảm thán" (mặc định) hoặc "Mọi câu".
- **FR-022**: Ở chế độ Theo từng từ, người dùng MUST chọn được: hiện dứt khoát từng từ (mặc định), từ nảy ra, máy đánh chữ.
- **FR-023**: Ở chế độ Karaoke, cả câu MUST hiện từ mốc bắt đầu và người dùng MUST chọn được: nhấn từ đang đọc (phóng to 115–120% kèm đổi màu, mặc định) hoặc quét màu liên tục; MUST kết hợp được với một hiệu ứng vào của FR-019 đến FR-021 cho cả câu.
- **FR-024**: Chế độ Theo từng từ và Karaoke MUST dùng mốc từng từ ước lượng: khoảng đọc của câu được chia cho các từ theo độ dài tương đối của từng từ, có thêm quãng nghỉ sau dấu câu. Khoảng đọc là từ lúc bắt đầu đến lúc đọc xong cue trong voice khi FR-004 dùng mốc đọc thật, ngược lại là từ mốc bắt đầu đến mốc kết thúc của cue trong tệp. Cùng đầu vào MUST luôn cho cùng mốc, và khung xem trước với video xuất ra MUST dùng cùng mốc. Việc ước lượng MUST NOT gọi nhà cung cấp AI.
- **FR-025**: Từ đầu MUST bắt đầu đúng lúc khoảng đọc bắt đầu, từ cuối MUST kết thúc không muộn hơn lúc khoảng đọc kết thúc, các từ theo đúng thứ tự và không chồng lấn; hết khoảng đọc mà câu còn hiện thì không từ nào được nhấn. Giao diện MUST ghi rõ mốc từng từ là ước lượng.
- **FR-026**: Người dùng MUST chỉnh được thời lượng hiệu ứng 100–600 ms (mặc định 250 ms), độ nảy Nhẹ/Vừa/Mạnh cho các hiệu ứng bung, nảy và từ nảy ra (mức Vừa của hiệu ứng nảy vượt tới 105%), màu nổi bật (gợi ý sẵn `#FFE600`, `#00FF66`, `#FF4500`, hồng phấn và màu tùy chọn), và cách biến mất: tắt ngay (mặc định), mờ dần, trượt xuống. Thông số không áp dụng cho lựa chọn hiện tại MUST được ẩn hoặc khóa.
- **FR-027**: Tổng thời lượng hiệu ứng vào và ra của một câu MUST NOT vượt quá thời lượng câu; khi vượt, hai phần MUST được rút ngắn theo tỉ lệ.
- **FR-028**: Khi đổi chế độ làm lựa chọn hiện tại không còn hợp lệ, hệ thống MUST chuyển sang mặc định của chế độ mới và báo cho người dùng.

**Xem trước**

- **FR-029**: Khung xem trước MUST phát voice cùng chữ trên đúng tỉ lệ và nền đã chọn, có phát/tạm dừng, thanh tua và hiển thị thời gian.
- **FR-030**: Mọi thay đổi cấu hình MUST hiện trên khung xem trước mà không cần xuất và không làm ngắt voice.
- **FR-031**: Video xuất ra MUST giống khung xem trước về nội dung, phông chữ, cỡ, màu, cách xuống dòng, vị trí và thời điểm.

**Xuất và tải về**

- **FR-032**: Phông màu MUST xuất `.mp4`; nền trong suốt MUST xuất `.mov` (mặc định) hoặc `.webm` giữ được độ trong suốt; giao diện MUST nêu phần mềm nào phù hợp với từng định dạng.
- **FR-033**: Người dùng MUST chọn được có kèm tiếng voice trong video hay không (mặc định có).
- **FR-034**: Trước khi xuất, hệ thống MUST hiện thời lượng và dung lượng ước tính, ghi rõ là ước tính.
- **FR-035**: Xuất video MUST chạy nền, độc lập với trình duyệt. Nội dung phụ đề và cấu hình MUST được chốt tại lúc bấm xuất; chỉnh sửa sau đó không ảnh hưởng tiến trình đã tạo.
- **FR-036**: Mỗi tiến trình MUST có trạng thái đang chờ, đang chạy, đã dừng, hoàn tất, lỗi, bị gián đoạn, có phần trăm tiến độ, và cập nhật tới người xem trong vòng 2 giây.
- **FR-037**: Khi hệ thống khởi động lại, tiến trình đang chạy MUST được xếp hàng lại hoặc đánh dấu bị gián đoạn để chạy lại; được phép xuất lại từ đầu.
- **FR-038**: Lỗi tạm thời MUST được thử lại tối đa 3 lần với thời gian chờ tăng dần; lỗi vĩnh viễn (tệp hỏng, tệp nguồn đã xóa, vượt giới hạn) MUST NOT được thử lại.
- **FR-039**: Mỗi tiến trình MUST có nhật ký lưu lại (đổi trạng thái, thử lại, cảnh báo, lỗi), xem được trên giao diện, không chứa thông tin bí mật hay chi tiết nội bộ.
- **FR-040**: Mỗi User MUST có tối đa 2 tiến trình xuất đang chờ, đang chạy hoặc bị gián đoạn, Administrator chỉnh được; yêu cầu vượt MUST bị từ chối ở máy chủ kèm thông báo.
- **FR-041**: Tổng số tiến trình xuất chạy cùng lúc MUST có giới hạn riêng (mặc định 1, Administrator chỉnh được), phần dư xếp hàng; tiến trình xuất MUST NOT chiếm chỗ của tiến trình tạo voice và tạo phụ đề.
- **FR-042**: Người dùng MUST dừng, chạy lại, xem cấu hình đã dùng, dùng lại cấu hình, tải về và xóa một hoặc nhiều lần xuất; MUST xem và xóa được tệp âm thanh đã tải lên; xóa MUST có bước xác nhận nêu số lượng và hậu quả; danh sách lần xuất và tệp tải lên kèm dung lượng MUST hiện trong tab Video Overlay.
- **FR-043**: Video thành phẩm và tệp âm thanh tải lên cho tính năng này MUST được giữ đến khi người dùng xóa (hoặc Project/User bị xóa), MUST tính vào hạn mức lưu trữ của User (mặc định 500 MB, Administrator chỉnh được) theo dung lượng thật, MUST được cộng vào số dung lượng hiển thị ở Dashboard và thống kê của Administrator, và MUST trả lại hạn mức ngay khi xóa. Tệp tạm của tiến trình MUST NOT tính vào hạn mức.
- **FR-044**: Hệ thống MUST chặn ở máy chủ việc tải tệp âm thanh khi vượt chỗ còn lại, và việc xuất khi dung lượng ước tính cộng dung lượng ước tính của các tiến trình xuất đang chờ, đang chạy hoặc bị gián đoạn của User vượt chỗ còn lại; thông báo MUST nêu còn lại, cần thêm và cách giải phóng. Video thật vượt chỗ còn lại lúc hoàn tất MUST NOT được lưu. Tệp tạm MUST được dọn khi tiến trình kết thúc, dù thành công hay không.

**Bảo mật, dữ liệu và giao diện**

- **FR-045**: Chỉ chủ sở hữu Project MUST xem, xuất, nghe, tải, dừng và xóa được dữ liệu Video Overlay của Project đó; truy cập của User khác và của Administrator MUST bị từ chối như thể dữ liệu không tồn tại, ở mọi đường truy cập.
- **FR-046**: Nội dung phụ đề, tên tệp và cấu hình do người dùng nhập MUST được kiểm tra ở máy chủ và chỉ được hiển thị như chữ; MUST NOT được hiểu là lệnh.
- **FR-047**: Xóa Project hoặc User MUST dừng tiến trình liên quan và xóa hết video, tệp tải lên, cấu hình, nhật ký của tính năng này.
- **FR-048**: Giao diện MUST đầy đủ vi và en, theo hệ thống thiết kế hiện có ở cả theme Sáng và Tối, có đủ trạng thái đang tải, rỗng, lỗi; xem trước, theo dõi, tải về và chỉnh cấu hình MUST dùng được trên điện thoại. Nội dung phụ đề MUST NOT bị dịch.
- **FR-049**: Các hành vi sau MUST có kiểm thử tự động: cô lập dữ liệu giữa hai User (kể cả tải video); mốc hiện/ẩn theo câu; ràng buộc mốc từng từ (FR-025); rút ngắn hiệu ứng (FR-027); thời lượng video bằng voice; giới hạn số tiến trình và thời lượng; cộng, chặn và trả lại hạn mức lưu trữ, kể cả khi nhiều tiến trình cùng lúc; phục hồi sau khởi động lại; lỗi tạm thời so với vĩnh viễn; xóa Project/User xóa sạch dữ liệu.

### Key Entities

- **Cấu hình overlay**: lựa chọn khung hình, nền, kiểu chữ, vị trí, chế độ đồng bộ, hiệu ứng, tiếng kèm. Mỗi Project có một cấu hình gần nhất; mỗi lần xuất giữ một bản đã chốt.
- **Nguồn voice**: voice của Project hoặc tệp âm thanh người dùng tải lên, có thời lượng. Tệp tải lên thuộc một Project và một User, giữ đến khi bị xóa và tính vào hạn mức của User.
- **Nguồn phụ đề**: kịch bản `.srt` có mốc của Project, gồm các cue đã chuẩn hóa.
- **Mốc hiển thị**: mốc bắt đầu, kết thúc của từng cue (và của từng từ khi cần), kèm nguồn gốc: mốc đọc thật của voice, mốc của tệp phụ đề, hay ước lượng.
- **Tiến trình xuất**: một lần xuất, thuộc Project; có nguồn, cấu hình đã chốt, trạng thái, tiến độ, lỗi và nhật ký.
- **Video overlay**: kết quả của một tiến trình hoàn tất; có định dạng, kích thước, thời lượng, dung lượng, thời điểm tạo; giữ đến khi bị xóa và tính vào hạn mức của User.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Người dùng đã có voice và `.srt` bấm được "Xuất Video Overlay" trong dưới 1 phút kể từ khi mở tab, dùng cấu hình mặc định, không cần hướng dẫn.
- **SC-002**: Trong video xuất ra, 100% cue của bộ mẫu hiện và ẩn lệch không quá 50 ms so với mốc áp dụng, ở cả đầu và cuối video dài 60 phút (không trôi dần).
- **SC-003**: Thời lượng video lệch thời lượng voice không quá 50 ms.
- **SC-004**: Thay đổi kiểu chữ, màu, vị trí hiện trên khung xem trước trong vòng 0,2 giây; sau khi tua, chữ đúng trong vòng 0,5 giây.
- **SC-005**: Tại 20 thời điểm lấy mẫu, khung xem trước và video xuất ra có cùng nội dung, cùng cách xuống dòng, và vị trí khối chữ lệch không quá 1% chiều cao khung hình.
- **SC-006**: Chữ đặc màu trắng có viền đen trên phông xanh lá, sau khi xóa phông bằng thiết lập mặc định của CapCut, Premiere, DaVinci Resolve, không còn mảng phông nhìn thấy được và chữ không bị thủng.
- **SC-007**: Tệp `.mp4` mở được trong cả bốn phần mềm CapCut, Premiere, DaVinci Resolve, After Effects; tệp `.mov` trong suốt giữ đúng độ trong suốt trong Premiere, DaVinci Resolve và After Effects.
- **SC-008**: Ở chế độ theo từ và karaoke, 100% cue của bộ mẫu thỏa FR-025, và ít nhất 80% số từ đổi trạng thái lệch không quá 300 ms so với lúc từ được đọc (đo trên voice khớp mốc tiếng Việt).
- **SC-009**: Video `.mp4` 5 phút với hiệu ứng theo câu hoàn tất trong không quá 5 phút kể từ khi bắt đầu chạy.
- **SC-010**: 100% tiến trình xuất tiếp tục khi người dùng đóng trình duyệt, và không tiến trình nào mất âm thầm sau khi hệ thống khởi động lại.
- **SC-011**: Khi một video 60 phút đang xuất, tiến trình tạo voice mới của User khác bắt đầu chạy trong vòng 10 giây nếu còn chỗ theo giới hạn tiến trình voice.
- **SC-012**: Trong kiểm thử với ít nhất 2 User, 0 trường hợp một User xem hoặc tải được video, tệp tải lên của User khác.
- **SC-013**: Ít nhất 90% người dùng thử tự tạo được video đúng ý ở lần xuất thứ nhất hoặc thứ hai.
- **SC-014**: Dung lượng đã dùng hiển thị cho User khớp 100% với tổng dung lượng thật các tệp của họ sau khi xuất, xóa hoặc xuất lỗi, cập nhật trong vòng 1 phút; 0 trường hợp hạn mức bị vượt do xuất video.

## Assumptions

- **Phạm vi phiên bản này**: gồm toàn bộ nhóm tính năng trong REQ-005, chia ưu tiên theo user story. Triển khai theo thứ tự P1 → P2 → P3.
- **Một cấu hình cho cả video**: kiểu chữ và hiệu ứng áp dụng cho mọi câu; chỉnh riêng từng câu nằm ngoài phạm vi.
- **"Câu có sắc thái cảm xúc mạnh"** ở hiệu ứng rung được hiểu là câu kết thúc bằng dấu chấm than, vì hệ thống không nhận biết cảm xúc giọng nói.
- **Phông chữ kiểu Arial**: Arial có bản quyền; nếu không có quyền dùng khi xuất ở máy chủ thì thay bằng phông chữ có dáng và độ rộng chữ tương đương. Mọi phông chữ trong danh sách phải được phép dùng để tạo video.
- **Đơn vị điểm ảnh** của cỡ chữ, viền, bóng, bo góc tính trên khung hình xuất ra; khung xem trước thu nhỏ theo tỉ lệ.
- **Tốc độ khung hình** cố định 30 hình/giây; không có lựa chọn khác ở phiên bản này.
- **Tệp `.webm`** không được mọi phần mềm dựng phim đọc; giao diện khuyên dùng `.mov` cho Premiere, DaVinci Resolve, After Effects.
- **Dung lượng**: đo thử ở bước lập kế hoạch (2026-11-25, máy dev, khung 1080×1920): video phông màu khoảng 1–3 MB/phút chưa kể tiếng; `.webm` trong suốt khoảng 1–5 MB/phút; `.mov` trong suốt khoảng 117–226 MB/phút. Vì video tính vào hạn mức 500 MB, một tệp `.mov` trong suốt chỉ dài được khoảng 2–3,5 phút dù giới hạn là 10 phút; người dùng chọn `.webm`, hoặc Administrator nâng hạn mức. Video `.mov` dưới 1 phút vẫn vừa hạn mức nên giữ FR-043.
- **Chưa kiểm chứng**: SC-009 đã đo thử trên máy dev (60 giây video xuất trong khoảng 15–27 giây) nhưng phải đo lại trên máy triển khai; SC-008 (80% số từ trong 300 ms) chưa đo vì cần nhận dạng giọng nói có tính phí; nếu cách ước lượng ở FR-024 không đạt SC-008 thì quay lại sửa spec.
- **Mốc của cue ghép cùng câu** trong voice khớp mốc là mốc chia theo ký tự; tính năng này dùng nguyên mốc đó, không cải thiện.
- **Nguồn phụ đề** là `.srt` như yêu cầu; voice tạo từ `.txt`/`.md` cần một tệp `.srt` đi kèm (có thể tạo bằng tính năng phiên âm của spec 004).
- **Xuống dòng sẵn có trong cue** không bắt buộc giữ; chữ được tự xuống dòng theo độ rộng tối đa.
- **Giới hạn tệp âm thanh tải lên** (100 MB, 60 phút) và số tiến trình (2 mỗi User) lấy theo spec 004 cho nhất quán.
- **Tính năng không gọi nhà cung cấp AI**; nhận dạng mốc từng từ từ voice nằm ngoài phạm vi.
- **Hạn mức khi đang xuất**: khác tiến trình tạo voice (được hoàn tất dù chạm hạn mức, spec 001), video vượt chỗ còn lại không được lưu, vì một video có thể lớn hơn cả hạn mức.
- **Phụ thuộc**: kịch bản, cue chuẩn hóa và voice khớp mốc (spec 001, 003), cài đặt hệ thống của Administrator, hạn mức lưu trữ, tiến trình nền và nhật ký hiện có.
- **Gợi ý kỹ thuật trong REQ-005** (cách dựng hình, hàng đợi, bộ mã hóa video) để lại cho bước `/speckit-plan`.
- **Ngoài phạm vi**: chỉnh sửa chữ hoặc mốc phụ đề trong màn hình này; ghép overlay lên video chính trong hệ thống; nhiều lớp chữ hoặc hai ngôn ngữ cùng lúc; logo, ảnh, nhạc nền; tải phông chữ riêng; mẫu cấu hình có tên hoặc chia sẻ giữa các Project; độ phân giải hoặc tốc độ khung hình khác; highlight theo từ trong trình phát voice; xuất tệp phụ đề; tính phí theo số video.
