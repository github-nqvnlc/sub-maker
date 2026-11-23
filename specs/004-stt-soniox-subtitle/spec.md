# Feature Specification: STT Soniox Tạo Phụ Đề & Tái Cấu Trúc Cấu Hình AI Provider Quản Trị

**Feature Branch**: `004-stt-soniox-subtitle`

**Created**: 2026-11-23

**Status**: Draft

**Input**: User description:
1. Phát triển tính năng STT tạo file subtitle từ audio/video qua Soniox API (`https://docs.soniox.com/stt/get-started`).
2. Tái cấu trúc cài đặt cấu hình API của Admin trong "Cấu hình AI chung" (`/admin/ai-configs`):
   - Mặc định: **FPT.AI** cố định chỉ có 1 token dùng tất cả model kể cả các model khác ngoài TTS sau này.
   - Mặc định: **SONIOX** cố định chỉ có 1 token dùng được tất cả các model Async và Real-time về STT (trong task này khuyến nghị Async, chuẩn bị sẵn cho Realtime và Translation).
   - Tùy chọn đặc biệt: **ShopAIKey** chỉ có 1 token dùng tất cả các model được đăng ký kể cả các model khác ngoài TTS.
   - Tùy chọn thêm: Dành cho Admin và User được cấu hình AI riêng thêm AI Provider chuẩn OpenAI. Riêng Admin có thể thêm nhiều AI Provider, có danh sách quản lý CRUDS, bật tắt công khai với các User hoặc chỉ định một hoặc nhiều User được dùng.

---

## Bối cảnh & Mục tiêu

Tính năng này giải quyết 2 bài toán chiến lược của hệ thống Sub Maker:
1. **Hoàn thiện vòng lặp phụ đề - giọng đọc**:
   - Tải lên tệp âm thanh (`.mp3`, `.wav`, `.m4a`,...) hoặc video (`.mp4`, `.mov`,...).
   - Bóc tách âm thanh siêu nhẹ bằng FFmpeg và phiên âm qua Soniox STT Async API.
   - Chuyển đổi tokens thành file phụ đề chuẩn `.srt` (có mốc thời gian), `.txt` hoặc `.md`.
   - Nạp trực tiếp vào Project để chỉnh sửa hoặc tạo Voice AI khớp mốc phụ đề.
2. **Chuẩn hóa hạ tầng Cấu hình AI Provider**:
   - Quy hoạch gọn gàng các nhà cung cấp cốt lõi (FPT.AI, Soniox, ShopAIKey) với quy tắc **1 Token duy nhất** dùng cho toàn bộ model hiện tại và tương lai.
   - Cung cấp cơ chế mở rộng không giới hạn thông qua danh sách **CRUD Custom OpenAI-Compatible Providers** cho phép Admin tự do tích hợp các nhà cung cấp AI mới (dùng cho TTS/LLM, không dùng cho STT) và phân quyền linh hoạt theo từng User.

---

## Clarifications

### Session 2026-11-23

- Q: Khi tạo phụ đề từ audio/video, người dùng chỉ phiên âm bằng Soniox hay còn chọn được Custom OpenAI Provider? → A: Chỉ Soniox; Custom Provider không dùng cho STT ở task này (chỉ phục vụ TTS/LLM).
- Q: Khi Admin xóa/tắt một Custom Provider lúc có job đang chờ/chạy dùng provider đó, xử lý thế nào? → A: Job đang chạy hoàn tất bình thường; job chưa bắt đầu chuyển `failed` kèm thông báo tiếng Việt "Nhà cung cấp đã bị xóa hoặc tắt".
- Q: Người dùng chọn ngôn ngữ của file hay để Soniox tự nhận diện? → A: Mặc định tự nhận diện; hộp thoại STT có ô tùy chọn "Ngôn ngữ gợi ý" (vi, en, ...) gửi sang Soniox làm language hint.
- Q: Mỗi lần phiên âm, file media được phép lớn và dài tối đa bao nhiêu? → A: Video ≤ 500 MB, audio ≤ 100 MB, thời lượng ≤ 60 phút mỗi file.
- Q: Người dùng nào được chạy STT bằng token Soniox chung và mỗi người được chạy bao nhiêu job cùng lúc? → A: Mọi User đã đăng nhập; tối đa 2 job STT đang chạy/chờ mỗi User, job thứ 3 bị từ chối kèm thông báo.

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Tải file Audio/Video lên và tạo file phụ đề .srt chuẩn xác (Priority: P1)

