import type { vi } from './vi';

/** Biến mọi chuỗi literal (`as const`) của từ điển tiếng Việt thành `string` để các ngôn ngữ khác khai báo cùng cấu trúc. */
type Widen<T> = T extends string ? string : { -readonly [K in keyof T]: Widen<T[K]> };

/**
 * Cấu trúc từ điển chung. `en.ts` khai báo `const en: Dict` nên THIẾU hoặc THỪA khóa so với tiếng Việt là lỗi biên dịch
 * (FR-023); thêm ngôn ngữ mới cũng chỉ cần một tệp khai báo `Dict`.
 */
export type Dict = Widen<typeof vi>;
