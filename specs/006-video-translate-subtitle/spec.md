# Feature Specification: Dịch video tự động và gắn đè phụ đề

**Feature Branch**: `main` (hiến pháp 1.4.0: triển khai chỉ trên `main`; `006-video-translate-subtitle` là tên thư mục spec)

**Created**: 2026-11-26

**Status**: Draft

**Input**: User description: "Giúp tôi làm rõ yêu cầu phát triển tính năng này @docs/todo/requirements/req-006/req-006.md" — Trong Project, người dùng tải lên một video bất kỳ (tối đa 10 GB), hệ thống nhận dạng lời nói và dịch bằng Soniox (mọi ngôn ngữ sang tiếng Việt, hoặc tiếng Việt sang tiếng Anh), cho duyệt và sửa phụ đề, tùy chỉnh kiểu chữ, vị trí, hiệu ứng, rồi xuất video đã gắn cứng phụ đề kèm tệp phụ đề rời.

## Bối cảnh

Hiện Sub Maker làm được phụ đề **cùng ngôn ngữ** từ audio/video (spec 004: video tối đa 500 MB, 60 phút) và xuất video **chỉ có chữ** để người dùng tự chèn vào phần mềm dựng phim (spec 005). Người muốn phát hành lại một video tiếng nước ngoài vẫn phải tự dịch, tự canh phụ đề và tự ghép chữ vào video. Tính năng này làm trọn chuỗi đó trong một nơi: tải video lên, nhận bản dịch có mốc thời gian, sửa, tạo kiểu và tải về video thành phẩm.

Thuật ngữ dùng trong tài liệu:

- **Việc dịch video**: một lần làm việc với một video, gồm video nguồn, cài đặt dịch, kịch bản phụ đề, kiểu hiển thị và các bản xuất.
- **Cue**: một đơn vị phụ đề có mốc bắt đầu, mốc kết thúc, **câu gốc** (lời nói được chép lại) và **câu dịch**.
- **Phụ đề gắn cứng**: chữ được vẽ thẳng vào hình, không tắt được khi xem.
- **Video nguồn**: tệp người dùng tải lên. **Video thành phẩm**: video đã gắn cứng phụ đề.
- **Từ điển thuật ngữ**: danh sách cặp "từ gốc → từ dịch mong muốn" của một Project.

### Hiện trạng có ảnh hưởng tới yêu cầu

- Hạn mức lưu trữ mặc định là **500 MB mỗi User**; một video nguồn 10 GB lớn gấp khoảng 20 lần.
- Kho lưu tệp hiện **không mở ra Internet**; mọi tệp đi qua ứng dụng có kiểm tra quyền. Hệ thống được công bố qua một đường hầm có giới hạn dung lượng mỗi yêu cầu (thường 100 MB).
- Phiên âm hiện có (spec 004) giới hạn video 500 MB và 60 phút, dùng một khóa Soniox chung do hệ thống trả tiền.
- Theo tài liệu Soniox (đọc ngày 2026-11-26): dịch tệp ghi sẵn được hỗ trợ; mỗi tệp dài tối đa **300 phút** (không nâng được); **phần chữ dịch không có mốc thời gian**, chỉ phần lời gốc có mốc, và chữ dịch không khớp một-một với lời gốc; phần ngữ cảnh gửi kèm (gồm từ điển thuật ngữ) tối đa khoảng 10.000 ký tự.
- Bộ vẽ chữ, khung xem trước, phông chữ và hiệu ứng của video overlay (spec 005) đã có và được dùng lại.

### Đối chiếu hiến pháp (phiên bản 1.4.0)

| Nội dung | Kết luận |
| --- | --- |
| Nguyên tắc I (cô lập dữ liệu, phân quyền ở máy chủ) | Tuân thủ: FR-008, FR-056, FR-057 |
| Nguyên tắc II (bí mật) | Tuân thủ: dùng cấu hình Soniox hiện có, không đưa khóa xuống trình duyệt (FR-058) |
| Nguyên tắc III (tiến trình nền) | Tuân thủ: FR-047 đến FR-052; spec thêm trạng thái "đã dừng" mà REQ-006 thiếu |
| Nguyên tắc IV (chi phí, dùng lại kết quả) | Tuân thủ: FR-008, FR-016, FR-017 |
| Nguyên tắc IV (hạn mức video, thời hạn tự xóa, hạn mức 500 MB) | Tuân thủ: FR-053 đến FR-055 |
| Nguyên tắc V (kiểm thử) | Mỗi user story có kiểm thử độc lập; FR-061 nêu hành vi bắt buộc có kiểm thử tự động |
| Nguyên tắc VI (giao diện, xác nhận xóa, tìm không dấu, không tự dịch nội dung) | Tuân thủ: FR-023, FR-025, FR-045, FR-059; việc dịch phụ đề là do User yêu cầu |
| "Lưu trữ file" | Tuân thủ: video nguồn, video thành phẩm và phụ đề dịch nằm trong danh sách; tải về có kiểm tra quyền (FR-056) |
| "Dịch vụ nội bộ không mở ra Internet" | Tuân thủ: video tải qua ứng dụng, kho lưu tệp vẫn kín (FR-004) |
| "Mốc từng từ để hiển thị chữ trong video" | Tuân thủ: mốc ước lượng trong khoảng của cue, có ghi chú trên giao diện (FR-034) |
| "Mốc của phụ đề dịch" | Tuân thủ: FR-015 |
| "Định dạng phụ đề" | Tuân thủ: `.srt` và `.vtt` chỉ để tải về (FR-039) |
| "Phạm vi giai đoạn này" | Tuân thủ: dịch video đã nằm trong phạm vi; sửa và xuất phụ đề chỉ trong tính năng này |
| "Hoàn tất triển khai trên `main`" | Áp dụng ở bước triển khai, không đổi yêu cầu chức năng; việc cần người dùng (đo có phí, người thử) phải được chốt trước khi push |

Hiến pháp đã được sửa từ 1.3.0 lên 1.4.0 ngày 2026-11-26 cho tính năng này: thêm dịch video vào phạm vi, thêm hạn mức video riêng kèm thời hạn tự xóa, bổ sung tệp được lưu, cho phép mốc ước lượng cho phụ đề dịch và video gắn cứng phụ đề, và cho xuất `.vtt`. Không còn xung đột nào phải xử lý trước `/speckit-plan`.

## Clarifications

### Session 2026-11-26