Người dùng vào một Project, chọn tính năng "Tạo phụ đề từ Audio/Video", tải lên một tệp âm thanh (ví dụ: `audio.mp3`) hoặc tệp video (ví dụ: `clip.mp4`). Hệ thống xử lý bóc tách âm thanh ngầm, gửi sang Soniox STT, nhận về danh sách từ kèm mốc thời gian, tự động định dạng thành tệp phụ đề chuẩn `.srt` với số thứ tự, mốc thời gian bắt đầu - kết thúc và nội dung câu. Khi hoàn tất, file `.srt` tự động xuất hiện trong danh sách kịch bản của Project.

**Why this priority**: Luồng nghiệp vụ cốt lõi (MVP) chuyển đổi media thành phụ đề.

**Independent Test**: Tải lên một tệp âm thanh tiếng Việt dài 1 phút; kiểm tra hệ thống trả về file `.srt` có các cue khớp với lời nói trong âm thanh, mở xem trước và đọc được đầy đủ các cue.

**Acceptance Scenarios**:
1. **Given** người dùng ở trang chi tiết Project, **When** mở hộp thoại STT và chọn file `.mp3` hoặc `.mp4`, **Then** hệ thống chấp nhận các định dạng media hợp lệ (`.mp3`, `.wav`, `.m4a`, `.aac`, `.flac`, `.ogg`, `.mp4`, `.mov`, `.mkv`, `.webm`) và kiểm tra giới hạn: video ≤ 500 MB, audio ≤ 100 MB, thời lượng ≤ 60 phút; file vượt giới hạn bị từ chối trước khi gửi sang Soniox.
2. **Given** hộp thoại STT đang mở, **When** người dùng không chọn ngôn ngữ, **Then** hệ thống để Soniox tự nhận diện ngôn ngữ; **When** người dùng chọn "Ngôn ngữ gợi ý" (ví dụ `vi`), **Then** ngôn ngữ đó được gửi sang Soniox làm language hint.
3. **Given** tệp video `.mp4`, **When** tiến trình bắt đầu, **Then** hệ thống sử dụng `ffmpeg` trích xuất luồng audio mono 16kHz không kèm video để giảm tối đa kích thước trước khi truyền tải lên Soniox.
4. **Given** audio đã được upload lên Soniox, **When** Soniox hoàn tất phiên âm, **Then** hệ thống nhận về mảng `tokens` và tự động gom nhóm thành các cue phụ đề có mốc thời gian chuẩn xác (`HH:MM:SS,mmm --> HH:MM:SS,mmm`).
5. **Given** file `.srt` được tạo thành công, **When** hoàn tất, **Then** file được lưu vào `subtitle_files` và `subtitle_cues`, hiển thị ngay lập tức trong danh sách kịch bản (khung bên trái) của Project.
6. **Given** file phụ đề vừa tạo từ STT, **When** người dùng bấm "Tạo voice", **Then** hệ thống nhận diện đây là file có mốc thời gian (`hasTimecodes: true`) và cho phép chạy chế độ khớp mốc thời gian phụ đề.

---

### User Story 2 - Tùy chọn định dạng xuất (.srt, .txt, .md) và nhận diện người nói (Priority: P2)

Người dùng có thể lựa chọn định dạng tệp đầu ra mong muốn:
- `.srt`: Phụ đề video với mốc thời gian chuẩn.
- `.txt`: Bản ghi văn bản thuần túy nối các câu nói liền mạch.
- `.md`: Tài liệu Markdown có cấu trúc, hiển thị phân đoạn người nói nếu bật tùy chọn *Speaker Diarization*.

**Why this priority**: Mở rộng tính hữu dụng cho nhiều mục đích: phụ đề video, ghi chú cuộc họp, bóc băng phỏng vấn.

