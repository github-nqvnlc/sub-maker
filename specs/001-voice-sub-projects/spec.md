# Feature Specification: Quản lý Project tạo Voice từ Subtitle (CRUDS)

**Feature Branch**: `001-voice-sub-projects`

**Created**: 2026-11-19

**Status**: Draft

**Input**: User description: "Phần mềm web quản lý (CRUDS) việc tạo voice từ kịch bản/subtitle (.skt, .md, .txt): tạo/xem/sửa/xóa/tìm kiếm Project; upload file subtitle để AI sinh voice; xem log chi tiết, chạy nền; nghe voice và highlight đúng câu đang đọc theo thời gian thực."

## Clarifications

### Session 2026-11-19

- Q: Ai được đăng nhập và mỗi người có thấy Project của người khác không? → A: Có tài khoản Administrator cấp sẵn qua cấu hình, quản lý các tài khoản User. User tự đăng ký và đăng nhập, có cá nhân hóa (avatar, tên, hồ sơ). Mỗi User chỉ thấy và quản lý Project và Dashboard thống kê của chính mình. Administrator xem thống kê (số Project, số voice, mức sử dụng AI…) của từng User.
- Q: Khóa API nhà cung cấp AI do ai cung cấp? → A: Cả hai. Mặc định dùng cấu hình chung do Administrator thiết lập. Administrator có thể cấu hình đầy đủ nhà cung cấp AI (địa chỉ gốc, khóa API…) và quản lý danh sách User được phép nhập cấu hình AI riêng (thêm/xóa). User mới mặc định không nằm trong danh sách đó; User trong danh sách có thể nhập cấu hình riêng để thay thế cấu hình chung.
- Q: Khi User bị xóa, dữ liệu của họ xử lý thế nào? → A: Xóa vĩnh viễn toàn bộ Project, file, voice, log và cấu hình AI riêng của User; chỉ giữ số liệu thống kê tổng hợp ẩn danh của hệ thống.
- Q: User vừa đăng ký có dùng được ngay cấu hình AI chung không? → A: Có, dùng ngay sau khi đăng ký, không cần Administrator duyệt. Tính phí theo mức sử dụng sẽ phát triển ở giai đoạn sau; hiện tại chỉ thống kê.
- Q: Giới hạn kích thước file kịch bản và dung lượng lưu trữ mỗi User? → A: File kịch bản tối đa 2 MB; mỗi User tối đa 500 MB lưu trữ (file + audio); Administrator chỉnh được các giá trị này.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Tạo Project và sinh voice từ file subtitle (Priority: P1)

Người dùng tạo một Project mới (tên, mô tả, chọn nhà cung cấp AI giọng nói), sau đó upload một file kịch bản/subtitle (.skt, .md hoặc .txt). Hệ thống tách nội dung thành các câu/đoạn, dùng AI tạo giọng đọc cho toàn bộ nội dung và lưu thành một "voice" thuộc Project. Người dùng theo dõi log chi tiết từng bước ngay trên màn hình.

**Why this priority**: Đây là giá trị cốt lõi của sản phẩm. Chỉ cần có luồng này là đã có MVP dùng được: từ kịch bản ra được file giọng đọc.

**Independent Test**: Tạo Project, upload một file .txt ngắn, chọn nhà cung cấp, bắt đầu tạo voice; quan sát log chạy đến khi hoàn tất và nghe được voice kết quả.

**Acceptance Scenarios**:

1. **Given** người dùng đang ở danh sách Project, **When** nhập tên, mô tả, chọn nhà cung cấp AI và lưu, **Then** Project mới xuất hiện trong danh sách và có thể mở ra.
2. **Given** một Project đã tạo, **When** người dùng upload file .skt, .md hoặc .txt hợp lệ và chọn giọng đọc, **Then** hệ thống tạo một tiến trình sinh voice mới và hiển thị log trạng thái theo thời gian thực.
3. **Given** tiến trình đang chạy, **When** có sự kiện mới (đọc file, tách câu, gửi từng đoạn, nhận kết quả, ghép audio, hoàn tất/lỗi), **Then** log trên màn hình cập nhật ngay, mỗi dòng có thời điểm, mức độ (thông tin/cảnh báo/lỗi) và nội dung dễ hiểu.
4. **Given** file có định dạng không hỗ trợ, rỗng hoặc vượt giới hạn kích thước, **When** upload, **Then** hệ thống từ chối kèm thông báo rõ lý do và không tạo tiến trình.
5. **Given** tiến trình hoàn tất, **When** người dùng mở Project, **Then** voice được lưu vào danh sách voice của Project và có thể nghe lại.

---

### User Story 2 - Chạy nền và theo dõi tiến trình (Priority: P1)

Người dùng có thể rời khỏi màn hình đang tạo voice (đóng tab, chuyển trang, sang Project khác) mà tiến trình vẫn tiếp tục chạy. Khi quay lại, người dùng thấy trạng thái và log đầy đủ tới thời điểm hiện tại, kể cả phần log phát sinh lúc vắng mặt.

**Why this priority**: Việc tạo voice cho kịch bản dài mất nhiều phút; nếu bắt người dùng ở lại màn hình thì sản phẩm khó dùng thực tế.

**Independent Test**: Bắt đầu tạo voice cho file đủ dài, chuyển sang trang khác/đóng tab, mở lại sau vài phút và thấy tiến trình đã hoàn tất (hoặc đang chạy) cùng log đầy đủ.

**Acceptance Scenarios**:

1. **Given** tiến trình đang chạy, **When** người dùng rời trang hoặc đóng trình duyệt, **Then** tiến trình vẫn tiếp tục và không bị hủy.
2. **Given** người dùng quay lại trang chi tiết Project, **When** tiến trình vẫn đang chạy, **Then** thấy tiến độ hiện tại (ví dụ số câu đã xong/tổng số) và log tiếp tục cập nhật trực tiếp.
3. **Given** nhiều tiến trình thuộc nhiều Project cùng chạy, **When** người dùng xem danh sách Project, **Then** mỗi Project cho biết có tiến trình đang chạy hay không.

---

### User Story 3 - Xem Project, nghe voice và highlight theo thời gian thực (Priority: P1)

Người dùng mở chi tiết Project để xem tên, mô tả, danh sách tiến trình và trạng thái từng tiến trình, xem lại nội dung subtitle đã upload và nghe voice đã tạo. Khi phát voice, văn bản subtitle hiển thị bên cạnh được làm nổi bật đúng câu/đoạn đang được đọc, tự cuộn để câu đó luôn nằm trong vùng nhìn thấy, và theo sát khi người dùng tua hoặc tạm dừng.

**Why this priority**: Đây là điểm khác biệt và là cách người dùng kiểm tra chất lượng voice so với kịch bản; yêu cầu đọc lại và nghe lại là một phần cốt lõi của sản phẩm.

**Independent Test**: Mở Project có voice hoàn tất, bấm phát; câu đang đọc được làm nổi bật và chuyển theo audio; tua tới giữa chừng thì highlight nhảy tới đúng câu tương ứng; bấm vào một câu thì audio nhảy tới câu đó.

**Acceptance Scenarios**:

1. **Given** Project có voice hoàn tất, **When** người dùng bấm phát, **Then** câu đang đọc được làm nổi bật và chuyển sang câu kế tiếp đúng lúc audio chuyển câu (sai lệch không gây cảm giác lệch tiếng).
2. **Given** voice đang phát, **When** câu đang đọc nằm ngoài vùng nhìn thấy, **Then** vùng văn bản tự cuộn để đưa câu đó vào tầm nhìn.
3. **Given** người dùng kéo thanh tua tới một thời điểm bất kỳ, **When** thả ra, **Then** highlight cập nhật tới đúng câu tại thời điểm đó.
4. **Given** người dùng bấm vào một câu trong văn bản, **When** thao tác, **Then** audio phát từ đầu câu đó.
5. **Given** Project có nhiều voice, **When** người dùng chọn một voice, **Then** nội dung subtitle và highlight tương ứng với voice được chọn.
6. **Given** Project có tiến trình đang chạy hoặc lỗi, **When** mở chi tiết, **Then** thấy rõ từng tiến trình và trạng thái: đang chờ, đang chạy, tạm dừng/đã dừng, hoàn tất, lỗi.

---

### User Story 4 - Chỉnh sửa Project và quản lý tiến trình voice (Priority: P2)

Người dùng sửa thông tin Project (tên, mô tả, nhà cung cấp mặc định). Với các tiến trình voice, người dùng xem chi tiết, sửa thiết lập (ví dụ giọng đọc, tốc độ) rồi chạy lại, dừng tiến trình đang chạy, và xóa một hoặc nhiều tiến trình/voice cùng lúc.

**Why this priority**: Cần thiết để dùng lâu dài và sửa sai, nhưng luồng tạo và nghe (P1) đã tự mang lại giá trị.

**Independent Test**: Sửa tên Project, dừng một tiến trình đang chạy, chọn nhiều tiến trình rồi xóa; kiểm tra danh sách phản ánh đúng.

**Acceptance Scenarios**:

1. **Given** một Project, **When** người dùng sửa tên/mô tả/nhà cung cấp và lưu, **Then** thông tin mới hiển thị ở danh sách và chi tiết.
2. **Given** tiến trình đang chạy, **When** người dùng bấm dừng, **Then** tiến trình dừng, trạng thái chuyển thành "đã dừng", phần đã làm được giữ lại và log ghi nhận việc dừng.
3. **Given** tiến trình đã dừng hoặc lỗi, **When** người dùng sửa thiết lập và chạy lại, **Then** hệ thống tạo lượt chạy mới (hoặc tiếp tục cùng tiến trình), tái sử dụng kết quả đã có của các câu không đổi để tránh tốn phí lặp; voice cuối cùng luôn dùng một thiết lập thống nhất, không trộn nhiều giọng hay tốc độ.
4. **Given** nhiều tiến trình được chọn, **When** người dùng xác nhận xóa, **Then** các tiến trình đó và voice tương ứng bị xóa; tiến trình đang chạy phải được dừng trước hoặc bị chặn xóa kèm thông báo.

---

### User Story 5 - Xóa một hoặc nhiều Project (Priority: P2)

Người dùng chọn một hoặc nhiều Project trong danh sách rồi xóa. Hệ thống yêu cầu xác nhận, nêu rõ số Project và dữ liệu kèm theo (subtitle, voice, log) sẽ bị xóa và không khôi phục được.

**Why this priority**: Cần để dọn dẹp, nhưng không chặn giá trị cốt lõi.

**Independent Test**: Chọn 3 Project, xóa, xác nhận; cả 3 biến mất khỏi danh sách và dữ liệu đi kèm không còn truy cập được.

**Acceptance Scenarios**:

1. **Given** danh sách Project, **When** người dùng chọn nhiều Project và bấm xóa, **Then** hiển thị hộp xác nhận nêu rõ số lượng và hậu quả.
2. **Given** người dùng xác nhận, **When** xóa, **Then** các Project và toàn bộ dữ liệu liên quan bị xóa; nếu có tiến trình đang chạy, chúng được dừng trước khi xóa.
3. **Given** người dùng hủy ở bước xác nhận, **When** hủy, **Then** không có gì bị xóa.