- Q: Video tới 10 GB trong khi hạn mức là 500 MB mỗi User, tính dung lượng thế nào? → A: Hạn mức video riêng, mặc định 30 GB mỗi User, Administrator chỉnh được. Video nguồn tự xóa sau 48 giờ, video thành phẩm sau 7 ngày. Phụ đề giữ lâu dài và tính vào hạn mức 500 MB.
- Q: Ai được dùng Dịch Video và mỗi video dài tối đa bao nhiêu? → A: Chỉ User được Administrator cấp quyền; tối đa 180 phút mỗi video (chỉnh được); 1 việc đang chạy mỗi User.
- Q: Video tải lên theo đường nào? → A: Từng phần 10–20 MB qua ứng dụng, chuyển thẳng vào kho lưu tệp; không mở kho ra Internet.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Tải video lớn lên và nhận phụ đề đã dịch (Priority: P1)

Người dùng vào Project, mở tab "Dịch Video", chọn một video, chọn hướng dịch và bấm bắt đầu. Video được tải lên theo từng phần, tạm dừng và tiếp tục được. Hệ thống tự lấy âm thanh, nhận dạng, dịch và tạo kịch bản phụ đề hai cột (gốc, dịch) sẵn để duyệt.

**Why this priority**: Đây là giá trị cốt lõi và là đầu vào của mọi bước sau.

**Independent Test**: Tải lên một video tiếng Anh 5 phút, ngắt mạng giữa chừng rồi tiếp tục; kiểm tra nhận được kịch bản tiếng Việt có mốc khớp lời nói, kèm câu gốc tiếng Anh.

**Acceptance Scenarios**:

1. **Given** tab "Dịch Video", **When** chọn tệp `.mp4`, `.mov`, `.mkv`, `.webm`, `.avi`, `.flv` hoặc `.m4v` không quá 10 GB, **Then** hệ thống nhận tệp; tệp sai định dạng, quá lớn, hỏng, không có tiếng hoặc quá thời lượng bị từ chối kèm nguyên nhân và cách xử lý.
2. **Given** đang tải lên, **When** xem màn hình, **Then** thấy phần trăm, tốc độ (MB/s) và thời gian còn lại.
3. **Given** đang tải lên, **When** bấm tạm dừng rồi tiếp tục, hoặc mạng đứt rồi có lại, **Then** việc tải tiếp tục từ phần đã xong.
4. **Given** đã đóng trình duyệt khi mới tải được một phần, **When** quay lại trong thời hạn giữ và chọn đúng tệp đó, **Then** việc tải tiếp tục; chọn tệp khác bị từ chối tiếp tục và được hỏi có tạo việc mới không.
5. **Given** video đã tải xong, **When** hệ thống xử lý, **Then** tiến độ đi qua các giai đoạn chuẩn bị âm thanh, nhận dạng và dịch, tạo phụ đề, rồi chuyển "chờ duyệt"; đóng trình duyệt không làm dừng tiến trình.
6. **Given** hướng "Tiếng Việt → Tiếng Anh", **When** hoàn tất, **Then** cột gốc là tiếng Việt, cột dịch là tiếng Anh.
7. **Given** video có đoạn nói sẵn bằng ngôn ngữ đích, **When** hoàn tất, **Then** đoạn đó vẫn có cue, câu dịch lấy nguyên câu gốc.
8. **Given** User chưa được cấp quyền Dịch Video, **When** mở tab hoặc gửi yêu cầu trực tiếp, **Then** giao diện nêu cách xin quyền và máy chủ từ chối tạo việc, không phát sinh phí.
9. **Given** User đang có một việc đang chạy, hoặc video dài quá giới hạn, hoặc không đủ hạn mức video, **When** tạo việc mới, **Then** bị từ chối kèm nguyên nhân và cách xử lý.

---

### User Story 2 - Duyệt và sửa phụ đề trên trình phát đồng bộ (Priority: P1)

Người dùng xem video với phụ đề nổi, sửa câu dịch, chỉnh mốc, thêm, xóa, gộp, tách cue trước khi xuất.

**Why this priority**: Bản dịch máy luôn cần sửa; xuất lại một video lớn tốn thời gian nên phải sửa trước.

**Independent Test**: Với một kịch bản đã dịch, sửa chữ, dịch mốc ±100 ms, gộp hai cue, tách một cue, tải lại trang và kiểm tra mọi thay đổi còn nguyên.

**Acceptance Scenarios**:

1. **Given** video đang phát, **When** tới mốc của một cue, **Then** chữ hiện nổi trên video, cue đó được tô sáng và danh sách tự cuộn tới nó.
2. **Given** danh sách cue, **When** bấm một cue, **Then** video tua tới mốc bắt đầu của cue.
3. **Given** hai cột gốc và dịch, **When** sửa chữ một cue, **Then** khung xem trước đổi ngay và thay đổi được tự lưu.
4. **Given** một cue được chọn, **When** tăng giảm mốc bắt đầu hoặc kết thúc ±100 ms, ±500 ms, hoặc kéo trên dòng thời gian, **Then** mốc đổi và không vượt qua cue liền kề.
5. **Given** hai cue liền nhau, **When** gộp, **Then** thành một cue từ mốc đầu tới mốc cuối, nối chữ ở cả hai cột; **When** tách một cue, **Then** thành hai cue không chồng lấn.
6. **Given** vừa sửa nhầm, **When** bấm hoàn tác, **Then** thay đổi gần nhất được đảo lại.
7. **Given** video nguồn có định dạng trình duyệt không phát được, **When** mở trình biên tập, **Then** người dùng vẫn xem trước được bằng bản xem trước do hệ thống tạo, hoặc được báo rõ và vẫn sửa, nghe tiếng và xuất được.

---

### User Story 3 - Xuất video gắn cứng phụ đề và tải tệp phụ đề (Priority: P1)

Người dùng bấm "Xuất video", theo dõi tiến độ, rồi tải video `.mp4` đã gắn phụ đề; tải riêng tệp `.srt` hoặc `.vtt`.

**Why this priority**: Là kết quả cuối người dùng cần. Cùng US1 và US2, với kiểu chữ mặc định, đã thành sản phẩm dùng được.

**Independent Test**: Xuất một video 5 phút bằng kiểu mặc định; so thời lượng, kích thước, tốc độ khung hình, tiếng với video nguồn và kiểm tra chữ hiện đúng mốc; tải `.srt`, `.vtt` và mở bằng trình phát khác.

**Acceptance Scenarios**:

