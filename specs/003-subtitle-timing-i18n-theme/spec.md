# Feature Specification: Voice khớp mốc thời gian phụ đề, đa ngôn ngữ, giao diện Sáng/Tối và font tiếng Việt

**Feature Branch**: `003-subtitle-timing-i18n-theme`

**Created**: 2026-11-20

**Status**: Draft

**Input**: User description: "1. Thêm giao diện Dark/Light, đặc biệt nổi bật viền ô nhập ở mỗi theme. 2. Hỏi có đa ngôn ngữ không, nếu chưa có thì làm. 3. Ở /admin/settings làm nổi bật tab đang được chọn. 4. Đổi font chữ cho hợp tiếng Việt. 5. Đọc tệp phụ đề mẫu docs/example/tham-quyen-2026.srt: quét bỏ số thứ tự và mốc thời gian, chỉ tạo voice từ phần chữ bên dưới mốc thời gian, rồi khi ghép voice phải khớp mốc thời gian của từng đoạn; điều tra và cho biết có làm được không (người dùng cần xác nhận). 6. Nếu tệp phụ đề như ví dụ quá dài thì đưa ra giải pháp để người dùng xác nhận."

## Bối cảnh

Hệ thống hiện tại (spec 001) chỉ có giao diện tiếng Việt, một theme sáng, font chữ Outfit, và khi đọc tệp phụ đề (trước đây đặt đuôi riêng `.skt`) thì **bỏ qua** số thứ tự lẫn mốc thời gian rồi tạo voice liên tục: thời lượng voice do giọng đọc quyết định, không bám theo mốc của phụ đề. Tính năng này làm hai nhóm việc: (a) **voice khớp thời gian phụ đề** — thứ người làm video cần để voice trùng hình; (b) **nền tảng giao diện**: Sáng/Tối, đa ngôn ngữ, font tiếng Việt, làm nổi bật tab quản trị.

Spec này tự đứng độc lập: không giả định tính năng nào khác đang được làm song song. Thư mục spec 002 (tệp lớn, chọn giọng, ước tính chi phí) hiện chỉ còn thư mục rỗng; nếu sau này làm lại, các mục Sáng/Tối và tab quản trị không cần đưa vào đó nữa vì đã nằm ở đây.

## Kết quả điều tra (trả lời các câu hỏi của người dùng)

**Đa ngôn ngữ — hiện chưa có.** Toàn bộ chữ trên giao diện đang nằm trong một bộ từ điển tiếng Việt duy nhất và trang khai báo ngôn ngữ cố định là tiếng Việt; chưa có cơ chế chọn/đổi ngôn ngữ. Bộ từ điển tập trung giúp việc thêm ngôn ngữ khả thi: tính năng này thêm **tiếng Anh** bên cạnh tiếng Việt (mặc định) và nút đổi ngôn ngữ. Lưu ý: nguyên tắc giao diện của dự án hiện ghi "giao diện MUST dùng tiếng Việt", nên cần sửa nguyên tắc đó thành "tiếng Việt là mặc định và luôn đầy đủ, cho phép thêm ngôn ngữ khác" (xem Assumptions).

**Font chữ — Outfit không có bộ ký tự tiếng Việt.** Font hiện dùng chỉ có các nhóm ký tự Latin và Latin mở rộng, **không** có nhóm tiếng Việt; các chữ có dấu chồng (ệ, ữ, ẳ, ỗ…) có thể bị thay bằng font dự phòng nên lệch nét, lệch chiều cao dòng và không đồng nhất. Cần đổi sang font có đủ bộ ký tự tiếng Việt.

**Khớp mốc thời gian phụ đề — làm được.** Điều tra trên tệp mẫu `docs/example/tham-quyen-2026.srt` (chuẩn SubRip `.srt`; trước đây hệ thống nhận đuôi riêng `.skt`, nay thay hẳn bằng `.srt`):

- Tệp có **244 cue**, tổng **9.186 ký tự**, kéo dài **11 phút 45 giây**; tốc độ chữ của phụ đề trung vị 14,1 ký tự/giây, 90% cue dưới 16 ký tự/giây.
- Khoảng nghỉ giữa các cue từ 0,08 đến 0,93 giây (109/243 khoảng nghỉ dài hơn 0,3 giây): có chỗ trống để mượn khi một cue đọc hơi dài.
- **Đã đo thật** bằng gói FPT Thường (giọng Ban Mai) trên 40 cue đầu: thời gian đọc bằng **0,9 lần** khe thời gian ở mức trung vị; **11/40 cue (27%)** đọc dài hơn khe của mình ở tốc độ thường, nhưng chỉ **3/40** vượt 1,25 lần — cả ba là cue chỉ có khe 1 giây với 12–18 ký tự ("Không Putin.", "Không Ukraine."…); chỉ 1/40 vượt 1,5 lần. Tốc độ đọc trung bình của giọng là 15,5 ký tự/giây so với 14,0 của phụ đề.
- Kết luận: **làm được** bằng cách đặt âm thanh của từng cue tại đúng mốc bắt đầu của nó, làm đầy khoảng trống bằng im lặng, và xử lý riêng các cue đọc dài hơn khe (mượn khoảng nghỉ liền sau, nén nhẹ, rồi trượt nhẹ cue kế tiếp và bù lại ở khoảng nghỉ sau — đã được xác nhận). Không cần nhà cung cấp trả mốc thời gian từng từ.
- Hạn chế cần biết: khoảng **40/244 cue kết thúc giữa câu** (cuối cue là dấu phẩy hoặc không dấu, ví dụ "Tập nói về một tương lai / mở, dựa trên luật lệ, / công nghệ và thị trường."). Đọc từng cue riêng làm giọng hạ xuống ở chỗ cắt, nghe rời rạc hơn so với đọc cả câu.
- Chi phí tệp mẫu (đơn giá FPT tham chiếu, tính theo ký tự): **0,15 USD** với Thường hoặc Pro, **0,91 USD** với Ultra; **244 yêu cầu** (khoảng 8 phút ở gói Thường vì giới hạn ~30 yêu cầu/phút).

