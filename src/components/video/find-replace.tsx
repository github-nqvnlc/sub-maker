'use client';

import { useCallback, useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SelectField, SwitchRow } from '@/components/overlay/fields';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { useT } from '@/lib/i18n/client';
import { fmt } from '@/lib/i18n/fmt';
import type { CueOp } from '@/lib/video/cue-ops';
import { defaultMatchDiacritics, findInCues, matchVariants, replaceOps, type FindColumn, type FindMatch, type MatchVariant } from '@/lib/video/find-replace';
import type { Cue } from '@/lib/video/types';

export type FindState = {
  query: string;
  replacement: string;
  column: FindColumn;
  caseSensitive: boolean;
  wholeWord: boolean;
  /** null: theo từ tìm có dấu hay không */
  matchDiacritics: boolean | null;
};
export const EMPTY_FIND: FindState = { query: '', replacement: '', column: 'target', caseSensitive: false, wholeWord: false, matchDiacritics: null };

/** Kết quả tìm của trình biên tập theo trạng thái khung tìm. */
export function useFindMatches(cues: readonly Cue[], state: FindState, open: boolean) {
  const { query, column, caseSensitive, wholeWord } = state;
  const matchDiacritics = state.matchDiacritics ?? defaultMatchDiacritics(query);
  const matches = useMemo(
    () => (open && query ? findInCues(cues, { query, column, caseSensitive, wholeWord, matchDiacritics }) : []),
    [cues, open, query, column, caseSensitive, wholeWord, matchDiacritics],
  );
  return { matches, matchDiacritics };
}

/**
 * Tìm và thay thế trong phụ đề (spec 006, US6; FR-025). Thay thế tất cả là một lô thao tác nên hoàn tác bằng một lần; đụng nhiều dạng
 * khác dấu thì xác nhận và liệt kê từng dạng.
 */
