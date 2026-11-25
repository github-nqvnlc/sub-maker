'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { CanvasPanel } from '@/components/overlay/canvas-panel';
import { EffectsPanel } from '@/components/overlay/effects-panel';
import { ExportPanel } from '@/components/overlay/export-panel';
import { OverlayJobList } from '@/components/overlay/overlay-job-list';
import { PreviewPlayer } from '@/components/overlay/preview-player';
import { isUsable, SourcePicker, type SourceFile, type SourceVoice } from '@/components/overlay/source-picker';
import { TypographyPanel } from '@/components/overlay/typography-panel';
import { EmptyState, ErrorState, LoadingList } from '@/components/shared/states';
import {
  OVERLAY_ACTIVE,
  useOverlayAudios,
  useOverlayAutosave,
  useOverlayJobs,
  useOverlayRefresh,
  useOverlayState,
  useOverlayTimeline,
  type OverlayAudioDto,
  type OverlaySource,
  type OverlayStateDto,
} from '@/lib/hooks/use-overlay';
import { useT } from '@/lib/i18n/client';
import { colorWarnings } from '@/lib/overlay/colors';
import { DEFAULT_CONFIG, type OverlayConfig } from '@/lib/overlay/config';
import type { OverlayWarning } from '@/lib/overlay/types';

type Props = {
  projectId: string;
  files: readonly SourceFile[];
  voices: readonly SourceVoice[];
  onGoToScripts: () => void;
  onCreateVoice: () => void;
};

