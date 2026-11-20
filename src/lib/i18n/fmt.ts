/** Thay giữ chỗ `{name}` trong chuỗi giao diện bằng giá trị tương ứng; giữ nguyên giữ chỗ nếu thiếu giá trị. */
export function fmt(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, key: string) => (key in values ? String(values[key]) : m));
}