## Clarifications

### Session 2026-11-20

- Q: Khi một cue vẫn đọc dài hơn khe sau khi đã mượn khoảng nghỉ và nén tối đa, xử lý thế nào? → A: Trượt nhẹ — cue sau bắt đầu trễ vài phần giây rồi bù lại ở khoảng nghỉ kế tiếp (giữ giọng tự nhiên, không tốn thêm lần gọi).
- Q: Có ghép các cue cùng một câu để đọc tự nhiên hơn không? → A: Có, vì người dùng muốn ngữ điệu mượt mà; đây là cách đọc **mặc định** ở chế độ khớp mốc (tắt được để đọc riêng từng cue).
- Q: Giải pháp cho phụ đề quá dài? → A: Chia phần theo cửa sổ thời gian (khoảng 10 phút phụ đề, cắt tại khoảng nghỉ dài), mỗi phần tạo riêng, đặt đúng mốc tuyệt đối rồi ghép thành MỘT voice duy nhất; tiếp tục được theo phần.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Voice khớp mốc thời gian của từng cue phụ đề (Priority: P1)

Người dùng tải tệp phụ đề chuẩn SubRip (`.srt`) có mốc thời gian. Hệ thống nhận ra tệp có mốc thời gian, **loại bỏ số thứ tự và dòng mốc thời gian khỏi văn bản đọc**, chỉ lấy chữ bên dưới mốc. Trong hộp thoại "Tạo voice", người dùng chọn chế độ **"Khớp mốc thời gian phụ đề"** (mặc định bật khi tệp có mốc hợp lệ) hoặc "Đọc liên tục" (như hiện nay). Ở chế độ khớp mốc, các cue thuộc cùng một câu được đọc liền một hơi để ngữ điệu mượt (tắt được để đọc riêng từng cue); âm thanh của mỗi câu được đặt đúng tại thời điểm bắt đầu của cue đầu tiên trong câu, giữa các cue là im lặng, và voice cuối cùng có độ dài và các mốc trùng với phụ đề để người dùng ghép thẳng vào video.

**Why this priority**: Đây là giá trị chính của yêu cầu mới và là điều kiện để voice dùng được cho dựng video; các mục khác là hỗ trợ.

**Independent Test**: Với `docs/example/tham-quyen-2026.srt`, tạo voice ở chế độ khớp mốc; kiểm tra văn bản đọc không còn số thứ tự/mốc, thời điểm bắt đầu của từng cue trong voice trùng mốc phụ đề trong sai số cho phép, và voice dài tương đương 11 phút 45 giây.

**Acceptance Scenarios**:

1. **Given** tệp `.srt` mẫu, **When** tải lên, **Then** được chấp nhận; xem trước hiển thị từng cue gồm mốc bắt đầu–kết thúc và phần chữ, và phần chữ **không** chứa số thứ tự hay dòng mốc thời gian; hiển thị tổng số cue, tổng số ký tự và độ dài phụ đề.
2. **Given** tệp có mốc hợp lệ, **When** mở "Tạo voice", **Then** chế độ "Khớp mốc thời gian phụ đề" được bật sẵn; người dùng đổi sang "Đọc liên tục" được và khi đó hệ thống hoạt động đúng như trước (mốc bị bỏ qua).
3. **Given** chế độ khớp mốc, **When** tạo xong, **Then** âm thanh của mỗi đơn vị đọc (một câu gồm một hoặc nhiều cue liền nhau) bắt đầu tại mốc bắt đầu của cue đầu tiên trong đơn vị đó (theo sai số ở SC-001), khoảng giữa hai đơn vị là im lặng, và độ dài tổng của voice bằng mốc kết thúc cue cuối cùng (hoặc dài hơn một chút nếu cue cuối đọc không kịp).
4. **Given** một cue đọc dài hơn khe thời gian của nó ở tốc độ thường, **When** ghép, **Then** hệ thống xử lý theo FR-006 (mượn khoảng nghỉ, nén nhẹ, rồi trượt nhẹ) mà không cắt cụt lời đọc và không làm chồng tiếng lên cue kế tiếp.
5. **Given** voice đã tạo ở chế độ khớp mốc, **When** mở trình phát, **Then** câu/cue đang đọc được làm nổi bật đúng theo mốc phụ đề, tua đến thời điểm nào thì highlight đúng cue ở thời điểm đó.
6. **Given** tệp có mốc không hợp lệ (cue chồng lấn, mốc kết thúc trước mốc bắt đầu, cue ngoài thứ tự, cue chỉ có ký hiệu như ♪ hoặc [Music]), **When** xem trước/tạo voice, **Then** hệ thống chuẩn hóa hoặc bỏ qua cue có vấn đề, hiển thị cảnh báo liệt kê số cue và lý do, không lỗi âm thầm.
7. **Given** tệp không có mốc thời gian (văn bản thường), **When** mở "Tạo voice", **Then** chế độ khớp mốc không khả dụng (hiện lý do) và hệ thống đọc liên tục như hiện nay.
8. **Given** hộp thoại tạo voice hiển thị ước tính, **When** chọn chế độ khớp mốc, **Then** ước tính tính theo ký tự thực sự đọc (đã loại số thứ tự/mốc), số yêu cầu (một yêu cầu cho mỗi câu khi bật "Ghép cue cùng câu", một cho mỗi cue khi tắt); số yêu cầu và chi phí là con số chắc chắn vì cách xử lý tràn khe không gọi thêm nhà cung cấp.
9. **Given** các cue liên tiếp thuộc cùng một câu (ví dụ "Tập nói về một tương lai / mở, dựa trên luật lệ, / công nghệ và thị trường."), **When** bật "Ghép cue cùng câu" (mặc định), **Then** cả câu được đọc liền một hơi với ngữ điệu trọn vẹn (không hạ giọng ở chỗ cắt giữa các cue), bắt đầu tại mốc của cue đầu; mốc nội bộ giữa các cue trong câu (cho highlight) được chia theo tỷ lệ số ký tự.