1. **Given** kịch bản chờ duyệt, **When** bấm "Xuất video", **Then** nội dung phụ đề và kiểu được chốt, tiến trình hiện phần trăm và nhật ký.
2. **Given** tiến trình hoàn tất, **When** tải về, **Then** nhận `.mp4` giữ khung hình, tốc độ khung hình và tiếng của video nguồn, phụ đề đúng mốc.
3. **Given** kịch bản đã duyệt, **When** tải phụ đề, **Then** chọn được `.srt` hoặc `.vtt`, nội dung là bản dịch, bản gốc hoặc song ngữ.
4. **Given** video đã xuất và video nguồn còn được giữ, **When** sửa phụ đề rồi xuất lại, **Then** có bản mới mà không phải tải lên hay dịch lại.
5. **Given** video nguồn đã hết hạn và bị xóa, **When** mở việc dịch, **Then** vẫn sửa và tải được tệp phụ đề, nút xuất video bị khóa kèm lý do và lựa chọn tải lại đúng video.
6. **Given** video thành phẩm đã tạo, **When** xem việc dịch, **Then** thấy ngày video bị xóa (7 ngày sau khi tạo); sau ngày đó video không còn tải được và dung lượng được trả lại.

---

### User Story 4 - Tùy chỉnh kiểu chữ, vị trí, chế độ song ngữ và vùng an toàn (Priority: P2)

Người dùng chọn chế độ hiển thị, phông chữ, cỡ, màu, viền, bóng, hộp nền, vị trí, canh lề, độ rộng; bật khung mô phỏng giao diện TikTok, YouTube Shorts, Instagram Reels để tránh bị che.

**Why this priority**: Làm video đúng phong cách kênh; video vẫn dùng được với kiểu mặc định.

**Independent Test**: Đổi từng thuộc tính trên video dọc và ngang, so khung xem trước với video xuất ra tại cùng thời điểm.

**Acceptance Scenarios**:

1. **Given** khung xem trước, **When** đổi một thuộc tính, **Then** chữ đổi ngay, video không bị ngắt.
2. **Given** chế độ song ngữ, **When** hiển thị, **Then** câu gốc ở dòng trên (nhỏ hơn, màu phụ hoặc mờ hơn), câu dịch ở dưới (lớn, màu chính).
3. **Given** bật vùng an toàn của một mạng xã hội trên video 9:16, **When** khối chữ lấn vào vùng bị che, **Then** hệ thống cảnh báo; khung mô phỏng không xuất hiện trong video thành phẩm.
4. **Given** cấu hình đã chỉnh, **When** xuất video, **Then** cách xuống dòng, vị trí, màu, cỡ giống khung xem trước.

---

### User Story 5 - Từ điển thuật ngữ theo Project (Priority: P2)

Người dùng khai báo cặp từ trước khi dịch để tên riêng, thương hiệu, thuật ngữ được dịch đúng ý; bộ từ điển được dùng lại cho các video khác trong Project.

**Why this priority**: Giảm mạnh công sửa với nội dung chuyên ngành.

**Independent Test**: Nhập 10 cặp từ (có cặp "giữ nguyên"), dịch video có các từ đó, đối chiếu kết quả; mở việc mới trong cùng Project và thấy từ điển có sẵn.

**Acceptance Scenarios**:

1. **Given** màn hình từ điển, **When** thêm từng dòng hoặc dán nhiều dòng dạng `gốc -> dịch` hoặc `gốc, dịch`, **Then** các cặp hợp lệ được thêm; dòng lỗi và từ gốc trùng được liệt kê để sửa.
2. **Given** một cặp đánh dấu "Giữ nguyên không dịch", **When** dịch, **Then** từ đó được yêu cầu giữ nguyên trong bản dịch.
3. **Given** từ điển đã lưu, **When** tạo việc dịch mới trong Project, **Then** từ điển được áp dụng, người dùng xem và sửa được trước khi bắt đầu.
4. **Given** đã dịch xong, **When** sửa từ điển rồi bấm "Dịch lại", **Then** hệ thống nêu chi phí phát sinh và việc các chỉnh sửa tay sẽ bị thay, chỉ chạy sau khi xác nhận.

---

### User Story 6 - Tìm kiếm và thay thế hàng loạt (Priority: P2)

Người dùng sửa một lỗi lặp lại trong toàn bộ kịch bản bằng một thao tác.

**Why this priority**: Video dài có hàng nghìn cue; dò tay không khả thi.

**Independent Test**: Với kịch bản có từ lặp biết trước số lần, kiểm tra đếm, tô sáng, thay một, thay tất cả, các tùy chọn và hoàn tác.

**Acceptance Scenarios**:

1. **Given** ô tìm kiếm, **When** gõ một cụm từ, **Then** hiện số kết quả khớp và tô sáng các vị trí.
2. **Given** một kết quả đang chọn, **When** bấm "Thay thế", **Then** chỉ vị trí đó đổi và chuyển sang kết quả kế tiếp.
3. **Given** nhiều kết quả, **When** bấm "Thay thế tất cả", **Then** mọi vị trí trong cột đã chọn được thay, thông báo nêu số vị trí và hoàn tác được trong một thao tác.
4. **Given** bật "Phân biệt hoa/thường" hoặc "Khớp cả từ", **When** tìm, **Then** kết quả theo đúng tùy chọn, kể cả chữ tiếng Việt có dấu.
5. **Given** gõ từ tìm không dấu (ví dụ "ban") khớp nhiều từ khác dấu, **When** bấm "Thay thế tất cả", **Then** hộp xác nhận liệt kê từng dạng khớp kèm số lượng trước khi thay.

---

### User Story 7 - Theo dõi, phục hồi và quản lý dung lượng (Priority: P2)

Người dùng xem danh sách việc dịch của Project, dừng, chạy lại, xóa; biết video nguồn còn được giữ tới khi nào.

**Why this priority**: Xử lý video lớn mất nhiều thời gian và chiếm nhiều chỗ.

**Independent Test**: Khởi động lại hệ thống ở từng giai đoạn, dừng và chạy lại, xóa việc đang chạy; kiểm tra không mất tiến trình, không tính phí lặp, dung lượng được trả lại.

**Acceptance Scenarios**:

