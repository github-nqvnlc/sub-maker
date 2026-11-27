'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Check, Loader2, Pencil, Plus, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { SwitchRow } from '@/components/overlay/fields';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { ErrorState, LoadingList } from '@/components/shared/states';
import { ApiError, api, apiPut } from '@/lib/api-client';
import { useVideoTab, videoKeys } from '@/lib/hooks/use-video';
import { useT } from '@/lib/i18n/client';
import { fmt } from '@/lib/i18n/fmt';
import { GLOSSARY_TERM_MAX, glossaryChars, parseGlossaryLines, validateGlossary, type GlossaryLimits, type GlossaryLineError, type GlossaryReason } from '@/lib/video/glossary';
import type { VideoProjectSettingsDto, VideoTabDto } from '@/lib/video/service';
import type { GlossaryPair } from '@/lib/video/types';

const EMPTY: GlossaryPair = { source: '', target: '', keep: false };
const limitsOf = (tab: VideoTabDto): GlossaryLimits => ({ maxPairs: tab.limits.glossaryMaxPairs, maxChars: tab.limits.glossaryMaxChars });

/** Hai ô từ gốc, từ dịch và công tắc "giữ nguyên": dùng cho dòng thêm mới và dòng đang sửa. */
function PairFields({ id, pair, disabled, autoFocus, onChange }: { id: string; pair: GlossaryPair; disabled: boolean; autoFocus?: boolean; onChange: (p: GlossaryPair) => void }) {
  const t = useT();
  const g = t.video.glossary;
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={`${id}-source`}>{g.source}</Label>
          <Input id={`${id}-source`} autoFocus={autoFocus} value={pair.source} maxLength={GLOSSARY_TERM_MAX * 2} readOnly={disabled} onChange={(e) => onChange({ ...pair, source: e.target.value })} />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${id}-target`}>{g.target}</Label>
          <Input id={`${id}-target`} value={pair.keep ? pair.source : pair.target} maxLength={GLOSSARY_TERM_MAX * 2} readOnly={disabled} disabled={pair.keep} onChange={(e) => onChange({ ...pair, target: e.target.value })} />
        </div>
      </div>
      <SwitchRow id={`${id}-keep`} label={g.keep} checked={pair.keep} onChange={(keep) => onChange({ ...pair, keep })} />
    </div>
  );
}

function Editor({ projectId, pairs, limits }: { projectId: string; pairs: GlossaryPair[]; limits: GlossaryLimits }) {
  const t = useT();
  const g = t.video.glossary;
  const qc = useQueryClient();
  const root = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<GlossaryPair>(EMPTY);
  /** dòng đang sửa, nhớ theo từ gốc ban đầu: danh sách đổi thì không trỏ sang cặp khác */
  const [editing, setEditing] = useState<{ source: string; pair: GlossaryPair } | null>(null);
  const [bulk, setBulk] = useState('');
  const [lineErrors, setLineErrors] = useState<GlossaryLineError[]>([]);
  /** lỗi của dòng đang thêm hoặc đang sửa */
  const [problem, setProblem] = useState<{ where: 'add' | 'edit'; text: string } | null>(null);
  const [removing, setRemoving] = useState<GlossaryPair | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);

  /** Đưa tiêu điểm tới một phần tử sau khi danh sách vẽ lại (nút vừa bấm có thể đã bị gỡ). */
  const focusLater = (selector: string) => setTimeout(() => root.current?.querySelector<HTMLElement>(selector)?.focus(), 50);
  const editButton = (source: string) => `[data-edit-for="${CSS.escape(source)}"]`;

  // đọc bản mới nhất rồi mới áp thay đổi, để không xóa mất cặp vừa thêm ở thẻ hoặc thiết bị khác; `null` là không có gì để lưu
  const save = useMutation({
    mutationFn: async (change: (current: GlossaryPair[], limits: GlossaryLimits) => GlossaryPair[] | null) => {
      const fresh = await qc.fetchQuery({ queryKey: videoKeys.tab(projectId), queryFn: () => api<VideoTabDto>(`/api/projects/${projectId}/video`), staleTime: 0 });
      const next = change(fresh.settings.glossary, limitsOf(fresh));
      return next ? apiPut<VideoProjectSettingsDto>(`/api/projects/${projectId}/video/settings`, { glossary: next }) : null;
    },
    onSuccess: (settings) => {
      if (!settings) return;
      qc.setQueryData<VideoTabDto>(videoKeys.tab(projectId), (old) => (old ? { ...old, settings } : old));
      toast.success(g.saved);
    },
    onError: (e) => {
      // máy chủ nêu thứ tự cặp và lý do: nói rõ thay vì chỉ bảo sửa dòng được đánh dấu
      const detail =
        e instanceof ApiError && e.code === 'GLOSSARY_INVALID'
          ? Object.entries(e.fields ?? {})
              .map(([line, reason]) => fmt(g.pairError, { line, reason: g.reasons[reason as GlossaryReason] ?? reason }))
              .join('; ')
          : '';
      // lỗi mạng chỉ có thông báo thô của trình duyệt
      toast.error(e instanceof ApiError ? e.message : t.common.genericError, { description: detail || undefined });
    },
  });
  const busy = save.isPending;

  /** Lưu danh sách mới nếu hợp lệ; `source` là từ gốc của dòng người dùng vừa thêm hoặc sửa, để nêu đúng lỗi của dòng đó. */
  const submit = (where: 'add' | 'edit', build: (current: GlossaryPair[]) => { next: GlossaryPair[]; index: number }, done: () => void) => {
    setProblem(null);
    save.mutate(
      (current, max) => {
        const { next, index } = build(current);
        const check = validateGlossary(next, max);
        if (check.ok) return check.pairs;
        const own = check.errors.find((e) => e.line === index + 1) ?? check.errors[0];
        setProblem({ where, text: check.code === 'GLOSSARY_TOO_LARGE' ? g.reasons.limit : g.reasons[own!.reason] });
        return null;
      },
      { onSuccess: (saved) => saved && done() },
    );
  };
  const saveEdit = () => {
    if (!editing) return;
    const { source, pair } = editing;
    submit(
      'edit',
      (current) => {
        const at = current.findIndex((x) => x.source === source);
        // cặp đã bị xóa ở nơi khác thì thêm lại với nội dung vừa sửa
        return at < 0 ? { next: [...current, pair], index: current.length } : { next: current.map((x, i) => (i === at ? pair : x)), index: at };
      },
      () => {
        setEditing(null);
        focusLater(editButton(pair.source.normalize('NFC').trim()));
      },
    );
  };
  const cancelEdit = () => {
    // đang lưu thì chưa hủy được: yêu cầu đã gửi đi
    if (!editing || busy) return;
    const { source } = editing;
    setEditing(null);
    setProblem(null);
    focusLater(editButton(source));
  };

  const addBulk = () => {
    const text = bulk;
    let failed: GlossaryLineError[] = [];
    save.mutate(
      (current, max) => {
        const { added, errors } = parseGlossaryLines(text, current, max);
        failed = errors;
        if (added.length > 0) return [...current, ...added];
        return null;
      },
      {
        onSuccess: () => {
          // giữ lại đúng các dòng lỗi để sửa, đánh số theo vị trí mới
          const lines = text.split(/\r\n|\r|\n/);
          setBulk(failed.map((e) => lines[e.line - 1]).join('\n'));
          setLineErrors(failed.map((e, i) => ({ line: i + 1, reason: e.reason })));
        },
      },
    );
  };

  return (
    <Card ref={root}>
      <CardContent className="space-y-4 p-5">
        <p className="text-xs text-muted-foreground">{g.desc}</p>
        <p className="text-xs tabular-nums text-muted-foreground" data-testid="glossary-count">
          {fmt(g.count, { pairs: pairs.length, maxPairs: limits.maxPairs, chars: glossaryChars(pairs), maxChars: limits.maxChars })}
        </p>
        {pairs.length === 0 ? (
          <p className="text-sm text-muted-foreground">{g.empty}</p>
        ) : (
          <div className="max-h-80 overflow-y-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{g.source}</TableHead>
                  <TableHead>{g.target}</TableHead>
                  <TableHead className="w-24">
                    <span className="sr-only">{g.actions}</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pairs.map((p) =>
                  editing?.source === p.source ? (
                    <TableRow key={p.source}>
                      <TableCell colSpan={3} className="whitespace-normal">
                        <form
                          className="space-y-2"
                          onSubmit={(e) => {
                            e.preventDefault();
                            if (!busy) saveEdit();
                          }}
                          onKeyDown={(e) => e.key === 'Escape' && cancelEdit()}
                        >
                          <PairFields id="glossary-edit" autoFocus pair={editing.pair} disabled={busy} onChange={(pair) => setEditing({ source: p.source, pair })} />
                          {problem?.where === 'edit' ? (
                            <p role="alert" className="text-xs text-destructive">
                              {problem.text}
                            </p>
                          ) : null}
                          <div className="flex justify-end gap-2">
                            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={cancelEdit}>
                              <X className="size-3.5" />
                              {t.common.cancel}
                            </Button>
                            <Button type="submit" size="sm" disabled={busy}>
                              <Check className="size-3.5" />
                              {t.common.save}
                            </Button>
                          </div>
                        </form>
                      </TableCell>
                    </TableRow>
                  ) : (
                    <TableRow key={p.source}>
                      <TableCell className="whitespace-normal break-all">{p.source}</TableCell>
                      <TableCell className="whitespace-normal break-all">{p.keep ? <Badge variant="secondary">{g.keep}</Badge> : p.target}</TableCell>
                      <TableCell>
                        <div className="flex justify-end gap-1">
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            disabled={busy}
                            data-edit-for={p.source}
                            aria-label={fmt(g.editPair, { source: p.source })}
                            onClick={() => {
                              setEditing({ source: p.source, pair: p });
                              setProblem(null);
                            }}
                          >
                            <Pencil className="size-3.5" />
                          </Button>
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            disabled={busy}
                            aria-label={fmt(g.removePair, { source: p.source })}
                            onClick={() => {
                              setRemoving(p);
                              setRemoveOpen(true);
                            }}
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ),
                )}
              </TableBody>
            </Table>
          </div>
        )}

        <Separator />
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (busy) return;
            const pair = draft;
            submit(
              'add',
              (current) => ({ next: [...current, pair], index: current.length }),
              () => setDraft(EMPTY),
            );
          }}
        >
          <h3 className="text-sm font-medium">{g.addTitle}</h3>
          <PairFields id="glossary-add" pair={draft} disabled={busy} onChange={setDraft} />
          {problem?.where === 'add' ? (
            <p role="alert" className="text-xs text-destructive">
              {problem.text}
            </p>
          ) : null}
          <div className="flex justify-end">
            <Button type="submit" size="sm" variant="outline" disabled={busy || !draft.source.trim()}>
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
              {g.add}
            </Button>
          </div>
        </form>

        <Separator />
        <div className="space-y-2">
          <h3 id="glossary-bulk-title" className="text-sm font-medium">
            {g.bulk}
          </h3>
          <Textarea rows={4} value={bulk} readOnly={busy} aria-labelledby="glossary-bulk-title" aria-describedby="glossary-bulk-hint" onChange={(e) => setBulk(e.target.value)} />
          <p id="glossary-bulk-hint" className="text-xs text-muted-foreground">
            {g.bulkHint}
          </p>
          {lineErrors.length > 0 ? (
            <ul role="alert" className="space-y-0.5 text-xs text-destructive" data-testid="glossary-line-errors">
              {lineErrors.map((e) => (
                <li key={e.line}>{fmt(g.lineError, { line: e.line, reason: g.reasons[e.reason] })}</li>
              ))}
            </ul>
          ) : null}
          <div className="flex justify-end">
            <Button size="sm" variant="outline" disabled={busy || !bulk.trim()} onClick={addBulk}>
              <Plus className="size-3.5" />
              {g.addLines}
            </Button>
          </div>
        </div>
      </CardContent>

      <ConfirmDialog
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        title={g.removeTitle}
        description={
          <>
            <p className="font-medium break-all text-foreground">
              {removing?.source} → {removing?.keep ? g.keep : removing?.target}
            </p>
            <p>{g.removeDesc}</p>
          </>
        }
        confirmLabel={t.common.delete}
        onConfirm={async () => {
          if (!removing) return;
          const { source } = removing;
          // lỗi đã được báo bằng toast
          await save.mutateAsync((current) => current.filter((x) => x.source !== source)).catch(() => undefined);
          focusLater('#glossary-add-source');
        }}
      />
    </Card>
  );
}

/** Từ điển thuật ngữ của Project (spec 006, US5; FR-019 đến FR-021): dùng ở tab Dịch Video và trong trình biên tập. */
export function GlossaryEditor({ projectId }: { projectId: string }) {
  const t = useT();
  const g = t.video.glossary;
  const tab = useVideoTab(projectId);
  return (
    <section className="space-y-3" aria-labelledby="video-glossary-title">
      <h2 id="video-glossary-title" className="scroll-mt-4 text-base font-semibold">
        {g.title}
      </h2>
      {tab.isPending ? (
        <LoadingList rows={2} />
      ) : !tab.data ? (
        <ErrorState message={t.video.loadError} onRetry={() => void tab.refetch()} />
      ) : (
        <Editor projectId={projectId} pairs={tab.data.settings.glossary} limits={limitsOf(tab.data)} />
      )}
    </section>
  );
}
