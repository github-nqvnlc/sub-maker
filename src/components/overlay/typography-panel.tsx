'use client';

import { Card, CardContent } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { SelectField, SwitchRow } from '@/components/overlay/fields';
import { SliderField } from '@/components/overlay/slider-field';
import { ColorField } from '@/components/shared/color-field';
import { useT } from '@/lib/i18n/client';
import { ALIGNS, ANCHOR_Y, ANCHORS, LIMITS, type OverlayConfig } from '@/lib/overlay/config';
import { FONT_FAMILIES, FONT_LABELS, FONT_WEIGHTS, hasWeight } from '@/lib/overlay/fonts';

/** Kiểu chữ và vị trí (FR-012..014). */
export function TypographyPanel({ config, onChange }: { config: OverlayConfig; onChange: (c: OverlayConfig) => void }) {
  const t = useT();
  const { font, stroke, shadow, box } = config;
  const textSwatches = [
    { value: '#FFFFFF', label: t.overlay.swatches.white },
    { value: '#FFE600', label: t.overlay.swatches.yellow },
    { value: '#000000', label: t.overlay.swatches.black },
  ];
  return (
    <section className="space-y-3" aria-labelledby="overlay-type-title">
      <h2 id="overlay-type-title" className="text-base font-semibold">
        {t.overlay.typographyTitle}
      </h2>
      <Card>
        <CardContent className="space-y-4 p-5">
          <h3 className="text-sm font-medium">{t.overlay.textGroup}</h3>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <SelectField
              label={t.overlay.font}
              value={font.family}
              onChange={(family) => onChange({ ...config, font: { ...font, family, weight: hasWeight(family, font.weight) ? font.weight : 700 } })}
              options={FONT_FAMILIES.map((f) => ({ value: f, label: FONT_LABELS[f] }))}
            />
            <SelectField
              label={t.overlay.fontWeight}
              value={String(font.weight) as '400' | '700' | '800'}
              onChange={(w) => onChange({ ...config, font: { ...font, weight: Number(w) as 400 | 700 | 800 } })}
              options={FONT_WEIGHTS.map((w) => {
                const key = String(w) as '400' | '700' | '800';
                const ok = hasWeight(font.family, w);
                return { value: key, label: ok ? t.overlay.weights[key] : `${t.overlay.weights[key]} (${t.overlay.weightMissing})`, disabled: !ok };
              })}
            />
            <SliderField id="ov-size" label={t.overlay.fontSize} value={font.size} {...LIMITS.fontSize} unit=" px" onChange={(size) => onChange({ ...config, font: { ...font, size } })} />
            <ColorField id="ov-text" label={t.overlay.textColor} value={config.text.color} swatches={textSwatches} onChange={(color) => onChange({ ...config, text: { color } })} />
          </div>

          <Separator />
          <h3 className="text-sm font-medium">{t.overlay.decorGroup}</h3>
          <SwitchRow id="ov-stroke" label={t.overlay.stroke} hint={t.overlay.strokeHint} checked={stroke.enabled} onChange={(enabled) => onChange({ ...config, stroke: { ...stroke, enabled } })} />
          {stroke.enabled ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <ColorField id="ov-stroke-color" label={t.overlay.strokeColor} value={stroke.color} onChange={(color) => onChange({ ...config, stroke: { ...stroke, color } })} />
              <SliderField id="ov-stroke-width" label={t.overlay.strokeWidth} value={stroke.width} {...LIMITS.strokeWidth} unit=" px" onChange={(width) => onChange({ ...config, stroke: { ...stroke, width } })} />
            </div>
          ) : null}
          <SwitchRow id="ov-shadow" label={t.overlay.shadow} hint={t.overlay.shadowHint} checked={shadow.enabled} onChange={(enabled) => onChange({ ...config, shadow: { ...shadow, enabled } })} />
          {shadow.enabled ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <ColorField id="ov-shadow-color" label={t.overlay.shadowColor} value={shadow.color} onChange={(color) => onChange({ ...config, shadow: { ...shadow, color } })} />
              <SliderField id="ov-shadow-blur" label={t.overlay.shadowBlur} value={shadow.blur} {...LIMITS.shadowBlur} unit=" px" onChange={(blur) => onChange({ ...config, shadow: { ...shadow, blur } })} />
            </div>
          ) : null}
          <SwitchRow id="ov-box" label={t.overlay.box} hint={t.overlay.boxHint} checked={box.enabled} onChange={(enabled) => onChange({ ...config, box: { ...box, enabled } })} />
          {box.enabled ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <ColorField id="ov-box-color" label={t.overlay.boxColor} value={box.color} onChange={(color) => onChange({ ...config, box: { ...box, color } })} />
              <SliderField id="ov-box-opacity" label={t.overlay.boxOpacity} value={box.opacity} {...LIMITS.boxOpacity} unit="%" onChange={(opacity) => onChange({ ...config, box: { ...box, opacity } })} />
              <SliderField id="ov-box-radius" label={t.overlay.boxRadius} value={box.radius} {...LIMITS.boxRadius} unit=" px" onChange={(radius) => onChange({ ...config, box: { ...box, radius } })} />
            </div>
          ) : null}

          <Separator />
          <h3 className="text-sm font-medium">{t.overlay.positionTitle}</h3>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <SelectField
              label={t.overlay.anchor}
              value={config.position.anchor}
              onChange={(anchor) => onChange({ ...config, position: { anchor, y: ANCHOR_Y[anchor] } })}
              options={ANCHORS.map((a) => ({ value: a, label: t.overlay.anchors[a] }))}
            />
            <SelectField label={t.overlay.align} value={config.align} onChange={(align) => onChange({ ...config, align })} options={ALIGNS.map((a) => ({ value: a, label: t.overlay.aligns[a] }))} />
            <SliderField id="ov-y" label={t.overlay.y} value={config.position.y} {...LIMITS.y} unit="%" onChange={(y) => onChange({ ...config, position: { ...config.position, y } })} />
            <SliderField id="ov-width" label={t.overlay.maxWidth} value={config.maxWidthPct} {...LIMITS.maxWidthPct} unit="%" onChange={(maxWidthPct) => onChange({ ...config, maxWidthPct })} />
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