1. **Given** hệ thống khởi động lại khi đang dịch hoặc đang xuất, **When** chạy lại, **Then** tiến trình tiếp tục hoặc báo "bị gián đoạn, có thể chạy lại", giữ phần đã xong.
2. **Given** lỗi sau khi đã dịch xong, **When** chạy lại, **Then** không dịch lại và không phát sinh phí dịch mới.
3. **Given** chọn xóa một hoặc nhiều việc, **When** xác nhận, **Then** tiến trình dừng, tệp bị xóa, dung lượng được trả lại.
4. **Given** video nguồn hoặc thành phẩm có hạn giữ, **When** xem việc dịch, **Then** thấy thời điểm từng tệp bị xóa và dung lượng video đang dùng so với hạn mức.

---

### User Story 8 - Hiệu ứng hoạt ảnh phụ đề (Priority: P3)

Người dùng chọn hiệu ứng xuất hiện, hiệu ứng theo từng từ, karaoke và thời lượng.

**Why this priority**: Làm video ngắn nổi bật nhưng không ảnh hưởng luồng chính.

**Independent Test**: Lần lượt chọn từng hiệu ứng, so khung xem trước với video xuất ra.

**Acceptance Scenarios**:

1. **Given** chọn "Bung ra" 300 ms, **When** cue bắt đầu, **Then** chữ phóng từ 80% lên 100% trong 300 ms.
2. **Given** chọn karaoke, **When** cue đang hiện, **Then** cả câu hiện sẵn, từng từ lần lượt đổi màu và phóng to 115%, kèm ghi chú nhịp từng từ là ước lượng.
3. **Given** cue ngắn hơn thời lượng hiệu ứng, **When** hiển thị, **Then** hiệu ứng tự rút ngắn, không lấn sang cue kế.

---

### User Story 9 - Lấy âm thanh ngay trên máy người dùng để có phụ đề sớm (Priority: P3)

Khi thiết bị đủ khả năng, âm thanh được lấy ra ngay trong trình duyệt và gửi đi dịch trong lúc video còn đang tải lên; không đủ khả năng thì tự chuyển về luồng thường.

**Why this priority**: Rút ngắn thời gian chờ đáng kể, nhưng kết quả cuối không đổi.

**Independent Test**: Chạy cùng một video trên máy đủ khả năng và máy bị chặn khả năng; kiểm tra máy đầu có phụ đề trước khi tải xong, máy sau hoàn tất bình thường.

**Acceptance Scenarios**:

1. **Given** trình duyệt và thiết bị đủ khả năng, định dạng được hỗ trợ, **When** bắt đầu, **Then** âm thanh được gửi và dịch song song với tải video; duyệt và sửa phụ đề được trước khi video tải xong.
2. **Given** thiếu khả năng, bộ nhớ dưới 4 GB, định dạng không hỗ trợ hoặc lỗi giữa chừng, **When** xử lý, **Then** tự chuyển sang lấy âm thanh ở máy chủ sau khi tải xong, không cần người dùng thao tác và không tính phí dịch hai lần.
3. **Given** phụ đề sẵn sàng nhưng video chưa tải xong, **When** xem màn hình, **Then** nút xuất bị khóa kèm tiến độ tải; trình phát dùng tệp trên máy người dùng nếu phát được.

---

### User Story 10 - Xuất riêng lớp phụ đề để dựng phim (Priority: P3)

Người dựng phim xuất video chỉ có phụ đề trên phông xanh (`.mp4`) hoặc nền trong suốt (`.mov`) để chèn vào Premiere, CapCut.

**Why this priority**: Khả năng đã có ở spec 005; ở đây chỉ nối thêm nguồn phụ đề mới.

**Independent Test**: Xuất hai dạng từ một kịch bản đã duyệt, chèn lên video nguồn trong phần mềm dựng phim, kiểm tra khớp mốc.

**Acceptance Scenarios**:

1. **Given** kịch bản đã duyệt, **When** chọn xuất lớp phụ đề, **Then** nhận video có kích thước, thời lượng bằng video nguồn, chỉ có chữ trên nền đã chọn.

---

### Edge Cases

- **Tệp đổi đuôi, hỏng hoặc bộ mã không đọc được**: từ chối ngay khi kiểm tra được, trước khi phát sinh phí dịch.
- **Video không có tiếng hoặc không có lời nói**: báo rõ; không có tiếng thì không gọi dịch.
- **Nhiều luồng tiếng**: dùng luồng mặc định của tệp và nêu cho người dùng biết.
- **Video quay dọc có cờ xoay, kích thước lẻ, tốc độ khung hình thay đổi, HDR**: thành phẩm đúng chiều người xem thấy, tiếng không lệch; nếu phải đổi dải màu hay làm tròn kích thước thì báo trước khi xuất.
- **Video độ phân giải rất thấp hoặc trên 4K**: cỡ chữ tính theo tỉ lệ khung hình; video vượt độ phân giải hỗ trợ bị từ chối khi nhận.
- **Ngôn ngữ gốc không có khoảng trắng giữa các từ (Trung, Nhật, Thái)**: giới hạn dòng tính theo ký tự.
- **Câu dịch dài hơn nhiều so với lời gốc**: tách thành nhiều cue, chia thời gian trong khoảng của đoạn lời gốc; cue đọc quá nhanh được đánh dấu để người dùng xem lại.
- **Nhiều người nói chen nhau**: đổi người nói thì sang cue mới; tại mỗi thời điểm chỉ một cue.
- **Đoạn lời gốc không có bản dịch trả về**: cue giữ câu gốc, đánh dấu "chưa dịch".
- **Ký tự phông chữ không hỗ trợ**: dùng phông thay thế; không có thì cảnh báo cue bị ảnh hưởng.
- **Chữ có thẻ định dạng hoặc ký tự đặc biệt**: hiển thị như chữ thường, không bao giờ được hiểu là lệnh.
- **Từ điển quá giới hạn**: chặn khi lưu, nêu đang dùng bao nhiêu và giới hạn.
- **Từ cần thay không còn khớp** (người dùng vừa sửa tay): bỏ qua, đếm đúng số đã thay.
- **Hai tab cùng sửa một kịch bản**: thay đổi cũ hơn không ghi đè âm thầm; người dùng được báo tải lại.
- **Máy chủ không đủ chỗ trống cho video**: từ chối trước khi tải lên.
- **Phần tải dở bị bỏ quên**: tự dọn sau thời hạn giữ.
- **Soniox chưa cấu hình, hết số dư hoặc tạm lỗi**: chưa cấu hình thì báo trước khi tải lên; hết số dư là lỗi vĩnh viễn; lỗi tạm thời được thử lại có giới hạn.
- **Project hoặc User bị xóa khi đang xử lý**: dừng và xóa sạch, kể cả phần tải dở và dữ liệu ở nhà cung cấp.
- **Phiên đăng nhập hết hạn khi đang tải**: tạm dừng, đăng nhập lại rồi tiếp tục.
- **Bị thu hồi quyền Dịch Video**: không tạo việc, dịch hay xuất mới được và tiến trình đang chạy bị dừng; dữ liệu đã có vẫn xem, sửa, tải về và xóa được.
- **Video thành phẩm thật lớn hơn ước tính và vượt hạn mức video**: không lưu, báo cần giải phóng bao nhiêu, cho xuất lại mà không dịch lại.
- **Hạn mức 500 MB đã đầy khi lưu phụ đề**: kết quả dịch đã trả phí và bản đang sửa vẫn được lưu; chỉ chặn tạo việc mới.
- **Administrator hạ hạn mức video hoặc thời lượng tối đa**: dữ liệu và việc đã có giữ nguyên; giới hạn mới áp dụng cho việc tạo sau đó.
- **Tới hạn xóa khi đang xuất hoặc đang tải về**: chỉ xóa sau khi tiến trình hoặc lượt tải đó kết thúc.

