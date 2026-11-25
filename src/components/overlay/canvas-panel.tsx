'use client';

import { toast } from 'sonner';
import { Card, CardContent } from '@/components/ui/card';
import { SelectField } from '@/components/overlay/fields';
import { useT } from '@/lib/i18n/client';
import { applyBackground, ASPECTS, BACKGROUNDS, formatsOf, type OverlayConfig } from '@/lib/overlay/config';

/** Khung hình, nền và định dạng xuất (FR-007, FR-008, FR-032). */
export function CanvasPanel({ config, onChange }: { config: OverlayConfig; onChange: (c: OverlayConfig) => void }) {
  const t = useT();
  const formats = formatsOf(config.background);
  return (
    <section className="space-y-3" aria-labelledby="overlay-canvas-title">
      <h2 id="overlay-canvas-title" className="text-base font-semibold">
        {t.overlay.canvasTitle}
      </h2>
      <Card>
        <CardContent className="space-y-4 p-5">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <SelectField label={t.overlay.aspect} value={config.aspect} onChange={(aspect) => onChange({ ...config, aspect })} options={ASPECTS.map((a) => ({ value: a, label: t.overlay.aspects[a] }))} />
            <SelectField
              label={t.overlay.background}
              value={config.background}
              onChange={(background) => {
                const next = applyBackground(config, background);
                if (next.changed.includes('stroke.enabled')) toast.info(t.overlay.strokeOff);
                onChange(next.config);
              }}
              options={BACKGROUNDS.map((b) => ({ value: b, label: t.overlay.backgrounds[b] }))}
            />
            <SelectField label={t.overlay.format} value={config.format} onChange={(format) => onChange({ ...config, format })} options={formats.map((f) => ({ value: f, label: t.overlay.formats[f] }))} />
          </div>
          {config.format === 'mov' ? <p className="text-xs text-muted-foreground">{t.overlay.movHint}</p> : null}
        </CardContent>
      </Card>
    </section>
  );
}
