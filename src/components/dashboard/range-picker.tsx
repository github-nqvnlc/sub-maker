'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { vi } from '@/lib/i18n/vi';

export type DateRange = { from: string; to: string };

const DAY = 86_400_000;
const ymd = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

export function lastDays(n: number): DateRange {
  const now = Date.now();
  return { from: ymd(new Date(now - (n - 1) * DAY)), to: ymd(new Date(now)) };
}

/** Chọn nhanh 7/30/90 ngày hoặc nhập khoảng ngày tùy ý (dùng chung cho Dashboard và thống kê Admin). */
export function RangePicker({ value, onChange }: { value: DateRange; onChange: (r: DateRange) => void }) {
  const [from, setFrom] = useState(value.from);
  const [to, setTo] = useState(value.to);
  const bad = !from || !to || from > to;

  const preset = (n: number) => {
    const r = lastDays(n);
    setFrom(r.from);
    setTo(r.to);
    onChange(r);
  };

  return (
    <div className="flex flex-wrap items-end gap-2" role="group" aria-label={vi.dashboard.range}>
      <div className="flex gap-1">
        {[7, 30, 90].map((n) => (
          <Button key={n} type="button" size="sm" variant="outline" onClick={() => preset(n)}>
            {n === 7 ? vi.dashboard.last7 : n === 30 ? vi.dashboard.last30 : vi.dashboard.last90}
          </Button>
        ))}
      </div>
      <div className="space-y-1">
        <Label htmlFor="range-from" className="text-xs">
          {vi.dashboard.from}
        </Label>
        <Input id="range-from" type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className="w-40" />
      </div>
      <div className="space-y-1">
        <Label htmlFor="range-to" className="text-xs">
          {vi.dashboard.to}
        </Label>
        <Input id="range-to" type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className="w-40" />
      </div>
      <Button type="button" size="sm" disabled={bad} onClick={() => onChange({ from, to })}>
        {vi.dashboard.apply}
      </Button>
      {bad ? <p className="text-xs text-destructive">{vi.dashboard.invalidRange}</p> : null}
    </div>
  );
}