---

### User Story 6 - Tìm kiếm, sắp xếp, lọc danh sách Project (Priority: P2)

Người dùng tìm Project theo tên/mô tả, sắp xếp (theo tên, ngày tạo, ngày cập nhật gần nhất, số voice) và lọc (theo nhà cung cấp AI, theo trạng thái tiến trình: có tiến trình đang chạy / có lỗi / không có tiến trình). Danh sách chia trang khi có nhiều Project.

**Why this priority**: Giá trị tăng dần theo số lượng Project; không cần cho lần dùng đầu tiên.

**Independent Test**: Tạo vài Project với nhà cung cấp khác nhau, thử tìm theo từ khóa, đổi sắp xếp, áp dụng bộ lọc và kiểm tra kết quả đúng.

**Acceptance Scenarios**:

1. **Given** nhiều Project, **When** người dùng nhập từ khóa (có dấu hoặc không dấu), **Then** chỉ hiển thị Project có tên/mô tả khớp.
2. **Given** danh sách, **When** đổi tiêu chí hoặc chiều sắp xếp, **Then** thứ tự thay đổi tương ứng.
3. **Given** danh sách, **When** áp dụng bộ lọc (nhà cung cấp, trạng thái tiến trình), **Then** chỉ còn Project thỏa; có thể kết hợp tìm kiếm + lọc + sắp xếp và xóa bộ lọc dễ dàng.
4. **Given** không có kết quả, **When** tìm/lọc, **Then** hiển thị trạng thái "không tìm thấy" kèm gợi ý xóa bộ lọc.

---

### User Story 7 - Tài khoản, đăng nhập và hồ sơ cá nhân (Priority: P1)

Người dùng tự đăng ký tài khoản User, đăng nhập và cá nhân hóa hồ sơ (ảnh đại diện, tên hiển thị, thông tin giới thiệu). Mỗi User chỉ thấy và thao tác trên dữ liệu của chính mình. Administrator được cấp sẵn qua cấu hình triển khai, đăng nhập và quản lý danh sách tài khoản User (xem, khóa/mở khóa, xóa, đặt lại mật khẩu).

**Why this priority**: Dịch vụ công bố ra Internet và có nhiều người dùng; mọi tính năng khác (Project, voice, thống kê) đều gắn với chủ sở hữu nên phải có trước.

**Independent Test**: Đăng ký User mới, đăng nhập, sửa hồ sơ; đăng nhập User thứ hai và xác nhận không thấy dữ liệu của User đầu; đăng nhập Administrator và khóa một User.

**Acceptance Scenarios**:

1. **Given** khách chưa có tài khoản, **When** đăng ký với email/tên đăng nhập và mật khẩu hợp lệ, **Then** tài khoản User được tạo, đăng nhập được và tạo voice được ngay mà không cần chờ duyệt.
2. **Given** đăng ký bằng thông tin đã tồn tại hoặc mật khẩu yếu, **When** gửi, **Then** bị từ chối kèm thông báo rõ lý do.
3. **Given** User đã đăng nhập, **When** sửa avatar, tên hiển thị, giới thiệu và lưu, **Then** thông tin mới hiển thị trên toàn giao diện.
4. **Given** hai User A và B, **When** B truy cập trực tiếp địa chỉ Project của A, **Then** bị từ chối như thể không tồn tại.
5. **Given** Administrator đã đăng nhập, **When** khóa một User, **Then** User đó không đăng nhập được nữa và các tiến trình đang chạy của họ bị dừng; dữ liệu được giữ.
6. **Given** Administrator, **When** xóa một User, **Then** hệ thống yêu cầu xác nhận nêu rõ toàn bộ Project, file, voice, log và cấu hình AI riêng của User sẽ bị xóa vĩnh viễn không khôi phục được; sau khi xác nhận, các tiến trình đang chạy bị dừng và dữ liệu bị xóa hết, chỉ còn số liệu thống kê tổng hợp ẩn danh.

---

### User Story 8 - Dashboard thống kê cá nhân và thống kê toàn hệ thống cho Administrator (Priority: P2)

Mỗi User có Dashboard thống kê của riêng mình: số Project, số voice, tổng thời lượng voice, số tiến trình theo trạng thái, mức sử dụng AI (số ký tự/token tùy nhà cung cấp, chi phí ước tính) theo ngày/tháng và theo nhà cung cấp. Administrator xem Dashboard tổng hợp và bảng thống kê từng User (số Project, số voice, mức sử dụng AI, hoạt động gần nhất).

**Why this priority**: Giúp kiểm soát chi phí AI và theo dõi mức dùng từng người, nhưng không chặn luồng tạo voice cốt lõi.

**Independent Test**: User tạo vài Project và voice, mở Dashboard và thấy số liệu khớp; Administrator mở thống kê và thấy dòng riêng cho User đó với số liệu khớp.

**Acceptance Scenarios**:

1. **Given** User có dữ liệu, **When** mở Dashboard, **Then** chỉ thấy số liệu của chính mình, lọc được theo khoảng thời gian.
2. **Given** tiến trình hoàn tất, **When** User mở lại Dashboard, **Then** số voice, thời lượng và mức sử dụng AI đã cập nhật.
3. **Given** Administrator, **When** mở thống kê, **Then** thấy bảng từng User và tổng hợp toàn hệ thống, sắp xếp được theo từng chỉ số.
4. **Given** User thường, **When** truy cập trang thống kê của Administrator, **Then** bị từ chối.