---

### User Story 2 - Phụ đề rất dài: chia phần theo thời gian và ghép về đúng mốc tuyệt đối (Priority: P1)

Khi tệp phụ đề rất dài (ví dụ nhiều giờ, hoặc hàng chục nghìn cue), hệ thống chia kịch bản thành các **phần theo thời gian**, mỗi phần gồm trọn các cue liền kề, tạo voice cho từng phần rồi **đặt từng phần vào đúng vị trí tuyệt đối** trên trục thời gian của phụ đề và ghép thành một voice duy nhất. Lỗi hoặc dừng giữa chừng chỉ phải làm lại phần chưa xong. Người dùng chỉ thấy một tiến trình, tiến độ theo phần.

**Why this priority**: Phụ đề dài là trường hợp thật (tệp mẫu 12 phút đã có 244 yêu cầu); độ trôi thời gian và khả năng tiếp tục là điều kiện để dùng được. Giải pháp cụ thể cần người dùng xác nhận.

**Independent Test**: Ghép tệp mẫu lặp lại nhiều lần thành phụ đề hàng giờ; tạo voice, ngắt giữa chừng rồi tiếp tục; kiểm tra có một voice, mọi cue vẫn đúng mốc ở đầu, giữa, cuối, và phần đã xong không bị tạo/tính phí lại.

**Acceptance Scenarios**:

1. **Given** phụ đề vượt ngưỡng một phần, **When** tạo voice, **Then** hệ thống chia tại ranh giới cue (không cắt giữa cue), ưu tiên chia tại khoảng nghỉ dài, mỗi phần xử lý độc lập.
2. **Given** các phần đã xong, **When** ghép, **Then** mỗi cue nằm đúng mốc tuyệt đối của nó; lỗi thời gian **không cộng dồn** từ phần này sang phần khác (cue đầu và cue cuối cùng có cùng độ chính xác).
3. **Given** tiến trình bị dừng ở phần N, **When** tiếp tục, **Then** các phần đã xong và các đơn vị đọc đã có trong bộ nhớ đệm được dùng lại, không tạo lại, không tính phí lại.
4. **Given** một phần có đoạn bị nhà cung cấp từ chối nội dung (lỗi vĩnh viễn), **When** hoàn tất, **Then** tiến trình **hoàn tất** (không thất bại), vị trí đoạn đó là im lặng đúng khe, các đoạn còn lại vẫn đúng mốc, voice được lưu, và người dùng nhận danh sách đoạn lỗi (kèm số cue) như hiện nay.
5. **Given** phụ đề dài cả giờ, **When** xem tiến độ, **Then** thấy tiến độ theo phần và theo cue, log tổng hợp theo phần (không bùng nổ số dòng), ước tính thời gian còn lại phản ánh giới hạn tốc độ của nhà cung cấp.

---

### User Story 3 - Giao diện Sáng / Tối với viền ô nhập nổi bật ở mỗi theme (Priority: P2)

Người dùng chuyển giữa **Sáng**, **Tối** hoặc **Theo hệ thống** bằng nút dễ thấy ở mọi màn hình (cả đăng nhập/đăng ký); lựa chọn được ghi nhớ. Ở **cả hai theme**, mọi ô nhập (chữ, vùng văn bản, ô chọn/popover, ô tìm kiếm, ô chọn ngày, mật khẩu) có viền rõ so với nền và nổi bật hơn hẳn khi đang chọn.

**Why this priority**: Cải thiện khả năng dùng và thẩm mỹ, không chặn tính năng khác.

**Independent Test**: Chuyển ba chế độ trên các màn hình chính; kiểm tra mọi thành phần đọc được và viền ô nhập đạt tương phản ở cả hai theme; tải lại vẫn giữ lựa chọn.

**Acceptance Scenarios**:

1. **Given** bất kỳ màn hình nào, **When** chọn Sáng/Tối/Theo hệ thống, **Then** toàn bộ giao diện đổi ngay, không cần tải lại.
2. **Given** đã chọn một chế độ, **When** tải lại hoặc quay lại sau, **Then** giữ nguyên lựa chọn và không nhấp nháy sai theme khi mở trang.
3. **Given** chọn "Theo hệ thống", **When** thiết lập sáng/tối của thiết bị đổi, **Then** giao diện đổi theo.
4. **Given** ô nhập ở trạng thái bình thường, **When** nhìn vào ở theme Sáng hoặc Tối, **Then** viền phân biệt rõ với nền; **When** được chọn (focus), **Then** viền và vòng nhấn nổi bật hơn hẳn; ô lỗi có viền màu cảnh báo.
5. **Given** theme Tối, **When** xem biểu đồ, trình phát có highlight, nhãn trạng thái, bảng, hộp thoại, **Then** vẫn đọc rõ, highlight câu đang đọc vẫn nổi bật.

---

### User Story 4 - Đa ngôn ngữ giao diện: Tiếng Việt và Tiếng Anh (Priority: P2)

Người dùng đổi ngôn ngữ giao diện giữa **Tiếng Việt** (mặc định) và **English** bằng nút ở mọi màn hình; lựa chọn được ghi nhớ. Toàn bộ chữ trên giao diện (nhãn, nút, thông báo, lỗi, trạng thái, định dạng ngày/giờ/số/tiền) đổi theo ngôn ngữ đã chọn.

**Why this priority**: Người dùng hỏi và yêu cầu làm nếu chưa có; hiện chưa có nên cần bổ sung; không chặn các tính năng khác.

