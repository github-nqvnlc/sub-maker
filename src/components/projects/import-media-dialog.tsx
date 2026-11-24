'use client';

import { Import } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EmptyState, ErrorState, LoadingList } from '@/components/shared/states';
import { useSttJobs } from '@/lib/hooks/use-stt-jobs';
import { useFormat, useT } from '@/lib/i18n/client';

export function ImportMediaDialog({
  projectId,
  open,
  onClose,
  onSelectFile,
}: {
  projectId: string;
  open: boolean;
  onClose: () => void;
  onSelectFile: (fileId: string) => void;
}) {
  const t = useT();
  const fx = useFormat();
  const jobs = useSttJobs(projectId);
  const completedJobs = (jobs.data ?? []).filter((j) => j.status === 'completed' && j.resultSubtitleFileId);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t.projects.importFromMedia}</DialogTitle>
          <DialogDescription>{t.projects.importFromMediaDesc}</DialogDescription>
        </DialogHeader>

        {jobs.isPending ? (
          <LoadingList rows={3} />
        ) : jobs.isError ? (
          <ErrorState message={t.stt.loadError} onRetry={() => void jobs.refetch()} />
        ) : completedJobs.length === 0 ? (
          <EmptyState title={t.projects.noMediaSubtitles} />
        ) : (
          <ul className="divide-y rounded-lg border max-h-[400px] overflow-y-auto">
            {completedJobs.map((j) => (
              <li key={j.id} className="flex items-center justify-between gap-3 p-3 hover:bg-muted/30">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium text-sm">{j.targetFileName}</span>
                    <Badge variant="outline">.{j.targetFormat}</Badge>
                  </div>
                  <div className="mt-0.5 flex gap-3 text-xs text-muted-foreground">
                    <span className="capitalize">{j.mediaType}</span>
                    <span>{fx.dateTime(j.createdAt)}</span>
                  </div>
                </div>
                <Button
                  size="sm"
                  className="gap-1.5"
                  onClick={() => {
                    onSelectFile(j.resultSubtitleFileId!);
                    onClose();
                  }}
                >
                  <Import className="size-3.5" />
                  {t.projects.loadToScript}
                </Button>
              </li>
            ))}
          </ul>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t.common.cancel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
