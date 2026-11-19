/**
 * Kiểm tra Nguyên tắc VI: không có chuỗi tiếng Việt cứng trong thành phần giao diện (src/app, src/components).
 * Mọi chuỗi hiển thị phải nằm trong src/lib/i18n/vi.ts. Route Handler (src/app/api) trả thông báo lỗi tiếng Việt
 * từ máy chủ nên không thuộc phạm vi này. Chạy: `npm run check:i18n` (có trong CI).
 * Bỏ qua chú thích. Thoát mã 1 nếu có vi phạm.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOTS = ['src/app', 'src/components'];
const EXT = new Set(['.ts', '.tsx']);
// Ký tự có dấu đặc trưng của tiếng Việt (loại trừ chữ Latin có dấu dùng chung với ngôn ngữ khác)
const VI = /[ăâđêôơưĂÂĐÊÔƠƯàáạảãằắặẳẵầấậẩẫèéẹẻẽềếệểễìíịỉĩòóọỏõồốộổỗờớợởỡùúụủũừứựửữỳýỵỷỹ]/i;

function* walk(dir: string): Generator<string> {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (full.split(path.sep).join('/') === 'src/app/api') continue;
      yield* walk(full);
    }
    else if (EXT.has(path.extname(ent.name))) yield full;
  }
}

function stripComments(src: string): string {
  // Giữ nguyên số dòng: thay nội dung chú thích bằng khoảng trắng/xuống dòng
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, p1: string) => p1 + ' '.repeat(m.length - p1.length));
}

const violations: string[] = [];
for (const root of ROOTS) {
  if (!fs.existsSync(root)) continue;
  for (const file of walk(root)) {
    const lines = stripComments(fs.readFileSync(file, 'utf8')).split('\n');
    lines.forEach((line, i) => {
      if (VI.test(line)) violations.push(`${file.split(path.sep).join('/')}:${i + 1}: ${line.trim().slice(0, 100)}`);
    });
  }
}

if (violations.length > 0) {
  console.error(`Có ${violations.length} chuỗi tiếng Việt cứng trong giao diện (hãy chuyển vào src/lib/i18n/vi.ts):`);
  for (const v of violations) console.error('  ' + v);
  process.exit(1);
}
console.log('check:i18n — không có chuỗi tiếng Việt cứng trong giao diện.');
