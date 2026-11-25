'use client';

import { WarningList } from '@/components/overlay/warning-list';
import type { OverlayJobDto } from '@/lib/hooks/use-overlay';
import { useT } from '@/lib/i18n/client';
import { usesHighlight } from '@/lib/overlay/colors';
import { usesDuration, usesIntensity } from '@/lib/overlay/config';
import { FONT_LABELS } from '@/lib/overlay/fonts';

/** Cấu hình và cảnh báo đã chốt của một lần xuất (FR-042), chỉ xem. */
export function JobConfig({ job }: { job: OverlayJobDto }) {
  const t = useT();
  const c = job.config;
  const off = t.common.no;
  const rows: Array<[string, string]> = [
    [t.overlay.voice, job.sourceNames.voice],
    [t.overlay.subtitle, job.sourceNames.subtitle],
    [t.overlay.aspect, t.overlay.aspects[c.aspect]],
    [t.overlay.background, t.overlay.backgrounds[c.background]],
    [t.overlay.format, t.overlay.formats[c.format]],
    [t.overlay.includeAudio, c.includeAudio ? t.common.yes : t.common.no],
    [t.overlay.font, `${FONT_LABELS[c.font.family]}, ${c.font.size} px, ${t.overlay.weights[String(c.font.weight) as '400' | '700' | '800']}`],
    [t.overlay.textColor, c.text.color],
    [t.overlay.stroke, c.stroke.enabled ? `${c.stroke.color}, ${c.stroke.width} px` : off],
    [t.overlay.shadow, c.shadow.enabled ? `${c.shadow.color}, ${c.shadow.blur} px` : off],
    [t.overlay.box, c.box.enabled ? `${c.box.color}, ${c.box.opacity}%, ${c.box.radius} px` : off],
    [t.overlay.positionTitle, `${t.overlay.anchors[c.position.anchor]} (${c.position.y}%), ${t.overlay.aligns[c.align]}, ${c.maxWidthPct}%`],
    [t.overlay.sync, t.overlay.syncs[c.sync]],
  ];
  if (c.sync !== 'word') rows.push([t.overlay.enter, t.overlay.enters[c.enter]]);
  if (c.sync !== 'cue') rows.push([t.overlay.wordEffect, t.overlay.wordEffects[c.wordEffect]]);
  rows.push([t.overlay.exit, t.overlay.exits[c.exit]]);
  if (usesDuration(c)) rows.push([t.overlay.effectMs, `${c.effectMs} ms`]);
  if (usesIntensity(c)) rows.push([t.overlay.intensity, t.overlay.intensities[c.intensity]]);
  if (usesHighlight(c)) rows.push([t.overlay.highlightColor, c.highlightColor]);
  if (c.sync !== 'word' && c.enter === 'shake') rows.push([t.overlay.shakeScope, t.overlay.shakeScopes[c.shakeScope]]);

  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="text-right break-words">{value}</dd>
          </div>
        ))}
      </dl>
      <WarningList title={t.overlay.configWarnings} warnings={job.warnings} />
    </div>
  );
}
