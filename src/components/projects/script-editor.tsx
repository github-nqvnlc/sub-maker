'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Code2,
  FilePlus2,
  FileText,
  ListOrdered,
  RotateCcw,
  Sparkles,
} from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, api } from '@/lib/api-client';
import { useT } from '@/lib/i18n/client';
import { cn } from '@/lib/utils';

export type ScriptFormat = 'srt' | 'txt' | 'md';

type Uploaded = { id: string };

const TIME_RE = /^\s*((?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)\s*-->\s*((?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)/;
const CUE_INDEX_RE = /^\s*\d{1,6}\s*$/;

function formatSrtTime(totalMs: number): string {
  const ms = Math.max(0, totalMs);
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1_000);
  const millis = ms % 1_000;

  const hh = String(hours).padStart(2, '0');
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  const mmm = String(millis).padStart(3, '0');

  return `${hh}:${mm}:${ss},${mmm}`;
}

function parseTimeMs(t: string): number {
  const [main = '0:00', frac = ''] = t.replace(',', '.').split('.');
  const parts = main.split(':').map(Number);
  const [h, m, sec] = parts.length === 3 ? [parts[0]!, parts[1]!, parts[2]!] : [0, parts[0]!, parts[1]!];
  return ((h * 60 + m) * 60 + sec) * 1000 + Number((frac + '000').slice(0, 3));
}

function countSrtCues(text: string): { count: number; lastEndMs: number; lastIndex: number } {
  const lines = text.split('\n');
  let count = 0;
  let lastEndMs = 0;
  let lastIndex = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const match = TIME_RE.exec(line);
    if (match) {
      count++;
      const endMs = parseTimeMs(match[2]!);
      if (endMs > lastEndMs) lastEndMs = endMs;
      const prevLine = i > 0 ? lines[i - 1]!.trim() : '';
      if (CUE_INDEX_RE.test(prevLine)) {
        const num = Number(prevLine);
        if (num > lastIndex) lastIndex = num;
      }
    }
  }

  return { count, lastEndMs, lastIndex: lastIndex || count };
}