**Independent Test**: Tải lên đoạn audio có 2 người đối thoại, chọn xuất `.md` kèm tùy chọn tách người nói; kiểm tra file markdown đầu ra có nhãn phân biệt `**Người nói 1**:`, `**Người nói 2**:`.

**Acceptance Scenarios**:
1. **Given** người dùng chọn định dạng `.txt`, **When** phiên âm hoàn tất, **Then** file kịch bản sinh ra có đuôi `.txt` chứa toàn bộ văn bản phiên âm được ngắt đoạn theo ngữ nghĩa câu.
2. **Given** người dùng bật tùy chọn "Phân biệt người nói" (Speaker Diarization) và chọn định dạng `.md`, **When** hoàn tất, **Then** file Markdown được định dạng với các đoạn hội thoại có tên người nói tương ứng, nhãn dạng `**Người nói 1**:`, `**Người nói 2**:` theo ngôn ngữ giao diện (bản tiếng Anh là `**Speaker 1**:`).

---

### User Story 3 - Theo dõi tiến trình phiên âm nền trực quan (Priority: P3)

Tiến trình STT được thực hiện bất đồng bộ qua hàng đợi nền `pg-boss`. Người dùng có thể rời trang hoặc đóng trình duyệt mà không làm mất tiến trình; khi quay lại, thanh tiến trình hiển thị rõ ràng từng giai đoạn.

**Why this priority**: Tuân thủ Nguyên tắc III trong Hiến pháp dự án (Tiến trình nền bền vững và quan sát được).

**Acceptance Scenarios**:
1. **Given** tiến trình STT đang chạy, **When** người dùng tải lại trang hoặc đổi thiết bị, **Then** trạng thái và thanh tiến trình tự động khôi phục đúng tiến độ thực tế.
2. **Given** sự cố mạng khi gọi Soniox hoặc file media bị lỗi không đọc được, **When** có lỗi, **Then** tiến trình chuyển trạng thái `failed` kèm thông báo lỗi tiếng Việt rõ ràng.

---

### User Story 4 - Admin cấu hình các AI Provider cốt lõi với 1 Token duy nhất (Priority: P1)

Quản trị viên truy cập trang **Cấu hình AI chung** (`/admin/ai-configs`), thiết lập 3 nhà cung cấp cố định:
- **FPT.AI**: Nhập 1 token duy nhất dùng cho toàn bộ model (VITs, TTS-pro, TTS-ultra và các model mở rộng sau này).
- **SONIOX**: Nhập 1 token duy nhất dùng cho toàn bộ model STT Async (`stt-async-v6`), Real-time (`stt-rt-v6`) và tính năng Translation sau này.
- **ShopAIKey**: Nhập 1 token duy nhất dùng cho toàn bộ model OpenAI, Minimax và các model mở rộng khác.

**Why this priority**: Đơn giản hóa quản trị khóa API, tránh việc mỗi model phải nhập 1 khóa rời rạc gây khó khăn bảo trì.

**Independent Test**: Cấu hình token FPT.AI và Soniox; bấm "Kiểm tra kết nối" nhận phản hồi thành công; chạy tạo voice FPT và chạy STT Soniox đều sử dụng đúng token tương ứng.

**Acceptance Scenarios**:
1. **Given** Admin ở tab FPT.AI, **When** nhập 1 API Key và lưu, **Then** mọi model FPT đều sử dụng chung khóa này.
2. **Given** Admin ở tab SONIOX, **When** nhập 1 API Key, **Then** hệ thống cho phép chọn model STT mặc định (mặc định chọn `stt-async-v6`) và kiểm tra kết nối với Soniox API.
3. **Given** Admin ở tab ShopAIKey, **When** nhập 1 API Key, **Then** mọi model OpenAI/Minimax đăng ký đều hoạt động với khóa này.

---

### User Story 5 - Admin quản lý CRUD Custom AI Providers chuẩn OpenAI & Phân quyền User (Priority: P2)