## Requirements *(mandatory)*

### Functional Requirements

**Video nguồn và tải lên**

- **FR-001**: Mỗi Project MUST có tab "Dịch Video" để tạo và quản lý việc dịch video.
- **FR-002**: Hệ thống MUST nhận `.mp4`, `.mov`, `.mkv`, `.webm`, `.avi`, `.flv`, `.m4v`, tối đa 10 GB (Administrator chỉnh được), mọi tỉ lệ khung hình, tối thiểu 16:9, 9:16, 1:1, 4:5, 21:9, độ phân giải tới 4K.
- **FR-003**: Hệ thống MUST kiểm tra ở máy chủ nội dung thật của tệp (đọc được, có hình, có tiếng, thời lượng, độ phân giải) trước khi gọi dịch.
- **FR-004**: Video MUST được tải lên theo từng phần 10–20 MB qua ứng dụng (có kiểm tra đăng nhập và quyền sở hữu ở mỗi phần) và chuyển thẳng vào kho lưu tệp; không bước nào được giữ cả tệp trong bộ nhớ hay trong một yêu cầu duy nhất; kho lưu tệp MUST NOT mở ra Internet.
- **FR-005**: Người dùng MUST tạm dừng, tiếp tục, hủy được; phần lỗi MUST được tự thử lại có giới hạn với thời gian chờ tăng dần; tải lại trang hoặc đóng trình duyệt rồi chọn lại đúng tệp MUST tiếp tục được trong 48 giờ.
- **FR-006**: Giao diện MUST hiện phần trăm, tốc độ (MB/s), thời gian còn lại ước tính.
- **FR-007**: Hệ thống MUST kiểm tra đủ chỗ (theo quy tắc ở FR-053 và dung lượng máy chủ) trước khi cho bắt đầu tải.
- **FR-008**: Chỉ Administrator và User được Administrator cấp quyền MUST tạo việc, tải lên, dịch và xuất được; quyền mặc định tắt, bật tắt theo từng User và kiểm tra ở máy chủ. Video MUST dài tối đa 180 phút (Administrator chỉnh được, không quá 300 phút). Mỗi User MUST có tối đa 1 việc đang chạy (đang tải lên, đang chờ, chuẩn bị âm thanh, dịch, xuất hoặc bị gián đoạn; Administrator chỉnh được); việc chờ duyệt, hoàn tất, đã dừng hoặc lỗi không tính.

**Chuẩn bị âm thanh**

- **FR-009**: Hệ thống MUST tự lấy âm thanh từ video ở máy chủ và chỉ gửi âm thanh cho nhà cung cấp, không gửi hình.
- **FR-010**: Khi thiết bị đủ khả năng, hệ thống SHOULD lấy âm thanh ngay trong trình duyệt và bắt đầu dịch song song với tải video; mọi trường hợp thiếu khả năng hoặc lỗi MUST tự chuyển về FR-009 mà không cần người dùng thao tác.
- **FR-011**: Âm thanh do trình duyệt gửi MUST được kiểm tra như dữ liệu không tin cậy và đối chiếu thời lượng với video sau khi tải xong; lệch quá 1 giây thì lấy lại ở máy chủ và báo người dùng trước khi phát sinh phí dịch lần hai.

**Nhận dạng và dịch**

- **FR-012**: Người dùng MUST chọn một trong hai hướng: "Mọi ngôn ngữ → Tiếng Việt" (mặc định, tự nhận diện ngôn ngữ nói) hoặc "Tiếng Việt → Tiếng Anh". Việc thêm cặp ngôn ngữ sau này MUST không đổi cách dùng.
- **FR-013**: Nhận dạng và dịch MUST dùng cấu hình Soniox dùng chung do Administrator quản lý, có tự nhận diện ngôn ngữ và phân biệt người nói; chưa cấu hình thì chặn trước khi tải lên.
- **FR-014**: Hệ thống MUST lưu cả câu gốc và câu dịch; câu đã ở ngôn ngữ đích dùng làm câu dịch.
- **FR-015**: Mốc của cue MUST lấy từ mốc lời gốc. Vì chữ dịch không có mốc riêng, cue được tách nhỏ trong một đoạn lời gốc MUST có mốc ước lượng nằm trong khoảng của đoạn đó và được lưu kèm dấu hiệu là ước lượng.
- **FR-016**: Mỗi lần gọi nhà cung cấp MUST ghi bản ghi sử dụng (User, Project, thời lượng, chi phí ước tính). Kết quả đã có MUST được dùng lại khi sửa chữ, đổi kiểu, xuất lại, chạy lại sau lỗi; chỉ "Dịch lại" (đổi từ điển hoặc hướng dịch) mới gọi lại và MUST xác nhận trước.
- **FR-017**: Dữ liệu gửi sang nhà cung cấp MUST được xóa sau khi lấy được kết quả hoặc khi việc bị xóa, dừng, lỗi vĩnh viễn.
- **FR-018**: Cue MUST được tạo tự động: mỗi dòng chữ dịch tối đa 12 từ và ưu tiên không dưới 5 từ khi câu đủ dài (ngôn ngữ không có khoảng trắng: tối đa 42 ký tự), tối đa 2 dòng; ngắt ưu tiên tại dấu câu, tại quãng nghỉ trên 300 ms và khi đổi người nói; không cắt giữa từ; cue không chồng lấn và hiện ít nhất 0,7 giây khi khoảng trống cho phép.