---

### User Story 9 - Cấu hình nhà cung cấp AI chung và riêng (Priority: P1)

Administrator thiết lập cấu hình nhà cung cấp AI dùng chung cho toàn hệ thống (loại nhà cung cấp, địa chỉ gốc, khóa API, model/giọng mặc định, bật/tắt) và quản lý danh sách User được phép dùng cấu hình AI riêng. User mới mặc định không nằm trong danh sách. User trong danh sách có thêm mục cài đặt để nhập cấu hình riêng (địa chỉ gốc, khóa API…) và khi có cấu hình riêng hợp lệ thì các lần tạo voice của họ dùng cấu hình đó thay cho cấu hình chung.

**Why this priority**: Không có cấu hình nhà cung cấp thì không tạo được voice; đồng thời quyết định ai chịu chi phí và ai được dùng khóa riêng.

**Independent Test**: Administrator nhập cấu hình chung và User thường tạo được voice; Administrator thêm User vào danh sách, User đó nhập cấu hình riêng và tạo voice bằng cấu hình riêng; Administrator xóa User khỏi danh sách và User quay về dùng cấu hình chung.

**Acceptance Scenarios**:

1. **Given** Administrator ở trang cài đặt AI, **When** thêm hoặc sửa nhà cung cấp (địa chỉ gốc, khóa API, model/giọng mặc định) và lưu, **Then** cấu hình chung được áp dụng cho các lần tạo voice mới của mọi User chưa có cấu hình riêng.
2. **Given** khóa API đã lưu, **When** Administrator mở lại cài đặt, **Then** khóa chỉ hiển thị dạng che (ví dụ 4–6 ký tự cuối), có thể thay mới nhưng không xem lại đầy đủ.
3. **Given** Administrator, **When** có nút kiểm tra kết nối và bấm, **Then** hệ thống thử gọi nhà cung cấp và báo thành công hoặc lý do lỗi.
4. **Given** User mới đăng ký, **When** mở cài đặt cá nhân, **Then** không thấy mục cấu hình AI riêng, và các lần tạo voice dùng cấu hình chung.
5. **Given** Administrator thêm User vào danh sách được phép, **When** User đó mở cài đặt, **Then** thấy mục cấu hình AI riêng và nhập được địa chỉ gốc, khóa API; cấu hình riêng hợp lệ được dùng thay cấu hình chung.
6. **Given** User đang có cấu hình riêng, **When** Administrator xóa User khỏi danh sách, **Then** User không còn dùng hoặc sửa được cấu hình riêng, các lần tạo voice sau đó quay về cấu hình chung; cấu hình riêng được giữ nhưng vô hiệu, không bị xóa.
7. **Given** User thường không nằm trong danh sách, **When** cố gửi cấu hình riêng trực tiếp (không qua giao diện), **Then** bị từ chối.

---

### Edge Cases

- Cấu hình chung chưa được thiết lập hoặc bị tắt: User thường không bắt đầu được tiến trình, thấy thông báo rõ và Administrator được cảnh báo ở trang cài đặt.
- Cấu hình riêng của User sai khóa hoặc hết số dư: tiến trình báo lỗi nêu rõ là cấu hình riêng; hệ thống không tự chuyển sang cấu hình chung để tránh vô tình tốn chi phí của Administrator.
- Administrator xóa User khỏi danh sách khi tiến trình dùng cấu hình riêng đang chạy: tiến trình đang chạy được hoàn tất với cấu hình đã dùng khi bắt đầu; các tiến trình mới dùng cấu hình chung.
- Thống kê mức sử dụng AI phân biệt được lượt dùng cấu hình chung (chi phí của hệ thống) và cấu hình riêng (chi phí của User).
- Administrator xóa hoặc khóa User đang có tiến trình chạy: tiến trình bị dừng trước; khóa giữ nguyên dữ liệu, xóa thì dữ liệu bị xóa vĩnh viễn.
- Xóa User thất bại giữa chừng (ví dụ lỗi kho lưu trữ): User chuyển sang trạng thái "đang xóa", không đăng nhập được, và việc xóa được thử lại cho đến khi không còn dữ liệu mồ côi.
- Đăng ký hàng loạt hoặc đoán mật khẩu: giới hạn số lần thử và tốc độ đăng ký, tạm khóa sau nhiều lần sai.
- Số liệu thống kê khi tiến trình bị dừng/lỗi giữa chừng: chỉ tính phần thực sự đã gọi nhà cung cấp.
- Nhà cung cấp không trả số token (chỉ có ký tự): thống kê hiển thị đơn vị mà nhà cung cấp đo được, không bịa số.
- File chứa nhiều ngôn ngữ, ký tự đặc biệt, emoji, markup Markdown (tiêu đề, danh sách, liên kết): hệ thống chỉ đọc phần nội dung nói được, bỏ ký hiệu định dạng, và cho người dùng thấy văn bản sẽ được đọc trước khi chạy.
- File .skt/.srt có mốc thời gian sẵn: mốc thời gian không dùng để quyết định audio; thời lượng thật lấy từ audio sinh ra (xem Assumptions).
- File rất dài vượt giới hạn mỗi lần gọi của nhà cung cấp: tự chia theo câu/đoạn, ghép lại theo đúng thứ tự.
- Một phần đoạn bị lỗi (hết hạn mức, mạng lỗi, nhà cung cấp quá tải): thử lại tự động có giới hạn; nếu vẫn lỗi, tiến trình chuyển "lỗi" nhưng giữ phần đã xong để chạy tiếp từ chỗ dở thay vì làm lại từ đầu.
- Khóa/tài khoản nhà cung cấp hết số dư hoặc không có quyền với giọng/model đã chọn: báo rõ nguyên nhân bằng ngôn ngữ dễ hiểu, không lộ khóa bí mật.
- Nội dung bị nhà cung cấp từ chối (chính sách an toàn): đánh dấu câu liên quan, không thử lại vô ích.
- Người dùng upload cùng một file hai lần hoặc chạy lại với cùng cài đặt: tái sử dụng kết quả đã có để không tốn phí lặp.
- Hai tab cùng mở một Project: trạng thái và log nhất quán giữa hai tab.
- Mất kết nối giữa chừng khi đang xem log: khi kết nối lại, log tự đồng bộ phần bị thiếu.
- Máy chủ khởi động lại khi tiến trình đang chạy: tiến trình không bị mất âm thầm; được đánh dấu rõ (tiếp tục hoặc "bị gián đoạn, có thể chạy lại").
- Xóa Project/tiến trình đang chạy hoặc đang được người khác nghe: dừng tiến trình trước, phát hiện audio không còn tồn tại và thông báo thân thiện.
- User đạt giới hạn dung lượng khi tiến trình đang chạy: tiến trình hiện tại được hoàn tất, các tiến trình mới bị chặn kèm thông báo.
- Tên Project trùng nhau: cho phép, nhưng phân biệt bằng ngày tạo; tên trống hoặc quá dài bị từ chối.

