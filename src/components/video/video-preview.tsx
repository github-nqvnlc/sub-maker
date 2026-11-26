'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { fmtDuration } from '@/lib/format';
import { useSubtitleCanvas } from '@/lib/hooks/use-subtitle-canvas';
import type { VideoJobDetailDto } from '@/lib/hooks/use-video';
import { useT } from '@/lib/i18n/client';
import { localVideoUrl } from '@/lib/video/upload-client';
import type { Cue, VideoMedia } from '@/lib/video/types';
import { cn } from '@/lib/utils';

type SourceKind = 'local' | 'preview' | 'source' | 'audio';
type Source = { kind: SourceKind; url: string };

/**
 * Khung xem trước của trình biên tập (spec 006, FR-022; US2 kịch bản 7): video có phụ đề nổi. Thứ tự nguồn phát: tệp trên máy → bản
 * xem trước → video nguồn → chỉ âm thanh; nguồn lỗi thì chuyển sang nguồn kế tiếp. Một phần tử `<video>` phát cả âm thanh nên mốc
 * đang phát không đổi khi đổi nguồn.
 */
export function VideoPreview({ job, media, cues, mediaRef }: { job: VideoJobDetailDto; media: VideoMedia; cues: readonly Cue[]; mediaRef: React.RefObject<HTMLVideoElement | null> }) {
  const t = useT();
  const p = t.video.editor.preview;
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lastTime = useRef(0);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  const [playFailed, setPlayFailed] = useState(false);
  // tệp trên máy, nếu video được chọn trong phiên này và trình duyệt phát được
  const [local] = useState(() => (media.browserPlayable ? localVideoUrl(job.id) : null));
  const { fonts } = useSubtitleCanvas({ boxRef, canvasRef, mediaRef, style: job.style, cues });

  const alive = job.sourceState === 'ready' || job.sourceState === 'checking';
  const sources = useMemo(() => {
    const url = (kind: Exclude<SourceKind, 'local'>) => `/api/video/jobs/${job.id}/media?kind=${kind}`;
    const list: Source[] = [];
    if (local) list.push({ kind: 'local', url: local });
    if (job.previewState === 'ready') list.push({ kind: 'preview', url: url('preview') });
    if (alive && media.browserPlayable) list.push({ kind: 'source', url: url('source') });
    if (alive) list.push({ kind: 'audio', url: url('audio') });
    return list;
  }, [job.id, job.previewState, alive, media.browserPlayable, local]);
  // lỗi phát được nhớ theo trạng thái video nguồn: tải lại video thì thử lại từ đầu
  const failKey = (url: string) => `${job.sourceState}:${url}`;
  const source = sources.find((s) => !failed.has(failKey(s.url))) ?? null;

  useEffect(() => {
    const el = mediaRef.current;
    if (!el) return;
    const onTime = () => {
      // đang đổi nguồn thì đồng hồ về 0: giữ mốc cũ để khôi phục
      if (el.readyState > 0) {
        lastTime.current = el.currentTime;
        setCurrent(el.currentTime);
      }
    };
    const onLoaded = () => {
      setLoading(false);
      if (lastTime.current > 0 && Math.abs(el.currentTime - lastTime.current) > 0.5) el.currentTime = lastTime.current;
    };
    const onStart = () => setLoading(true);
    const onPlay = () => {
      setPlaying(true);
      setPlayFailed(false);
    };
    const onPause = () => setPlaying(false);
    const events: Array<[string, () => void]> = [
      ['timeupdate', onTime],
      ['seeked', onTime],
      ['loadedmetadata', onLoaded],
      ['loadstart', onStart],
      ['play', onPlay],
      ['pause', onPause],
      ['ended', onPause],
      ['emptied', onPause],
    ];
    for (const [name, fn] of events) el.addEventListener(name, fn);
    if (el.readyState > 0) onLoaded();
    return () => {
      for (const [name, fn] of events) el.removeEventListener(name, fn);
    };
  }, [mediaRef]);

  const url = source?.url ?? null;
  const toggle = () => {
    const el = mediaRef.current;
    if (!el || !url) return;
    if (el.paused) void el.play().catch(() => setPlayFailed(true));
    else el.pause();
  };
  const duration = media.durationMs / 1000;
  const note = !source
    ? job.sourceState === 'uploading'
      ? p.notReady
      : !alive
        ? p.gone
        : null
    : source.kind === 'audio'
      ? job.previewState === 'pending'
        ? p.audioWhilePreview
        : p.audioOnly
      : null;
  const broken = (!source && alive) || playFailed;

  return (
    <section className="space-y-3 rounded-lg border p-4" aria-labelledby="video-preview-title">
      <h2 id="video-preview-title" className="text-base font-semibold">
        {p.title}
      </h2>
      <div className="flex justify-center">
        {/* nền đen là khung hình của video (nội dung), không theo theme */}
        <div
          ref={boxRef}
          className="relative w-full overflow-hidden rounded-md border bg-black [--box-h:38dvh] lg:[--box-h:56dvh]"
          style={{ aspectRatio: `${media.width} / ${media.height}`, maxWidth: `calc(var(--box-h) * ${media.width / media.height})` }}
        >
          <video
            ref={mediaRef}
            src={url ?? undefined}
            preload="auto"
            playsInline
            data-testid="video-preview-media"
            data-kind={source?.kind ?? 'none'}
            className="absolute inset-0 size-full object-contain"
            onError={() => {
              if (url) setFailed((old) => new Set(old).add(failKey(url)));
            }}
          />
          <canvas ref={canvasRef} role="img" aria-label={p.label} data-testid="video-preview-canvas" data-fonts={fonts} className={cn('pointer-events-none absolute inset-0 size-full', fonts !== 'ready' && 'opacity-40')} />
        </div>
      </div>
      {source && loading ? (
        <p role="status" className="text-xs text-muted-foreground">
          {p.loading}
        </p>
      ) : null}
      {note ? (
        <p role="status" className="text-xs text-muted-foreground">
          {note}
        </p>
      ) : null}
      {broken ? (
        <p role="alert" className="text-sm text-destructive">
          {p.playError}
        </p>
      ) : null}
      {fonts === 'loading' ? (
        <p role="status" className="text-xs text-muted-foreground">
          {t.overlay.previewLoading}
        </p>
      ) : null}
      {fonts === 'error' ? (
        <p role="alert" className="text-sm text-destructive">
          {p.fontError}
        </p>
      ) : null}
      <div className="flex items-center gap-3">
        <Button size="icon" onClick={toggle} disabled={!source} aria-label={playing ? t.player.pause : t.player.play} data-testid="video-play">
          {playing ? <Pause className="size-5" /> : <Play className="size-5" />}
        </Button>
        <span className="shrink-0 text-sm tabular-nums text-muted-foreground" data-testid="video-time">
          {fmtDuration(current * 1000)} / {fmtDuration(media.durationMs)}
        </span>
        <Slider
          className="flex-1"
          min={0}
          max={Math.max(duration, 0.001)}
          step={0.1}
          value={[Math.min(current, duration)]}
          disabled={!source}
          onValueChange={([v]) => {
            const el = mediaRef.current;
            if (el && v !== undefined) {
              el.currentTime = v;
              lastTime.current = v;
              setCurrent(v);
            }
          }}
          aria-label={t.player.seek}
        />
      </div>
    </section>
  );
}