**Independent Test**: Đổi sang English rồi đi qua toàn bộ màn hình chính; không còn chữ tiếng Việt sót lại ở phần giao diện; đổi lại tiếng Việt thì như cũ; tải lại giữ lựa chọn.

**Acceptance Scenarios**:

1. **Given** bất kỳ màn hình, **When** đổi ngôn ngữ, **Then** toàn bộ chữ giao diện đổi ngay, không cần tải lại và không mất dữ liệu đang nhập.
2. **Given** đã chọn một ngôn ngữ, **When** tải lại/đăng nhập lại/mở trên thiết bị khác của cùng tài khoản, **Then** dùng lại ngôn ngữ đã chọn (theo tài khoản khi đã đăng nhập, theo trình duyệt khi chưa).
3. **Given** thông báo lỗi do máy chủ trả về, **When** hiển thị, **Then** hiển thị bằng ngôn ngữ đang chọn, nêu nguyên nhân và bước nên làm tiếp.
4. **Given** ngày giờ, số và tiền, **When** hiển thị, **Then** theo quy ước của ngôn ngữ đang chọn (ví dụ 1.234,5 và 1,234.5).
5. **Given** một khóa chữ chưa có bản dịch ở ngôn ngữ chọn, **When** hiển thị, **Then** dùng tiếng Việt thay thế và không hiện khóa kỹ thuật; bộ kiểm tra tự động báo thiếu bản dịch.
6. **Given** nội dung do người dùng tạo (tên Project, nội dung phụ đề, tên giọng), **When** đổi ngôn ngữ giao diện, **Then** nội dung đó **không** bị dịch hay đổi.

---

### User Story 5 - Font chữ phù hợp tiếng Việt (Priority: P2)

Toàn bộ giao diện dùng một font có **đủ bộ ký tự tiếng Việt**, để mọi chữ có dấu hiển thị cùng một kiểu chữ, đúng nét, không bị cắt dấu và dễ đọc ở cỡ nhỏ.

**Why this priority**: Giao diện chủ yếu là tiếng Việt; font hiện tại thiếu nhóm ký tự tiếng Việt nên chữ có dấu chồng bị lệch và không đồng nhất.

**Independent Test**: Hiển thị bộ kiểm tra gồm toàn bộ chữ cái tiếng Việt (hoa/thường, đủ dấu) ở các cỡ và độ đậm dùng trong giao diện; kiểm tra không ký tự nào dùng font dự phòng và dấu không bị cắt.

**Acceptance Scenarios**:

1. **Given** mọi chữ cái tiếng Việt có dấu (hoa và thường), **When** hiển thị ở mọi cỡ/độ đậm đang dùng, **Then** 100% ký tự lấy từ font chính, cùng nét với chữ không dấu.
2. **Given** dòng chữ có dấu chồng như "Ệ", "Ữ", "Ẳ", **When** hiển thị ở tiêu đề, nút, ô nhập, bảng, **Then** dấu không bị cắt hoặc chồng lên dòng trên.
3. **Given** theme Sáng hoặc Tối, **When** xem chữ nhỏ (nhãn, chú thích, bảng), **Then** vẫn đọc rõ.
4. **Given** mạng chậm hoặc font chưa tải xong, **When** mở trang, **Then** chữ hiện bằng font dự phòng có hỗ trợ tiếng Việt, không để trống và không nhảy bố cục đáng kể khi font tải xong.

---

### User Story 6 - Làm nổi bật tab đang chọn ở khu quản trị (Priority: P3)

Ở khu **Quản trị** (`/admin/settings` và các trang quản trị dùng chung thanh tab: Người dùng, Cấu hình AI chung, User dùng AI riêng, Thống kê hệ thống, Cài đặt hệ thống), tab của trang hiện tại được **làm nổi bật rõ ràng**.

**Why this priority**: Cải thiện nhận biết vị trí; nhỏ và độc lập.

**Independent Test**: Mở lần lượt từng trang quản trị; đúng một tab được nổi bật và trùng trang đang mở, ở cả hai theme và cả hai ngôn ngữ.

**Acceptance Scenarios**:

1. **Given** quản trị viên mở `/admin/settings`, **When** nhìn thanh tab, **Then** tab "Cài đặt hệ thống" nổi bật (nền/viền/đậm chữ khác hẳn) và các tab khác ở trạng thái thường.
2. **Given** chuyển sang trang quản trị khác, **When** trang mở ra, **Then** tab nổi bật chuyển theo.
3. **Given** theme Sáng hoặc Tối, **When** xem tab đang chọn, **Then** vẫn nổi bật rõ và không chỉ dựa vào màu (có thêm gạch chân/đậm); trình đọc màn hình đọc được tab hiện tại.

---

### Edge Cases

