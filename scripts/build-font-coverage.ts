/**
 * Sinh `public/fonts/overlay/coverage.json`: các khoảng mã ký tự mà từng phông chữ của video overlay hỗ trợ (spec 005, R9).
 * Đọc thẳng bảng `cmap` của TTF (định dạng 4 và 12), không cần phụ thuộc. Thoát mã 1 nếu phông chữ nào thiếu chữ tiếng Việt.
 * Chạy: `npx tsx scripts/build-font-coverage.ts`
 */
import fs from 'node:fs';
import path from 'node:path';
import { VIETNAMESE_CHARS } from '../src/lib/overlay/fonts';

const DIR = path.resolve(process.cwd(), 'public/fonts/overlay');

/** Các mã ký tự có glyph khác 0 trong TTF. */
export function codepointsOf(ttf: Buffer): Set<number> {
  const numTables = ttf.readUInt16BE(4);
  let cmap = -1;
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    if (ttf.toString('latin1', rec, rec + 4) === 'cmap') cmap = ttf.readUInt32BE(rec + 8);
  }
  if (cmap < 0) throw new Error('Không có bảng cmap');
  const out = new Set<number>();
  const n = ttf.readUInt16BE(cmap + 2);
  for (let i = 0; i < n; i++) {
    const rec = cmap + 4 + i * 8;
    const platform = ttf.readUInt16BE(rec);
    const encoding = ttf.readUInt16BE(rec + 2);
    // Chỉ các bảng Unicode: nền tảng 0, hoặc 3 (Windows) với mã 1/10
    if (!(platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10)))) continue;
    const sub = cmap + ttf.readUInt32BE(rec + 4);
    const format = ttf.readUInt16BE(sub);
    if (format === 4) {
      const segX2 = ttf.readUInt16BE(sub + 6);
      const endAt = sub + 14;
      const startAt = endAt + segX2 + 2;
      const deltaAt = startAt + segX2;
      const rangeAt = deltaAt + segX2;
      for (let s = 0; s < segX2; s += 2) {
        const end = ttf.readUInt16BE(endAt + s);
        const start = ttf.readUInt16BE(startAt + s);
        const delta = ttf.readUInt16BE(deltaAt + s);
        const range = ttf.readUInt16BE(rangeAt + s);
        for (let c = start; c <= end && c < 0xffff; c++) {
          let g: number;
          if (range === 0) g = (c + delta) & 0xffff;
          else {
            const at = rangeAt + s + range + (c - start) * 2;
            const raw = at + 1 < ttf.length ? ttf.readUInt16BE(at) : 0;
            g = raw === 0 ? 0 : (raw + delta) & 0xffff;
          }
          if (g !== 0) out.add(c);
        }
      }
    } else if (format === 12) {
      const groups = ttf.readUInt32BE(sub + 12);
      for (let k = 0; k < groups; k++) {
        const g = sub + 16 + k * 12;
        const start = ttf.readUInt32BE(g);
        const end = ttf.readUInt32BE(g + 4);
        for (let c = start; c <= end; c++) out.add(c);
      }
    }
  }
  return out;
}

function toRanges(set: Set<number>): Array<[number, number]> {
  const sorted = [...set].sort((a, b) => a - b);
  const ranges: Array<[number, number]> = [];
  for (const c of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && c === last[1] + 1) last[1] = c;
    else ranges.push([c, c]);
  }
  return ranges;
}

const result: Record<string, Record<string, Array<[number, number]>>> = {};
let failed = false;
for (const file of fs.readdirSync(DIR).filter((f) => f.endsWith('.ttf')).sort()) {
  const m = /^(.+)-(\d{3})\.ttf$/.exec(file);
  if (!m) throw new Error(`Tên tệp phông chữ không hợp lệ: ${file}`);
  const set = codepointsOf(fs.readFileSync(path.join(DIR, file)));
  const missing = [...VIETNAMESE_CHARS].filter((ch) => !set.has(ch.codePointAt(0)!));
  if (missing.length > 0) {
    failed = true;
    console.error(`${file}: thiếu ${missing.length} ký tự tiếng Việt: ${missing.slice(0, 20).join(' ')}`);
  }
  (result[m[1]!] ??= {})[m[2]!] = toRanges(set);
  console.log(`${file}: ${set.size} ký tự`);
}
if (failed) process.exit(1);
fs.writeFileSync(path.join(DIR, 'coverage.json'), `${JSON.stringify(result)}\n`);
console.log('Đã ghi public/fonts/overlay/coverage.json');