export function ScriptEditor({
  projectId,
  onCreated,
  className,
}: {
  projectId: string;
  onCreated?: (fileId: string) => void;
  className?: string;
}) {
  const t = useT();
  const qc = useQueryClient();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [format, setFormat] = useState<ScriptFormat>('srt');
  const [fileName, setFileName] = useState('');
  const [content, setContent] = useState('');
  const [error, setError] = useState<string | null>(null);

  const charCount = content.length;
  const lineCount = content ? content.split('\n').length : 0;
  const srtStats = format === 'srt' ? countSrtCues(content) : null;

  const templates: Record<ScriptFormat, string> = {
    srt: t.files.templateSrt,
    txt: t.files.templateTxt,
    md: t.files.templateMd,
  };

  const createMutation = useMutation({
    mutationFn: async ({ name, text, ext }: { name: string; text: string; ext: ScriptFormat }) => {
      const cleanName = (name.trim() || `script-${Date.now().toString().slice(-4)}`).replace(
        /\.(srt|txt|md)$/i,
        '',
      );
      const fullName = `${cleanName}.${ext}`;
      const file = new File([text], fullName, { type: 'text/plain;charset=utf-8' });

      const form = new FormData();
      form.set('file', file);
      return api<Uploaded>(`/api/projects/${projectId}/files`, { method: 'POST', body: form });
    },
    onSuccess: (res) => {
      setError(null);
      toast.success(t.files.subtitleCreated);
      void qc.invalidateQueries({ queryKey: ['project', projectId] });
      setContent('');
      setFileName('');
      onCreated?.(res.id);
    },
    onError: (e) => {
      const msg = e instanceof ApiError ? (e.fields?.file ?? e.message) : t.common.genericError;
      setError(msg);
    },
  });

  function handleInsertCue() {
    const nextIdx = (srtStats?.lastIndex ?? 0) + 1;
    const startMs = srtStats && srtStats.count > 0 ? srtStats.lastEndMs + 500 : 0;
    const endMs = startMs + 3500;
    const startTimeStr = formatSrtTime(startMs);
    const endTimeStr = formatSrtTime(endMs);

    const cueBlock = `${nextIdx}\n${startTimeStr} --> ${endTimeStr}\n${t.files.newCueText}\n`;

    const el = textareaRef.current;
    if (!el) {
      setContent((prev) => (prev ? `${prev.trimEnd()}\n\n${cueBlock}` : cueBlock));
      return;
    }

    const start = el.selectionStart ?? content.length;
    const end = el.selectionEnd ?? content.length;
    const needsPrefixBreak = start > 0 && !content.slice(0, start).endsWith('\n\n');
    const prefix = needsPrefixBreak ? '\n\n' : '';
    const newText = content.slice(0, start) + prefix + cueBlock + content.slice(end);

    setContent(newText);
    setTimeout(() => {
      el.focus();
      const pos = start + prefix.length + cueBlock.length;
      el.setSelectionRange(pos, pos);
    }, 0);
  }

  function handleLoadTemplate() {
    setContent(templates[format]);
    setError(null);
  }

  function handleClear() {
    setContent('');
    setError(null);
  }

  function handleNormalizeSrt() {
    if (format !== 'srt') return;
    const lines = content.replace(/\r\n/g, '\n').split('\n');
    const cues: { start: string; end: string; text: string[] }[] = [];

    for (let i = 0; i < lines.length; i++) {
      const match = TIME_RE.exec(lines[i]!);
      if (match) {
        const start = match[1]!;
        const end = match[2]!;
        const texts: string[] = [];
        let j = i + 1;
        while (j < lines.length && lines[j]!.trim() !== '') {
          if (TIME_RE.test(lines[j]!)) break;
          texts.push(lines[j]!.trim());
          j++;
        }
        cues.push({ start, end, text: texts });
        i = j - 1;
      }
    }

    if (cues.length === 0) {
      toast.error(t.files.invalidSrtBadge);
      return;
    }

    const formatted = cues
      .map((c, idx) => `${idx + 1}\n${c.start} --> ${c.end}\n${c.text.join('\n') || '...'}`)
      .join('\n\n');

    setContent(formatted + '\n');
    toast.success(t.files.normalizedSrt);
  }

  function handleSubmit() {
    if (!content.trim()) {
      setError(t.files.contentRequired);
      return;
    }

    createMutation.mutate({
      name: fileName,
      text: content,
      ext: format,
    });
  }

  return (
    <Card className={cn('border-muted-foreground/20 shadow-sm', className)}>
      <CardHeader className="space-y-3 pb-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2 text-base font-semibold">
              <FileText className="size-4 text-primary" />
              {t.files.editorTitle}
            </CardTitle>
            <CardDescription className="text-xs">{t.files.editorDesc}</CardDescription>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{t.files.format}:</span>
            <Tabs
              value={format}
              onValueChange={(val) => {
                const nextFmt = val as ScriptFormat;
                setFormat(nextFmt);
                setError(null);
              }}
            >
              <TabsList className="h-8">
                <TabsTrigger value="srt" className="text-xs px-2.5">
                  .srt
                </TabsTrigger>
                <TabsTrigger value="txt" className="text-xs px-2.5">
                  .txt
                </TabsTrigger>
                <TabsTrigger value="md" className="text-xs px-2.5">
                  .md
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          <div className="flex items-center gap-1.5 flex-1 min-w-[200px] max-w-sm">
            <Label htmlFor="editor-filename" className="sr-only">
              {t.files.fileNameLabel}
            </Label>
            <Input
              id="editor-filename"
              placeholder={t.files.fileNamePlaceholder}
              value={fileName}
              onChange={(e) => setFileName(e.target.value)}
              className="h-8 text-xs font-mono"
            />
            <Badge variant="outline" className="h-8 px-2 text-xs font-mono shrink-0">
              .{format}
            </Badge>
          </div>

          <div className="flex flex-wrap items-center gap-1.5 ml-auto">
            {format === 'srt' ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleInsertCue}
                  className="h-8 gap-1 text-xs"
                  title={t.files.insertCueTitle}
                >
                  <Clock className="size-3.5 text-primary" />
                  {t.files.insertCue}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleNormalizeSrt}
                  className="h-8 gap-1 text-xs"
                  title={t.files.formatSrtTitle}
                >
                  <ListOrdered className="size-3.5" />
                  {t.files.formatSrt}
                </Button>
              </>
            ) : null}

            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleLoadTemplate}
              className="h-8 gap-1 text-xs"
              title={t.files.sampleTemplateTitle}
            >
              <Code2 className="size-3.5" />
              {t.files.sampleTemplate}
            </Button>

            {content ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleClear}
                className="h-8 px-2 text-xs text-muted-foreground hover:text-foreground"
                title={t.files.clearContentTitle}
              >
                <RotateCcw className="size-3.5" />
              </Button>
            ) : null}
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-2 pb-3">
        <Textarea
          ref={textareaRef}
          value={content}
          onChange={(e) => {
            setContent(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Tab') {
              e.preventDefault();
              const el = e.currentTarget;
              const start = el.selectionStart;
              const end = el.selectionEnd;
              const val = el.value;
              setContent(val.substring(0, start) + '  ' + val.substring(end));
              setTimeout(() => {
                el.selectionStart = el.selectionEnd = start + 2;
              }, 0);
            }
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              handleSubmit();
            }
          }}
          placeholder={
            format === 'srt'
              ? t.files.placeholderSrt
              : format === 'md'
                ? t.files.placeholderMd
                : t.files.placeholderTxt
          }
          className="min-h-[280px] max-h-[460px] font-mono text-xs leading-relaxed resize-y"
          spellCheck={false}
        />

        {error ? (
          <p role="alert" className="flex items-center gap-1.5 text-xs text-destructive">
            <AlertCircle className="size-3.5 shrink-0" />
            {error}
          </p>
        ) : null}
      </CardContent>

      <CardFooter className="flex flex-wrap items-center justify-between gap-3 border-t bg-muted/20 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>
            {charCount} {t.files.chars}
          </span>
          <span>·</span>
          <span>
            {lineCount} {t.files.lines}
          </span>

          {format === 'srt' ? (
            <>
              <span>·</span>
              {srtStats && srtStats.count > 0 ? (
                <Badge
                  variant="secondary"
                  className="gap-1 font-normal text-emerald-600 dark:text-emerald-400 bg-emerald-500/10"
                >
                  <CheckCircle2 className="size-3" />
                  {t.files.validSrtBadge.replace('{n}', String(srtStats.count))}
                </Badge>
              ) : content.trim() ? (
                <Badge
                  variant="outline"
                  className="gap-1 font-normal text-amber-600 dark:text-amber-400 border-amber-500/30"
                >
                  <AlertCircle className="size-3" />
                  {t.files.invalidSrtBadge}
                </Badge>
              ) : null}
            </>
          ) : null}
        </div>

        <Button
          type="button"
          onClick={handleSubmit}
          disabled={createMutation.isPending || !content.trim()}
          className="ml-auto font-medium shadow-sm gap-2"
        >
          {createMutation.isPending ? (
            <>
              <Sparkles className="size-4 animate-spin" />
              {t.files.creatingSubtitle}
            </>
          ) : (
            <>
              <FilePlus2 className="size-4" />
              {t.files.createSubtitle}
            </>
          )}
        </Button>
      </CardFooter>
    </Card>
  );
}
