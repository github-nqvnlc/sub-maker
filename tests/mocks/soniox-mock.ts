import { spawnSync } from 'node:child_process';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { SonioxToken } from '@/lib/providers/adapters/soniox-types';

/**
 * Máy chủ Soniox giả cho kiểm thử tự động (spec 004, T004, Nguyên tắc V): mô phỏng REST async
 * (`/v1/files`, `/v1/transcriptions`, `/transcript`, DELETE, `/v1/models`). Không gọi Soniox thật.
 *
 * Chọn kịch bản bằng tiền tố địa chỉ gốc: baseUrl = `${url}/s/<kịch bản>`; ghép nhiều thành phần bằng `+`:
 *   ok        thành công, transcript tiếng Việt ~9 giây, 2 người nói
 *   401       mọi lệnh gọi trả 401
 *   402       POST /transcriptions trả 402 (hết số dư)
 *   5xx       mọi lệnh gọi trả 503
 *   429-<k>   k yêu cầu đầu (bất kỳ) trả 429 `retry-after: 0`
 *   empty     transcript không có token (không có giọng nói)
 *   fail      transcription kết thúc `status: "error"`
 *   slow-<n>  transcription ở `processing` trong n lần poll đầu
 *   delfail   DELETE trả 500
 *   nodur     không trả `audio_duration_ms`
 *   onset     mốc lời nói dời tới đúng lúc âm thanh ĐÃ NHẬN bắt đầu có tiếng (spec 006)
 * Yêu cầu có `translation` (spec 006) nhận kết quả song ngữ một chiều.
 */

export type SonioxRequest = { method: string; path: string; scenario: string; auth: string | undefined; body: string; bytes: number };

export type SonioxMock = {
  url: string;
  baseUrl: (scenario?: string) => string;
  requests: SonioxRequest[];
  /** id file/transcription đã bị xóa (để kiểm tra dọn dữ liệu) */
  deleted: { files: Set<string>; transcriptions: Set<string> };
  reset(): void;
  close(): Promise<void>;
};

const S = (text: string, start_ms: number, end_ms: number, speaker?: string): SonioxToken => ({ text, start_ms, end_ms, confidence: 0.97, ...(speaker ? { speaker } : {}) });

/** Token dưới-từ mẫu: hai người nói, có khoảng lặng, dấu câu là token riêng. */
export const SAMPLE_TOKENS: SonioxToken[] = [
  S('Xin', 120, 380, '1'),
  S(' chào', 400, 700, '1'),
  S(' các', 720, 900, '1'),
  S(' bạn', 920, 1200, '1'),
  S('.', 1200, 1210, '1'),
  S(' Hôm', 1800, 2050, '1'),
  S(' nay', 2060, 2300, '1'),
  S(' chúng', 2320, 2600, '1'),
  S(' ta', 2610, 2800, '1'),
  S(' học', 2820, 3100, '1'),
  S(' bài', 3120, 3350, '1'),
  S(' mới', 3360, 3700, '1'),
  S('.', 3700, 3710, '1'),
  S(' Vâng', 4500, 4800, '2'),
  S(',', 4800, 4810, '2'),
  S(' cảm', 4900, 5150, '2'),
  S(' ơn', 5160, 5400, '2'),
  S(' thầy', 5420, 5800, '2'),
  S('.', 5800, 5810, '2'),
];

/**
 * Kết quả dịch một chiều (spec 006): mỗi cụm lời gốc có mốc, theo sau là cụm lời dịch KHÔNG có mốc. Ba câu, hai người nói.
 */
type Phrase = { speaker: string; start: number; end: number; source: string; target: string };

function translated(phrases: Phrase[], from: string, to: string): SonioxToken[] {
  return phrases.flatMap((p) => {
    const words = p.source.split(' ');
    const step = (p.end - p.start) / words.length;
    const original: SonioxToken[] = words.map((w, i) => ({ ...S(` ${w}`, Math.round(p.start + i * step), Math.round(p.start + (i + 1) * step - 20), p.speaker), language: from, translation_status: 'original' }));
    const translation = p.target.split(' ').map((w) => ({ text: ` ${w}`, confidence: 0.95, language: to, speaker: p.speaker, translation_status: 'translation' }) as unknown as SonioxToken);
    return [...original, ...translation];
  });
}

