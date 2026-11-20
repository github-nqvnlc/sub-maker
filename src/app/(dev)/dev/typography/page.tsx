/* eslint-disable no-restricted-syntax -- trang kiểm thử nội bộ (chỉ E2E/dev), không thuộc giao diện người dùng */
import { notFound } from 'next/navigation';

export const dynamic = 'force-dynamic';

/** Trang kiểm thử chữ (spec 003, US5): chỉ bật ngoài production hoặc khi chạy E2E (E2E_MODE=1); production thật trả 404. */
const BASES = ['a', 'ă', 'â', 'e', 'ê', 'i', 'o', 'ô', 'ơ', 'u', 'ư', 'y'];
/** Huyền, hỏi, ngã, sắc, nặng (dấu kết hợp U+0300, U+0309, U+0303, U+0301, U+0323). */
const TONES = [0x0300, 0x0309, 0x0303, 0x0301, 0x0323].map((c) => String.fromCharCode(c));

function lowercaseSet(): string[] {
  const out = new Set<string>(['đ', ...BASES]);
  for (const b of BASES) for (const t of TONES) out.add((b + t).normalize('NFC'));
  return [...out];
}

export default function TypographyPage() {
  if (process.env.NODE_ENV === 'production' && process.env.E2E_MODE !== '1') notFound();
  const lower = lowercaseSet();
  const upper = lower.map((c) => c.toLocaleUpperCase('vi'));
  const sizes = [12, 14, 16, 20, 24, 32];
  const weights = [400, 500, 600, 700];
  return (
    <main className="mx-auto max-w-4xl space-y-8 p-6">
      <h1 className="text-2xl font-semibold">Kiểm thử chữ tiếng Việt</h1>
      <p className="text-sm text-muted-foreground">Mọi chữ cái tiếng Việt (hoa, thường, đủ dấu) phải lấy từ font chính, dấu không bị cắt.</p>

      <section aria-label="Chữ có dấu chồng" className="space-y-2">
        <h2 className="text-lg font-semibold">Ệ Ữ Ẳ Ỗ Ợ Ẫ</h2>
        <button type="button" className="rounded-md border px-3 py-2 text-sm font-medium">
          Ệ Ữ Ẳ Ỗ
        </button>
        <input aria-label="Ô nhập thử" defaultValue="Ệ Ữ Ẳ Ỗ" className="block h-9 w-48 rounded-lg border border-field-border bg-transparent px-2.5 text-sm" />
      </section>

      <section aria-label="Bảng chữ cái" className="space-y-4">
        {weights.map((w) => (
          <div key={w} data-weight={w} style={{ fontWeight: w }} className="space-y-1">
            <p className="text-xs text-muted-foreground">Độ đậm {w}</p>
            {sizes.map((s) => (
              <p key={s} data-size={s} style={{ fontSize: s }} className="break-words">
                <span data-testid="lower">{lower.join(' ')}</span> <span data-testid="upper">{upper.join(' ')}</span>
              </p>
            ))}
          </div>
        ))}
      </section>
    </main>
  );
}
