import { randomUUID } from 'node:crypto';
import { ProviderError, classifyHttpError, toProviderError } from '../errors';
import type { CallContext, TestResult } from '../types';
import { joinUrl } from './shared';
import {
  isRealtimeModel,
  type SonioxTranscript,
  type SonioxTranscription,
  type SonioxUploadedFile,
  type StartTranscriptionOptions,
} from './soniox-types';

/**
 * Client Soniox STT async (spec 004, contracts/soniox-client.md). Mọi lệnh gọi đi qua `ctx.fetch` (safeFetch, chống SSRF);
 * khóa API chỉ nằm trong header Authorization, không bao giờ trên URL hay trong log.
 * Lỗi luôn là ProviderError: `transient` (mạng, 429, 5xx) được worker thử lại; còn lại là vĩnh viễn.
 */
export class SonioxSttClient {
  constructor(private readonly ctx: CallContext) {}

  private url(path: string) {
    return joinUrl(this.ctx.config.baseUrl, `/v1/${path.replace(/^\/+/, '')}`);
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: `Bearer ${this.ctx.config.apiKey}`, accept: 'application/json', ...extra };
  }

  private async call(path: string, init: Omit<RequestInit, 'headers'> & { headers?: Record<string, string>; allow404?: boolean } = {}): Promise<Response | null> {
    const { allow404, ...rest } = init;
    let res: Response;
    try {
      // Mọi lệnh gọi đều kèm Authorization (kể cả GET/DELETE)
      res = await this.ctx.fetch(this.url(path), { ...rest, headers: this.headers(init.headers), signal: this.ctx.signal });
    } catch (e) {
      if (this.ctx.signal?.aborted) throw e;
      throw toProviderError(e);
    }
    if (res.ok) return res;
    if (res.status === 404 && allow404) return null;
    const body = await res.text().catch(() => '');
    // 402: hết số dư/ngân sách (tài liệu Soniox) → vĩnh viễn, không thử lại
    if (res.status === 402) throw new ProviderError('quota', undefined, 402);
    throw classifyHttpError(res.status, body, res.headers.get('retry-after'));
  }

  private async json<T>(res: Response | null): Promise<T> {
    if (!res) throw new ProviderError('bad_request', undefined, 404);
    try {
      return (await res.json()) as T;
    } catch {
      throw new ProviderError('transient'); // phản hồi 2xx nhưng không phải JSON
    }
  }

  /** POST /v1/files (multipart, trường `file`). */
  async uploadAudioFile(audio: Uint8Array, fileName: string): Promise<{ fileId: string }> {
    const boundary = `----submaker${randomUUID().replace(/-/g, '')}`;
    const safeName = fileName.replace(/["\r\n\\]/g, '_') || 'audio.mp3';
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeName}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      'utf8',
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
    const body = Buffer.concat([head, Buffer.from(audio), tail]);
    const res = await this.call('files', {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      body,
    });
    const file = await this.json<SonioxUploadedFile>(res);
    if (!file?.id) throw new ProviderError('transient');
    return { fileId: file.id };
  }

  /** POST /v1/transcriptions. */
  async startTranscription(fileId: string, opts: StartTranscriptionOptions): Promise<{ transcriptionId: string }> {
    if (isRealtimeModel(opts.model)) throw new ProviderError('forbidden_model');
    const payload: Record<string, unknown> = {
      model: opts.model,
      file_id: fileId,
      enable_speaker_diarization: !!opts.enableSpeakerDiarization,
      enable_language_identification: !!opts.enableLanguageIdentification,
    };
    if (opts.languageHints?.length) payload.language_hints = opts.languageHints;
    if (opts.clientReferenceId) payload.client_reference_id = opts.clientReferenceId.slice(0, 256);
    if (opts.translation) payload.translation = { type: 'one_way', target_language: opts.translation.targetLanguage };
    if (opts.translationTerms?.length) payload.context = { translation_terms: opts.translationTerms.map(({ source, target }) => ({ source, target })) };
    const res = await this.call('transcriptions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const t = await this.json<SonioxTranscription>(res);
    if (!t?.id) throw new ProviderError('transient');
    return { transcriptionId: t.id };
  }

  /** GET /v1/transcriptions/{id}. */
  async getTranscription(transcriptionId: string): Promise<SonioxTranscription> {
    return this.json<SonioxTranscription>(await this.call(`transcriptions/${encodeURIComponent(transcriptionId)}`));
  }

  /** GET /v1/transcriptions/{id}/transcript (chỉ khi completed). */
  async getTranscript(transcriptionId: string): Promise<SonioxTranscript> {
    const t = await this.json<SonioxTranscript>(await this.call(`transcriptions/${encodeURIComponent(transcriptionId)}/transcript`));
    return { id: t.id, text: t.text ?? '', tokens: Array.isArray(t.tokens) ? t.tokens : [] };
  }

  /** DELETE /v1/transcriptions/{id}; 404 coi như đã xóa. */
  async deleteTranscription(transcriptionId: string): Promise<void> {
    await this.call(`transcriptions/${encodeURIComponent(transcriptionId)}`, { method: 'DELETE', allow404: true });
  }

  /** DELETE /v1/files/{id}; 404 coi như đã xóa. */
  async deleteFile(fileId: string): Promise<void> {
    await this.call(`files/${encodeURIComponent(fileId)}`, { method: 'DELETE', allow404: true });
  }

  /** GET /v1/models — kiểm tra khóa API (nút "Kiểm tra kết nối"). */
  async testConnection(): Promise<TestResult & { models?: string[] }> {
    const started = Date.now();
    try {
      const res = await this.call('models');
      const body = await this.json<{ models?: Array<{ id?: string }> }>(res);
      const models = (body.models ?? []).map((m) => m.id).filter((x): x is string => typeof x === 'string');
      return { ok: true, message: 'Kết nối thành công.', latencyMs: Date.now() - started, models };
    } catch (e) {
      const pe = e instanceof ProviderError ? e : toProviderError(e);
      return { ok: false, message: pe.message, latencyMs: Date.now() - started };
    }
  }
}
