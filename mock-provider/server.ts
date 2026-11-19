import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

/**
 * Máy chủ nhà cung cấp TTS giả dùng cho kiểm thử (Nguyên tắc V): mô phỏng FPT Marketplace và ShopAIKey (OpenAI TTS, MiniMax).
 *
 * Chọn kịch bản bằng tiền tố đường dẫn của địa chỉ gốc:
 *   FPT Marketplace   baseUrl = `${url}/s/<scenario>/v1`       → POST /audio/speech
 *   ShopAIKey         baseUrl = `${url}/s/<scenario>`          → POST /tts/openai/speech
 *   ShopAIKey MiniMax baseUrl = `${url}/s/<scenario>`          → POST /tts/minimax/t2a_v2 (audio dạng hex; lỗi nghiệp vụ nằm trong base_resp)
 *   Kịch bản riêng của MiniMax: `mm-<mã>` (HTTP 200 kèm base_resp.status_code = mã) | `bad-hex`
 *
 * Kịch bản: ok | 429-then-ok | 5xx | 401 | 403-quota | 403-model | 400-policy |
 *           policy-marker | 400-voice | malformed | timeout | redirect-internal | oversize |
 *           ok-then-5xx-<N> | delay-<ms>
 *   - `policy-marker`: chỉ chặn (400 policy) khi văn bản chứa "[BLOCK]", còn lại thành công.
 *   - `429-then-ok`: mỗi văn bản bị 429 ở lần gọi đầu tiên, các lần sau thành công.
 *   - `ok-then-5xx-<N>`: N yêu cầu POST đầu thành công, sau đó 503 cho tới khi `reset()` (mô phỏng sự cố giữa chừng).
 *   - `delay-<ms>`: thành công nhưng phản hồi sau <ms> mili giây (để thử dừng tiến trình giữa chừng).
 */

export type RecordedRequest = {
  ts: number;
  scenario: string;
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
};

export type MockProvider = {
  url: string;
  requests: RecordedRequest[];
  reset(): void;
  close(): Promise<void>;
};

const SAMPLE_RATE = 24_000;
const MS_PER_CHAR = 55;
const MIN_MS = 400;

/** WAV PCM 16-bit mono chứa một âm sin nhẹ, độ dài tính theo số ký tự. */
export function makeWav(durationMs: number, sampleRate = SAMPLE_RATE, freq = 220): Buffer {
  const samples = Math.max(1, Math.round((durationMs / 1000) * sampleRate));
  const dataLen = samples * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < samples; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * freq * i) / sampleRate) * 3000);
    buf.writeInt16LE(v, 44 + i * 2);
  }
  return buf;
}

export function expectedDurationMs(text: string): number {
  return Math.max(MIN_MS, [...text].length * MS_PER_CHAR);
}

const VALID_VOICES = 'banmai, thuminh, leminh, minhquan, ngoclam, giahuy, kimngan, hatieumai, huyphong';