**Từ điển thuật ngữ**

- **FR-019**: Mỗi Project MUST có một từ điển thuật ngữ gồm cặp từ gốc → từ dịch, hoặc "Giữ nguyên không dịch"; thêm, sửa, xóa từng dòng và dán hàng loạt (mỗi dòng một cặp, ngăn bằng `->` hoặc dấu phẩy; có `->` thì ưu tiên `->`).
- **FR-020**: Từ điển MUST bị giới hạn kích thước phù hợp giới hạn của nhà cung cấp (mặc định 200 cặp và tổng 8.000 ký tự) và kiểm tra ở máy chủ.
- **FR-021**: Từ điển MUST được gửi kèm khi dịch, và bản đã dùng MUST được lưu theo từng việc. Giao diện MUST nói rõ từ điển là chỉ dẫn cho máy dịch, kết quả cần được duyệt.

**Duyệt và biên tập**

- **FR-022**: Trình phát MUST có phát, tạm dừng, tua; phụ đề nổi theo thời gian thực; danh sách tự cuộn và tô sáng cue đang phát; bấm cue thì tua tới. Người dùng tạm ngưng tự cuộn được khi đang tự cuộn danh sách.
- **FR-023**: Người dùng MUST sửa được câu gốc và câu dịch; thêm, xóa (có xác nhận nêu số lượng và hậu quả), gộp, tách cue; chỉnh mốc bằng ±100 ms, ±500 ms, nhập số hoặc kéo trên dòng thời gian.
- **FR-024**: Hệ thống MUST giữ mốc hợp lệ (kết thúc sau bắt đầu ít nhất 100 ms, không chồng cue liền kề, không vượt thời lượng video), tự lưu thay đổi, cho hoàn tác và làm lại trong phiên, và không để bản sửa cũ ghi đè bản mới một cách âm thầm.
- **FR-025**: Tìm kiếm và thay thế MUST áp dụng cho cột dịch (mặc định) hoặc cột gốc; hiện số kết quả; tô sáng; "Thay thế", "Thay thế tất cả"; tùy chọn phân biệt hoa/thường và khớp cả từ (đúng với tiếng Việt có dấu). Thay tất cả MUST hoàn tác được bằng một thao tác. Từ tìm không dấu MUST khớp cả chữ có dấu; từ tìm có dấu khớp đúng dấu; có tùy chọn "Khớp đúng dấu". Khi một lần thay tất cả đụng nhiều dạng khác dấu, MUST xác nhận và liệt kê từng dạng kèm số lượng.

**Kiểu hiển thị**

- **FR-026**: Người dùng MUST chọn chế độ Chỉ bản dịch (mặc định), Song ngữ (gốc trên, dịch dưới) hoặc Chỉ bản gốc.
- **FR-027**: Người dùng MUST chọn phông chữ có đủ tiếng Việt: Be Vietnam Pro, Roboto, Montserrat, Inter, phông kiểu Arial, Oswald, Open Sans; cỡ 16–96 tính trên khung chuẩn cạnh ngắn 1080 điểm ảnh và co giãn theo video; độ đậm 400, 600, 700, 800 (độ đậm phông không có thì không chọn được).
- **FR-028**: Người dùng MUST chỉnh màu chữ (bảng màu nhanh và mã HEX); viền bật/tắt, màu, dày 1–10; bóng bật/tắt, màu, độ mờ, khoảng cách, độ đậm; hộp nền bật/tắt, màu, độ đục 0–100%, bo góc. Ở chế độ song ngữ, dòng gốc MUST chỉnh được riêng cỡ, màu, độ mờ.
- **FR-029**: Người dùng MUST chọn vị trí nhanh Dưới (85%, mặc định), Giữa (50%), Trên (15%), tinh chỉnh độ cao 0–100%, canh trái, giữa, phải, độ rộng tối đa (mặc định 80%). Khối chữ MUST luôn nằm trọn trong khung hình.
- **FR-030**: Người dùng MUST bật được khung mô phỏng vùng bị che của TikTok, YouTube Shorts, Instagram Reels trên khung xem trước, có cảnh báo khi chữ lấn vào; khung MUST NOT xuất hiện trong video.
- **FR-031**: Kiểu gần nhất MUST được lưu theo Project và đưa về mặc định được.

**Hiệu ứng**

- **FR-032**: Người dùng MUST chọn được hiệu ứng xuất hiện: tức thì (mặc định), mờ dần, bung ra, nảy đàn hồi, trượt lên, nhòe chuyển động, phát sáng neon.
- **FR-033**: Người dùng MUST chọn được kiểu theo từng từ (từ bung ra, máy đánh chữ) và karaoke (từ đang đọc đổi màu, phóng 115%).
- **FR-034**: Mốc từng từ MUST là ước lượng trong khoảng của cue theo cùng quy tắc của spec 005, cho cả câu gốc và câu dịch; giao diện MUST ghi rõ, và nêu rằng với bản dịch, từ được tô không phải từ đang được nói. Ở chế độ song ngữ, hiệu ứng theo từ chỉ áp dụng cho dòng dịch.
- **FR-035**: Thời lượng hiệu ứng MUST chỉnh được 100–500 ms (mặc định 250 ms) và tự rút ngắn khi cue ngắn hơn.

**Xem trước và xuất**

- **FR-036**: Khung xem trước và video xuất ra MUST giống nhau về nội dung, phông, cỡ, màu, xuống dòng, vị trí, hiệu ứng và thời điểm.
- **FR-037**: Video thành phẩm MUST là `.mp4` phát được trên thiết bị và mạng xã hội phổ biến, giữ độ phân giải, tốc độ khung hình và thời lượng của nguồn; tiếng giữ nguyên chất lượng, chỉ chuyển mã khi định dạng đích không chứa được.
- **FR-038**: Ở mức mặc định, tại 20 thời điểm lấy mẫu đặt cạnh nhau ở kích thước gốc, người xem MUST NOT phân biệt được thành phẩm với nguồn ở vùng không có chữ.
- **FR-039**: Người dùng MUST tải được tệp `.srt` và `.vtt` (bản dịch, bản gốc hoặc song ngữ), mốc theo kịch bản mới nhất.
- **FR-040**: Người dùng MUST đưa được phụ đề đã duyệt thành kịch bản của Project để dùng với tạo voice và video overlay.
- **FR-041**: Người dùng MUST xuất được lớp phụ đề riêng: `.mp4` phông xanh hoặc `.mov` nền trong suốt, theo quy tắc spec 005, kích thước và thời lượng bằng video nguồn, trong giới hạn thời lượng của nền trong suốt.
- **FR-042**: Nội dung phụ đề và kiểu MUST được chốt lúc bấm xuất. Trước khi xuất, hệ thống MUST hiện dung lượng và thời gian ước tính, ghi rõ là ước tính.
- **FR-043**: Xuất bị chặn khi video nguồn chưa tải xong, đã bị xóa, hoặc không đủ chỗ.