- **Cue quá ngắn so với lời đọc** (ví dụ khe 1 giây cho 18 ký tự): giữ lời đọc đầy đủ, áp dụng FR-006 (mượn khoảng nghỉ, nén nhẹ, trượt nhẹ); không cắt cụt.
- **Cue chồng lấn nhau hoặc mốc ngược**: khe thời gian của cue được giới hạn bởi mốc bắt đầu của cue kế tiếp; cue có mốc kết thúc trước mốc bắt đầu được chuẩn hóa và cảnh báo.
- **Cue không có chữ đọc được** (♪, [Music], dòng trống): bỏ qua khi đọc, giữ im lặng đúng khoảng thời gian; không gửi yêu cầu rỗng tới nhà cung cấp và không tính phí.
- **Cue gồm nhiều dòng**: gộp thành một câu đọc liền; cue có chỉ dẫn định dạng (thẻ in nghiêng, màu, vị trí) được làm sạch trước khi đọc.
- **Cue kết thúc giữa câu**: ở chế độ mặc định các cue liền nhau cho đến hết câu (kết thúc bằng dấu chấm, chấm hỏi, chấm than, ba chấm hoặc hai chấm) được đọc như một đơn vị để giữ ngữ điệu mượt; người dùng tắt được "Ghép cue cùng câu" để đọc riêng từng cue và khớp từng cue chính xác hơn. Câu quá dài (vượt giới hạn một yêu cầu của nhà cung cấp) được tách theo mệnh đề.
- **Tệp phụ đề có mốc ở giờ lớn** (hàng giờ) và nhiều nghìn cue: không làm đơ giao diện hay ảnh hưởng người dùng khác; chia phần theo US2.
- **Mốc bắt đầu của cue đầu khác 0**: voice mở đầu bằng im lặng đúng bằng mốc đó để khớp video.
- **Đổi giọng/gói/tốc độ giữa các lần tạo**: bộ nhớ đệm theo cue không dùng nhầm kết quả của giọng/tốc độ khác.
- **Cue lặp lại cùng một câu** (ví dụ "Không chiến tranh."): tái sử dụng âm thanh đã có trong bộ nhớ đệm của chính người dùng, không tính phí lại.
- **Giới hạn tốc độ nhà cung cấp** (~30 yêu cầu/phút ở FPT Thường): phụ đề nhiều cue tạo nhiều yêu cầu; ước tính thời gian phải phản ánh và tiến trình chờ rồi tiếp tục, không thất bại.
- **Ngôn ngữ**: văn bản tiếng Anh dài hơn tiếng Việt có thể làm vỡ bố cục nút/bảng; mọi màn hình phải dùng được ở cả hai ngôn ngữ trên điện thoại. Nút đổi ngôn ngữ và đổi theme hoạt động ở cả trang đăng nhập.
- **Trình duyệt chặn lưu trữ cục bộ**: theme và ngôn ngữ vẫn hoạt động (mặc định Theo hệ thống / Tiếng Việt), không lỗi.
- **Thông báo từ máy chủ**: không sót chữ tiếng Việt cứng khi đang dùng English (hệ thống không gửi email).
- **Sửa thiết lập rồi tiếp tục tiến trình**: nếu đổi chế độ khớp mốc hoặc "Ghép cue cùng câu", danh sách đơn vị đọc được dựng lại từ đầu; đơn vị có nội dung trùng với bản cũ dùng lại bộ nhớ đệm (không tính phí lại), số liệu tiến độ được tính lại cho đúng.

## Requirements *(mandatory)*

### Functional Requirements

**Voice khớp mốc thời gian (US1)**

- **FR-001**: Hệ thống MUST nhận tệp phụ đề có mốc thời gian chuẩn SubRip với đuôi `.srt` (thay hẳn đuôi riêng `.skt`; tệp `.skt` bị từ chối với thông báo chỉ nhận `.txt`, `.md`, `.srt`), và MUST xác định tệp có mốc hợp lệ hay không. Kịch bản `.txt` và `.md` vẫn được hỗ trợ ở chế độ "Đọc liên tục".
- **FR-002**: Với tệp có mốc, hệ thống MUST tách mỗi cue thành (mốc bắt đầu, mốc kết thúc, chữ đọc); số thứ tự và dòng mốc MUST NOT nằm trong văn bản gửi tới giọng đọc, MUST NOT được tính vào số ký tự tính phí.
- **FR-003**: Hộp thoại "Tạo voice" MUST có lựa chọn **"Khớp mốc thời gian phụ đề"** / **"Đọc liên tục"**; mặc định bật khớp mốc khi tệp có mốc hợp lệ; tệp không có mốc thì chỉ có "Đọc liên tục" kèm lý do.
- **FR-004**: Ở chế độ khớp mốc, âm thanh của mỗi cue MUST bắt đầu tại mốc bắt đầu của cue đó; khoảng giữa các cue MUST là im lặng; voice kết quả MUST là một tệp có độ dài tương đương mốc kết thúc cue cuối; timeline (highlight, tua) MUST bám theo mốc phụ đề.
- **FR-005**: Hệ thống MUST chuẩn hóa mốc bất thường (chồng lấn, mốc ngược, ngoài thứ tự, cue không có chữ đọc) và MUST hiển thị cảnh báo liệt kê số cue và lý do trước khi tạo voice.
- **FR-006**: Khi lời đọc của một đơn vị đọc dài hơn khe thời gian của nó, hệ thống MUST xử lý theo thứ tự: (1) mượn khoảng im lặng liền sau (không lấn sang cue kế tiếp); (2) nén thời lượng nhẹ trong giới hạn không làm giọng méo (mặc định tối đa 1,25 lần); (3) nếu vẫn tràn thì **trượt nhẹ**: đơn vị kế tiếp bắt đầu trễ đúng bằng phần tràn còn lại rồi bù dần ở các khoảng nghỉ kế tiếp cho đến khi trở về đúng mốc. Độ trễ tối đa so với mốc phụ đề là **0,5 giây**; nếu sẽ vượt mức này, đơn vị tràn MUST được đánh dấu cảnh báo (kèm số cue) để người dùng sửa phụ đề, tiến trình vẫn chạy tiếp. Hệ thống MUST NOT cắt cụt lời đọc, MUST NOT làm chồng tiếng và MUST NOT gọi lại nhà cung cấp chỉ để tăng tốc.
- **FR-007**: Ở chế độ khớp mốc, hệ thống MUST có tùy chọn **"Ghép cue cùng câu"**, **bật mặc định**: các cue liên tiếp được nhóm cho đến cue kết thúc bằng dấu kết câu (. ? ! … hoặc :) thành một đơn vị đọc, đọc một yêu cầu với ngữ điệu liền mạch, bắt đầu tại mốc của cue đầu nhóm và kết thúc không muộn hơn khe tổng của nhóm theo FR-006; mốc nội bộ từng cue trong nhóm (dùng cho highlight) MUST được chia theo tỷ lệ số ký tự. Khi tắt, mỗi cue là một đơn vị đọc riêng (khớp từng cue chính xác hơn, ngữ điệu có thể rời rạc ở cue kết thúc giữa câu). Kích thước nhóm MUST bị giới hạn bởi giới hạn một yêu cầu của nhà cung cấp.
- **FR-008**: Trước khi tạo voice, hộp thoại MUST hiển thị ước tính theo ký tự đọc thực (sau khi bỏ số thứ tự/mốc), số cue, số yêu cầu, thời lượng voice và thời gian xử lý ước tính, và MUST loại các đơn vị đọc đã có trong bộ nhớ đệm của chính người dùng; vì cách xử lý tràn khe không gọi thêm nhà cung cấp nên số yêu cầu và chi phí ước tính không có khoản phát sinh ngoài dự kiến. Số tiền quy đổi chỉ hiển thị khi đơn giá của model đã được cấu hình; chưa cấu hình thì hiển thị "chưa cấu hình đơn giá" thay vì bịa số.
- **FR-009**: Bộ nhớ đệm MUST theo đơn vị đọc (nội dung, giọng, model, tốc độ); âm thanh gốc của đơn vị đọc MUST được giữ để đổi cách xử lý tràn khe, đổi mốc phụ đề hoặc bật/tắt "Ghép cue cùng câu" (với các đơn vị không đổi) mà không phải gọi lại nhà cung cấp.
- **FR-010**: Ở chế độ khớp mốc, khi nhà cung cấp từ chối nội dung của một đoạn (lỗi vĩnh viễn kiểu "nội dung bị chặn"), hệ thống MUST chỉ làm im lặng đúng khe của đoạn đó, các đoạn còn lại vẫn đúng mốc, tiến trình MUST kết thúc ở trạng thái **hoàn tất** kèm cảnh báo, voice MUST được lưu, và danh sách đoạn lỗi (kèm số cue) MUST được báo cho người dùng. Các lỗi khác (sai khóa, hết hạn mức nhà cung cấp, lỗi tạm thời đã hết lần thử) vẫn dừng tiến trình để tiếp tục sau như spec 001 (Nguyên tắc III), không tạo voice thiếu.
- **FR-011**: Trang xem trước MUST hiển thị từng cue với mốc bắt đầu–kết thúc và chữ đọc, tải dần theo trang cho tệp nhiều cue.