const newest = <T extends { createdAt: string }>(rows: readonly T[]): T | undefined => [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

/**
 * Nguồn hiệu lực: lựa chọn của người dùng nếu còn dùng được, nếu không thì voice mới nhất và đúng tệp `.srt` của nó (FR-001, US1).
 * Danh sách âm thanh chưa tải xong thì giữ nguyên lựa chọn để không nhảy sang voice khác.
 */
function resolveSource(picked: OverlaySource, voices: readonly SourceVoice[], files: readonly SourceFile[], audios: readonly OverlayAudioDto[] | undefined): OverlaySource {
  let voiceId: string | null = null;
  let audioId: string | null = null;
  if (picked.voiceId && voices.some((v) => v.id === picked.voiceId)) voiceId = picked.voiceId;
  else if (picked.audioId && (!audios || audios.some((a) => a.id === picked.audioId))) audioId = picked.audioId;
  else if (voices.length > 0) voiceId = newest(voices)!.id;
  else audioId = newest((audios ?? []).filter((a) => a.status === 'ready'))?.id ?? null;

  const usable = files.filter(isUsable);
  const ownFile = voices.find((v) => v.id === voiceId)?.fileId;
  const fileId = usable.find((f) => f.id === picked.fileId)?.id ?? usable.find((f) => f.id === ownFile)?.id ?? newest(usable)?.id ?? null;
  return { voiceId, audioId, fileId };
}

/** Tab "Video Overlay" của Project (spec 005). */
export function OverlayTab(props: Props) {
  const t = useT();
  const state = useOverlayState(props.projectId);
  if (state.isPending) return <LoadingList rows={4} />;
  if (state.isError) return <ErrorState message={t.overlay.loadError} onRetry={() => void state.refetch()} />;
  return <Editor {...props} initial={state.data} limits={state.data.limits} />;
}

function Editor({ projectId, files, voices, onGoToScripts, onCreateVoice, initial, limits }: Props & { initial: OverlayStateDto; limits: OverlayStateDto['limits'] }) {
  const t = useT();
  const top = useRef<HTMLDivElement>(null);
  const [config, setConfig] = useState<OverlayConfig>(initial.config);
  const [picked, setPicked] = useState<OverlaySource>(initial.source);
  const [previewWarnings, setPreviewWarnings] = useState<OverlayWarning[]>([]);
  const audios = useOverlayAudios(projectId);
  const { save, failed } = useOverlayAutosave(projectId);

  const source = useMemo(() => resolveSource(picked, voices, files, audios.data), [picked, voices, files, audios.data]);
  const audio = audios.data?.find((a) => a.id === source.audioId);
  const audioReady = !source.audioId || audio?.status === 'ready';
  const timeline = useOverlayTimeline(projectId, source, audioReady);
  const complete = !!source.fileId && !!(source.voiceId ?? source.audioId);

  function changeConfig(next: OverlayConfig) {
    setConfig(next);
    save({ config: next, source });
  }
  function changeSource(next: OverlaySource) {
    setPicked(next);
    save({ config, source: resolveSource(next, voices, files, audios.data) });
  }

  // Một lần xuất kết thúc làm thay đổi chỗ còn lại: làm mới số liệu
  const jobs = useOverlayJobs(projectId);
  const refresh = useOverlayRefresh(projectId);
  const active = jobs.data?.filter((j) => OVERLAY_ACTIVE.has(j.status)).length;
  const seen = useRef(active);
  useEffect(() => {
    if (seen.current !== undefined && active !== undefined && active < seen.current) refresh();
    seen.current = active;
  }, [active, refresh]);

  const onWarnings = useCallback((w: OverlayWarning[]) => setPreviewWarnings(w), []);
  const warnings = [...(timeline.data?.warnings ?? []), ...colorWarnings(config), ...(timeline.data ? previewWarnings : [])];
  const audioSrc = source.voiceId ? `/api/voices/${source.voiceId}/audio` : `/api/overlay/audios/${source.audioId}/stream`;

  return (
    <div ref={top} className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <h2 className="text-base font-semibold">{t.overlay.title}</h2>
          <p className="text-xs text-muted-foreground">{t.overlay.desc}</p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            changeConfig(structuredClone(DEFAULT_CONFIG));
            toast.success(t.overlay.resetDone);
          }}
        >
          {t.overlay.reset}
        </Button>
      </div>
      {failed ? (
        <p role="alert" className="text-sm text-destructive">
          {t.overlay.saveError}
        </p>
      ) : null}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <div className="min-w-0 space-y-6 lg:col-span-7">
          <SourcePicker projectId={projectId} source={source} onChange={changeSource} voices={voices} files={files} audios={audios} />
          <CanvasPanel config={config} onChange={changeConfig} />
          <TypographyPanel config={config} onChange={changeConfig} />
          <EffectsPanel config={config} onChange={changeConfig} />
          <ExportPanel
            projectId={projectId}
            config={config}
            onChange={changeConfig}
            source={source}
            durationMs={complete && audioReady && timeline.data && !timeline.isError ? timeline.data.durationMs : null}
            limits={limits}
            warnings={warnings}
          />
        </div>

        {/* Xem trước: cột phải, bám theo khi cuộn trên màn hình rộng; hiện lên đầu trên điện thoại */}
        <div className="order-first min-w-0 lg:order-none lg:col-span-5">
          <section className="space-y-3 lg:sticky lg:top-4" aria-labelledby="overlay-preview-title">
            <h2 id="overlay-preview-title" className="text-base font-semibold">
              {t.overlay.previewTitle}
            </h2>
            {!complete ? (
              <EmptyState
                title={t.overlay.emptyTitle}
                description={t.overlay.emptyDesc}
                action={
                  <div className="flex flex-wrap justify-center gap-2">
                    <Button size="sm" variant="outline" onClick={onGoToScripts}>
                      {t.overlay.goScripts}
                    </Button>
                    {files.length > 0 ? (
                      <Button size="sm" onClick={onCreateVoice}>
                        {t.overlay.createVoice}
                      </Button>
                    ) : null}
                  </div>
                }
              />
            ) : source.audioId && audios.isPending ? (
              <LoadingList rows={4} />
            ) : source.audioId && audios.isError ? (
              <ErrorState message={audios.error.message} onRetry={() => void audios.refetch()} />
            ) : !audioReady ? (
              audio?.status === 'failed' ? (
                <ErrorState message={(t.overlay.errors as Record<string, string>)[audio.errorCode ?? 'INTERNAL'] ?? t.overlay.errors.INTERNAL} />
              ) : (
                <div className="space-y-2">
                  <p role="status" className="text-sm text-muted-foreground">
                    {t.overlay.uploadStarted}
                  </p>
                  <LoadingList rows={3} />
                </div>
              )
            ) : timeline.isError ? (
              <ErrorState message={timeline.error.message || t.overlay.previewTimelineError} onRetry={() => void timeline.refetch()} />
            ) : timeline.data ? (
              <PreviewPlayer key={source.voiceId ?? source.audioId} audioSrc={audioSrc} durationMs={timeline.data.durationMs} config={config} cues={timeline.data.cues} onWarnings={onWarnings} />
            ) : (
              <LoadingList rows={4} />
            )}
          </section>
        </div>
      </div>

      <OverlayJobList
        projectId={projectId}
        onReuse={(c) => {
          changeConfig(structuredClone(c));
          toast.success(t.overlay.reused);
          top.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }}
      />
    </div>
  );
}