Quản trị viên có thể thêm **nhiều nhà cung cấp AI chuẩn OpenAI** vào hệ thống (DeepSeek, Groq, Together, OpenAI Official, Local LLM,...), quản lý danh sách (Thêm, Sửa, Xóa, Bật/Tắt) và thiết lập phạm vi phân quyền:
- **Công khai (Public)**: Mọi User trong hệ thống đều được dùng.
- **Chỉ định User (Restricted)**: Chỉ một hoặc nhiều User được Admin chọn mới thấy và dùng được provider này.
- **Chỉ Admin (Private)**: Chỉ Administrator dùng.
Đồng thời, User có cờ `canUseCustomAi = true` có thể cấu hình AI Provider chuẩn OpenAI của riêng mình tại `/settings/ai`.

**Why this priority**: Cho phép hệ thống mở rộng linh hoạt với mọi nhà cung cấp AI mới trên thế giới theo chuẩn OpenAI mà không cần thay đổi mã nguồn.

**Independent Test**: Admin tạo Custom Provider "DeepSeek" với quyền "Chỉ định User A"; đăng nhập tài khoản User A thấy provider này; đăng nhập User B không thấy provider này.

**Acceptance Scenarios**:
1. **Given** Admin ở tab "Nhà cung cấp OpenAI tùy chỉnh", **When** bấm "Thêm Provider", **Then** mở biểu mẫu nhập Tên, Base URL, API Key, Danh sách Models và Phạm vi phân quyền.
2. **Given** Custom Provider được đặt chế độ "Công khai", **When** bất kỳ User nào tạo Project hoặc Voice, **Then** provider này xuất hiện trong danh sách lựa chọn (Custom Provider không xuất hiện ở lựa chọn engine STT — STT chỉ dùng Soniox).
3. **Given** Custom Provider được đặt chế độ "Chỉ định User", **When** Admin chọn User A, **Then** chỉ User A thấy provider này, các User khác không thấy.
4. **Given** Admin xóa một Custom Provider, **When** xác nhận, **Then** provider bị xóa khỏi danh sách; các Job đang chạy dùng provider này hoàn tất bình thường, các Job chưa bắt đầu chuyển sang `failed` kèm thông báo tiếng Việt "Nhà cung cấp đã bị xóa hoặc tắt".
5. **Given** User được cấp quyền cấu hình AI riêng, **When** vào `/settings/ai`, **Then** có thể nhập cấu hình AI chuẩn OpenAI riêng của mình.

---

## Edge Cases

- **Tệp video không có luồng âm thanh**: FFmpeg phát hiện không có audio track -> Báo lỗi sớm: "Tệp video không chứa âm thanh để chuyển thành văn bản".
- **File vượt giới hạn dung lượng**: Bị từ chối ngay khi tải lên (413) với thông báo nêu rõ giới hạn bị vượt.
- **File dài hơn 60 phút**: File được nhận và tạo job, nhưng worker đo thời lượng trước khi gửi Soniox và chuyển job sang `failed` với thông báo "Tệp dài hơn 60 phút, vui lòng cắt ngắn trước khi phiên âm"; không phát sinh chi phí Soniox.
- **User đã có 2 job STT đang chờ/đang chạy**: Yêu cầu tạo job thứ 3 bị từ chối ngay với thông báo "Bạn đang có 2 tiến trình phiên âm, vui lòng đợi hoàn tất trước khi tạo thêm".
- **File âm thanh hoàn toàn im lặng hoặc chỉ có tiếng ồn**: Soniox trả về văn bản rỗng -> Thông báo: "Không phát hiện giọng nói rõ ràng trong tệp media".
- **Worker khởi động lại giữa chừng**: Job đang chạy chuyển `interrupted` và tự xếp hàng lại; người dùng thấy trạng thái "Bị gián đoạn, đang chạy lại".
- **Custom Provider bị lỗi kết nối hoặc sai API Key**: Nút "Kiểm tra kết nối" báo lỗi cụ thể (mã HTTP, thông điệp phản hồi từ server nhà cung cấp) để Admin điều chỉnh ngay.
- **Custom Provider bị xóa hoặc tắt khi còn Job liên quan**: Job đang chạy hoàn tất bình thường; Job chưa bắt đầu chuyển `failed` với thông báo "Nhà cung cấp đã bị xóa hoặc tắt".
- **Voice job đang chạy bị gián đoạn sau khi provider của nó bị xóa hoặc tắt**: Khi được chạy lại, job chuyển `failed` với cùng thông báo "Nhà cung cấp đã bị xóa hoặc tắt" (phần đã xong được giữ lại).
- **Project hoặc User bị xóa khi STT job đang chạy**: Worker phát hiện job không còn, dừng xử lý, xóa file media tạm của job và xóa file/bản phiên âm đã gửi lên Soniox.
- **User bị xóa khỏi danh sách chỉ định của một Custom Provider**: Các tiến trình đang chạy của User đó hoàn tất bình thường; nếu một tiến trình bị gián đoạn rồi chạy lại thì chuyển `failed` với thông báo "Bạn không còn quyền dùng nhà cung cấp này" (phần đã xong được giữ lại); tiến trình chưa bắt đầu cũng chuyển `failed` với cùng thông báo; các lần tạo mới tiếp theo không còn thấy provider này.

