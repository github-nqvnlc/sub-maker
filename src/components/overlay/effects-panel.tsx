'use client';

import { toast } from 'sonner';
import { Card, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { SelectField } from '@/components/overlay/fields';
import { SliderField } from '@/components/overlay/slider-field';
import { ColorField } from '@/components/shared/color-field';
import { useT } from '@/lib/i18n/client';
import { usesHighlight } from '@/lib/overlay/colors';
import { EXITS, INTENSITIES, LIMITS, normalizeConfig, SHAKE_SCOPES, SYNCS, usesDuration, usesIntensity, WORD_EFFECTS_OF, type Enter, type OverlayConfig } from '@/lib/overlay/config';

const ENTER_GROUPS: ReadonlyArray<{ key: 'basic' | 'dynamic' | 'cinematic'; items: readonly Enter[] }> = [
  { key: 'basic', items: ['cut', 'fade'] },
  { key: 'dynamic', items: ['pop', 'bounce', 'slideUp', 'slideLeft', 'slideRight', 'dropDown'] },
  { key: 'cinematic', items: ['blurIn', 'glitch', 'glow', 'flip3d', 'shake'] },
];

/** Chế độ đồng bộ, hiệu ứng và thông số (FR-017..028). Thông số không áp dụng cho lựa chọn hiện tại được ẩn. */
export function EffectsPanel({ config, onChange }: { config: OverlayConfig; onChange: (c: OverlayConfig) => void }) {
  const t = useT();
  const highlights = [
    { value: '#FFE600', label: t.overlay.swatches.yellow },
    { value: '#00FF66', label: t.overlay.swatches.neonGreen },
    { value: '#FF4500', label: t.overlay.swatches.orange },
    { value: '#FF8AC4', label: t.overlay.swatches.pink },
  ];

  /** Đổi lựa chọn rồi đưa tổ hợp không hợp về mặc định của chế độ, báo cho người dùng biết (FR-028). */
  function apply(next: OverlayConfig) {
    const r = normalizeConfig(next);
    // hiệu ứng từ luôn phải đổi theo chế độ; chỉ báo khi một lựa chọn người dùng đã đặt bị thay
    if (r.changed.some((p) => p === 'enter' || (p === 'wordEffect' && config.wordEffect !== 'none'))) toast.info(t.overlay.configAdjusted);
    onChange(r.config);
  }

  return (
    <section className="space-y-3" aria-labelledby="overlay-fx-title">
      <h2 id="overlay-fx-title" className="text-base font-semibold">
        {t.overlay.effectsTitle}
      </h2>
      <Card>
        <CardContent className="space-y-4 p-5">
          <h3 className="text-sm font-medium">{t.overlay.syncGroup}</h3>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <SelectField label={t.overlay.sync} value={config.sync} onChange={(sync) => apply({ ...config, sync })} options={SYNCS.map((s) => ({ value: s, label: t.overlay.syncs[s] }))} />
            {config.sync !== 'cue' ? (
              <SelectField
                label={t.overlay.wordEffect}
                value={config.wordEffect}
                onChange={(wordEffect) => apply({ ...config, wordEffect })}
                options={WORD_EFFECTS_OF[config.sync].map((w) => ({ value: w, label: t.overlay.wordEffects[w] }))}
              />
            ) : null}
          </div>
          {config.sync !== 'cue' ? <p className="text-xs text-muted-foreground">{t.overlay.wordEstimated}</p> : null}

          <Separator />
          <h3 className="text-sm font-medium">{t.overlay.motionGroup}</h3>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {config.sync !== 'word' ? (
              <div className="space-y-2">
                <Label>{t.overlay.enter}</Label>
                <Select
                  value={config.enter}
                  onValueChange={(v) => {
                    const enter = v as Enter;
                    // "Mờ dần" gồm cả mờ dần ra; người dùng đổi lại cách biến mất được
                    apply({ ...config, enter, exit: enter === 'fade' && config.exit === 'cut' ? 'fade' : config.exit });
                  }}
                >
                  <SelectTrigger className="w-full" aria-label={t.overlay.enter}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ENTER_GROUPS.map((g) => (
                      <SelectGroup key={g.key}>
                        <SelectLabel>{t.overlay.enterGroups[g.key]}</SelectLabel>
                        {g.items.map((e) => (
                          <SelectItem key={e} value={e}>
                            {t.overlay.enters[e]}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
            <SelectField label={t.overlay.exit} value={config.exit} onChange={(exit) => apply({ ...config, exit })} options={EXITS.map((e) => ({ value: e, label: t.overlay.exits[e] }))} />
            {usesDuration(config) ? (
              <SliderField id="ov-fx-ms" label={t.overlay.effectMs} value={config.effectMs} {...LIMITS.effectMs} unit=" ms" onChange={(effectMs) => onChange({ ...config, effectMs })} />
            ) : null}
            {usesIntensity(config) ? (
              <SelectField label={t.overlay.intensity} value={config.intensity} onChange={(intensity) => onChange({ ...config, intensity })} options={INTENSITIES.map((i) => ({ value: i, label: t.overlay.intensities[i] }))} />
            ) : null}
            {config.sync !== 'word' && config.enter === 'shake' ? (
              <SelectField label={t.overlay.shakeScope} value={config.shakeScope} onChange={(shakeScope) => onChange({ ...config, shakeScope })} options={SHAKE_SCOPES.map((s) => ({ value: s, label: t.overlay.shakeScopes[s] }))} />
            ) : null}
            {usesHighlight(config) ? (
              <ColorField id="ov-highlight" label={t.overlay.highlightColor} value={config.highlightColor} swatches={highlights} onChange={(highlightColor) => onChange({ ...config, highlightColor })} />
            ) : null}
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
