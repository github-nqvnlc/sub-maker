'use client';

import { useEffect, useRef, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { fmtDuration } from '@/lib/format';
import { useOverlayCanvas } from '@/lib/hooks/use-overlay-canvas';
import { useT } from '@/lib/i18n/client';
import { isTransparent, sizeOf, type OverlayConfig } from '@/lib/overlay/config';
import type { AppliedCue, OverlayWarning } from '@/lib/overlay/types';
import { cn } from '@/lib/utils';

/** Ô bàn cờ bằng màu theme để phân biệt vùng trong suốt; không nằm trong video. */
const CHECKER: React.CSSProperties = {
  backgroundImage: 'conic-gradient(var(--muted) 25%, var(--background) 0 50%, var(--muted) 0 75%, var(--background) 0)',
  backgroundSize: '24px 24px',
};

/**
 * Trình xem trước (FR-029..031): phát voice cùng chữ trên đúng tỉ lệ và nền đã chọn; mọi thay đổi cấu hình hiện ngay, không ngắt tiếng.
 */
export function PreviewPlayer({
  audioSrc,
  durationMs,
  config,
  cues,
  onWarnings,
}: {
  audioSrc: string;
  durationMs: number;
  config: OverlayConfig;
  cues: readonly AppliedCue[];
  onWarnings: (w: OverlayWarning[]) => void;
}) {
  const t = useT();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [error, setError] = useState(false);
  const { fonts, warnings } = useOverlayCanvas({ canvasRef, audioRef, config, cues });
  const size = sizeOf(config);
  const duration = durationMs / 1000;
  const transparent = isTransparent(config);

  useEffect(() => {
    onWarnings(warnings);
  }, [warnings, onWarnings]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onTime = () => setCurrent(audio.currentTime);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onError = () => setError(true);
    const onLoad = () => {
      setError(false);
      setCurrent(audio.currentTime);
    };
    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('seeked', onTime);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('ended', onPause);
    audio.addEventListener('error', onError);
    audio.addEventListener('loadstart', onLoad);
    return () => {
      audio.removeEventListener('timeupdate', onTime);
      audio.removeEventListener('seeked', onTime);
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('ended', onPause);
      audio.removeEventListener('error', onError);
      audio.removeEventListener('loadstart', onLoad);
    };
  }, []);

  function toggle() {
    const audio = audioRef.current;
    if (!audio) return;
    // Trình duyệt chặn tự phát: lần bấm này là thao tác của người dùng nên được phép
    if (audio.paused) void audio.play().catch(() => setError(true));
    else audio.pause();
  }

  return (
    <div className="space-y-3 rounded-lg border p-4">
      <audio ref={audioRef} src={audioSrc} preload="auto" data-testid="overlay-audio" />
      <div className="flex justify-center">
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={t.overlay.previewLabel}
          width={size.width}
          height={size.height}
          data-testid="overlay-canvas"
          data-fonts={fonts}
          style={transparent ? CHECKER : undefined}
          className={cn('block h-auto max-h-[38dvh] w-auto max-w-full rounded-md border lg:max-h-[56dvh]', fonts !== 'ready' && 'opacity-40')}
        />
      </div>
      {transparent ? <p className="text-xs text-muted-foreground">{t.overlay.checkerNote}</p> : null}
      {fonts === 'loading' ? (
        <p role="status" className="text-xs text-muted-foreground">
          {t.overlay.previewLoading}
        </p>
      ) : null}
      {fonts === 'error' ? (
        <p role="alert" className="text-sm text-destructive">
          {t.overlay.previewFontError}
        </p>
      ) : null}

      <div className="flex items-center gap-3">
        <Button size="icon" onClick={toggle} aria-label={playing ? t.player.pause : t.player.play} data-testid="overlay-play">
          {playing ? <Pause className="size-5" /> : <Play className="size-5" />}
        </Button>
        <span className="w-24 shrink-0 text-sm tabular-nums text-muted-foreground" data-testid="overlay-time">
          {fmtDuration(current * 1000)} / {fmtDuration(durationMs)}
        </span>
        <Slider
          className="flex-1"
          min={0}
          max={Math.max(duration, 0.001)}
          step={0.05}
          value={[Math.min(current, duration)]}
          onValueChange={([v]) => {
            const audio = audioRef.current;
            if (audio && v !== undefined) {
              audio.currentTime = v;
              setCurrent(v);
            }
          }}
          aria-label={t.player.seek}
        />
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {t.player.audioError}
        </p>
      ) : null}
    </div>
  );
}
