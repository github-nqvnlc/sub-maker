'use client';

import { useEffect, useRef, useState } from 'react';
import { Pause, Volume2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useT } from '@/lib/i18n/client';
import { cn } from '@/lib/utils';

const FPT_AVAILABLE_PREVIEWS = new Set([
  // FPT.AI-VITs
  'banmai',
  'thuminh',
  'leminh',
  'minhquan',
  'ngoclam',
  'giahuy',
  'kimngan',
  'hatieumai',
  'huyphong',
  // FPT.TTS-pro & FPT.TTS-ultra
  'std_banmai',
  'std_kimngan',
  'std_quanganh',
  'std_minhquang',
  'std_vietkhoa',
  'fci_phuongan',
  'fci_xuantoan',
]);

function getPreviewUrl(providerType: string, voiceId: string): string | null {
  if (providerType === 'fpt_marketplace' && FPT_AVAILABLE_PREVIEWS.has(voiceId)) {
    return `/previews/fpt/${voiceId}.mp3`;
  }
  return null;
}

export function VoicePreviewButton({
  providerType,
  voiceId,
  className,
}: {
  providerType: string;
  voiceId: string;
  className?: string;
}) {
  const t = useT();
  const [playingVoice, setPlayingVoice] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const previewUrl = getPreviewUrl(providerType, voiceId);
  const isPlaying = playingVoice === voiceId;

  // Dọn dẹp audio khi unmount hoặc đổi voice/provider
  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  }, [voiceId, providerType]);

  if (!previewUrl) return null;

  function togglePlay() {
    if (isPlaying && audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
      setPlayingVoice(null);
      return;
    }

    if (audioRef.current) {
      audioRef.current.pause();
    }

    const audio = new Audio(previewUrl!);
    audioRef.current = audio;

    audio.onended = () => {
      setPlayingVoice(null);
      audioRef.current = null;
    };
    audio.onerror = () => {
      setPlayingVoice(null);
      audioRef.current = null;
    };
    audio.onpause = () => {
      setPlayingVoice((cur) => (cur === voiceId ? null : cur));
    };

    audio
      .play()
      .then(() => setPlayingVoice(voiceId))
      .catch(() => {
        setPlayingVoice(null);
        audioRef.current = null;
      });
  }

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={togglePlay}
            className={cn(
              'h-9 gap-1.5 px-3 transition-colors',
              isPlaying
                ? 'border-primary bg-primary/10 text-primary font-medium ring-1 ring-primary/30'
                : 'text-muted-foreground hover:text-foreground',
              className,
            )}
            aria-label={isPlaying ? t.jobs.stopPreview : t.jobs.listenPreview}
          >
            {isPlaying ? (
              <>
                <Pause className="size-3.5 fill-current animate-pulse text-primary" />
                <span>{t.jobs.stopPreview}</span>
              </>
            ) : (
              <>
                <Volume2 className="size-3.5 text-primary" />
                <span>{t.jobs.listenPreview}</span>
              </>
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t.jobs.voicePreviewTooltip}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
