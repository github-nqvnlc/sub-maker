'use client';

import { useState } from 'react';
import { Combine, Plus, Scissors, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useT } from '@/lib/i18n/client';
import { fmt } from '@/lib/i18n/fmt';
import type { Caret, CueColumn, Edge } from '@/lib/video/cue-ops';
import { formatCueTime, parseCueTime } from '@/lib/video/time';
import { CUE_LIMITS, type Cue } from '@/lib/video/types';

/** Thao tác trên một cue; trình biên tập thực hiện và báo kết quả. */
export type CueActions = {
  text: (id: string, column: CueColumn, value: string) => void;
  caret: (id: string, caret: Caret) => void;
  setEdge: (id: string, edge: Edge, ms: number) => void;
  nudge: (id: string, edge: Edge, deltaMs: number) => void;
  split: (id: string) => void;
  merge: (id: string) => void;
  addAfter: (id: string) => void;
  addFirst: () => void;
  remove: (id: string) => void;
};

const NUDGES = [-500, -100, 100, 500] as const;
const signed = (n: number): string => (n > 0 ? `+${n}` : `−${Math.abs(n)}`);

/** Ô chữ sửa tại chỗ. Trong lúc gõ giữ đúng chuỗi người dùng đang nhập (chuẩn hóa NFC không làm nhảy con trỏ). */
function CueText({
  value,
  label,
  column,
  readOnly,
  onChange,
  onCaret,
}: {
  value: string;
  label: string;
  column: CueColumn;
  readOnly: boolean;
  onChange: (v: string) => void;
  onCaret: (offset: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  // bản nháp chỉ còn dùng khi vẫn khớp chữ đang lưu: bản mới hơn (tab khác, dịch lại) không bị chữ cũ đè
  const shown = draft !== null && draft.normalize('NFC') === value ? draft : value;
  return (
    <Textarea
      aria-label={label}
      data-column={column}
      value={shown}
      readOnly={readOnly}
      maxLength={CUE_LIMITS.maxTextChars}
      rows={2}
      className="min-h-16 resize-y"
      onChange={(e) => {
        setDraft(e.target.value);
        onChange(e.target.value);
      }}
      onSelect={(e) => onCaret(e.currentTarget.selectionStart)}
      onBlur={() => setDraft(null)}
    />
  );
}

/** Hai cột câu gốc và bản dịch của một cue. */
export function CueFields({ cue, number, readOnly, actions }: { cue: Cue; number: number; readOnly: boolean; actions: CueActions }) {
  const t = useT();
  const l = t.video.editor.list;
  const columns: Array<{ column: CueColumn; value: string; label: string; heading: string }> = [
    { column: 'source', value: cue.sourceText, label: fmt(l.sourceOf, { n: number }), heading: l.source },
    { column: 'target', value: cue.targetText, label: fmt(l.targetOf, { n: number }), heading: l.target },
  ];
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {columns.map(({ column, value, label, heading }) => (
        <div key={column} className="space-y-1">
          {/* màn hình hẹp xếp chồng hai ô và ẩn hàng tiêu đề cột */}
          <span className="text-xs text-muted-foreground sm:hidden" aria-hidden>
            {heading}
          </span>
          <CueText column={column} value={value} label={label} readOnly={readOnly} onChange={(v) => actions.text(cue.id, column, v)} onCaret={(offset) => actions.caret(cue.id, { column, offset })} />
        </div>
      ))}
    </div>
  );
}

/** Một mốc: nhập số, hoặc dịch ±100 / ±500 ms. */
function TimeField({ cue, number, edge, actions }: { cue: Cue; number: number; edge: Edge; actions: CueActions }) {
  const t = useT();
  const l = t.video.editor.tools;
  const value = edge === 'start' ? cue.startMs : cue.endMs;
  const [draft, setDraft] = useState<string | null>(null);
  const [bad, setBad] = useState(false);
  const label = fmt(edge === 'start' ? l.startOf : l.endOf, { n: number });
  const id = `cue-${edge}-${cue.id}`;

  const commit = () => {
    if (draft === null) return;
    const ms = parseCueTime(draft);
    setBad(ms === null);
    if (ms === null) return;
    setDraft(null);
    if (ms !== value) actions.setEdge(cue.id, edge, ms);
  };

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-1">
        <Label htmlFor={id} className="w-16 text-xs">
          {edge === 'start' ? l.start : l.end}
        </Label>
        <Input
          id={id}
          aria-label={label}
          aria-invalid={bad}
          inputMode="decimal"
          className="h-8 w-28 text-xs tabular-nums"
          value={draft ?? formatCueTime(value)}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            }
          }}
        />
        {NUDGES.map((delta) => (
          <Button
            key={delta}
            type="button"
            size="sm"
            variant="outline"
            className="tabular-nums"
            aria-label={fmt(l.nudge, { name: label, delta: signed(delta) })}
            onClick={() => {
              setDraft(null);
              setBad(false);
              actions.nudge(cue.id, edge, delta);
            }}
          >
            {signed(delta)}
          </Button>
        ))}
      </div>
      {bad ? (
        <p role="alert" className="text-xs text-destructive">
          {l.badTime}
        </p>
      ) : null}
    </div>
  );
}

/** Công cụ của cue đang chọn: mốc, tách, gộp, thêm, xóa (spec 006, FR-023). */
export function CueTools({ cue, number, isLast, actions }: { cue: Cue; number: number; isLast: boolean; actions: CueActions }) {
  const t = useT();
  const l = t.video.editor.tools;
  return (
    <div className="space-y-2 border-t pt-2" data-testid="cue-tools">
      <TimeField key={`s-${cue.id}`} cue={cue} number={number} edge="start" actions={actions} />
      <TimeField key={`e-${cue.id}`} cue={cue} number={number} edge="end" actions={actions} />
      <div className="flex flex-wrap gap-1">
        {number === 1 && cue.startMs >= CUE_LIMITS.minDurationMs ? (
          <Button type="button" size="sm" variant="outline" onClick={actions.addFirst}>
            <Plus className="size-3.5" />
            {l.addBefore}
          </Button>
        ) : null}
        <Button type="button" size="sm" variant="outline" onClick={() => actions.split(cue.id)}>
          <Scissors className="size-3.5" />
          {l.split}
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={isLast} onClick={() => actions.merge(cue.id)}>
          <Combine className="size-3.5" />
          {l.merge}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => actions.addAfter(cue.id)}>
          <Plus className="size-3.5" />
          {l.add}
        </Button>
        <Button type="button" size="sm" variant="outline" aria-label={fmt(l.delete, { n: number })} onClick={() => actions.remove(cue.id)}>
          <Trash2 className="size-3.5" />
          {t.common.delete}
        </Button>
      </div>
    </div>
  );
}
