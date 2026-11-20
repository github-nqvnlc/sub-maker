# Sub Maker Constitution

## Core Principles

### I. Bảo mật và cô lập dữ liệu (BẮT BUỘC)

- Mọi chức năng (trừ đăng ký/đăng nhập) MUST yêu cầu đăng nhập. Kiểm tra quyền MUST thực hiện ở
  phía máy chủ cho mọi đường truy cập: giao diện, địa chỉ trực tiếp, API và tải file audio.
- User MUST chỉ truy cập được dữ liệu của chính mình (Project, file, voice, tiến trình, log,
  thống kê). Truy cập dữ liệu của người khác MUST bị từ chối như thể dữ liệu không tồn tại.
- Chức năng quản trị (quản lý User, cấu hình AI chung, danh sách User được dùng cấu hình AI riêng,
  thống kê toàn hệ thống) MUST chỉ dành cho Administrator. Administrator chỉ xem thống kê và
  quản lý tài khoản, MUST NOT duyệt nội dung Project của User.
- Mật khẩu MUST được lưu bằng băm có muối; đăng nhập và đăng ký MUST có giới hạn tốc độ.

**Lý do**: Dịch vụ công bố ra Internet, đăng ký mở, và nội dung kịch bản/voice của User là riêng
tư. Một lần lộ dữ liệu giữa các User là lỗi nghiêm trọng nhất của sản phẩm.

### II. Bảo vệ khóa API và thông tin bí mật

- Khóa API (chung và riêng) MUST được lưu mã hóa, MUST NOT được gửi xuống trình duyệt, ghi vào
  log, hoặc hiển thị lại đầy đủ (chỉ hiện dạng che, ví dụ vài ký tự cuối).
- Bí mật triển khai (tài khoản Administrator, khóa mã hóa, thông tin MinIO, token tunnel) MUST
  nằm trong biến môi trường hoặc cơ chế bí mật của triển khai, MUST NOT commit vào mã nguồn.
- Địa chỉ gọi nhà cung cấp có chứa khóa trên URL MUST NOT được ghi log. Thông báo lỗi trả cho
  User MUST NOT chứa khóa hoặc chi tiết nội bộ.
- Chỉ User trong danh sách được phép mới được nhập cấu hình AI riêng; yêu cầu gửi trực tiếp từ
  User ngoài danh sách MUST bị máy chủ từ chối.

**Lý do**: Khóa AI gắn với tiền thật. Lộ khóa gây thiệt hại tài chính ngay lập tức.

### III. Tiến trình nền bền vững và quan sát được

- Tiến trình tạo voice MUST chạy nền, độc lập với trình duyệt: rời trang hoặc đóng tab MUST NOT
  làm dừng tiến trình.
- Mỗi tiến trình MUST có trạng thái rõ ràng (đang chờ, đang chạy, đã dừng, hoàn tất, lỗi), tiến
  độ và log chi tiết được lưu lại, cập nhật cho người xem trong vòng 2 giây, và tự đồng bộ khi
  kết nối lại.
- Hệ thống MUST chịu được việc khởi động lại: tiến trình không được mất âm thầm; phải tiếp tục
  hoặc được đánh dấu "bị gián đoạn, có thể chạy lại", giữ phần đã xong.
- Số tiến trình chạy đồng thời MUST có giới hạn; phần dư được xếp hàng.
- Lỗi tạm thời (mạng, quá tải, 429/5xx) MUST được thử lại có giới hạn với backoff; lỗi vĩnh viễn
  (sai khóa, thiếu quyền, nội dung bị chặn) MUST NOT bị thử lại.

**Lý do**: Voice cho kịch bản dài mất nhiều phút; người dùng chỉ tin hệ thống khi thấy rõ nó
đang làm gì và không mất công sức khi có sự cố.

### IV. Kiểm soát chi phí và dùng lại kết quả AI

- Audio đã sinh MUST được tái sử dụng khi nội dung, giọng và thiết lập giống nhau (khóa cache theo
  băm nội dung); không tính phí lặp.
- Mỗi lần gọi nhà cung cấp MUST ghi bản ghi sử dụng (User, Project, nhà cung cấp, số ký tự/token,
  chi phí ước tính, nguồn cấu hình chung hay riêng). Thống kê MUST dựa trên các bản ghi này và
  MUST NOT bịa số khi nhà cung cấp không trả đơn vị đó.