**Tiến trình và quản lý**

- **FR-044**: Danh sách việc dịch của Project MUST hiện tên tệp, dung lượng, thời lượng, hướng dịch, trạng thái, tiến độ, hạn giữ video nguồn.
- **FR-045**: Người dùng MUST dừng, chạy lại, tải kết quả và xóa một hoặc nhiều việc, có xác nhận nêu số lượng và hậu quả.
- **FR-046**: Người dùng MUST tải lại được đúng video nguồn cho một việc đã bị xóa video để xuất tiếp mà không dịch lại.
- **FR-047**: Mọi xử lý sau tải lên MUST chạy nền, độc lập với trình duyệt.
- **FR-048**: Trạng thái MUST gồm: đang tải lên, đang chờ, đang chuẩn bị âm thanh, đang dịch, chờ duyệt, đang xuất, hoàn tất, đã dừng, lỗi, bị gián đoạn; kèm phần trăm, nhật ký, cập nhật tới người xem trong vòng 2 giây và đồng bộ lại khi kết nối lại.
- **FR-049**: Tiến độ MUST theo mốc: chuẩn bị âm thanh 0–10%, nhận dạng và dịch 10–40%, tạo phụ đề 40–50% (tới đây là chờ duyệt), xuất video 50–95%, lưu thành phẩm 95–100%.
- **FR-050**: Khởi động lại MUST NOT làm mất tiến trình: tiếp tục hoặc đánh dấu bị gián đoạn, giữ phần đã tải, kết quả dịch và kịch bản đã sửa.
- **FR-051**: Lỗi tạm thời MUST được thử lại tối đa 3 lần với backoff; lỗi vĩnh viễn MUST NOT thử lại.
- **FR-052**: Số tiến trình dịch và số tiến trình xuất chạy cùng lúc trên toàn hệ thống MUST có giới hạn riêng (xuất mặc định 1, Administrator chỉnh được), phần dư xếp hàng. Việc xử lý video lớn MUST NOT chiếm chỗ của tạo voice, tạo phụ đề và video overlay: các tiến trình đó vẫn bắt đầu trong vòng 10 giây khi còn chỗ theo giới hạn riêng.

**Dung lượng và vòng đời tệp**

- **FR-053**: Video nguồn, video thành phẩm và lớp phụ đề xuất ở tab này MUST tính vào **hạn mức video** riêng của User (mặc định 30 GB, Administrator chỉnh được), tách khỏi hạn mức 500 MB. Hệ thống MUST chặn ở máy chủ việc tải lên và xuất khi dung lượng cần (gồm phần đang giữ chỗ cho tiến trình đang chạy) vượt chỗ còn lại, kể cả khi nhiều yêu cầu cùng lúc; MUST trả lại dung lượng ngay khi tệp bị xóa; MUST hiện mức dùng cho User và trong thống kê của Administrator. Tệp tạm không tính vào hạn mức.
- **FR-054**: Video nguồn MUST tự xóa sau 48 giờ kể từ lần xuất thành công gần nhất; nếu chưa xuất lần nào (chờ duyệt, đã dừng, lỗi) thì sau 7 ngày không hoạt động. Video thành phẩm và lớp phụ đề MUST tự xóa sau 7 ngày kể từ khi tạo. Tệp đến hạn MUST NOT bị xóa khi tiến trình hoặc lượt tải đang dùng nó; việc xóa thực hiện ngay sau khi kết thúc. Người dùng xóa việc thì tiến trình dừng và mọi tệp bị xóa ngay. Hạn xóa MUST hiện trên giao diện. Tệp âm thanh, tệp tạm và phần tải dở quá 48 giờ MUST được dọn.
- **FR-055**: Kịch bản phụ đề (gốc, dịch, mốc) và tệp phụ đề MUST được giữ đến khi người dùng xóa việc, Project hoặc tài khoản; tính vào hạn mức 500 MB nhưng MUST NOT làm mất kết quả dịch hay bản đang sửa khi hạn mức đầy.

**Bảo mật, dữ liệu và giao diện**

- **FR-056**: Chỉ chủ sở hữu MUST xem, tải lên tiếp, sửa, xuất, tải về, dừng và xóa được dữ liệu của tính năng; truy cập của người khác và của Administrator MUST bị từ chối như thể không tồn tại, ở mọi đường truy cập, kể cả phát video và tải từng phần.
- **FR-057**: Xóa Project hoặc User MUST dừng tiến trình liên quan và xóa hết dữ liệu của tính năng.
- **FR-058**: Khóa nhà cung cấp MUST NOT xuống trình duyệt, vào nhật ký hay thông báo lỗi. Trước lần dùng đầu, giao diện MUST nêu rằng âm thanh được gửi cho nhà cung cấp bên ngoài.
- **FR-059**: Giao diện MUST đủ vi và en, theo hệ thống thiết kế hiện có ở theme Sáng và Tối, đủ trạng thái đang tải, rỗng, lỗi, không có kết quả; theo dõi, duyệt, sửa chữ và tải về MUST dùng được trên điện thoại. Nội dung phụ đề MUST NOT bị giao diện tự dịch.
- **FR-060**: Tên tệp, nội dung phụ đề, từ điển và cấu hình MUST được kiểm tra ở máy chủ và chỉ hiển thị như chữ.
- **FR-061**: MUST có kiểm thử tự động cho: cô lập dữ liệu giữa hai User; cấp và thu hồi quyền; giới hạn thời lượng và số việc đang chạy; tải tiếp sau gián đoạn; tạo cue và mốc; tìm và thay thế; giới hạn từ điển; dùng lại kết quả dịch, không tính phí lặp; phục hồi sau khởi động lại; lỗi tạm thời so với vĩnh viễn; dung lượng và tự xóa theo hạn; xóa Project/User xóa sạch.

### Key Entities

