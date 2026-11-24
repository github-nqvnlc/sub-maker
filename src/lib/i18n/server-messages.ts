import { en } from './en';
import { vi } from './vi';
import type { Locale } from './locale';

/**
 * Dịch THÔNG BÁO DO MÁY CHỦ trả về (lỗi API, trường lỗi của biểu mẫu, lỗi tiến trình đã lưu) sang ngôn ngữ khác (spec 003, FR-022).
 * Nguồn thông báo là tiếng Việt (mã lỗi `code` không đổi theo ngôn ngữ); bảng dưới ánh xạ câu tiếng Việt → câu tương ứng:
 *  - tự động: mọi câu trong `vi.errors` / `vi.validation` ↔ cùng khóa của từ điển ngôn ngữ đích;
 *  - thủ công: các câu viết trực tiếp ở dịch vụ/route (khớp nguyên văn, hoặc mẫu có tham số).
 * `scripts/check-i18n.ts` kiểm tra mọi câu tiếng Việt trong lời gọi tạo lỗi đều có mục ở đây.
 */
type Rule = [match: string | RegExp, to: string];

const EN_RULES: Rule[] = [
  // ---- src/lib/api, route ----
  ['Nội dung gửi lên phải là JSON hợp lệ', 'The request body must be valid JSON'],
  ['Trang hoặc kích thước trang không hợp lệ', 'Invalid page or page size'],
  ['Không có thay đổi nào', 'There are no changes'],
  ['Thiếu xác nhận', 'Confirmation is missing'],
  // ---- jobs ----
  ['Dự án sử dụng nhà cung cấp SONIOX (STT), không hỗ trợ tạo voice.', 'The project uses SONIOX (STT) provider, voice generation is not supported.'],
  ['Chỉ tiếp tục được tiến trình đã dừng, bị lỗi hoặc bị gián đoạn.', 'Only a job that is stopped, failed or interrupted can be resumed.'],
  ['Trạng thái tiến trình vừa thay đổi, hãy tải lại trang.', 'The job state has just changed. Please reload the page.'],
  [
    'Chỉ sửa được thiết lập khi tiến trình đã dừng, bị lỗi hoặc bị gián đoạn (hãy dừng trước). Với tiến trình đã hoàn tất, hãy chạy lại với thiết lập mới.',
    'Settings can only be edited while the job is stopped, failed or interrupted (stop it first). For a completed job, run it again with new settings.',
  ],
  ['Tệp không có cue nào đọc được.', 'The file has no readable cues.'],
  ['Không đưa được tiến trình vào hàng đợi. Hãy thử lại sau.', 'The job could not be queued. Please try again later.'],
  ['Hệ thống tạm thời chưa nhận được việc mới. Hãy thử lại sau ít phút.', 'The system cannot accept new work right now. Please try again in a few minutes.'],
  ['Trạng thái không hợp lệ', 'Invalid status'],
  ['Tiến trình đang chờ hoặc đang chạy. Hãy dừng trước khi xóa.', 'The job is queued or running. Stop it before deleting.'],
  ['Tiến trình của Project đang dừng, hãy thử lại sau ít giây.', "The Project's jobs are still stopping. Please try again in a few seconds."],
  [/^File đang được dùng bởi (\d+) tiến trình\/voice\. Hãy xóa các tiến trình đó trước\.$/, 'The file is used by $1 jobs/voices. Delete those jobs first.'],
  // ---- script files (parsing/detect) ----
  ['Tệp không phải mã hóa UTF-8 (có vẻ là UTF-16). Hãy lưu lại tệp ở dạng UTF-8 rồi tải lên.', 'The file is not UTF-8 encoded (it looks like UTF-16). Save it as UTF-8 and upload it again.'],
  ['Tệp có vẻ là dữ liệu nhị phân, không phải văn bản. Chỉ hỗ trợ tệp văn bản .txt, .md hoặc .srt.', 'The file looks like binary data, not text. Only .txt, .md or .srt text files are supported.'],
  ['Tệp không phải mã hóa UTF-8 hợp lệ. Hãy lưu lại tệp ở dạng UTF-8 rồi tải lên.', 'The file is not valid UTF-8. Save it as UTF-8 and upload it again.'],
  ['Định dạng không được hỗ trợ. Chỉ nhận tệp .txt, .md hoặc .srt.', 'Unsupported format. Only .txt, .md or .srt files are accepted.'],
  ['Tệp rỗng.', 'The file is empty.'],
  [/^Tệp lớn hơn ([\d.,]+) MB cho phép\.$/, 'The file is larger than the allowed $1 MB.'],
  ['Tệp không có nội dung đọc được (sau khi bỏ ký hiệu định dạng, mốc thời gian, emoji và liên kết).', 'The file has no readable content (after removing formatting, timecodes, emoji and links).'],
  ['Tệp vượt quá kích thước cho phép.', 'The file is larger than allowed.'],
  ['Cần gửi tệp dạng multipart.', 'The file must be sent as multipart form data.'],
  ['Thiếu tệp kịch bản.', 'The script file is missing.'],
  // ---- avatar / account ----
  ['Tệp ảnh rỗng', 'The image file is empty'],
  ['Ảnh đại diện tối đa 1 MB', 'The avatar can be at most 1 MB'],
  ['Chỉ chấp nhận ảnh PNG, JPEG hoặc WebP', 'Only PNG, JPEG or WebP images are accepted'],
  ['Cần gửi tệp ảnh dạng multipart', 'The image must be sent as multipart form data'],
  ['Thiếu tệp ảnh', 'The image file is missing'],
  ['Mật khẩu hiện tại không đúng', 'The current password is incorrect'],
  ['Không thể thao tác lên tài khoản Administrator.', 'This action cannot be applied to an Administrator account.'],
  ['Tài khoản đang được xóa.', 'The account is being deleted.'],
  ['Cần nhập đúng email của tài khoản để xác nhận xóa', "Enter the account's exact email to confirm deletion"],
  // ---- providers / catalog / settings ----
  ['Model không được hỗ trợ cho nhà cung cấp này', 'This model is not supported by this provider'],
  ['Giọng đọc không có trong model đã chọn', 'This voice is not available in the selected model'],
  ['Giọng đọc không có trong danh mục', 'This voice is not in the catalog'],
  [/^Tốc độ phải từ ([\d.,]+) đến ([\d.,]+)$/, 'Speed must be between $1 and $2'],
  [/^Tối đa (\d+) ký tự mỗi yêu cầu$/, 'At most $1 characters per request'],
  ['Địa chỉ gốc không hợp lệ hoặc không được phép (cần https, không trỏ về mạng nội bộ).', 'The base URL is invalid or not allowed (https is required and it must not point to an internal network).'],
  ['Cần nhập khóa API khi tạo cấu hình', 'An API key is required when creating the settings'],
  ['Nhà cung cấp đang quá tải hoặc không phản hồi.', 'The provider is overloaded or not responding.'],
  ['Khóa API không hợp lệ. Hãy kiểm tra lại cấu hình nhà cung cấp.', 'The API key is invalid. Please check the provider settings.'],
  ['Tài khoản nhà cung cấp đã hết hạn mức hoặc số dư.', 'The provider account has run out of quota or balance.'],
  ['Cấu hình chưa được cấp quyền dùng model hoặc giọng đọc này.', 'The settings are not allowed to use this model or voice.'],
  ['Giọng đọc không hợp lệ cho model đã chọn.', 'This voice is not valid for the selected model.'],
  ['Nội dung bị nhà cung cấp từ chối theo chính sách an toàn.', "The content was rejected by the provider's safety policy."],
  ['Yêu cầu không được nhà cung cấp chấp nhận.', 'The request was not accepted by the provider.'],
  ['Địa chỉ nhà cung cấp không được phép. Hãy kiểm tra lại địa chỉ gốc.', 'The provider address is not allowed. Please check the base URL.'],
  ['Kết nối thành công.', 'Connected successfully.'],
  // ---- usage ----
  ['Ngày không hợp lệ (định dạng YYYY-MM-DD)', 'Invalid date (use YYYY-MM-DD)'],
  ['Ngày không hợp lệ', 'Invalid date'],
  ['Ngày bắt đầu phải trước hoặc bằng ngày kết thúc', 'The start date must be on or before the end date'],
  [/^Khoảng thời gian tối đa (\d+) ngày$/, 'The date range can be at most $1 days'],
  // ---- spec 004: STT, Soniox, Custom Provider ----
  ['Thiếu tệp âm thanh hoặc video.', 'The audio or video file is missing.'],
  ['Model real-time không dùng được để tạo phụ đề. Hãy chọn model async.', 'Real-time models cannot create subtitles. Choose an async model.'],
  [
    'Nhà cung cấp chuẩn OpenAI dùng chung được quản lý ở mục Nhà cung cấp OpenAI tùy chỉnh.',
    'Shared OpenAI-compatible providers are managed under Custom OpenAI providers.',
  ],
  ['Chỉ Project dùng nhà cung cấp chuẩn OpenAI mới chọn được nhà cung cấp tùy chỉnh.', 'Only a Project that uses an OpenAI-compatible provider can choose a custom provider.'],
];

