'use client';

import { fmt } from '@/lib/i18n/fmt';
import { useT } from '@/lib/i18n/client';
import type { Dict } from '@/lib/i18n/types';
import type { OverlayWarning } from '@/lib/overlay/types';

/** Dựng câu cảnh báo theo ngôn ngữ người xem từ mã và tham số. */
export function warningText(t: Dict, w: OverlayWarning): string {
  const params = { ...(w.params ?? {}) };
  if (w.code === 'KEYED_COLOR') params.field = (t.overlay.colorFields as Record<string, string>)[String(params.field)] ?? String(params.field);
  return fmt((t.overlay.warnings as Record<string, string>)[w.code] ?? w.code, params);
}

/** Khối lưu ý trước khi xuất: không chặn việc xuất. */
export function WarningList({ title, warnings }: { title: string; warnings: readonly OverlayWarning[] }) {
  const t = useT();
  if (warnings.length === 0) return null;
  return (
    <div role="status" className="space-y-1 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
      <p className="font-medium">{title}</p>
      <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
        {warnings.map((w, i) => (
          <li key={`${w.code}-${i}`}>{warningText(t, w)}</li>
        ))}
      </ul>
    </div>
  );
}