---

## Functional Requirements (FR)

- **FR-001**: Hệ thống MUST hỗ trợ tải lên các tệp âm thanh (`.mp3`, `.wav`, `.m4a`, `.aac`, `.flac`, `.ogg`) và video (`.mp4`, `.mov`, `.mkv`, `.webm`), với giới hạn video ≤ 500 MB, audio ≤ 100 MB và thời lượng ≤ 60 phút mỗi file; file vượt giới hạn MUST bị từ chối trước khi gửi sang Soniox. File media tạm không tính vào hạn mức lưu trữ của User: file chỉ nằm trên MinIO đến khi job kết thúc (hoàn tất hoặc lỗi) rồi bị xóa; chỉ file kịch bản kết quả mới tính vào hạn mức.
- **FR-002**: Hệ thống MUST sử dụng FFmpeg trích xuất luồng âm thanh (16kHz mono) từ tệp video trước khi gửi sang Soniox STT.
- **FR-003**: Hệ thống MUST tích hợp Soniox REST API (Upload File, Start Transcription, Poll Status, Get Transcript) sử dụng API Key bảo mật. Soniox là engine STT duy nhất của tính năng này; Custom OpenAI Provider không được dùng cho STT.
- **FR-004**: Hệ thống MUST gom nhóm tokens từ Soniox thành các cue phụ đề `.srt` hợp lệ theo quy chuẩn (tối đa 75 ký tự/cue, thời lượng cue 1,2–5,5 giây, ngắt theo dấu câu hoặc khi khoảng lặng giữa hai từ $\ge 380\text{ ms}$).
- **FR-005**: File phụ đề tạo ra MUST được lưu vào `subtitle_files` và `subtitle_cues`, hiển thị trực tiếp trong danh sách kịch bản của Project.
- **FR-006**: Tiến trình STT MUST chạy ngầm qua `pg-boss`, cập nhật tiến độ theo thời gian thực và tự động dọn dẹp file media tạm sau khi hoàn tất.
- **FR-007**: Hệ thống MUST lưu trữ và bảo vệ khóa API bằng mã hóa AES-256-GCM ở máy chủ, không lộ ra client.
- **FR-008**: Trang Cấu hình AI chung của Admin MUST hỗ trợ FPT.AI với 1 token duy nhất dùng cho toàn bộ model FPT.
- **FR-009**: Trang Cấu hình AI chung của Admin MUST hỗ trợ SONIOX với 1 token duy nhất dùng cho tất cả các model Async STT, Real-time STT và Translation.
- **FR-010**: Mặc định model STT của Soniox trong task này là `stt-async-v6`, có dropdown cho phép chọn các model khác (`stt-async-v5` kèm nhãn "Bản cũ", tự nhập model). Model mặc định dùng cho tạo phụ đề MUST là model async; `stt-rt-v6` hiển thị trong danh sách nhưng không chọn được làm mặc định cho đến khi có tính năng real-time.
- **FR-011**: Trang Cấu hình AI chung của Admin MUST hỗ trợ ShopAIKey với 1 token duy nhất dùng cho tất cả model đã đăng ký.
- **FR-012**: Admin MUST có quyền tạo, xem, cập nhật, xóa (CRUD) nhiều Custom AI Provider chuẩn OpenAI.
- **FR-013**: Admin MUST có thể thiết lập quyền sử dụng Custom Provider theo 3 chế độ: Công khai (mọi User), Chỉ định User (danh sách User cụ thể), hoặc Chỉ Admin.
- **FR-014**: Hệ thống MUST lọc danh sách nhà cung cấp khả dụng cho từng User dựa trên quyền hạn và cấu hình phân quyền của Admin.
- **FR-015**: User có cờ `canUseCustomAi = true` MUST có thể cấu hình AI Provider chuẩn OpenAI của riêng mình tại `/settings/ai`.
- **FR-016**: Hộp thoại STT MUST mặc định để Soniox tự nhận diện ngôn ngữ và MUST cung cấp ô tùy chọn "Ngôn ngữ gợi ý" (vi, en, ...); khi người dùng chọn, giá trị được gửi sang Soniox làm language hint.
- **FR-017**: Mọi User đã đăng nhập MUST được dùng STT (qua token Soniox chung của Admin); hệ thống MUST giới hạn tối đa 2 job STT ở trạng thái đang chờ/đang chạy cho mỗi User (cài đặt hệ thống `maxSttJobsPerUser`, mặc định 2, Admin chỉnh được) và từ chối yêu cầu vượt giới hạn với thông báo tiếng Việt rõ ràng.
- **FR-018**: Mỗi lần phiên âm hoàn tất MUST ghi đúng 1 bản ghi sử dụng tính phí gồm User, Project, STT job, `provider_type = soniox`, model, số giây âm thanh và chi phí ước tính (lấy đơn giá từ cấu hình Soniox, không hard-code). Mỗi lần gọi Soniox thất bại MUST ghi 1 bản ghi `ok = false` với chi phí 0. Upload file và các lần poll trạng thái không ghi bản ghi sử dụng.
- **FR-019**: Lỗi tạm thời từ Soniox (mạng, 429, 5xx) MUST được thử lại tối đa 3 lần với backoff tăng dần; lỗi vĩnh viễn (401, 403, file hỏng) MUST NOT được thử lại. Khi worker khởi động lại lúc job đang chạy, job MUST chuyển `interrupted` rồi được xếp hàng lại; job đã có `soniox_transcription_id` tiếp tục poll thay vì upload lại.
- **FR-020**: Mỗi STT job MUST có nhật ký chi tiết được lưu lại (mỗi lần đổi giai đoạn, mỗi lần thử lại, mỗi lỗi), xem được trong hộp thoại STT; nhật ký MUST NOT chứa khóa API hoặc URL có khóa.
- **FR-021**: Xóa Project hoặc User MUST xóa sạch các STT job, nhật ký và file media tạm liên quan; bản ghi sử dụng được giữ lại ở dạng ẩn danh. File audio đã upload và bản phiên âm trên Soniox MUST được xóa khi job kết thúc (hoàn tất hoặc lỗi) và khi Project/User bị xóa; lỗi khi xóa trên Soniox được ghi nhật ký nhưng không làm job thất bại.
- **FR-022**: Custom Provider mà User được quyền dùng MUST chọn được khi tạo Voice và MUST được dùng thật để tạo audio. Quyền truy cập và trạng thái bật của provider MUST được kiểm tra lại ở máy chủ khi worker bắt đầu chạy job.

---

## Success Criteria (SC)

- **SC-001**: File `.srt` sinh ra có mốc thời gian khớp với âm thanh gốc trong sai số $\le 200\text{ ms}$.
- **SC-002**: Tệp video 10 phút trích xuất âm thanh trong dưới 5 giây và hoàn tất toàn bộ quy trình STT trong dưới 45 giây.
- **SC-003**: Admin chỉ cần nhập 1 token duy nhất cho FPT.AI, 1 token duy nhất cho Soniox, 1 token duy nhất cho ShopAIKey.
- **SC-004**: Admin có thể tạo không giới hạn Custom AI Provider chuẩn OpenAI và phân quyền chính xác theo từng User.