## Requirements *(mandatory)*

### Functional Requirements

**Project (Create / Read / Update / Delete)**

- **FR-001**: Hệ thống MUST cho phép tạo Project với tên (bắt buộc), mô tả (tùy chọn) và nhà cung cấp AI giọng nói mặc định chọn từ danh sách được hỗ trợ.
- **FR-002**: Hệ thống MUST hiển thị trang chi tiết Project gồm tên, mô tả, nhà cung cấp, danh sách file subtitle, danh sách voice, danh sách tiến trình tạo voice và trạng thái từng tiến trình.
- **FR-003**: Hệ thống MUST cho phép sửa tên, mô tả, nhà cung cấp mặc định của Project.
- **FR-004**: Hệ thống MUST cho phép xóa một hoặc nhiều Project sau bước xác nhận, và xóa toàn bộ dữ liệu liên quan (file subtitle, voice, log, tiến trình); tiến trình đang chạy phải được dừng trước.

**Danh sách, tìm kiếm, sắp xếp, lọc**

- **FR-005**: Hệ thống MUST hiển thị danh sách Project có phân trang, mỗi mục nêu tên, mô tả rút gọn, nhà cung cấp, số voice, ngày cập nhật và trạng thái tiến trình tổng hợp.
- **FR-006**: Hệ thống MUST hỗ trợ tìm kiếm theo tên và mô tả, không phân biệt hoa/thường và chấp nhận gõ không dấu cho tiếng Việt.
- **FR-007**: Hệ thống MUST hỗ trợ sắp xếp theo tên, ngày tạo, ngày cập nhật, số voice (tăng/giảm).
- **FR-008**: Hệ thống MUST hỗ trợ lọc theo nhà cung cấp AI và theo trạng thái tiến trình (đang chạy, có lỗi, không có tiến trình), kết hợp được với tìm kiếm và sắp xếp.

**Upload subtitle và tạo voice**

- **FR-009**: Hệ thống MUST cho phép upload file kịch bản/subtitle định dạng .skt, .md, .txt vào một Project, kiểm tra định dạng, mã hóa ký tự (UTF-8) và kích thước tối đa 2 MB mỗi file trước khi chấp nhận.
- **FR-010**: Hệ thống MUST lưu file gốc đã upload và cho phép xem lại nội dung văn bản sau khi upload.
- **FR-011**: Hệ thống MUST tách nội dung thành các câu/đoạn theo thứ tự, loại bỏ ký hiệu định dạng không đọc được (Markdown, mốc thời gian, thẻ) và cho người dùng xem trước nội dung sẽ được đọc.
- **FR-012**: Hệ thống MUST tạo giọng đọc bằng nhà cung cấp AI được chọn, cho phép chọn giọng đọc và tốc độ trong phạm vi nhà cung cấp hỗ trợ, và xử lý giới hạn độ dài mỗi lần gọi bằng cách tự chia nhỏ rồi ghép đúng thứ tự.
- **FR-013**: Hệ thống MUST hỗ trợ ít nhất hai nhà cung cấp: FPT.AI (gồm dịch vụ Speech và/hoặc Marketplace) và ShopAIKey (các kênh TTS của nó), cho phép thêm nhà cung cấp khác về sau mà không đổi trải nghiệm người dùng.
- **FR-014**: Hệ thống MUST quản lý thông tin xác thực của nhà cung cấp một cách an toàn (cả cấu hình chung và riêng): lưu mã hóa, không hiển thị lại đầy đủ khóa sau khi lưu, không ghi vào log, không gửi xuống trình duyệt.
- **FR-015**: Hệ thống MUST lưu mỗi lần tạo voice thành một tiến trình độc lập thuộc Project, kèm cấu hình đã dùng (nhà cung cấp, giọng, tốc độ, file nguồn), và cho phép một Project có nhiều tiến trình/voice.
- **FR-016**: Hệ thống MUST ghi nhận thời lượng và mốc bắt đầu/kết thúc của từng câu trong voice hoàn tất để phục vụ phát đồng bộ.
- **FR-017**: Hệ thống MUST tái sử dụng audio đã sinh cho cùng nội dung + cùng giọng + cùng thiết lập, để không tính phí lặp.

**Tiến trình, log, chạy nền**