export async function startMockProvider(opts: { port?: number } = {}): Promise<MockProvider> {
  const requests: RecordedRequest[] = [];
  const seenOnce = new Set<string>();
  let postCount = 0;
  const files = new Map<string, { wav: Buffer; polls: number; needPolls: number }>();
  const sockets = new Set<import('node:net').Socket>();
  let pending: Array<() => void> = [];

  const hash = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 12);

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString('utf8');
    const rawUrl = new URL(req.url ?? '/', 'http://mock');

    if (rawUrl.pathname === '/__requests') return json(res, 200, requests);
    if (rawUrl.pathname === '/__reset' && req.method === 'POST') {
      reset();
      return json(res, 200, { ok: true });
    }

    const m = /^\/s\/([^/]+)(\/.*)$/.exec(rawUrl.pathname);
    // Link file chung: /files/<id>.wav (không cần tiền tố kịch bản)
    const fileMatch = /^\/(?:s\/[^/]+\/)?files\/([a-z0-9-]+)\.wav$/.exec(rawUrl.pathname);
    const scenario = m?.[1] ?? 'ok';
    const rest = m?.[2] ?? rawUrl.pathname;

    requests.push({
      ts: Date.now(),
      scenario,
      method: req.method ?? 'GET',
      path: rawUrl.pathname,
      headers: { ...req.headers },
      body,
    });

    if (fileMatch) return serveFile(res, scenario, fileMatch[1]!);

    const origin = `http://${req.headers.host}`;

    // ----- FPT Marketplace: POST /v1/audio/speech (baseUrl kết thúc bằng /v1) -----
    if (req.method === 'POST' && rest === '/v1/audio/speech') {
      const auth = String(req.headers['authorization'] ?? '');
      if (scenario === '401' || !auth.startsWith('Bearer ')) return json(res, 401, { error: { message: 'Invalid token' } });
      let payload: { model?: string; voice?: string; input?: string } = {};
      try {
        payload = JSON.parse(body);
      } catch {
        return json(res, 400, { error: { message: 'invalid json' } });
      }
      const text = payload.input ?? '';
      if (scenario === '400-voice') {
        return json(res, 400, {
          error: { message: `voice '${payload.voice}' is not available for model '${payload.model}'. Valid voices: ${VALID_VOICES}` },
        });
      }
      if (scenario === '403-model') return json(res, 403, { error: { message: `no access to model ${payload.model}` } });
      const early = await commonFailures(res, scenario, text, 'mkp');
      if (early) return;
      res.writeHead(200, { 'content-type': 'audio/wav' });
      return res.end(makeWav(expectedDurationMs(text)));
    }

    // ----- ShopAIKey: POST /tts/openai/speech -----
    if (req.method === 'POST' && rest === '/tts/openai/speech') {
      const auth = String(req.headers['authorization'] ?? '');
      if (scenario === '401' || !auth.startsWith('Bearer ')) return json(res, 401, { error: { message: 'Invalid token' } });
      let payload: { input?: string; voice?: string } = {};
      try {
        payload = JSON.parse(body);
      } catch {
        return json(res, 400, { error: { message: 'invalid json' } });
      }
      const text = payload.input ?? '';
      if (scenario === '403-model') {
        return json(res, 503, { error: { message: 'No available channel for model tts-1 under group default' } });
      }
      const early = await commonFailures(res, scenario, text, 'sak');
      if (early) return;
      const id = randomUUID();
      files.set(id, { wav: makeWav(expectedDurationMs(text)), polls: 0, needPolls: 0 });
      const url =
        scenario === 'redirect-internal' ? 'http://169.254.169.254/latest/meta-data/' : `${origin}/files/${id}.wav`;
      return json(res, 200, { url, key: `audio/${id}.wav`, model: 'tts-1', voice: payload.voice, format: 'wav', mimeType: 'audio/wav' });
    }

    // ----- ShopAIKey MiniMax: POST /tts/minimax/t2a_v2 (HTTP 200 kể cả khi lỗi nghiệp vụ: xem base_resp) -----
    if (req.method === 'POST' && rest === '/tts/minimax/t2a_v2') {
      const auth = String(req.headers['authorization'] ?? '');
      if (scenario === '401' || !auth.startsWith('Bearer ')) return json(res, 401, { error: { message: 'Invalid token' } });
      let payload: { text?: string } = {};
      try {
        payload = JSON.parse(body);
      } catch {
        return json(res, 400, { error: { message: 'invalid json' } });
      }
      const text = payload.text ?? '';
      const biz = /^mm-(\d+)$/.exec(scenario);
      if (biz) {
        postCount += 1;
        return json(res, 200, { base_resp: { status_code: Number(biz[1]), status_msg: 'mock business error' } });
      }
      if (scenario === '400-voice') {
        postCount += 1;
        return json(res, 200, { base_resp: { status_code: 2013, status_msg: 'invalid params, voice id not exist' } });
      }
      if (scenario === '403-model') {
        return json(res, 503, { error: { message: 'No available channel for model speech-02-hd under group default' } });
      }
      const early = await commonFailures(res, scenario, text, 'mm');
      if (early) return;
      if (scenario === 'bad-hex') {
        return json(res, 200, { data: { audio: 'zz-not-hex' }, base_resp: { status_code: 0, status_msg: 'success' } });
      }
      const wav = makeWav(expectedDurationMs(text));
      return json(res, 200, {
        data: { audio: Buffer.from(wav).toString('hex'), status: 2 },
        extra_info: { audio_length: expectedDurationMs(text), audio_sample_rate: SAMPLE_RATE, usage_characters: [...text].length, audio_format: 'wav' },
        trace_id: hash(randomUUID()),
        base_resp: { status_code: 0, status_msg: 'success' },
      });
    }

    return json(res, 404, { error: { message: `mock: không có route ${req.method} ${rawUrl.pathname}` } });
  });

  /** Các lỗi dùng chung; trả true nếu đã phản hồi. */
  async function commonFailures(res: http.ServerResponse, scenario: string, text: string, kind: string): Promise<boolean> {
    postCount += 1;
    const after = /^ok-then-5xx-(\d+)$/.exec(scenario);
    if (after) {
      if (postCount > Number(after[1])) {
        json(res, 503, { error: { message: 'upstream is overloaded' } });
        return true;
      }
      return false;
    }
    const delay = /^delay-(\d+)$/.exec(scenario);
    if (delay) {
      await new Promise<void>((resolve) => {
        pending.push(resolve);
        setTimeout(resolve, Number(delay[1])).unref();
      });
      return false;
    }
    switch (scenario) {
      case '5xx':
        json(res, 503, { error: { message: 'upstream is overloaded' } });
        return true;
      case '403-quota':
        json(res, 403, { error: { message: 'token quota is not enough' } });
        return true;
      case '400-policy':
        json(res, 400, { error: { message: 'Your request was rejected by the content management policy' } });
        return true;
      case 'policy-marker':
        if (text.includes('[BLOCK]')) {
          json(res, 400, { error: { message: 'Your request was rejected by the content management policy' } });
          return true;
        }
        return false;
      case 'malformed':
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"error": 0, "async": ');
        return true;
      case 'timeout':
        await new Promise<void>((resolve) => {
          pending.push(resolve);
          setTimeout(resolve, 120_000).unref();
        });
        if (!res.writableEnded && !res.destroyed) res.destroy();
        return true;
      case '429-then-ok': {
        const key = `${kind}:${hash(text)}`;
        if (!seenOnce.has(key)) {
          seenOnce.add(key);
          res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0' });
          res.end(JSON.stringify({ error: { message: 'rate limit' } }));
          return true;
        }
        return false;
      }
      default:
        return false;
    }
  }

  function serveFile(res: http.ServerResponse, scenario: string, id: string) {
    const f = files.get(id);
    if (!f) return json(res, 404, { error: 'not found' });
    f.polls += 1;
    if (f.polls <= f.needPolls) return json(res, 404, { error: 'not ready' });
    if (scenario === 'oversize') {
      res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': String(500 * 1024 * 1024) });
      return res.end(f.wav);
    }
    res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': String(f.wav.length) });
    return res.end(f.wav);
  }

  function json(res: http.ServerResponse, status: number, data: unknown) {
    if (res.writableEnded) return;
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
  }

  function reset() {
    requests.length = 0;
    seenOnce.clear();
    files.clear();
    postCount = 0;
  }

  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    reset,
    async close() {
      for (const r of pending) r();
      pending = [];
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// Chạy độc lập: `npx tsx mock-provider/server.ts [port]`
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll('\\', '/').split('/').slice(-2).join('/'));
if (isMain) {
  const port = Number(process.argv[2] ?? 4010);
  startMockProvider({ port }).then((m) => console.log(`mock provider: ${m.url}`));
}