**Phụ đề rất dài (US2)**

- **FR-012**: Khi phụ đề vượt ngưỡng một phần, hệ thống MUST chia thành các **phần theo cửa sổ thời gian** (mặc định khoảng 10 phút phụ đề), cắt tại ranh giới đơn vị đọc và ưu tiên khoảng nghỉ dài nhất gần điểm cắt; mỗi phần xử lý độc lập, được đặt vào **vị trí tuyệt đối** trên trục thời gian của phụ đề rồi ghép thành **một** voice duy nhất; sai lệch thời gian MUST NOT cộng dồn giữa các phần (độ trễ do trượt nhẹ MUST được đặt lại về 0 tại mỗi điểm cắt).
- **FR-013**: Phụ đề dài MUST có ước tính trước (số cue, số ký tự, số yêu cầu, thời lượng voice, thời gian xử lý, dung lượng đầu ra) và MUST bị chặn kèm giải thích nếu dung lượng đầu ra ước tính vượt hạn mức lưu trữ còn lại của người dùng.
- **FR-014**: Tiến trình MUST tiếp tục được sau dừng/lỗi/khởi động lại, bỏ qua mọi phần và cue đã xong; log MUST tổng hợp theo phần; tiến độ hiển thị theo phần và theo cue.
- **FR-015**: Tệp phụ đề nhiều cue MUST không làm đơ giao diện hay ảnh hưởng người dùng khác (xem trước theo trang, xử lý nền).

**Giao diện Sáng/Tối (US3)**

- **FR-016**: Hệ thống MUST cung cấp ba chế độ **Sáng / Tối / Theo hệ thống** với nút chuyển dễ thấy trên mọi màn hình, kể cả đăng nhập/đăng ký; mặc định Theo hệ thống.
- **FR-017**: Lựa chọn theme MUST được ghi nhớ giữa các lần truy cập và áp dụng ngay khi trang mở, không nhấp nháy sai theme.
- **FR-018**: Mọi màn hình và thành phần (biểu đồ, trình phát và highlight, bảng, hộp thoại, nhãn trạng thái, popover chọn giọng) MUST đọc rõ ở cả hai theme.
- **FR-019**: Mọi ô nhập (ô chữ, vùng văn bản, ô chọn/popover, ô tìm kiếm, ô chọn ngày, mật khẩu) MUST có viền phân biệt rõ với nền ở cả hai theme (tương phản viền–nền tối thiểu 3:1), trạng thái focus MUST nổi bật hơn hẳn, trạng thái lỗi MUST có viền cảnh báo riêng.

**Đa ngôn ngữ (US4)**

- **FR-020**: Hệ thống MUST hỗ trợ **Tiếng Việt** (mặc định, luôn đầy đủ) và **English**, với nút đổi ngôn ngữ ở mọi màn hình, kể cả đăng nhập/đăng ký.
- **FR-021**: Lựa chọn ngôn ngữ MUST được ghi nhớ (theo tài khoản khi đã đăng nhập, theo trình duyệt khi chưa) và áp dụng ngay khi trang mở.
- **FR-022**: Toàn bộ chữ giao diện (nhãn, nút, thông báo, lỗi do máy chủ trả về, trạng thái, tiêu đề trang, nhắc nhở xác nhận) MUST theo ngôn ngữ đang chọn; ngày giờ, số, tiền MUST theo quy ước của ngôn ngữ đó.
- **FR-023**: Khóa chữ thiếu bản dịch MUST rơi về tiếng Việt, không hiện khóa kỹ thuật; kiểm tra tự động MUST báo cáo mọi khóa thiếu ở một trong hai ngôn ngữ.
- **FR-024**: Nội dung do người dùng tạo (tên Project, nội dung phụ đề, tên giọng đọc) MUST NOT bị dịch; tìm kiếm không dấu tiếng Việt MUST vẫn hoạt động ở cả hai ngôn ngữ.
- **FR-025**: Cấu trúc ngôn ngữ MUST cho phép thêm ngôn ngữ thứ ba bằng cách bổ sung một bộ bản dịch mà không sửa mã ở từng màn hình.