- **FR-018**: Hệ thống MUST chạy tiến trình tạo voice nền, độc lập với trình duyệt: rời trang hoặc đóng tab không làm dừng tiến trình.
- **FR-019**: Hệ thống MUST cung cấp log chi tiết theo thời gian thực cho mỗi tiến trình (thời điểm, mức độ, nội dung, tiến độ x/y câu), cập nhật trực tiếp trên màn hình mà không cần tải lại trang, và lưu để xem lại sau.
- **FR-020**: Hệ thống MUST hiển thị trạng thái rõ ràng cho mỗi tiến trình: đang chờ, đang chạy, đã dừng, hoàn tất, lỗi, kèm tiến độ phần trăm.
- **FR-021**: Hệ thống MUST cho phép dừng tiến trình đang chạy, giữ lại phần đã xong, và cho phép chạy lại/tiếp tục từ phần chưa xong.
- **FR-022**: Hệ thống MUST cho phép xem và sửa thiết lập của tiến trình (giọng, tốc độ, nhà cung cấp) rồi chạy lại; chỉ sửa được thiết lập khi tiến trình đã dừng, lỗi hoặc bị gián đoạn (đang chờ/đang chạy phải dừng trước). Với tiến trình đã hoàn tất, việc đổi thiết lập được thực hiện bằng "chạy lại" tạo tiến trình mới, voice cũ giữ nguyên.
- **FR-023**: Hệ thống MUST cho phép chọn và xóa một hoặc nhiều tiến trình/voice cùng lúc sau bước xác nhận.
- **FR-024**: Hệ thống MUST tự thử lại có giới hạn với lỗi tạm thời của nhà cung cấp, và không thử lại với lỗi vĩnh viễn (sai khóa, thiếu quyền, nội dung bị từ chối); thông báo lỗi cho người dùng bằng ngôn ngữ dễ hiểu kèm gợi ý xử lý.
- **FR-025**: Hệ thống MUST giới hạn số tiến trình chạy đồng thời để tránh vượt hạn mức nhà cung cấp, các tiến trình dư được xếp hàng.

**Nghe voice và đồng bộ văn bản**

- **FR-026**: Hệ thống MUST cho phép nghe voice trong trình phát có phát/tạm dừng, tua, chỉnh tốc độ phát và âm lượng.
- **FR-027**: Hệ thống MUST làm nổi bật câu/đoạn đang được đọc theo thời gian thực của trình phát, tự cuộn để giữ câu đó trong tầm nhìn, và cập nhật đúng khi tua, tạm dừng hoặc phát lại.
- **FR-028**: Hệ thống MUST cho phép bấm vào một câu để phát từ câu đó.
- **FR-029**: Hệ thống MUST cho phép tải về file audio của voice đã tạo.

**Chung**

- **FR-030**: Hệ thống MUST yêu cầu đăng nhập cho mọi chức năng (trừ trang đăng ký/đăng nhập), vì dịch vụ được công bố ra Internet.
- **FR-031**: Giao diện MUST dùng tiếng Việt làm ngôn ngữ chính, hiển thị tốt trên máy tính và màn hình nhỏ (điện thoại/tablet) cho các thao tác xem, nghe và theo dõi tiến trình.
- **FR-032**: Hệ thống MUST bền dữ liệu: dữ liệu Project, file và voice không mất khi khởi động lại hay triển khai lại dịch vụ.
- **FR-033**: Hệ thống MUST có hai vai trò: Administrator (một tài khoản cấp sẵn qua cấu hình triển khai, không đăng ký qua giao diện) và User (tự đăng ký).
- **FR-034**: Hệ thống MUST cho phép khách tự đăng ký tài khoản User và đăng nhập/đăng xuất; mật khẩu được lưu an toàn, có giới hạn số lần đăng nhập sai. Mật khẩu MUST dài 10–128 ký tự, không toàn chữ số và không nằm trong danh sách mật khẩu phổ biến. Tài khoản mới MUST dùng được đầy đủ chức năng (kể cả tạo voice bằng cấu hình AI chung) ngay sau khi đăng ký, không cần Administrator duyệt.
- **FR-035**: Hệ thống MUST cho phép User cá nhân hóa hồ sơ: ảnh đại diện, tên hiển thị, thông tin giới thiệu, đổi mật khẩu.
- **FR-036**: Hệ thống MUST cô lập dữ liệu theo chủ sở hữu: User chỉ xem và thao tác được Project, file, voice, tiến trình, log và thống kê của chính mình; truy cập dữ liệu người khác bị từ chối ở mọi đường truy cập (giao diện, địa chỉ trực tiếp, tải file audio).
- **FR-037**: Administrator MUST quản lý được danh sách tài khoản User: xem, tìm kiếm, khóa/mở khóa, đặt lại mật khẩu, xóa vĩnh viễn (có xác nhận); xóa User MUST xóa toàn bộ Project, file, voice, log, cấu hình AI riêng của User đó và dừng các tiến trình đang chạy, chỉ giữ số liệu thống kê tổng hợp ẩn danh (không còn gắn với danh tính User).
- **FR-038**: Hệ thống MUST cung cấp Dashboard thống kê cá nhân cho mỗi User: số Project, số voice, tổng thời lượng voice, số tiến trình theo trạng thái, mức sử dụng AI (ký tự/token tùy nhà cung cấp, chi phí ước tính) theo ngày/tháng và theo nhà cung cấp.
- **FR-039**: Hệ thống MUST cung cấp cho Administrator thống kê tổng hợp và từng User (số Project, số voice, mức sử dụng AI, hoạt động gần nhất); chỉ Administrator truy cập được.
- **FR-040**: Hệ thống MUST ghi nhận mức sử dụng AI của từng lần gọi nhà cung cấp, gắn với User và Project, để làm nguồn cho thống kê; không tính phần dùng lại từ kho đã sinh (FR-017).
- **FR-041**: Administrator MUST cấu hình được đầy đủ nhà cung cấp AI dùng chung: thêm/sửa/xóa/bật/tắt nhà cung cấp, loại nhà cung cấp, địa chỉ gốc, khóa API, model và giọng đọc mặc định; có chức năng kiểm tra kết nối.
- **FR-042**: Administrator MUST quản lý được danh sách User được phép dùng cấu hình AI riêng (thêm, xóa, tìm kiếm); User mới tạo mặc định KHÔNG nằm trong danh sách.
- **FR-043**: User nằm trong danh sách MUST nhập, sửa, kiểm tra và xóa được cấu hình AI riêng của mình (địa chỉ gốc, khóa API…); cấu hình riêng hợp lệ MUST được dùng thay cho cấu hình chung ở các lần tạo voice của User đó. User ngoài danh sách MUST không thấy và không gửi được cấu hình riêng.
- **FR-044**: Khi User bị xóa khỏi danh sách, hệ thống MUST ngừng dùng cấu hình riêng của họ cho các tiến trình mới, giữ cấu hình đó ở trạng thái vô hiệu, và quay về cấu hình chung.
- **FR-045**: Hệ thống MUST ghi mỗi bản ghi sử dụng AI kèm nguồn cấu hình (chung hoặc riêng) để thống kê phân biệt được chi phí hệ thống với chi phí của User.
- **FR-046**: Hệ thống MUST giới hạn dung lượng lưu trữ mỗi User (file subtitle và audio) mặc định 500 MB; khi vượt, chặn tạo mới và báo rõ cho User cách giải phóng (xóa voice/Project). Administrator MUST chỉnh được giới hạn kích thước file và dung lượng mỗi User, và xem dung lượng đang dùng của từng User trong thống kê.

