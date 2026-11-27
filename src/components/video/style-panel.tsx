'use client';

import { RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { SelectField, SwitchRow } from '@/components/overlay/fields';
import { SliderField } from '@/components/overlay/slider-field';
import { ColorField } from '@/components/shared/color-field';
import { useT } from '@/lib/i18n/client';
import { FONT_FAMILIES, FONT_LABELS, hasWeight } from '@/lib/overlay/fonts';
import type { StyleSaveStatus } from '@/lib/video/style-store';
import { DEFAULT_VIDEO_STYLE, DISPLAYS, STYLE_ALIGNS, STYLE_ANCHOR_Y, STYLE_ANCHORS, STYLE_LIMITS, STYLE_WEIGHTS, type VideoStyle } from '@/lib/video/style';

type WeightKey = '400' | '600' | '700' | '800';

/** Kiểu chữ, chế độ hiển thị và vị trí của phụ đề trên video (spec 006, US4; FR-026..FR-029, FR-031). */
export function StylePanel({ style, status, onChange }: { style: VideoStyle; status: StyleSaveStatus; onChange: (style: VideoStyle) => void }) {
  const t = useT();
  const e = t.video.editor;
  const s = e.style;
  const o = t.overlay;
  const { font, sourceLine, stroke, shadow, box } = style;
  const textSwatches = [
    { value: '#FFFFFF', label: o.swatches.white },
    { value: '#FFE600', label: o.swatches.yellow },
    { value: '#000000', label: o.swatches.black },
  ];
  const saveText = { saved: e.save.saved, pending: e.save.dirty, saving: e.save.saving, error: null }[status];
  /** Đè cả kiểu của việc và kiểu gần nhất của Project nên phải hoàn tác được. */
  const reset = () => {
    const before = style;
    if (JSON.stringify(before) === JSON.stringify(DEFAULT_VIDEO_STYLE)) return;
    onChange(structuredClone(DEFAULT_VIDEO_STYLE));
    toast.success(s.resetDone, { action: { label: e.tools.undo, onClick: () => onChange(before) } });
  };

  return (
    <section className="space-y-3" aria-labelledby="video-style-title">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="video-style-title" className="text-base font-semibold">
          {s.title}
        </h2>
        {saveText ? (
          <span role="status" className="ml-auto text-xs text-muted-foreground" data-testid="style-save-status">
            {saveText}
          </span>
        ) : null}
        <Button size="sm" variant="outline" className={saveText ? undefined : 'ml-auto'} onClick={reset}>
          <RotateCcw className="size-3.5" />
          {s.reset}
        </Button>
      </div>
      <Card>
        <CardContent className="space-y-4 p-5">
          <SelectField label={s.display} value={style.display} onChange={(display) => onChange({ ...style, display })} options={DISPLAYS.map((d) => ({ value: d, label: s.displays[d] }))} />

          <Separator />
          <h3 className="text-sm font-medium">{o.textGroup}</h3>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <SelectField
              label={o.font}
              value={font.family}
              onChange={(family) => onChange({ ...style, font: { ...font, family, weight: hasWeight(family, font.weight) ? font.weight : 700 } })}
              options={FONT_FAMILIES.map((f) => ({ value: f, label: FONT_LABELS[f] }))}
            />
            <SelectField
              label={o.fontWeight}
              value={String(font.weight) as WeightKey}
              onChange={(w) => onChange({ ...style, font: { ...font, weight: Number(w) as VideoStyle['font']['weight'] } })}
              options={STYLE_WEIGHTS.map((w) => {
                const key = String(w) as WeightKey;
                const ok = hasWeight(font.family, w);
                return { value: key, label: ok ? s.weights[key] : `${s.weights[key]} (${o.weightMissing})`, disabled: !ok };
              })}
            />
            <div className="space-y-2">
              <SliderField id="vs-size" label={o.fontSize} value={font.size} {...STYLE_LIMITS.size} unit=" px" onChange={(size) => onChange({ ...style, font: { ...font, size } })} />
              <p className="text-xs text-muted-foreground">{s.sizeHint}</p>
            </div>
            <ColorField id="vs-color" label={o.textColor} value={style.color} swatches={textSwatches} onChange={(color) => onChange({ ...style, color })} />
          </div>

          {style.display === 'bilingual' ? (
            <>
              <Separator />
              <h3 className="text-sm font-medium">{s.sourceGroup}</h3>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <SliderField id="vs-source-size" label={s.sourceSize} value={sourceLine.size} {...STYLE_LIMITS.size} unit=" px" onChange={(size) => onChange({ ...style, sourceLine: { ...sourceLine, size } })} />
                <ColorField id="vs-source-color" label={s.sourceColor} value={sourceLine.color} swatches={textSwatches} onChange={(color) => onChange({ ...style, sourceLine: { ...sourceLine, color } })} />
                <SliderField id="vs-source-opacity" label={s.sourceOpacity} value={sourceLine.opacity} {...STYLE_LIMITS.opacity} unit="%" onChange={(opacity) => onChange({ ...style, sourceLine: { ...sourceLine, opacity } })} />
              </div>
            </>
          ) : null}

          <Separator />
          <h3 className="text-sm font-medium">{o.decorGroup}</h3>
          <SwitchRow id="vs-stroke" label={o.stroke} checked={stroke.enabled} onChange={(enabled) => onChange({ ...style, stroke: { ...stroke, enabled } })} />
          {stroke.enabled ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <ColorField id="vs-stroke-color" label={o.strokeColor} value={stroke.color} onChange={(color) => onChange({ ...style, stroke: { ...stroke, color } })} />
              <SliderField id="vs-stroke-width" label={o.strokeWidth} value={stroke.width} {...STYLE_LIMITS.strokeWidth} unit=" px" onChange={(width) => onChange({ ...style, stroke: { ...stroke, width } })} />
            </div>
          ) : null}
          <SwitchRow id="vs-shadow" label={o.shadow} checked={shadow.enabled} onChange={(enabled) => onChange({ ...style, shadow: { ...shadow, enabled } })} />
          {shadow.enabled ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <ColorField id="vs-shadow-color" label={o.shadowColor} value={shadow.color} onChange={(color) => onChange({ ...style, shadow: { ...shadow, color } })} />
              <SliderField id="vs-shadow-blur" label={o.shadowBlur} value={shadow.blur} {...STYLE_LIMITS.shadowBlur} unit=" px" onChange={(blur) => onChange({ ...style, shadow: { ...shadow, blur } })} />
              <SliderField id="vs-shadow-distance" label={s.shadowDistance} value={shadow.distance} {...STYLE_LIMITS.shadowDistance} unit=" px" onChange={(distance) => onChange({ ...style, shadow: { ...shadow, distance } })} />
              <SliderField id="vs-shadow-opacity" label={s.shadowOpacity} value={shadow.opacity} {...STYLE_LIMITS.opacity} unit="%" onChange={(opacity) => onChange({ ...style, shadow: { ...shadow, opacity } })} />
            </div>
          ) : null}
          <SwitchRow id="vs-box" label={o.box} hint={s.boxHint} checked={box.enabled} onChange={(enabled) => onChange({ ...style, box: { ...box, enabled } })} />
          {box.enabled ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <ColorField id="vs-box-color" label={o.boxColor} value={box.color} onChange={(color) => onChange({ ...style, box: { ...box, color } })} />
              <SliderField id="vs-box-opacity" label={o.boxOpacity} value={box.opacity} {...STYLE_LIMITS.opacity} unit="%" onChange={(opacity) => onChange({ ...style, box: { ...box, opacity } })} />
              <SliderField id="vs-box-radius" label={o.boxRadius} value={box.radius} {...STYLE_LIMITS.boxRadius} unit=" px" onChange={(radius) => onChange({ ...style, box: { ...box, radius } })} />
            </div>
          ) : null}

          <Separator />
          <h3 className="text-sm font-medium">{o.positionTitle}</h3>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <SelectField
              label={o.anchor}
              value={style.position.anchor}
              onChange={(anchor) => onChange({ ...style, position: { anchor, y: STYLE_ANCHOR_Y[anchor] } })}
              options={STYLE_ANCHORS.map((a) => ({ value: a, label: o.anchors[a] }))}
            />
            <SelectField label={o.align} value={style.align} onChange={(align) => onChange({ ...style, align })} options={STYLE_ALIGNS.map((a) => ({ value: a, label: o.aligns[a] }))} />
            <SliderField id="vs-y" label={o.y} value={style.position.y} {...STYLE_LIMITS.y} unit="%" onChange={(y) => onChange({ ...style, position: { ...style.position, y } })} />
            <SliderField id="vs-width" label={o.maxWidth} value={style.maxWidthPct} {...STYLE_LIMITS.maxWidthPct} unit="%" onChange={(maxWidthPct) => onChange({ ...style, maxWidthPct })} />
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