- **Việc dịch video**: thuộc một Project và một User; có tên tệp, dung lượng, thời lượng, kích thước hình, hướng dịch, trạng thái, tiến độ, lỗi, nhật ký, hạn giữ video nguồn.
- **Quyền và hạn mức Dịch Video của User**: cờ được phép, hạn mức video, dung lượng đã dùng và đang giữ chỗ.
- **Phiên tải lên**: tiến độ tải của một video theo từng phần; dùng để tiếp tục; có thời hạn.
- **Video nguồn**: tệp gốc, giữ tạm theo FR-054.
- **Kịch bản dịch**: danh sách cue của một việc, có phiên bản sửa đổi.
- **Cue**: thứ tự, mốc bắt đầu và kết thúc, nguồn mốc (đo hay ước lượng), câu gốc, câu dịch, ngôn ngữ gốc, người nói, cờ cần xem lại.
- **Từ điển thuật ngữ**: thuộc Project; các cặp từ; mỗi việc giữ bản chụp đã dùng.
- **Kiểu phụ đề**: chế độ hiển thị, kiểu chữ, vị trí, hiệu ứng; bản gần nhất theo Project và bản đã chốt theo mỗi lần xuất.
- **Bản xuất**: loại (gắn cứng, lớp phụ đề), cấu hình đã chốt, trạng thái, dung lượng, thời điểm.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Video 10 GB tải lên thành công trong 100% lần thử có ngắt mạng và tạm dừng; mỗi lần ngắt phải tải lại không quá 20 MB cho mỗi phần đang gửi dở.
- **SC-002**: Với video 10 GB dài 60 phút trên đường truyền 50 Mbps và thiết bị đủ khả năng, phụ đề sẵn sàng để duyệt trước khi video tải xong.
- **SC-003**: Với video 60 phút, từ lúc tải xong tới lúc chờ duyệt không quá 10 phút khi nhà cung cấp hoạt động bình thường.
- **SC-004**: Ít nhất 95% cue của bộ mẫu bắt đầu lệch không quá 300 ms so với lúc câu bắt đầu được nói.
- **SC-005**: Ít nhất 90% lần xuất hiện của từ trong từ điển, trên bộ mẫu, được dịch đúng như khai báo.
- **SC-006**: Thay thế tất cả trên kịch bản 3.000 cue đổi đúng 100% vị trí khớp trong không quá 2 giây.
- **SC-007**: Thay đổi chữ hoặc kiểu hiện trên khung xem trước trong vòng 0,2 giây.
- **SC-008**: Video thành phẩm lệch thời lượng so với nguồn không quá 100 ms, tiếng và hình lệch không quá 50 ms ở cả đầu và cuối.
- **SC-009**: Tại 20 thời điểm lấy mẫu, khung xem trước và video xuất ra cùng nội dung, cùng xuống dòng, vị trí lệch không quá 1% chiều cao khung.
- **SC-010**: Video 1080p dài 10 phút xuất xong trong không quá 20 phút kể từ khi bắt đầu chạy trên máy triển khai.
- **SC-011**: 100% tiến trình tiếp tục khi đóng trình duyệt; không tiến trình nào mất âm thầm hay bị tính phí dịch hai lần sau khi khởi động lại.
- **SC-012**: Trong kiểm thử với ít nhất 2 User, 0 trường hợp một User xem hoặc tải được dữ liệu của User khác.
- **SC-013**: 100% video quá hạn (nguồn và thành phẩm) bị xóa trong vòng 1 giờ sau hạn.
- **SC-014**: Ít nhất 90% người dùng thử tự làm được video dịch đầu tiên từ đầu tới cuối không cần trợ giúp.
- **SC-015**: Trong kiểm thử, 0 lần phát sinh phí dịch từ User không được cấp quyền và 0 lần hạn mức video bị vượt, kể cả khi gửi nhiều yêu cầu cùng lúc.

## Assumptions

- **Phạm vi phiên bản này**: toàn bộ nhóm tính năng của REQ-006, triển khai theo thứ tự P1 → P2 → P3.
- **Khi REQ-006 khác spec 005** (cỡ chữ, viền, vị trí nhanh, thời lượng hiệu ứng, phông chữ, độ đậm), tab Dịch Video theo REQ-006; hành vi vẽ chữ dùng lại spec 005; tab Video Overlay hiện có không đổi.
- **Một kiểu cho cả video**; chỉnh kiểu riêng từng cue nằm ngoài phạm vi.
- **Hạn giữ 7 ngày** cho video chưa xuất và việc cho tải tiếp trong 48 giờ là đề xuất thêm, REQ-006 chưa nêu.
- **Dung lượng**: hạn mức video 30 GB đủ cho một video 10 GB cùng thành phẩm cỡ tương đương. Tổng ổ đĩa phải tính theo số User được cấp quyền; việc này do Administrator quyết định khi cấp quyền. Lớp phụ đề nền trong suốt rất lớn nên thường bị chặn bởi hạn mức với video dài.
- **Thu hồi quyền** dừng tiến trình đang chạy để không phát sinh thêm chi phí, tương tự khóa tài khoản.
- **Dịch một chiều**: mỗi video một ngôn ngữ đích; video xen nhiều ngôn ngữ được dịch hết về ngôn ngữ đó.
- **Chọn luồng tiếng, chọn đoạn video để dịch, cắt ghép video, lồng tiếng bản dịch, tải video từ đường dẫn**: ngoài phạm vi.
- **Chia sẻ hoặc đăng thẳng lên mạng xã hội, nhận thông báo qua email**: ngoài phạm vi.
- **Mốc từng từ đo thật** của lời gốc không được dùng ở phiên bản này để giữ một cách hiển thị thống nhất và đúng cả sau khi sửa chữ.
- **Chưa kiểm chứng**: SC-003, SC-004, SC-005, SC-010 cần đo bằng video thật (có phí) và trên máy triển khai; khả năng lấy âm thanh trong trình duyệt với từng định dạng cần thử ở bước lập kế hoạch, định dạng không làm được thì đi luồng máy chủ.
- **Phụ thuộc**: cấu hình Soniox (spec 004), bộ vẽ chữ và xuất overlay (spec 005), hạn mức, tiến trình nền, nhật ký, cài đặt hệ thống hiện có; ổ đĩa máy chủ đủ cho video nguồn, tệp tạm và thành phẩm.
- **Gợi ý kỹ thuật trong REQ-006** (cách tải lên, công cụ tách âm thanh và dựng video, hàng đợi, cấu trúc bảng, nội dung yêu cầu gửi Soniox) để lại cho bước `/speckit-plan`.