### Key Entities

- **User Account (Tài khoản)**: Người dùng hệ thống, có vai trò (Administrator hoặc User), trạng thái (hoạt động/bị khóa) và hồ sơ cá nhân (ảnh đại diện, tên hiển thị, giới thiệu). Sở hữu các Project của mình.
- **Usage Record (Bản ghi sử dụng AI)**: Một lần gọi nhà cung cấp, gắn User, Project, nhà cung cấp, số ký tự/token và chi phí ước tính; là nguồn của thống kê.
- **Project**: Đơn vị làm việc. Có chủ sở hữu (User), tên, mô tả, nhà cung cấp AI mặc định, thời điểm tạo/cập nhật. Sở hữu các file subtitle, tiến trình và voice.
- **Subtitle File (Kịch bản)**: File gốc người dùng upload (.skt/.md/.txt) cùng văn bản đã chuẩn hóa. Thuộc một Project; có thể dùng cho nhiều tiến trình.
- **Segment (Câu/Đoạn)**: Một đơn vị văn bản được tách từ kịch bản theo thứ tự. Sau khi tạo voice có thêm mốc bắt đầu/kết thúc trong audio.
- **Voice Job (Tiến trình tạo voice)**: Một lần chạy sinh voice. Có cấu hình (nhà cung cấp, giọng, tốc độ, file nguồn), trạng thái, tiến độ, thời điểm, và nhật ký.
- **Voice (Voice đã tạo)**: Kết quả của một tiến trình hoàn tất: file audio, tổng thời lượng và danh sách mốc thời gian của các Segment. Thuộc Project.
- **Job Log Entry**: Một dòng nhật ký của tiến trình (thời điểm, mức độ, nội dung, tiến độ).
- **AI Provider (Nhà cung cấp)**: Nguồn sinh giọng (FPT.AI, ShopAIKey…), kèm danh sách giọng đọc/mô hình hỗ trợ.
- **AI Provider Configuration (Cấu hình AI)**: Địa chỉ gốc, khóa API (được che), model/giọng mặc định, trạng thái bật/tắt. Có hai phạm vi: chung (do Administrator quản lý) và riêng (thuộc một User được phép).
- **Custom AI Access List (Danh sách User được dùng cấu hình riêng)**: Tập các User mà Administrator cho phép nhập cấu hình AI riêng; mặc định rỗng với User mới.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Người dùng mới tạo được Project, upload file và bắt đầu tạo voice trong dưới 2 phút, không cần hướng dẫn.
- **SC-002**: Sau khi bắt đầu tiến trình, dòng log đầu tiên xuất hiện trên màn hình trong vòng 2 giây, và mỗi sự kiện mới hiển thị trong vòng 2 giây từ lúc xảy ra.
- **SC-003**: 100% tiến trình tiếp tục chạy khi người dùng rời trang hoặc đóng trình duyệt; khi quay lại, người dùng thấy đúng trạng thái và đầy đủ log.
- **SC-004**: Khi phát voice, câu được làm nổi bật khớp với câu đang đọc ở ít nhất 95% thời điểm kiểm tra; độ lệch chuyển câu không quá 0,3 giây.
- **SC-005**: Sau khi tua tới thời điểm bất kỳ, highlight chuyển đúng câu trong vòng 0,5 giây.
- **SC-006**: Với kịch bản khoảng 5.000 ký tự, từ lúc bắt đầu đến lúc nghe được voice hoàn chỉnh mất không quá 5 phút trong điều kiện nhà cung cấp hoạt động bình thường.
- **SC-007**: Với 200 Project, tìm kiếm/lọc/sắp xếp hiển thị kết quả trong dưới 1 giây.
- **SC-008**: Khi một phần tiến trình lỗi, ít nhất 90% lần chạy lại tái sử dụng phần đã xong thay vì làm lại từ đầu (không tốn phí lặp cho các câu đã có).
- **SC-009**: Chọn và xóa 10 Project hoặc 10 tiến trình cùng lúc hoàn tất trong dưới 5 giây thao tác (không tính bước xác nhận), không để lại dữ liệu mồ côi truy cập được.
- **SC-010**: 90% lỗi người dùng gặp (sai định dạng, hết hạn mức, quá tải, nội dung bị chặn) hiển thị thông báo nêu được nguyên nhân và bước nên làm tiếp theo.
- **SC-011**: Trong kiểm thử với ít nhất 2 User, 0 trường hợp một User xem được hoặc tải được dữ liệu của User khác qua bất kỳ đường truy cập nào.
- **SC-012**: Số liệu trên Dashboard (số Project, số voice, mức sử dụng AI) khớp 100% với dữ liệu thực tế của User, và cập nhật trong vòng 1 phút sau khi tiến trình hoàn tất.
- **SC-013**: Administrator tìm ra User dùng nhiều AI nhất trong tháng trong dưới 30 giây từ lúc mở trang thống kê.