- Giá, hệ số và giới hạn của nhà cung cấp MUST NOT bị hard-code như sự thật cố định; phải nằm
  trong cấu hình hoặc được ghi rõ là ước tính.
- Lỗi của cấu hình riêng MUST NOT tự chuyển sang cấu hình chung để tránh tiêu tốn chi phí ngoài
  ý muốn.
- Giới hạn lưu trữ (file 2 MB, 500 MB mỗi User; Administrator chỉnh được) MUST được áp dụng ở
  máy chủ.

**Lý do**: Khóa chung do hệ thống chịu phí và ai cũng đăng ký được; chi phí phải nhìn thấy được
và không phát sinh lặp.

### V. Kiểm thử trước khi phát hành

- Mỗi user story MUST có kịch bản kiểm thử độc lập khớp với "Independent Test" trong spec, và
  được chạy trước khi coi là hoàn thành.
- Các hành vi sau MUST có kiểm thử tự động: cô lập dữ liệu giữa hai User, phân quyền
  Administrator/User, chọn cấu hình AI chung/riêng, tái sử dụng cache, xử lý lỗi tạm thời so với
  vĩnh viễn, đồng bộ thời gian highlight theo câu, xóa User/Project/tiến trình xóa sạch dữ liệu.
- Tích hợp với nhà cung cấp AI MUST được kiểm thử bằng bản giả lập (mock) trong kiểm thử tự động;
  gọi nhà cung cấp thật chỉ dùng cho kiểm tra thủ công có chủ đích.
- Lỗi cần có kiểm thử tái hiện trước khi sửa.

**Lý do**: Các rủi ro lớn nhất (rò dữ liệu, tốn tiền, mất tiến trình) khó phát hiện bằng mắt.

### VI. Giao diện nhất quán, tiếng Việt là mặc định, dùng được trên mọi màn hình

- Giao diện MUST đầy đủ bằng tiếng Việt, là ngôn ngữ mặc định. MAY thêm ngôn ngữ giao diện khác
  (hiện thêm English) với điều kiện: mọi ngôn ngữ có đủ khóa chữ (kiểm tra tự động), khóa thiếu
  bản dịch MUST rơi về tiếng Việt và MUST NOT hiện khóa kỹ thuật, và lựa chọn của người dùng
  MUST được ghi nhớ. Nội dung do người dùng tạo (tên Project, nội dung phụ đề) MUST NOT bị dịch.
- Giao diện MUST theo đúng theme và thành phần chung của hệ thống thiết kế đã chọn; MUST NOT tự
  viết kiểu riêng cho thứ đã có thành phần chuẩn.
- Mọi màn hình MUST có đủ trạng thái: đang tải, rỗng, lỗi, không có kết quả.
- Thao tác xem, nghe, theo dõi tiến trình MUST dùng được trên điện thoại và máy tính bảng.
- Thao tác xóa (một hoặc nhiều) MUST có bước xác nhận nêu rõ số lượng và hậu quả.
- Thông báo lỗi MUST nêu nguyên nhân và bước nên làm tiếp theo, không lộ tên kỹ thuật nội bộ.
- Tìm kiếm tiếng Việt MUST chấp nhận gõ không dấu, ở mọi ngôn ngữ giao diện.

**Lý do**: Người dùng không phải kỹ thuật viên; sự nhất quán giảm lỗi thao tác và công sức bảo trì.
Người dùng chính nói tiếng Việt nên tiếng Việt luôn đầy đủ; ngôn ngữ khác mở rộng đối tượng dùng
mà không được làm giảm trải nghiệm tiếng Việt.

## Ràng buộc kỹ thuật và triển khai

- **Frontend**: Next.js, Tailwind CSS, shadcn/ui, dùng theme tại
  https://tweakcn.com/themes/cmmdxhg6d000804l5f6xlcbh3.
- **Backend và cơ sở dữ liệu**: chọn ở bước `/speckit-plan`, kèm lý do; lựa chọn MUST hỗ trợ tiến
  trình nền bền vững, truyền log thời gian thực và truy vấn tìm kiếm/lọc/sắp xếp cho 200+ Project.