const EN_PHRASES: Phrase[] = [
  { speaker: '1', start: 120, end: 1200, source: 'Hello everyone.', target: 'Xin chào mọi người.' },
  { speaker: '1', start: 1800, end: 3700, source: 'Today we learn something new.', target: 'Hôm nay chúng ta học điều mới.' },
  { speaker: '2', start: 4500, end: 5800, source: 'Thank you, teacher.', target: 'Cảm ơn thầy.' },
];

export const TRANSLATED_TO_VI = translated(EN_PHRASES, 'en', 'vi');
export const TRANSLATED_TO_EN = translated(
  EN_PHRASES.map((p) => ({ ...p, source: p.target, target: p.source })),
  'vi',
  'en',
);

/** Thân tệp trong yêu cầu multipart tải âm thanh lên. */
function filePart(raw: Buffer): Buffer {
  const start = raw.indexOf('\r\n\r\n') + 4;
  const end = raw.lastIndexOf('\r\n--');
  return raw.subarray(start, end);
}

/** Mốc (ms) âm thanh đầu tiên có tiếng trong tệp đã nhận: kịch bản `onset` đặt mốc lời nói theo đúng âm thanh được gửi. */
function onsetMs(audio: Buffer): number {
  const r = spawnSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-f', 's16le', '-ac', '1', '-ar', '16000', 'pipe:1'], { input: audio, maxBuffer: 64 * 1024 * 1024 });
  for (let i = 0; i + 1 < r.stdout.length; i += 2) if (Math.abs(r.stdout.readInt16LE(i)) > 1000) return Math.round(i / 32);
  return 0;
}