const rulesFor: Partial<Record<Locale, Rule[]>> = { en: EN_RULES };

/** Ánh xạ tự động: câu tiếng Việt của vi.errors/vi.validation → câu cùng khóa của từ điển đích. */
function autoMap(dict: typeof en): Map<string, string> {
  const m = new Map<string, string>();
  for (const section of ['errors', 'validation'] as const) {
    for (const key of Object.keys(vi[section]) as Array<keyof (typeof vi)[typeof section]>) {
      m.set(vi[section][key] as string, (dict[section] as Record<string, string>)[key as string]!);
    }
  }
  return m;
}
const AUTO: Partial<Record<Locale, Map<string, string>>> = { en: autoMap(en) };

/** Dịch một thông báo máy chủ sang `locale`; tiếng Việt hoặc câu chưa có trong bảng → giữ nguyên. */
export function translateMessage(locale: Locale, message: string): string {
  if (locale === 'vi' || !message) return message;
  const auto = AUTO[locale]?.get(message);
  if (auto) return auto;
  for (const [match, to] of rulesFor[locale] ?? []) {
    if (typeof match === 'string') {
      if (match === message) return to;
    } else {
      const m = match.exec(message);
      if (m) return message.replace(match, to);
    }
  }
  return message;
}

export function translateFields(locale: Locale, fields: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!fields || locale === 'vi') return fields;
  return Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, translateMessage(locale, v)]));
}

/** Các câu thủ công cho một ngôn ngữ (dùng cho kiểm tra phủ trong test/script). */
export const manualRules = (locale: Locale): Rule[] => rulesFor[locale] ?? [];
