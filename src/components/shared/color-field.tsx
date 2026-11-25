'use client';

import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useT } from '@/lib/i18n/client';
import { cn } from '@/lib/utils';

export type Swatch = { value: string; label: string };

const HEX = /^#[0-9a-f]{6}$/i;

/**
 * Ô chọn màu: bảng màu của hệ thống, ô nhập `#RRGGBB` và các mẫu gợi ý. Chỉ báo ra ngoài khi màu hợp lệ; đang gõ dở thì giữ chữ và báo sai.
 * Màu là nội dung do người dùng chọn nên đặt bằng `style`, không thuộc theme.
 */
export function ColorField({
  id,
  label,
  value,
  onChange,
  swatches = [],
  disabled,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (hex: string) => void;
  swatches?: readonly Swatch[];
  disabled?: boolean;
}) {
  const t = useT();
  // Chữ đang gõ dở (chưa hợp lệ) đi kèm giá trị lúc gõ: màu đổi từ nơi khác thì bỏ chữ dở
  const [draft, setDraft] = useState<{ text: string; base: string } | null>(null);
  const invalid = draft !== null && draft.base === value;
  const text = invalid ? draft.text : value;

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={value}
          disabled={disabled}
          aria-label={`${t.overlay.pickColor}: ${label}`}
          onChange={(e) => {
            setDraft(null);
            onChange(e.target.value.toUpperCase());
          }}
          className="h-8 w-10 shrink-0 cursor-pointer rounded-lg border border-field-border bg-transparent p-0.5 outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
        />
        <Input
          id={id}
          value={text}
          maxLength={7}
          disabled={disabled}
          aria-invalid={invalid}
          aria-describedby={invalid ? `${id}-error` : undefined}
          spellCheck={false}
          className="w-28 uppercase tabular-nums"
          onChange={(e) => {
            const v = e.target.value.trim();
            if (HEX.test(v)) {
              setDraft(null);
              onChange(v.toUpperCase());
            } else setDraft({ text: v, base: value });
          }}
        />
        {swatches.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {swatches.map((s) => (
              <button
                key={s.value}
                type="button"
                disabled={disabled}
                aria-label={s.label}
                aria-pressed={s.value === value}
                title={s.label}
                onClick={() => {
                  setDraft(null);
                  onChange(s.value);
                }}
                style={{ backgroundColor: s.value }}
                className={cn(
                  'size-6 cursor-pointer rounded-md border border-field-border outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50',
                  s.value === value && 'ring-2 ring-ring',
                )}
              />
            ))}
          </div>
        ) : null}
      </div>
      {invalid ? (
        <p id={`${id}-error`} className="text-xs text-destructive">
          {t.overlay.colorInvalid}
        </p>
      ) : null}
    </div>
  );
}
