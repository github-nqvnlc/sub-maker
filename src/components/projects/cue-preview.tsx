'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { EmptyState, ErrorState, LoadingList } from '@/components/shared/states';
import { api } from '@/lib/api-client';
import { fmtDuration } from '@/lib/format';
import { fmt } from '@/lib/i18n/fmt';
import { useFormat, useT } from '@/lib/i18n/client';
import type { Dict } from '@/lib/i18n/types';

type Cue = { idx: number; n: number; startMs: number; endMs: number; text: string; speakable: boolean; charCount: number };
type CueWarning = { cue: number; code: keyof Dict['files']['warning'] };
type CuesPage = { items: Cue[]; total: number; page: number; pageSize: number; warnings: CueWarning[]; warningCount: number };

const PAGE_SIZE = 100;
const WARNINGS_SHOWN = 8;

/** mm:ss,mmm cho mốc phụ đề (chính xác đến mili giây). */
function stamp(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${h > 0 ? `${pad(h)}:` : ''}${pad(m)}:${pad(s)},${pad(ms % 1000, 3)}`;
}

/** Xem trước các cue của tệp có mốc thời gian, tải theo trang để tệp lớn không làm đơ giao diện (FR-011). */
export function CuePreview({ fileId, durationMs }: { fileId: string; durationMs: number | null }) {
  const t = useT();
  const fx = useFormat();
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: ['cues', fileId, page],
    queryFn: () => api<CuesPage>(`/api/files/${fileId}/cues?page=${page}&pageSize=${PAGE_SIZE}`),
    placeholderData: keepPreviousData,
  });

  if (q.isPending) return <LoadingList rows={4} />;
  if (q.isError) return <ErrorState message={q.error.message} onRetry={() => void q.refetch()} />;
  const d = q.data;
  if (d.total === 0) return <EmptyState title={t.files.cuesEmpty} />;
  const pages = Math.max(1, Math.ceil(d.total / d.pageSize));

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        {fmt(t.files.cuesSummary, { n: fx.number(d.total), t: fmtDuration(durationMs ?? 0) })}. {t.files.cuesDesc}
      </p>
      {d.warningCount > 0 ? (
        <div role="status" className="space-y-1 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
          <p className="font-medium">{t.files.warningsTitle}</p>
          <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
            {d.warnings.slice(0, WARNINGS_SHOWN).map((w, i) => (
              <li key={`${w.cue}-${w.code}-${i}`}>{fmt(t.files.warningCue, { cue: w.cue, reason: t.files.warning[w.code] })}</li>
            ))}
          </ul>
          {d.warningCount > WARNINGS_SHOWN ? <p className="text-xs text-muted-foreground">{fmt(t.files.warningsMore, { n: d.warningCount - WARNINGS_SHOWN })}</p> : null}
        </div>
      ) : null}
      <ScrollArea className="h-80 rounded-md border" aria-busy={q.isPlaceholderData}>
        <ol className="divide-y">
          {d.items.map((c) => (
            <li key={c.idx} className="flex gap-3 p-3 text-sm">
              <span className="w-10 shrink-0 text-right tabular-nums text-muted-foreground" aria-label={`${t.files.cueColNo} ${c.n}`}>
                {c.n}
              </span>
              <span className="w-40 shrink-0 text-xs tabular-nums text-muted-foreground">
                {stamp(c.startMs)} → {stamp(c.endMs)}
              </span>
              <span className="min-w-0 break-words">{c.speakable ? c.text : <Badge variant="secondary">{t.files.cueSilent}</Badge>}</span>
            </li>
          ))}
        </ol>
      </ScrollArea>
      {pages > 1 ? (
        <div className="flex items-center justify-between gap-2">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            {t.files.cuePrev}
          </Button>
          <span className="text-sm tabular-nums text-muted-foreground">{fmt(t.files.cuePage, { p: page, n: pages })}</span>
          <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
            {t.files.cueNext}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
