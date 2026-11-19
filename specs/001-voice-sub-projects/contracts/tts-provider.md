# Hợp đồng nội bộ: Adapter nhà cung cấp TTS

Nguồn đặc điểm từng dịch vụ: [`docs/fpt-ai-voice-guide.md`](../../../docs/fpt-ai-voice-guide.md),
[`docs/shopaikey-guide.md`](../../../docs/shopaikey-guide.md). Mọi chỗ ⚠️ ở đó phải được thử thật (Spike S1–S3, [research.md](../research.md)).

## Giao diện (TypeScript, minh họa hợp đồng, không phải mã triển khai)

```ts
interface TtsProvider {
  readonly type: 'fpt_marketplace' | 'shopaikey_openai' | 'shopaikey_minimax';
  readonly limits: { maxCharsPerRequest: number; minChars: number };
  catalog(): ProviderCatalog;                         // model, giọng, thang tốc độ hợp lệ
  synthesize(req: SynthesizeRequest, ctx: CallContext): Promise<SynthesizeResult>;
  testConnection(ctx: CallContext): Promise<TestResult>;
}

interface SynthesizeRequest { text: string; model?: string; voice: string; speed?: number }
interface CallContext {
  config: { baseUrl: string; apiKey: string };        // apiKey đã giải mã, chỉ sống trong bộ nhớ
  signal: AbortSignal;                                // hủy khi người dùng dừng job
  fetch: typeof fetch;                                // safeFetch (chống SSRF), xem research R9
}
interface SynthesizeResult {
  audio: Uint8Array; mime: string;                    // wav | mp3 …, worker giải mã về PCM chuẩn
  unitsChars: number; unitsTokens?: number;           // chỉ điền tokens khi nhà cung cấp trả
  providerRequestId?: string;                         // ví dụ trace_id của MiniMax
}
```

Adapter **không** ghi DB, **không** ghi log chứa khóa; worker chịu trách nhiệm retry, cache, usage, log.

## Phân loại lỗi (bắt buộc dùng chung)

Adapter ném `ProviderError { kind, code, retryAfterMs? }`.

| `kind` | Điều kiện | Worker xử lý | Thông báo thân thiện (ví dụ) |
| --- | --- | --- | --- |
| `transient` | Timeout, lỗi mạng, 429, 5xx | Thử lại tối đa 4 lần, backoff mũ + jitter, tôn trọng `retryAfterMs` | "Nhà cung cấp đang quá tải, đang thử lại" |
| `auth` | 401, key sai/tắt | Dừng job, **không retry** | "Khóa API không hợp lệ. Kiểm tra cấu hình" |
| `quota` | 403 hết quota/credit, "Insufficient quota" | Dừng job, không retry | "Tài khoản nhà cung cấp đã hết hạn mức" |
| `forbidden_model` | 403/404 model hoặc giọng không thuộc gói | Dừng job | "Cấu hình chưa được cấp model/giọng này" |
| `voice_invalid` | 400 voice không hợp lệ (có thể kèm danh sách hợp lệ) | Đoạn `failed`, dừng job | "Giọng đọc không hợp lệ cho model này" |
| `content_blocked` | 400 "content management policy" | Đoạn `failed`, **không retry**, các đoạn khác vẫn chạy rồi kết thúc `failed` kèm danh sách đoạn | "Nội dung đoạn X bị nhà cung cấp từ chối" |
| `bad_request` | 400 khác | Dừng job | "Yêu cầu không được nhà cung cấp chấp nhận" |
| `ssrf_blocked` | Địa chỉ không qua kiểm tra | Dừng job | "Địa chỉ nhà cung cấp không được phép" |

Lỗi của cấu hình riêng **không** chuyển sang cấu hình chung. Mọi thông báo cho User không chứa khóa, URL có khóa hay nội dung phản hồi thô.

## Đặc tả từng adapter

### `fpt_marketplace`

- `POST {baseUrl}/audio/speech` (baseUrl mặc định `https://mkp-api.fptcloud.com/v1`), `Authorization: Bearer`, JSON `{ model, voice, input, response_format: "wav", speed? }`. Phản hồi nhị phân.
- Model: `FPT.AI-VITs`, `FPT.TTS-pro`, `FPT.TTS-ultra` (**phân biệt hoa/thường**); **voice không dùng chéo model** (xem bảng giọng ở guide §4.4).
- `speed` là hệ số, hợp lệ 0.25–4 (✅ kiểm chứng 2026-11-19; ≥ 5 → 422), chỉ gửi khi khác 1.
- 403 khi key chưa được cấp model → `forbidden_model`.

### `shopaikey_openai`

- `POST {baseUrl}/tts/openai/speech` (baseUrl mặc định `https://api.shopaikey.com`), `Authorization: Bearer`, JSON `{ input, model: "tts-1", voice, response_format, speed }`.
- `input` ≤ 4.096 ký tự; `speed` 0.25–4.0. Phản hồi JSON có `url` (audio đã upload lên S3) → tải qua `safeFetch`, giới hạn kích thước.
- Lỗi theo bảng guide §16 (401, 403 quota, 404/503 "No available channel" → `forbidden_model`, 429, 5xx).
- ⚠️ Chất lượng tiếng Việt chưa kiểm chứng: Spike S1.

### `shopaikey_minimax`

- `POST {baseUrl}/tts/minimax/t2a_v2` (baseUrl mặc định `https://api.shopaikey.com`), `Authorization: Bearer`, JSON
  `{ model, text, stream: false, language_boost: "Vietnamese", voice_setting: { voice_id, speed, vol: 1, pitch: 0 }, audio_setting: { sample_rate: 24000, format: "wav", channel: 1 } }`.
- Phản hồi JSON: `data.audio` là audio dạng **hex** (giải mã bằng `Buffer.from(hex, 'hex')`), `base_resp.status_code` = 0 khi thành công.
  ⚠️ Lỗi nghiệp vụ có thể đi kèm **HTTP 200** với `base_resp.status_code ≠ 0`: 1004/2049 → `auth`; 1008 → `quota`; 1026/1027 → `content_blocked`;
  1000/1001/1002/1013/1039/1041 → `transient`; 2013 → `voice_invalid` (nếu nhắc tới voice) hoặc `bad_request`.
- ✅ Kiểm chứng bằng khóa thật (2026-11-19): `speed` hợp lệ 0,5–2 (ngoài khoảng bị bỏ qua, không báo lỗi); WAV/PCM/MP3 đều có; giọng sai → HTTP 502, model sai → 503 (đều `transient`).
- Model chạy được: `speech-02-hd` (mặc định), `speech-02-turbo`, `speech-2.6-hd/turbo`, `speech-01-hd/turbo`. Không dùng `speech-2.8-*` (ShopAIKey trả 500).
- 18 giọng tiếng Việt `Vietnamese_*` (lấy từ `GET /tts/minimax/voices`, không cần khóa), lưu trong catalog. Độ trễ ~2–4 giây mỗi đoạn.

## Kiểm thử hợp đồng

Một bộ kiểm thử chung chạy với **mọi adapter** trên máy chủ giả: thành công, async chậm rồi thành công, 429 rồi thành công,
5xx liên tục (hết lần thử), 401, 403 quota, 400 policy, 400 voice sai, phản hồi hỏng, vượt thời gian, bị hủy giữa chừng, URL về địa chỉ nội bộ (bị chặn).
Mọi nhật ký sinh ra trong các kịch bản này được quét: không chứa khóa API.
