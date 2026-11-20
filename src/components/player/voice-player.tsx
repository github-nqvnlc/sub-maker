'use client';

import { useEffect, useState } from 'react';
import { Download, Pause, Play, Volume2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { fmtDuration } from '@/lib/format';
import { useT } from '@/lib/i18n/client';

const RATES = [0.75, 1, 1.25, 1.5, 2];

type Props = {
  voiceId: string;
  /** Thời lượng đã biết từ máy chủ (dùng khi trình duyệt chưa đọc được metadata). */
  durationMs: number;
  audioRef: React.RefObject<HTMLAudioElement | null>;
};

/**
 * Trình phát: phát/tạm dừng, tua, tốc độ, âm lượng, tải về (FR-026, FR-029).
 * Phần tử <audio> dùng chung với SyncedText qua `audioRef` để highlight đọc đúng `currentTime`.
 */
export function VoicePlayer({ voiceId, durationMs, audioRef }: Props) {
  const t = useT();
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(durationMs / 1000);
  const [rate, setRate] = useState(1);
  const [volume, setVolume] = useState(1);
  const [error, setError] = useState(false);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onTime = () => setCurrent(audio.currentTime);
    const onMeta = () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) setDuration(audio.duration);
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onError = () => setError(true);
    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('seeked', onTime);
    audio.addEventListener('loadedmetadata', onMeta);
    audio.addEventListener('durationchange', onMeta);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('ended', onPause);
    audio.addEventListener('error', onError);
    return () => {
      audio.removeEventListener('timeupdate', onTime);
      audio.removeEventListener('seeked', onTime);
      audio.removeEventListener('loadedmetadata', onMeta);
      audio.removeEventListener('durationchange', onMeta);
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('ended', onPause);
      audio.removeEventListener('error', onError);
    };
  }, [audioRef]);

  function toggle() {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) void audio.play().catch(() => setError(true));
    else audio.pause();
  }

  return (
    <div className="space-y-3 rounded-lg border p-4">
      <audio ref={audioRef} src={`/api/voices/${voiceId}/audio`} preload="metadata" />

      <div className="flex items-center gap-3">
        <Button size="icon" onClick={toggle} aria-label={playing ? t.player.pause : t.player.play} data-testid="play-toggle">
          {playing ? <Pause className="size-5" /> : <Play className="size-5" />}
        </Button>
        <span className="w-24 shrink-0 text-sm tabular-nums text-muted-foreground" data-testid="time-display">
          {fmtDuration(current * 1000)} / {fmtDuration(duration * 1000)}
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

      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{t.player.speed}</span>
          <Select
            value={String(rate)}
            onValueChange={(v) => {
              const r = Number(v);
              setRate(r);
              if (audioRef.current) audioRef.current.playbackRate = r;
            }}
          >
            <SelectTrigger className="h-8 w-20" aria-label={t.player.speed}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RATES.map((r) => (
                <SelectItem key={r} value={String(r)}>
                  {r}×
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex w-40 items-center gap-2">
          <Volume2 className="size-4 text-muted-foreground" aria-hidden />
          <Slider
            min={0}
            max={1}
            step={0.05}
            value={[volume]}
            onValueChange={([v]) => {
              if (v === undefined) return;
              setVolume(v);
              if (audioRef.current) audioRef.current.volume = v;
            }}
            aria-label={t.player.volume}
          />
        </div>
        <Button asChild variant="outline" size="sm" className="ml-auto">
          <a href={`/api/voices/${voiceId}/audio?download=true`} download>
            <Download className="size-4" />
            {t.player.download}
          </a>
        </Button>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {t.player.audioError}
        </p>
      ) : null}
    </div>
  );
}