export type SonioxHandler = Pick<SonioxMock, 'requests' | 'deleted' | 'reset'> & {
  /** Xử lý một yêu cầu có đường dẫn `/s/<kịch bản>/v1/...`. */
  handle(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<void>;
};

/** Bộ xử lý dùng chung cho máy chủ Soniox giả của kiểm thử và của máy chủ nhà cung cấp giả (E2E). */
export function createSonioxHandler(): SonioxHandler {
  const requests: SonioxRequest[] = [];
  const files = new Map<string, Buffer>();
  const transcriptions = new Map<string, { fileId: string; polls: number; scenario: string; body: Record<string, unknown> }>();
  const deleted = { files: new Set<string>(), transcriptions: new Set<string>() };
  let served429 = 0;

  const reset = () => {
    requests.length = 0;
    files.clear();
    transcriptions.clear();
    deleted.files.clear();
    deleted.transcriptions.clear();
    served429 = 0;
  };

  const send = (res: http.ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };
  const err = (res: http.ServerResponse, status: number, type: string, headers: Record<string, string> = {}) =>
    send(res, status, { status_code: status, error_type: type, message: type, request_id: randomUUID() }, headers);

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<unknown> => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks);
    const m = /^\/s\/([^/]+)\/v1\/(.*)$/.exec(pathname);
    if (!m) return err(res, 404, 'not_found');
    const scenario = decodeURIComponent(m[1]!);
    const rest = m[2]!;
    const parts = scenario.split('+');
    const has = (p: string) => parts.includes(p);
    const num = (prefix: string) => {
      const x = parts.find((p) => p.startsWith(prefix));
      return x ? Number(x.slice(prefix.length)) : 0;
    };
    requests.push({
      method: req.method ?? 'GET',
      path: `/v1/${rest}`,
      scenario,
      auth: req.headers.authorization,
      body: req.headers['content-type']?.includes('json') ? raw.toString('utf8') : '',
      bytes: raw.length,
    });

    if (!req.headers.authorization?.startsWith('Bearer ') || has('401')) return err(res, 401, 'unauthenticated');
    if (has('5xx')) return err(res, 503, 'service_unavailable');
    const limit429 = num('429-');
    if (served429 < limit429) {
      served429++;
      return err(res, 429, 'rate_limit_exceeded', { 'retry-after': '0' });
    }

    const method = req.method ?? 'GET';
    if (method === 'DELETE') {
      if (has('delfail')) return err(res, 500, 'internal_error');
      const d = /^(files|transcriptions)\/([^/]+)$/.exec(rest);
      if (!d) return err(res, 404, 'not_found');
      if (d[1] === 'files') {
        if (!files.delete(d[2]!)) return err(res, 404, 'file_not_found');
        deleted.files.add(d[2]!);
      } else {
        if (!transcriptions.delete(d[2]!)) return err(res, 404, 'transcription_not_found');
        deleted.transcriptions.add(d[2]!);
      }
      res.writeHead(204);
      return res.end();
    }
    if (method === 'GET' && rest === 'models') return send(res, 200, { models: [{ id: 'stt-async-v6' }, { id: 'stt-rt-v6' }] });
    if (method === 'POST' && rest === 'files') {
      if (!String(req.headers['content-type']).startsWith('multipart/form-data')) return err(res, 400, 'invalid_request');
      const id = randomUUID();
      files.set(id, raw);
      return send(res, 201, { id, filename: 'audio.mp3', size: raw.length, created_at: new Date().toISOString() });
    }
    if (method === 'POST' && rest === 'transcriptions') {
      if (has('402')) return err(res, 402, 'insufficient_balance');
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
      } catch {
        return err(res, 400, 'invalid_request');
      }
      if (typeof body.file_id !== 'string' || !files.has(body.file_id)) return err(res, 400, 'file_not_found');
      const id = randomUUID();
      transcriptions.set(id, { fileId: body.file_id, polls: 0, scenario, body });
      return send(res, 201, { id, status: 'queued', model: body.model, file_id: body.file_id, created_at: new Date().toISOString() });
    }
    const t = /^transcriptions\/([^/]+)(\/transcript)?$/.exec(rest);
    if (method === 'GET' && t) {
      const tr = transcriptions.get(t[1]!);
      if (!tr) return err(res, 404, 'transcription_not_found');
      const slow = num('slow-');
      if (!t[2]) {
        tr.polls++;
        const status = has('fail') ? 'error' : tr.polls <= slow ? 'processing' : 'completed';
        return send(res, 200, {
          id: t[1],
          status,
          model: tr.body.model,
          ...(has('nodur') ? {} : { audio_duration_ms: 9000 }),
          error_type: status === 'error' ? 'audio_decode_failed' : null,
          error_message: status === 'error' ? 'Audio decode failed' : null,
        });
      }
      const translation = tr.body.translation as { target_language?: string } | undefined;
      let tokens = has('empty') ? [] : translation ? (translation.target_language === 'en' ? TRANSLATED_TO_EN : TRANSLATED_TO_VI) : SAMPLE_TOKENS;
      const audio = files.get(tr.fileId);
      if (has('onset') && audio && tokens.length > 0) {
        const shift = onsetMs(filePart(audio)) - tokens[0]!.start_ms;
        tokens = tokens.map((x) => (x.translation_status === 'translation' ? x : { ...x, start_ms: x.start_ms + shift, end_ms: x.end_ms + shift }));
      }
      return send(res, 200, { id: t[1], text: tokens.map((x) => x.text).join(''), tokens });
    }
    return err(res, 404, 'not_found');
  };

  return { requests, deleted, reset, handle: async (req, res, pathname) => void (await handle(req, res, pathname)) };
}

export async function startSonioxMock(): Promise<SonioxMock> {
  const handler = createSonioxHandler();
  const server = http.createServer((req, res) => void handler.handle(req, res, new URL(req.url ?? '/', 'http://mock').pathname));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    baseUrl: (scenario = 'ok') => `${url}/s/${encodeURIComponent(scenario)}`,
    requests: handler.requests,
    deleted: handler.deleted,
    reset: handler.reset,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