- **Lưu trữ file**: S3 MinIO cho file subtitle, audio và avatar. File MUST NOT truy cập công khai
  không xác thực; tải về MUST đi qua kiểm tra quyền (ví dụ liên kết ký có thời hạn).
- **Triển khai**: Docker, công bố qua Cloudflare Tunnel và gắn tên miền. Các dịch vụ nội bộ (cơ sở
  dữ liệu, MinIO, tiến trình nền) MUST NOT mở cổng trực tiếp ra Internet.
- **Bền dữ liệu**: dữ liệu MUST nằm trên volume bền, không mất khi khởi động lại hoặc triển khai
  lại.
- **Nhà cung cấp AI**: MUST truy cập qua một giao diện trừu tượng chung (tổng hợp văn bản + giọng
  → audio) để thêm nhà cung cấp mới (FPT.AI Speech/Marketplace, ShopAIKey…) mà không đổi trải nghiệm
  người dùng. Đặc điểm từng nhà cung cấp lấy từ `docs/fpt-ai-voice-guide.md` và
  `docs/shopaikey-guide.md`; điểm chưa kiểm chứng trong đó MUST được thử thật trước khi dựa vào.
- **Văn bản và âm thanh**: văn bản MUST chuẩn hóa Unicode NFC và UTF-8; chia câu/đoạn theo giới
  hạn từng nhà cung cấp; mốc thời gian theo câu/đoạn (không theo từng từ).
- **Định dạng phụ đề**: dùng chuẩn SubRip `.srt` (số thứ tự, dòng mốc `hh:mm:ss,mmm --> hh:mm:ss,mmm`,
  chữ); không dùng định dạng riêng `.skt`. Kịch bản `.txt` và `.md` vẫn được hỗ trợ.

## Quy trình phát triển và chất lượng

- Công việc MUST đi theo quy trình Spec Kit: `/speckit-specify` → `/speckit-clarify` →
  `/speckit-plan` → `/speckit-tasks` → `/speckit-implement`. Thay đổi hành vi MUST cập nhật spec
  trước.
- Phạm vi giai đoạn này: CRUDS Project, tạo voice, xem/nghe đồng bộ, tài khoản, thống kê, cấu hình
  AI. Tính phí theo usage, hạn mức theo User, chia sẻ Project, highlight theo từng từ, xuất phụ
  đề, chỉnh văn bản trong ứng dụng thuộc giai đoạn sau và MUST NOT làm sớm khi chưa có spec.
- Mỗi thay đổi MUST được rà soát đối chiếu Core Principles; vi phạm MUST được ghi lại cùng lý do
  trong mục theo dõi độ phức tạp của plan.
- Tài liệu dự án (spec, plan, README, hướng dẫn vận hành) dùng tiếng Việt; thông báo giao diện
  theo ngôn ngữ người dùng đã chọn (mặc định tiếng Việt); tên mã (biến, hàm, bảng) dùng tiếng Anh.
- Nội dung do AI sinh ra có thể cần gắn nhãn theo nền tảng và luật nơi phát hành; quyền thương mại
  với audio phụ thuộc điều khoản nhà cung cấp và MUST được xác minh trước khi User dùng thương mại.

## Governance

- Constitution này ưu tiên hơn mọi thực hành khác của dự án. Khi spec, plan hoặc mã mâu thuẫn với
  nó, MUST sửa spec/plan/mã hoặc sửa constitution qua quy trình bên dưới, không bỏ qua âm thầm.
- **Sửa đổi**: nêu rõ thay đổi, lý do và tác động lên spec/plan/tasks đang có; cập nhật phiên bản
  và ngày; rà lại các tài liệu phụ thuộc.
- **Đánh số phiên bản**: MAJOR khi bỏ hoặc định nghĩa lại nguyên tắc theo hướng không tương thích;
  MINOR khi thêm nguyên tắc/mục hoặc mở rộng đáng kể; PATCH khi làm rõ câu chữ.
- **Rà soát tuân thủ**: mọi plan MUST có bước kiểm tra constitution trước khi thiết kế và sau khi
  thiết kế; mọi lần review MUST đối chiếu Nguyên tắc I, II và IV (bảo mật và chi phí) trước tiên.

**Version**: 1.1.0 | **Ratified**: 2026-11-19 | **Last Amended**: 2026-11-20