**Font chữ tiếng Việt (US5)**

- **FR-026**: Hệ thống MUST dùng một font chính có **đủ bộ ký tự tiếng Việt** (toàn bộ chữ cái hoa/thường có dấu) cho toàn bộ giao diện ở mọi độ đậm đang dùng; không ký tự tiếng Việt nào được lấy từ font dự phòng khi font chính đã tải.
- **FR-027**: Dấu của chữ tiếng Việt MUST không bị cắt hoặc chồng lên dòng khác ở tiêu đề, nút, ô nhập, bảng, hộp thoại và trình phát; chiều cao dòng MUST đủ chứa dấu chồng.
- **FR-028**: Trước khi font tải xong, hệ thống MUST hiển thị bằng font dự phòng hỗ trợ tiếng Việt, không để trống chữ; font MUST được phục vụ từ chính hệ thống (không phụ thuộc dịch vụ bên thứ ba lúc chạy).

**Tab quản trị (US6)**

- **FR-029**: Thanh tab khu Quản trị MUST làm nổi bật tab ứng với trang đang mở (ít nhất ở `/admin/settings`, áp dụng cho mọi trang quản trị dùng chung thanh tab) bằng dấu hiệu không chỉ dựa vào màu (nền, viền hoặc gạch chân, chữ đậm), MUST được công nghệ hỗ trợ nhận biết là trang hiện tại, nổi bật rõ ở cả hai theme và cả hai ngôn ngữ.

### Key Entities *(include if feature involves data)*

- **Cue phụ đề**: số thứ tự (không dùng để đọc), mốc bắt đầu, mốc kết thúc, chữ đọc; thuộc một tệp phụ đề; có thể bị chuẩn hóa hoặc bỏ qua kèm lý do.
- **Chế độ tạo voice**: "Khớp mốc thời gian" hoặc "Đọc liên tục", lưu cùng tiến trình.
- **Phần của tiến trình (theo thời gian)**: nhóm cue liền kề kèm khoảng thời gian tuyệt đối mà nó phủ; có trạng thái riêng để tiếp tục không làm lại.
- **Đơn vị đọc**: một câu gồm một hoặc nhiều cue liên tiếp (hoặc một cue khi tắt "Ghép cue cùng câu"); là đơn vị gửi tới giọng đọc và đơn vị của bộ nhớ đệm.
- **Âm thanh đơn vị đọc**: audio gốc của một đơn vị đọc (trước khi nén/đặt mốc), dùng lại theo nội dung, giọng, model, tốc độ.
- **Kết quả đặt mốc của đơn vị đọc**: thời điểm bắt đầu/kết thúc thực tế trong voice, mức nén đã áp dụng, độ trễ do trượt nhẹ so với mốc phụ đề, mốc nội bộ từng cue, cờ tràn khe (vượt 0,5 giây).
- **Tùy chọn giao diện của người dùng**: chế độ theme (Sáng/Tối/Theo hệ thống) và ngôn ngữ giao diện (vi/en).
- **Bản dịch giao diện**: tập chữ giao diện theo từng ngôn ngữ, có kiểm tra đầy đủ giữa các ngôn ngữ.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Ở chế độ khớp mốc với tệp mẫu `tham-quyen-2026.srt`, **≥ 95%** đơn vị đọc bắt đầu trong voice trong vòng **±0,15 giây** so với mốc phụ đề, **100%** đơn vị trong vòng **±0,5 giây**, độ trễ không bao giờ vượt 0,5 giây (đơn vị sẽ vượt thì bị đánh dấu cảnh báo), và độ dài voice nằm trong **±1 giây** so với mốc kết thúc cue cuối (chưa tính cue cuối tràn khe). Mốc nội bộ giữa các cue cùng một câu lệch tối đa **0,5 giây** so với mốc phụ đề.
- **SC-002**: Văn bản gửi đi đọc chứa **0** số thứ tự và **0** dòng mốc thời gian; số ký tự tính phí đúng bằng tổng ký tự của các đơn vị đọc (chữ của cue, cộng một khoảng trắng nối giữa các cue cùng đơn vị): với tệp mẫu là 9.186 khi đọc riêng từng cue và khoảng 9.226 khi ghép cue cùng câu (204 đơn vị).
- **SC-003**: Với phụ đề dài tới 3 giờ, độ lệch thời gian của cue ở cuối voice **không lớn hơn** độ lệch ở đầu voice (không cộng dồn), và khi tiếp tục sau gián đoạn **100%** phần/cue đã xong được dùng lại không tính phí lại.
- **SC-004**: Xem trước tệp phụ đề lớn nhất mà hệ thống cho phép (hàng chục nghìn cue trở lên) hiển thị trong **dưới 10 giây** và các thao tác của người dùng khác vẫn phản hồi **dưới 1 giây**.
- **SC-005**: Đổi ngôn ngữ áp dụng toàn bộ giao diện trong **dưới 1 giây** không tải lại; kiểm thử tự động xác nhận **100%** khóa chữ có đủ ở cả hai ngôn ngữ và **0** chuỗi tiếng Việt cứng còn sót ở màn hình hiển thị bằng English.
- **SC-006**: **100%** ký tự tiếng Việt trong bộ kiểm tra (toàn bộ chữ cái hoa/thường có dấu) hiển thị từ font chính; **0** dấu bị cắt ở các cỡ và độ đậm dùng trong giao diện.
- **SC-007**: **100%** màn hình chính đọc rõ ở cả hai theme; viền ô nhập đạt tương phản **≥ 3:1** với nền ở cả hai theme; lựa chọn theme và ngôn ngữ giữ sau khi tải lại ở **100%** trường hợp thử, không nhấp nháy sai theme khi mở trang.
- **SC-008**: **100%** người tham gia thử nghiệm nhận ra đúng tab quản trị đang mở trong vòng **2 giây**, ở cả hai theme.
- **SC-009**: Người dùng làm theo đúng hướng dẫn trên màn hình hoàn tất tạo voice khớp mốc từ tệp `.srt` mẫu trong **dưới 3 phút** thao tác (chưa tính thời gian xử lý nền) và không cần chỉnh phụ đề thủ công cho **≥ 90%** tệp thử nghiệm có mốc hợp lệ.