export function FindReplacePanel({
  cues,
  state,
  matches,
  matchDiacritics,
  current,
  readOnly,
  takeFocusRef,
  onChange,
  onCurrent,
  onApply,
  onClose,
}: {
  cues: readonly Cue[];
  state: FindState;
  matches: readonly FindMatch[];
  matchDiacritics: boolean;
  /** chỉ số vị trí đang chọn, đã kẹp trong khoảng hợp lệ */
  current: number;
  readOnly: boolean;
  /** người dùng vừa bấm mở: đưa con trỏ vào ô tìm một lần (không phải mỗi lần khung được dựng lại) */
  takeFocusRef: React.RefObject<boolean>;
  onChange: (s: FindState) => void;
  /** chuyển tới một kết quả: danh sách cuộn theo */
  onCurrent: (index: number) => void;
  /** áp một lô thao tác; false khi bị từ chối */
  onApply: (ops: CueOp[]) => boolean;
  onClose: () => void;
}) {
  const t = useT();
  const f = t.video.editor.find;
  /** thay thế tất cả đang chờ xác nhận: đúng những vị trí đã liệt kê; giữ nội dung trong lúc hộp thoại đóng */
  const [pending, setPending] = useState<{ variants: MatchVariant[]; matches: readonly FindMatch[] } | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const queryRef = useCallback(
    (el: HTMLInputElement | null) => {
      if (el && takeFocusRef.current) {
        takeFocusRef.current = false;
        el.focus();
      }
    },
    [takeFocusRef],
  );
  const go = (step: number) => matches.length > 0 && onCurrent((current + step + matches.length) % matches.length);
  const search = (change: Partial<FindState>) => {
    onChange({ ...state, ...change });
    onCurrent(0);
  };

  const apply = (chosen: readonly FindMatch[]) => {
    const { ops, replaced } = replaceOps(cues, chosen, state.replacement, state.column);
    if (replaced === 0) {
      toast.error(f.nothing);
      return null;
    }
    if (!onApply(ops)) return null;
    toast.success(fmt(f.replaced, { count: replaced }));
    return ops;
  };

  /** Thay một chỗ rồi chọn chỗ khớp đầu tiên nằm sau đoạn vừa chèn (chữ mới có thể vẫn khớp từ tìm). */
  const replaceOne = () => {
    const match = matches[current];
    if (!match) return;
    // chỗ đang chọn đã giống hệt chữ thay: không có gì để đổi, sang chỗ kế
    if (replaceOps(cues, [match], state.replacement, state.column).replaced === 0) return void go(1);
    const ops = apply([match]);
    const op = ops?.[0];
    if (op?.type !== 'update') return;
    const updated = cues.map((c) => (c.id === op.id ? { ...c, ...op.patch } : c));
    const next = findInCues(updated, { query: state.query, column: state.column, caseSensitive: state.caseSensitive, wholeWord: state.wholeWord, matchDiacritics });
    const order = new Map(updated.map((c, i) => [c.id, i]));
    const at = order.get(match.cueId)!;
    const after = match.start + state.replacement.normalize('NFC').length;
    const index = next.findIndex((m) => order.get(m.cueId)! > at || (m.cueId === match.cueId && m.start >= after));
    onCurrent(Math.max(0, index));
  };

  const replaceAll = () => {
    const variants = matchVariants(matches);
    if (variants.length <= 1) return void apply(matches);
    setPending({ variants, matches });
    setConfirmOpen(true);
  };

  return (
    <section
      aria-labelledby="video-find-title"
      onKeyDown={(e) => {
        // hộp thoại và danh sách chọn nằm ngoài khung (cổng riêng) tự xử lý phím Escape của chúng
        if (e.key === 'Escape' && !e.defaultPrevented && e.currentTarget.contains(e.target as Node)) onClose();
      }}
    >
      <Card>
        <CardContent className="space-y-4 p-5">
          <div className="flex items-center justify-between gap-2">
            <h2 id="video-find-title" className="text-base font-semibold">
              {f.title}
            </h2>
            <Button size="icon-sm" variant="ghost" aria-label={f.close} onClick={onClose}>
              <X className="size-3.5" />
            </Button>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="video-find-query">{f.query}</Label>
              <Input
                id="video-find-query"
                ref={queryRef}
                value={state.query}
                maxLength={200}
                onChange={(e) => {
                  const query = e.target.value;
                  // từ tìm bị xóa hoặc đổi giữa có dấu và không dấu: "khớp đúng dấu" lại tự theo từ tìm mới (FR-025)
                  const follow = !query || defaultMatchDiacritics(query) !== defaultMatchDiacritics(state.query);
                  search({ query, ...(follow ? { matchDiacritics: null } : {}) });
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    go(e.shiftKey ? -1 : 1);
                  }
                }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="video-find-replacement">{f.replacement}</Label>
              <Input id="video-find-replacement" value={state.replacement} maxLength={200} disabled={readOnly} onChange={(e) => onChange({ ...state, replacement: e.target.value })} />
            </div>
            <SelectField
              label={f.column}
              value={state.column}
              onChange={(column) => search({ column })}
              options={[
                { value: 'target', label: t.video.editor.list.target },
                { value: 'source', label: t.video.editor.list.source },
              ]}
            />
            <div className="space-y-3">
              <SwitchRow id="video-find-case" label={f.caseSensitive} checked={state.caseSensitive} onChange={(caseSensitive) => search({ caseSensitive })} />
              <SwitchRow id="video-find-word" label={f.wholeWord} checked={state.wholeWord} onChange={(wholeWord) => search({ wholeWord })} />
              <SwitchRow id="video-find-marks" label={f.matchDiacritics} checked={matchDiacritics} onChange={(v) => search({ matchDiacritics: v })} />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span role="status" className="text-sm tabular-nums text-muted-foreground" data-testid="find-count">
              {!state.query ? '' : matches.length === 0 ? f.none : fmt(f.position, { n: current + 1, total: matches.length })}
            </span>
            <Button size="icon-sm" variant="outline" aria-label={f.previous} disabled={matches.length === 0} onClick={() => go(-1)}>
              <ChevronUp className="size-3.5" />
            </Button>
            <Button size="icon-sm" variant="outline" aria-label={f.next} disabled={matches.length === 0} onClick={() => go(1)}>
              <ChevronDown className="size-3.5" />
            </Button>
            <div className="ml-auto flex flex-wrap gap-2">
              <Button size="sm" variant="outline" disabled={readOnly || matches.length === 0} onClick={replaceOne}>
                {f.replace}
              </Button>
              <Button size="sm" variant="outline" disabled={readOnly || matches.length === 0} onClick={replaceAll}>
                {f.replaceAll}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        destructive={false}
        title={f.confirmTitle}
        description={
          <>
            <p className="font-medium text-foreground">{fmt(f.confirmCount, { count: pending?.matches.length ?? 0 })}</p>
            <ul className="list-disc space-y-0.5 pl-5">
              {pending?.variants.map((v) => (
                <li key={v.form}>{fmt(f.variant, { form: v.form, count: v.count })}</li>
              ))}
            </ul>
            <p>{f.confirmDesc}</p>
          </>
        }
        confirmLabel={f.replaceAll}
        onConfirm={() => void (pending && apply(pending.matches))}
      />
    </section>
  );
}
