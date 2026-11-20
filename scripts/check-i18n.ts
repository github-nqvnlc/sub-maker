/**
 * Kiểm tra Nguyên tắc VI: không có chuỗi tiếng Việt cứng trong thành phần giao diện (src/app, src/components).
 * Mọi chuỗi hiển thị phải nằm trong src/lib/i18n/vi.ts. Route Handler (src/app/api) trả thông báo lỗi tiếng Việt
 * từ máy chủ nên không thuộc phạm vi này. Chạy: `npm run check:i18n` (có trong CI).
 * Bỏ qua chú thích. Thoát mã 1 nếu có vi phạm.
 */
import fs from 'node:fs';
import path from 'node:path';
import { en } from '../src/lib/i18n/en';
import { vi } from '../src/lib/i18n/vi';

const ROOTS = ['src/app', 'src/components'];
const EXT = new Set(['.ts', '.tsx']);
// Ký tự có dấu đặc trưng của tiếng Việt (loại trừ chữ Latin có dấu dùng chung với ngôn ngữ khác)
const VI = /[ăâđêôơưĂÂĐÊÔƠƯàáạảãằắặẳẵầấậẩẫèéẹẻẽềếệểễìíịỉĩòóọỏõồốộổỗờớợởỡùúụủũừứựửữỳýỵỷỹ]/i;

function* walk(dir: string): Generator<string> {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      // src/app/api: thông báo lỗi do máy chủ trả; src/app/(dev): trang kiểm thử nội bộ (chỉ E2E/dev), không thuộc giao diện người dùng
      const rel = full.split(path.sep).join('/');
      if (rel === 'src/app/api' || rel === 'src/app/(dev)') continue;
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

// ---- Đa ngôn ngữ (spec 003, FR-023): từ điển vi/en đủ khóa, không rỗng, cùng giữ chỗ; giao diện không nhập vi trực tiếp ----
function leaves(obj: unknown, prefix = ''): Array<[string, string]> {
  if (typeof obj === 'string') return [[prefix, obj]];
  if (obj && typeof obj === 'object') return Object.entries(obj).flatMap(([k, v]) => leaves(v, prefix ? `${prefix}.${k}` : k));
  return [];
}
const holders = (v: string) => [...v.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort().join(',');
const viLeaves = new Map(leaves(vi));
const enLeaves = new Map(leaves(en));
for (const [k, v] of viLeaves) {
  const e = enLeaves.get(k);
  if (e === undefined) violations.push(`Thiếu khóa ở en.ts: ${k}`);
  else if (e.trim() === '') violations.push(`Chuỗi rỗng ở en.ts: ${k}`);
  else if (holders(v) !== holders(e)) violations.push(`Giữ chỗ khác nhau giữa vi và en: ${k} (${holders(v)} ≠ ${holders(e)})`);
}
for (const k of enLeaves.keys()) if (!viLeaves.has(k)) violations.push(`Thừa khóa ở en.ts (không có ở vi.ts): ${k}`);

const IMPORT_VI = /from\s+['"]@\/lib\/i18n\/vi['"]/;
for (const root of ROOTS) {
  if (!fs.existsSync(root)) continue;
  for (const file of walk(root)) {
    const src = fs.readFileSync(file, 'utf8');
    if (IMPORT_VI.test(src)) violations.push(`${file.split(path.sep).join('/')}: nhập trực tiếp '@/lib/i18n/vi' — dùng useT()/getT() để theo ngôn ngữ người dùng chọn`);
  }
}

if (violations.length > 0) {
  console.error(`Có ${violations.length} vi phạm i18n (chuỗi tiếng Việt cứng trong giao diện, từ điển lệch nhau hoặc nhập vi trực tiếp):`);
  for (const v of violations) console.error('  ' + v);
  process.exit(1);
}
console.log('check:i18n — không có chuỗi tiếng Việt cứng trong giao diện.');