## Assumptions

- **Phụ đề `.srt` (SubRip)**: số thứ tự, dòng mốc `hh:mm:ss,mmm --> hh:mm:ss,mmm`, một hoặc nhiều dòng chữ, dòng trống ngăn cue. Đuôi riêng `.skt` đã bị loại bỏ và thay bằng `.srt`; bộ đọc phụ đề hiện có đã loại số thứ tự/mốc nhưng **chủ ý bỏ mốc**; tính năng này giữ mốc ở chế độ khớp mốc và giữ nguyên hành vi cũ ở "Đọc liên tục".
- Số liệu đo ở phần Kết quả điều tra lấy từ 40 cue đầu của tệp mẫu với gói FPT Thường (giọng Ban Mai, tốc độ mặc định); tỷ lệ cue tràn khe sẽ khác theo giọng, gói và tốc độ nên ước tính trên giao diện chỉ là gần đúng và kết quả thật được đo sau khi tạo.
- Nén thời lượng nhẹ và mượn khoảng nghỉ là tính toán thuần âm thanh trên máy, **không gọi thêm nhà cung cấp**, nên không phát sinh chi phí; mức nén tối đa mặc định **1,25 lần** (vượt mức này chất lượng giọng giảm rõ).
- Khi bật "Ghép cue cùng câu" (mặc định), tệp mẫu cần khoảng **204 yêu cầu** (nhóm theo dấu . ? ! … và dấu hai chấm; tối đa 4 cue một nhóm) so với 244 khi đọc riêng từng cue; chi phí theo ký tự không đổi vì FPT AI tính phí theo ký tự, nhưng thời gian xử lý tăng ở nhà cung cấp có giới hạn số yêu cầu mỗi phút. Mốc nội bộ trong một câu chỉ phục vụ highlight và được ước lượng theo tỷ lệ ký tự, không phải mốc đo từ giọng đọc.
- Độ trễ tối đa 0,5 giây, cửa sổ chia phần khoảng 10 phút và mức nén 1,25 lần là các giá trị mặc định có thể được Administrator chỉnh trong Cài đặt hệ thống.
- Cue lặp lại cùng nội dung tái sử dụng bộ nhớ đệm theo người dùng nên giảm cả chi phí lẫn số yêu cầu.
- **Thuật ngữ trên giao diện**: "đoạn" là đơn vị đọc (một câu gồm một hoặc nhiều cue; giữ nhãn "đoạn" của spec 001, ví dụ "đoạn lỗi"); "cue" là một dòng phụ đề gốc. Hai từ không dùng lẫn lộn cho cùng một khái niệm.
- Giới hạn kích thước tệp hiện hành (2 MB, Administrator chỉnh được) và hạn mức lưu trữ mỗi người dùng giữ nguyên; phụ đề dài hàng giờ vẫn nằm trong 2 MB (tệp mẫu 20 KB cho 12 phút, tức khoảng 300 KB cho 3 giờ); việc tăng giới hạn kích thước tệp nằm ngoài spec này. Chế độ "Đọc liên tục" giữ nguyên cách chia đoạn hiện có; chia phần theo thời gian ở US2 chỉ áp dụng cho tệp có mốc.
- **Đa ngôn ngữ**: bổ sung tiếng Anh; tiếng Việt vẫn là mặc định và đầy đủ. Nguyên tắc giao diện của dự án ("Giao diện MUST dùng tiếng Việt") cần được sửa thành "tiếng Việt là mặc định và luôn đầy đủ; cho phép thêm ngôn ngữ khác" qua một lần cập nhật hiến pháp riêng — việc này không do spec này thực hiện nhưng là điều kiện trước khi triển khai.
- Chuỗi hiển thị từ máy chủ (lỗi, thông báo) được trả theo ngôn ngữ của người dùng đang đăng nhập; thông báo kỹ thuật nội bộ trong log vận hành không cần dịch.
- Ngôn ngữ của giọng đọc/tiếng nói và nội dung phụ đề vẫn là tiếng Việt; đa ngôn ngữ ở đây chỉ là giao diện.
- Theme và ngôn ngữ lưu theo trình duyệt khi chưa đăng nhập và theo tài khoản khi đã đăng nhập; mặc định Theo hệ thống và Tiếng Việt. Bảng màu giữ phong cách hiện tại, bổ sung phiên bản Tối.
- Font chính là font miễn phí có đủ bộ ký tự tiếng Việt, được phục vụ từ chính hệ thống; chọn font cụ thể ở bước lập kế hoạch dựa trên thử nghiệm hiển thị chữ có dấu chồng và độ dễ đọc ở cỡ nhỏ.
- Thanh tab khu Quản trị là thanh điều hướng chung của các trang `/admin/*`; "tab đang chọn" là tab của trang đang mở.
- Ngoài phạm vi: nâng giới hạn kích thước tệp, chọn nhà cung cấp/giọng ở bước tạo voice, tính tiền theo model; dịch nội dung người dùng; ngôn ngữ giọng đọc ngoài tiếng Việt; căn chỉnh theo từng từ bằng nhận dạng giọng nói; tạo phụ đề từ audio; dựng video; tự sửa mốc phụ đề.