## Assumptions

- **Người dùng và quyền** (đã làm rõ): Một Administrator cấp sẵn qua cấu hình; User tự đăng ký. Dữ liệu tách riêng theo User. Administrator quản lý tài khoản và xem thống kê từng User, nhưng ở phiên bản này không duyệt nội dung Project/kịch bản/voice của User (bảo vệ riêng tư; có thể bổ sung sau nếu cần).
- **Đăng ký**: Đăng ký mở bằng email/tên đăng nhập và mật khẩu; phiên bản đầu KHÔNG có xác minh email, đăng nhập qua bên thứ ba hay quên mật khẩu tự phục vụ (đã chốt ở bước lập kế hoạch); khi User quên mật khẩu, Administrator đặt lại.
- **Hạn mức và tính phí** (đã làm rõ): User mới dùng ngay sau khi đăng ký, không cần duyệt. Mức sử dụng AI chỉ được thống kê; tính phí theo mức sử dụng và hạn mức/chặn tự động theo User thuộc giai đoạn sau. Rủi ro chấp nhận: ai đăng ký cũng có thể dùng cấu hình chung nên chi phí do hệ thống chịu, được giảm nhẹ bằng giới hạn tốc độ đăng ký và số tiến trình đồng thời (FR-025, FR-034) và Administrator khóa User khi cần. Chi phí của cấu hình riêng do User chịu.
- **"Voice được upload trong Project"** được hiểu là danh sách các voice (audio) thuộc Project do hệ thống tạo ra từ subtitle; không có chức năng upload audio có sẵn của người dùng ở phiên bản này.
- **Định dạng .skt**: Coi là kịch bản văn bản thuần, có thể kèm mốc thời gian giống file phụ đề. Mốc thời gian (nếu có) được bỏ qua khi sinh voice; thời lượng thật lấy từ audio. Nếu sau này có đặc tả .skt riêng, sẽ bổ sung.
- **Ngôn ngữ**: Nội dung chính là tiếng Việt; giao diện tiếng Việt. Chất lượng tiếng Việt của từng nhà cung cấp cần được người dùng nghe thử.
- **Mốc thời gian từng câu**: Nhà cung cấp không trả mốc thời gian nên được suy ra bằng cách sinh voice theo từng câu/nhóm câu rồi ghép; vì vậy độ chính xác theo câu/đoạn, không theo từng từ. Highlight từng từ nằm ngoài phạm vi.
- **Quyền truy cập nhà cung cấp** (đã làm rõ): Cấu hình chung do Administrator nhập qua giao diện cài đặt; User được phép có thể nhập cấu hình riêng thay thế. Khóa của User thường không bao giờ được nhập qua giao diện thông thường nếu họ không nằm trong danh sách. Số dư, giá và giới hạn do nhà cung cấp quyết định; hệ thống chỉ ghi nhận mức sử dụng (ký tự, số lần gọi) để người dùng biết.
- **Một file subtitle cho mỗi lần chạy**: Một tiến trình dùng một file; một Project có thể có nhiều file và nhiều tiến trình.
- **Giới hạn kích thước** (đã làm rõ): File kịch bản tối đa 2 MB; mỗi User tối đa 500 MB lưu trữ; Administrator chỉnh được.
- **Ràng buộc kỹ thuật do người dùng chỉ định** (để bước lập kế hoạch dùng, không thuộc yêu cầu nghiệp vụ): giao diện dùng NextJS + Tailwind CSS + shadcn/ui với theme tại https://tweakcn.com/themes/cmmdxhg6d000804l5f6xlcbh3; lưu trữ file bằng S3 MinIO; triển khai bằng Docker, qua Cloudflare Tunnel và gắn tên miền; backend và cơ sở dữ liệu để quá trình lập kế hoạch quyết định. Tài liệu nhà cung cấp: `docs/fpt-ai-voice-guide.md`, `docs/shopaikey-guide.md`.
- **Ngoài phạm vi (bổ sung sau)**: xuất phụ đề có mốc thời gian, chỉnh sửa văn bản kịch bản trực tiếp trong ứng dụng, highlight theo từng từ, phân quyền chi tiết ngoài hai vai trò, nhóm/chia sẻ Project giữa các User, hạn mức và tính phí theo mức sử dụng của User, thanh toán, tạo ảnh/video/nhạc.
