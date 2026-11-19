# Hướng dẫn chi tiết dùng ShopAIKey (đa model: chat, ảnh, video, giọng nói, nhạc)

> Tài liệu **dùng chung cho nhiều dự án**, không gắn với dự án cụ thể nào.
> Cập nhật: 2026-11-19. Nguồn chính: tài liệu chính thức tại `shopaikey.com/docs/*`, trang bảng giá `shopaikey.com/models`, Điều khoản dịch vụ (cập nhật 30/04/2026), cộng với các lần gọi thật ngày 2026-11-13.

## Mục lục

1. [ShopAIKey là gì?](#1-shopaikey-là-gì)
2. [Mô hình hoạt động: key, group, credit](#2-mô-hình-hoạt-động-key-group-credit)
3. [Mua key, nạp tiền, kiểm tra số dư](#3-mua-key-nạp-tiền-kiểm-tra-số-dư)
4. [Bảng endpoint & Base URL (quan trọng nhất)](#4-bảng-endpoint--base-url-quan-trọng-nhất)
5. [Bắt đầu nhanh: gọi thử trong 1 phút](#5-bắt-đầu-nhanh-gọi-thử-trong-1-phút)
6. [OpenAI format: chat, stream, vision, tool calling](#6-openai-format-chat-stream-vision-tool-calling)
7. [Anthropic format (Claude)](#7-anthropic-format-claude)
8. [Google GenAI SDK (Gemini)](#8-google-genai-sdk-gemini)
9. [Tạo ảnh (Nano Banana và các model ảnh khác)](#9-tạo-ảnh-nano-banana-và-các-model-ảnh-khác)
10. [Tạo video (Veo, Grok)](#10-tạo-video-veo-grok)
11. [Text-to-Speech (OpenAI, Gemini, MiniMax)](#11-text-to-speech-openai-gemini-minimax)
12. [Tạo nhạc (Suno)](#12-tạo-nhạc-suno)
13. [Embeddings, Rerank, Moderation và API khác](#13-embeddings-rerank-moderation-và-api-khác)
14. [Cấu hình công cụ lập trình (Claude Code, Codex, Cline, Cursor…)](#14-cấu-hình-công-cụ-lập-trình)
15. [Chọn model, group và kiểm soát chi phí](#15-chọn-model-group-và-kiểm-soát-chi-phí)
16. [Mã lỗi và xử lý sự cố](#16-mã-lỗi-và-xử-lý-sự-cố)
17. [Mẫu code production: retry, fallback, async task](#17-mẫu-code-production-retry-fallback-async-task)
18. [Bảo mật](#18-bảo-mật)
19. [Rủi ro, điều khoản, pháp lý](#19-rủi-ro-điều-khoản-pháp-lý)
20. [Checklist trước khi đưa vào sản phẩm](#20-checklist-trước-khi-đưa-vào-sản-phẩm)
21. [Điểm chưa kiểm chứng](#21-điểm-chưa-kiểm-chứng)
22. [Liên kết & hỗ trợ](#22-liên-kết--hỗ-trợ)

**Quy ước độ tin cậy**

| Ký hiệu | Nghĩa |
| :-: | --- |
| 📘 | Lấy trực tiếp từ tài liệu chính thức của ShopAIKey |
| ✅ | Đã tự gọi thật và quan sát kết quả |
| ⚠️ | Chưa kiểm chứng / suy ra — tự thử trước khi dựa vào |

---

## 1. ShopAIKey là gì?

📘 ShopAIKey là **marketplace / LLM gateway** bán API key cho nhiều dịch vụ AI, hoạt động như **reverse proxy**: bạn giữ nguyên code, chỉ đổi **Base URL** và **API key**. Hỗ trợ ba "dáng" API chính:

- **OpenAI-compatible** (`/v1/...`)
- **Anthropic-compatible** (`/v1/messages`)
- **Google GenAI** (Gemini)

Phạm vi dịch vụ (📘 trang giới thiệu): chat/LLM (Claude, GPT, Gemini, DeepSeek, Qwen, Llama…), tạo ảnh (Nano Banana, Kling AI Image, GPT Image, Vidu Image), tạo video (Veo, Grok), Text-to-Speech (OpenAI, Gemini, MiniMax), nhạc (Suno), embeddings, rerank, moderation…

Số lượng model: trang giới thiệu ghi "hơn 500", trang bảng giá tại thời điểm đọc ghi **249 model, 19 nhóm** (tiêu đề trang ghi "280+") — số liệu thay đổi; xem `shopaikey.com/models`.

Hỗ trợ tính năng gốc (📘): streaming (SSE), vision, function calling/tool use, extended thinking/reasoning, prompt caching (Anthropic).

> Đây là **bên thứ ba bán lại**, không phải nhà cung cấp gốc. Đọc kỹ [§19](#19-rủi-ro-điều-khoản-pháp-lý) trước khi dùng cho sản phẩm thật.

---

## 2. Mô hình hoạt động: key, group, credit

### 2.1. API key

- Dạng `sk-...`. Một tài khoản có thể có nhiều key; mỗi key có số dư/credit riêng (📘).
- Có thể **mua key không cần tài khoản** (key gửi qua email) hoặc **mua sau khi đăng nhập** để quản lý lâu dài.

### 2.2. Group (gói model) — khái niệm cốt lõi

📘 **Group** = *tập model được phép dùng* + *hệ số giá*. Group của key quyết định key gọi được model nào và tính tiền thế nào.

Bảng nhóm đọc được trên `shopaikey.com/models` (số liệu lúc đọc, có thể đổi):

| Nhóm | Hệ số giá | Số model |
| --- | :-: | :-: |
| Cheap API | ×1.2 | 148 |
| OpenAI Medium | ×3 | 67 |
| Cheap API S2 | ×3 | 56 |
| Gemini API | ×1.5 | 28 |
| Claude Code Max | ×2 | 21 |
| Gemini Fast | ×3 | 21 |
| Veo High Quality | ×2.5 | 16 |
| Claude & Claude Code API | ×1 | 15 |
| Claude Code Discount | ×0.8 | 15 |
| Claude Code Max S2 | ×2 | 15 |
| (+9 nhóm khác) | … | … |

Quy tắc:

- Gọi model **không nằm trong group của key** → lỗi `No available channel for model … under group …` (404/503).
- Một key có thể gắn **nhiều group**; **thứ tự chọn là thứ tự ưu tiên** khi gọi.
- Đổi group bất cứ lúc nào (nút bút chì "Đổi gói model" ở trang **API Keys**), áp dụng ngay, không đổi key, không ảnh hưởng số dư.
- Ví dụ giá: model gốc $3/1M token, group `+20%` → tính $3,6/1M token.
- Key mua không đăng nhập dùng **group mặc định**; muốn chọn group khác hoặc nhiều group phải đăng nhập.
- Group **không đổi endpoint/format API**.

### 2.3. Credit và tỷ giá

- Nạp bằng VND (VietQR) → quy đổi thành **USD credit** theo tỷ lệ/tỷ giá hiển thị lúc thanh toán (không hồi tố). Tại thời điểm đọc: **1$ = 3.250 ₫** (📘 trang bảng giá).
- Credit **không hết hạn**, không trừ phí duy trì (📘 điều khoản).
- Bảng giá hiển thị cả VND và USD, theo `Input/1M token`, `Output/1M token`, `cache` (token cache), hoặc **theo lần** (ảnh/video…).
- Có khuyến mại theo mức nạp và chính sách đại lý/seller.

---

## 3. Mua key, nạp tiền, kiểm tra số dư

### 3.1. Mua key

1. Vào `shopaikey.com` → chọn hình thức mua (nhanh không tài khoản, hoặc đăng nhập).
2. Chọn **group** phù hợp ([§15](#15-chọn-model-group-và-kiểm-soát-chi-phí)).
3. Chọn gói credit: **tối thiểu $10, bội số của $10** (📘).
4. Quét **VietQR**, chuyển **đúng số tiền, đúng nội dung** (không tự sửa). Hệ thống xác nhận thường trong **1–3 phút**.
5. Nhận key trên trang/tài khoản, hoặc qua email "Đơn hàng thành công" (kiểm tra Spam).

Hãy **lưu mã đơn hàng, key, biên lai** (cần khi tra soát).

### 3.2. Nạp thêm

- Trong tài khoản: nút **Nạp** cạnh key (key giữ nguyên, không đổi cấu hình).
- Không tài khoản: mục "Nạp thêm cho key" ở trang chủ.
- Chuyển sai nội dung/số tiền hoặc dùng lại QR cũ → có thể không cộng tự động, cần tra soát thủ công.

### 3.3. Kiểm tra số dư

- Có tài khoản: cột **Sử dụng** ở **API Keys**; chi tiết từng request ở **Lịch sử sử dụng**.
- Không tài khoản: nhập key vào ô **Kiểm tra số dư** trên trang chủ.

### 3.4. Hỗ trợ khi cần tra soát

Telegram `@shopaikey_support`; bot mua key/tra đơn `@shopaikey_bot`. Gửi kèm: công cụ và hệ điều hành, thông báo lỗi đầy đủ **kèm request id**, **6 ký tự cuối của key** (không gửi cả key), thời điểm, model, mã đơn/biên lai.

---

## 4. Bảng endpoint & Base URL (quan trọng nhất)

Lỗi phổ biến nhất là **sai Base URL** (📘). Hãy nhớ quy tắc `/v1`:

| Dịch vụ/SDK | Base URL | Header xác thực |
| --- | --- | --- |
| **OpenAI SDK** & công cụ kiểu OpenAI (Cline, Cursor, Continue, OpenCode, Codex CLI, LobeChat, NextChat, Dify, n8n…) | `https://api.shopaikey.com/v1` | `Authorization: Bearer sk-…` |
| **Anthropic SDK**, **Claude Code** | `https://api.shopaikey.com` *(không `/v1`)* | `x-api-key: sk-…` (SDK) hoặc `ANTHROPIC_AUTH_TOKEN` (Claude Code) |
| **Google GenAI SDK**, **Gemini CLI** | `https://api.shopaikey.com` | `GEMINI_API_KEY` / `apiKey` |
| Ảnh Nano Banana (endpoint riêng) | `POST https://api.shopaikey.com/images/google/generations` | `Authorization: Bearer` |
| Video | `POST https://api.shopaikey.com/v1/video/generations` · `GET …/{task_id}` | `Authorization: Bearer` |
| TTS riêng | `https://api.shopaikey.com/tts/openai/speech` · `/tts/google/generations` · `/tts/minimax/…` | `Authorization: Bearer` |
| Suno | `https://api.shopaikey.com/suno/submit/music` · `/suno/fetch/{taskId}` | `Authorization: Bearer` |
| Seller API (đại lý) | `https://api.shopaikey.com/seller` | secret key của seller |

Ghi nhớ:

- Công cụ kiểu **OpenAI** cần `/v1` ở cuối; **Claude Code/Anthropic SDK** thì **không** có `/v1`, không có dấu `/` thừa.
- Nếu công cụ **không cho đổi Base URL** thì không dùng được ShopAIKey (📘 điều khoản).
- Nếu chỉ dán key mà không đổi Base URL, công cụ gửi key sang máy chủ gốc và báo "sai key".

---

## 5. Bắt đầu nhanh: gọi thử trong 1 phút

Đặt biến môi trường:

```bash
export SHOPAIKEY_API_KEY="sk-..."
```

**OpenAI format** (📘):

```bash
curl https://api.shopaikey.com/v1/chat/completions \
  -H "Authorization: Bearer $SHOPAIKEY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5-mini","messages":[{"role":"user","content":"Xin chào"}]}'
```

**Anthropic format** (📘; dùng khi key chỉ có gói Claude):

```bash
curl https://api.shopaikey.com/v1/messages \
  -H "x-api-key: $SHOPAIKEY_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"claude-sonnet-4-5","max_tokens":200,"messages":[{"role":"user","content":"Xin chào"}]}'
```

Liệt kê model key dùng được (⚠️ endpoint chuẩn OpenAI; thử trên key của bạn):

```bash
curl https://api.shopaikey.com/v1/models -H "Authorization: Bearer $SHOPAIKEY_API_KEY"
```

> Trên **Windows**, tài liệu khuyên chạy `curl` trong Git Bash/WSL: PowerShell xử lý dấu nháy khác nên dễ báo lỗi JSON. Trong PowerShell hãy dùng `Invoke-RestMethod` với `ConvertTo-Json` (ví dụ ở [§9](#9-tạo-ảnh-nano-banana-và-các-model-ảnh-khác)) hoặc `curl.exe` + file JSON (`-d "@body.json"`).

---

## 6. OpenAI format: chat, stream, vision, tool calling

Tất cả theo 📘 tài liệu chính thức.

### 6.1. Khởi tạo

```ts
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.SHOPAIKEY_API_KEY!,
  baseURL: "https://api.shopaikey.com/v1",
});
```

```python
from openai import OpenAI
import os
client = OpenAI(api_key=os.environ["SHOPAIKEY_API_KEY"], base_url="https://api.shopaikey.com/v1")
```

### 6.2. Chat Completions

```ts
const completion = await openai.chat.completions.create({
  model: "gpt-4o",
  messages: [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "Xin chào!" },
  ],
  max_tokens: 1000,
  temperature: 1.0,
});
console.log(completion.choices[0].message.content);
```

Endpoint: `POST https://api.shopaikey.com/v1/chat/completions`. Header bắt buộc: `Authorization: Bearer <token>`, `Content-Type: application/json`.

### 6.3. Streaming

```ts
const stream = await openai.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "Kể một câu chuyện dài" }],
  stream: true,
});
for await (const chunk of stream) {
  const t = chunk.choices[0]?.delta?.content || "";
  if (t) process.stdout.write(t);
}
```

### 6.4. Vision (ảnh vào)

```ts
// từ URL
{ type: "image_url", image_url: { url: "https://example.com/image.png" } }
// từ base64
{ type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64}` } }
```

Ghép vào `content: [ { type: "text", text: "Mô tả ảnh" }, <phần ảnh trên> ]`.

### 6.5. Function calling

```ts
const completion = await openai.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "Thời tiết Hà Nội hôm nay thế nào?" }],
  tools: [{
    type: "function",
    function: {
      name: "get_weather",
      description: "Lấy thời tiết tại một địa điểm",
      parameters: {
        type: "object",
        properties: { location: { type: "string" }, unit: { type: "string", enum: ["celsius", "fahrenheit"] } },
        required: ["location"],
      },
    },
  }],
  tool_choice: "auto",
});
const calls = completion.choices[0].message.tool_calls;
```

### 6.6. Xử lý lỗi (OpenAI SDK)

```ts
try { /* ... */ } catch (e) {
  if (e instanceof OpenAI.APIError) { console.error(e.status, e.message); } else throw e;
}
```

### 6.7. Tham số không phải model nào cũng hỗ trợ

Gửi tham số model không biết (ví dụ `reasoning_effort`) có thể nhận `400 Unrecognized request argument` → bỏ tham số đó hoặc đổi model (📘).

---

## 7. Anthropic format (Claude)

```ts
import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({
  apiKey: process.env.SHOPAIKEY_API_KEY!,
  baseURL: "https://api.shopaikey.com",      // KHÔNG có /v1
});

const msg = await anthropic.messages.create({
  model: "claude-sonnet-4-5",
  max_tokens: 1024,
  system: "Bạn là trợ lý lập trình.",
  messages: [{ role: "user", content: "Giải thích async/await" }],
});
console.log(msg.content[0].text);
```

Tài liệu chính thức có đủ ví dụ cho: **streaming** (`messages.stream`, event `content_block_delta`), **vision** (URL & base64, `source.type = "url" | "base64"`), **hội thoại nhiều lượt**, **tool use** (`input_schema`, `stop_reason === "tool_use"`), xử lý lỗi `Anthropic.APIError`. Prompt caching của Anthropic được hỗ trợ (📘).

Tên model phải **đúng như bảng giá** (ví dụ `claude-sonnet-4-5`, không phải "Claude Sonnet 4.5").

---

## 8. Google GenAI SDK (Gemini)

```ts
import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({
  apiKey: process.env.SHOPAIKEY_API_KEY!,
  httpOptions: { baseUrl: "https://api.shopaikey.com" },
});

const r = await ai.models.generateContent({
  model: "gemini-2.5-flash",
  contents: "Xin chào! Bạn là ai?",
  config: { systemInstruction: "Bạn là trợ lý thân thiện." },
});
console.log(r.text);
```

Python: `http_options.base_url = "https://api.shopaikey.com"`.

Có ví dụ chính thức cho: `generateContentStream`, chat nhiều lượt (`ai.chats.create`), ảnh (URL `fileData`, base64 `inlineData`), **đọc video**:

- Qua **URL** cần model Gemini 3 (ví dụ `gemini-3-flash-preview`, `gemini-3-pro-preview`).
- Với `gemini-2.5-flash` hãy gửi video bằng **base64** (`inlineData`).

---

## 9. Tạo ảnh (Nano Banana và các model ảnh khác)

### 9.1. Endpoint riêng cho Nano Banana (📘)

```
POST https://api.shopaikey.com/images/google/generations
Authorization: Bearer <key>
```

| Tham số | Kiểu | Bắt buộc | Mô tả |
| --- | --- | :-: | --- |
| `model` | string | ✔ | `nano-banana`, `nano-banana-2`, `nano-banana-2.1`, `nano-banana-pro` |
| `prompt` | string | ✔ | Mô tả ảnh |
| `size` | string | ✖ | **Tỉ lệ khung hình**, mặc định `1:1`: `1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9` |
| `imageSize` | string | ✖ | Cho `-2`, `-2.1`, `-pro`: `0.5K`, `1K`, `2K`, `4K`; mặc định `2K` |
| `format` | string | ✖ | `png` (mặc định) hoặc `jpeg` |
| `response_format` | string | ✖ | `url` (mặc định) hoặc `b64_json` |
| `image_urls` | array | ✖ | Ảnh tham chiếu: tối đa 3 (`nano-banana`), 5 (`-2`, `-2.1`, `-pro`) |

So sánh model (📘):

| | `nano-banana` | `nano-banana-2` | `nano-banana-2.1` | `nano-banana-pro` |
| --- | --- | --- | --- | --- |
| Ảnh tham chiếu | ≤ 3 | ≤ 5 | ≤ 5 | ≤ 5 |
| Kích thước | cố định | 0.5K–4K | 0.5K–4K | 0.5K–4K |
| Chất lượng | Tốt | Rất tốt | Rất tốt | Tuyệt vời |
| Tốc độ | Nhanh | Cân bằng | Cân bằng | Trung bình |

Ví dụ:

```bash
curl -X POST 'https://api.shopaikey.com/images/google/generations' \
  -H "Authorization: Bearer $SHOPAIKEY_API_KEY" -H 'Content-Type: application/json' \
  -d '{"model":"nano-banana-2.1","prompt":"Poster tàu vũ trụ, phong cách flat","size":"9:16","imageSize":"1K","format":"png","response_format":"b64_json"}'
```

Phản hồi: `{"created":…,"data":[{"url":"…"}]}` hoặc `{"data":[{"b64_json":"…"}]}`.

PowerShell:

```powershell
$body = @{ model="nano-banana-2.1"; prompt="Poster tàu vũ trụ"; size="9:16"; imageSize="1K"; response_format="b64_json" } | ConvertTo-Json
$r = Invoke-RestMethod -Method Post -Uri "https://api.shopaikey.com/images/google/generations" `
  -Headers @{ Authorization = "Bearer $env:SHOPAIKEY_API_KEY" } `
  -ContentType "application/json; charset=utf-8" -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 180
[IO.File]::WriteAllBytes("out.png", [Convert]::FromBase64String($r.data[0].b64_json))
```

### 9.2. Lưu ý thực tế (✅ 2026-11-13)

- Với **một key cụ thể** của chúng tôi, endpoint riêng `/images/google/generations` trả **"Model not found"** cho Nano Banana, trong khi **đường tương thích Gemini** chạy được:

  ```
  POST https://api.shopaikey.com/v1beta/models/gemini-nano-banana-2.1:generateContent?key=<API_KEY>
  { "contents":[{"parts":[{"text":"…"}]}],
    "generationConfig":{"responseModalities":["IMAGE"],
      "imageConfig":{"aspectRatio":"9:16","imageSize":"1K"},"seed":1} }
  ```

  Kết quả: ảnh nằm ở `candidates[0].content.parts[].inlineData.data` (base64). **Chỉ** tham số `?key=` được chấp nhận; header `x-goog-api-key` bị `401`.
- Cần **key thuộc nhóm có model ảnh Gemini** (ví dụ nhóm "Gemini API" hoặc "Image Only") — đây là nguyên nhân hay gặp nhất của "Model not found". Nếu endpoint riêng lỗi, hãy kiểm tra group trước rồi mới thử đường Gemini.
- Tên model trên đường Gemini theo bảng giá (`gemini-nano-banana-2.1`); trên endpoint riêng dùng tên ngắn (`nano-banana-2.1`).
- Ảnh 1K mất khoảng **23–79 giây**; đặt timeout ≥ 180 s.
- Vì key nằm trên URL (đường Gemini), **không log URL**; không in lỗi `fetch` nguyên văn (có thể lặp lại URL).
- Mọi ảnh Google mang watermark SynthID (vô hình).

### 9.3. Model ảnh khác

📘 trang giới thiệu nhắc: Kling AI Image, GPT Image (ví dụ `gpt-image-2-all` tính **theo lần**), Vidu Image. Tài liệu endpoint riêng cho các model này **chưa có trong mục Hướng dẫn** (⚠️); xem `shopaikey.com/api-docs` và bảng giá, và thử qua `POST /v1/images/generations` kiểu OpenAI nếu model hỗ trợ (⚠️ chưa kiểm chứng).

---

## 10. Tạo video (Veo, Grok)

Mô hình **bất đồng bộ**: tạo task → poll trạng thái (📘).

```
POST /v1/video/generations         → trả task_id
GET  /v1/video/generations/{task_id}
```

### 10.1. Model

- Google Veo: `veo2-fast`, `veo2`, `veo2-pro`, `veo3-fast`, `veo3`, `veo3-pro`, `veo3.1-fast`, `veo3.1`, `veo3.1-pro`
- Grok: `grok-video-3`

### 10.2. Tham số

| Tham số | Áp dụng | Mô tả |
| --- | --- | --- |
| `model` ✔ | cả hai | ID model |
| `prompt` ✔ | cả hai | Mô tả video |
| `metadata.images` | cả hai | Mảng URL ảnh → **image-to-video** |
| `metadata.aspect_ratio` | cả hai | `16:9`, `3:2`, `2:3`, `1:1`… |
| `metadata.enhance_prompt` | Veo | Tự tối ưu prompt |
| `metadata.enable_upsample` | Veo | Upsample video |
| `metadata.duration` | Grok | Số giây |
| `metadata.resolution` | Grok | `720p`, `1080p` |

### 10.3. Ví dụ

```bash
# Veo
curl -X POST https://api.shopaikey.com/v1/video/generations \
  -H "Authorization: Bearer $SHOPAIKEY_API_KEY" -H 'Content-Type: application/json' \
  -d '{"model":"veo3-fast","prompt":"Một con mèo chơi trong vườn lúc sáng sớm",
       "metadata":{"aspect_ratio":"16:9","enhance_prompt":true,"enable_upsample":true}}'

# Grok
curl -X POST https://api.shopaikey.com/v1/video/generations \
  -H "Authorization: Bearer $SHOPAIKEY_API_KEY" -H 'Content-Type: application/json' \
  -d '{"model":"grok-video-3","prompt":"Một con mèo chơi trong vườn",
       "metadata":{"duration":5,"aspect_ratio":"3:2","resolution":"1080p"}}'
```

Phản hồi tạo task: `{"code":"success","data":{"task_id":"task_…","status":"queued",…}}`.

### 10.4. Trạng thái task

| `status` | Ý nghĩa |
| --- | --- |
| `queued` | Đang xếp hàng |
| `processing` | Đang xử lý (có `progress` như `"50%"`) |
| `SUCCESS` | Xong → lấy video tại `data.result_url` |
| `FAILURE` | Thất bại → xem `data.fail_reason` (ví dụ vi phạm chính sách nội dung) |

Lưu ý: giá trị `status` viết **không đồng nhất hoa/thường** (`queued/processing` thường, `SUCCESS/FAILURE` hoa) — so sánh không phân biệt hoa thường. Lỗi cũng có thể nằm trong JSON với `code: "success"` ở tầng ngoài; luôn kiểm tra `data.status`.

Polling mẫu: xem [§17.3](#173-polling-task-bất-đồng-bộ-video-nhạc-tts-minimax-async).

---

## 11. Text-to-Speech (OpenAI, Gemini, MiniMax)

Base URL `https://api.shopaikey.com`, header `Authorization: Bearer <key>` (📘). Hai endpoint đầu **upload audio lên S3 và trả về URL** (không trả nhị phân).

### 11.1. OpenAI TTS — `POST /tts/openai/speech`

| Tham số | Mô tả |
| --- | --- |
| `input` ✔ | Văn bản, **tối đa 4096 ký tự** |
| `model` | Mặc định `tts-1` |
| `voice` | Mặc định `alloy`; có `alloy, echo, fable, onyx, nova, shimmer` |
| `response_format` | `mp3` (mặc định), `opus`, `aac`, `flac`, `wav`, `pcm` |
| `speed` | `0.25 – 4.0` (mặc định 1) |

Phản hồi: `{"url":"…/audio/abc.mp3","key":"audio/abc.mp3","model":"tts-1","voice":"alloy","format":"mp3","mimeType":"audio/mpeg"}`.

```bash
curl -X POST https://api.shopaikey.com/tts/openai/speech \
  -H "Authorization: Bearer $SHOPAIKEY_API_KEY" -H 'Content-Type: application/json' \
  -d '{"input":"Xin chào, đây là giọng demo","model":"tts-1","voice":"alloy","response_format":"mp3","speed":1.0}'
```

### 11.2. Google Gemini TTS — `POST /tts/google/generations`

| Tham số | Mô tả |
| --- | --- |
| `text` ✔ | Văn bản |
| `model` | Mặc định `gemini-2.5-flash-preview-tts` |
| `voice` | Mặc định `Kore` |

Server đổi PCM → WAV, upload S3. Phản hồi: `{"url":"…wav","sampleRate":24000,"mimeType":"audio/wav",…}`.

### 11.3. MiniMax TTS

| Endpoint | Công dụng |
| --- | --- |
| `POST /tts/minimax/t2a_v2` | Đồng bộ; `stream: true` để SSE. Audio trả về dạng **hex** trong `data.audio` |
| `POST /tts/minimax/t2a_async_v2` | Bất đồng bộ → `task_id`, `file_id` |
| `GET /tts/minimax/query/t2a_async_query_v2?task_id=…` | Trạng thái: `Processing`, `Success`, `Failed`, `Expired` |
| `GET /tts/minimax/files/retrieve?file_id=…` | Lấy `download_url` |
| `GET /tts/minimax/voices` | Danh sách `system_voice` (cache 1 giờ, **không cần key**) |

Body `t2a_v2`: `model` ✔ (ví dụ `speech-02-hd`), `text` ✔, `voice_setting {voice_id, speed, vol, pitch, emotion}`, `audio_setting {sample_rate, bitrate, format}`, `language_boost`.

```bash
curl -X POST https://api.shopaikey.com/tts/minimax/t2a_v2 \
  -H "Authorization: Bearer $SHOPAIKEY_API_KEY" -H 'Content-Type: application/json' \
  -d '{"model":"speech-02-hd","text":"Xin chào","voice_setting":{"voice_id":"male-qn-qingse","speed":1,"vol":1,"pitch":0},
       "audio_setting":{"sample_rate":32000,"bitrate":128000,"format":"mp3"}}'
```

Giải mã audio hex (Node): `Buffer.from(res.data.audio, "hex")`.

⚠️ Chất lượng **tiếng Việt** của từng nhà cung cấp chưa được kiểm chứng ở đây: hãy nghe thử (đặc biệt `language_boost` của MiniMax) trước khi chọn.

---

## 12. Tạo nhạc (Suno)

Bất đồng bộ (📘): `POST /suno/submit/music` → `taskId` → poll `GET /suno/fetch/{taskId}` mỗi **3 giây**. Mỗi yêu cầu tạo **2 bản nhạc**.

| Tham số | Mô tả |
| --- | --- |
| `mv` ✔ | Phiên bản model (ví dụ `chirp-hawk`; xem danh sách model trong tài liệu) |
| `gpt_description_prompt` | *Chế độ mô tả*: mô tả bằng ngôn ngữ tự nhiên |
| `prompt` | *Chế độ lyrics*: lời bài hát (`[Verse]`, `[Chorus]`…) |
| `title`, `tags` | Tiêu đề, thể loại (`pop, upbeat`) |
| `make_instrumental` | `true` = không lời |

Phải có **một trong** `gpt_description_prompt` hoặc `prompt`.

Tạo lời bài hát riêng: `POST /suno/submit/lyrics` (`prompt` ✔, `title`, `tags`).

Kết quả xong: `data.status = "SUCCESS"`, `data.data[]` chứa `audio_url`, `video_url`, `image_url`, `title`, `tags`, `prompt`, `model_name`, `duration`. Thất bại: `status = "FAILED"` + `fail_reason`. Trạng thái trung gian: `submitted / queueing / processing`.

---

## 13. Embeddings, Rerank, Moderation và API khác

📘 Trang giới thiệu nói ShopAIKey hỗ trợ **Embeddings, Rerank, Moderations** và "nhiều API khác", nhưng mục Hướng dẫn **không có trang chi tiết** cho các API này. Vì ShopAIKey proxy chuẩn OpenAI, cách thử hợp lý (⚠️ chưa kiểm chứng):

```bash
# Embeddings (nếu model có trong group của key)
curl https://api.shopaikey.com/v1/embeddings -H "Authorization: Bearer $SHOPAIKEY_API_KEY" \
  -H 'Content-Type: application/json' -d '{"model":"<tên-model-embedding>","input":"xin chào"}'
```

Tên model và endpoint chính xác (đặc biệt Rerank) hãy xem `shopaikey.com/api-docs` và bảng giá; nếu thiếu, hỏi hỗ trợ.

Ngoài ra có: **Seller API** (`/seller`, dành cho đại lý: tạo key hàng loạt, nạp/rút credit, thống kê — không dành cho người dùng cuối) và công cụ **DNS Resolver** (hướng dẫn riêng).

---

## 14. Cấu hình công cụ lập trình

Mọi công cụ chỉ cần **2 thứ: Base URL và API key** (📘).

| Công cụ | Cấu hình | Base URL |
| --- | --- | --- |
| **Claude Code** | `~/.claude/settings.json` (Windows: `%USERPROFILE%\.claude\settings.json`) | `https://api.shopaikey.com` |
| **Gemini CLI** | `~/.gemini/.env`: `GEMINI_API_KEY`, `GOOGLE_GEMINI_BASE_URL` | `https://api.shopaikey.com` |
| **Codex CLI** | `~/.codex/config.toml` + `auth.json` | `https://api.shopaikey.com/v1` |
| **Cline / Roo / Kilo Code** | Provider **OpenAI Compatible** | `https://api.shopaikey.com/v1` |
| **Cursor** | Settings → Models → Override OpenAI Base URL | `https://api.shopaikey.com/v1` |
| **Continue** | `apiBase` trong `config.yaml` | `https://api.shopaikey.com/v1` |
| **OpenCode** | `baseURL` trong `opencode.json` | `https://api.shopaikey.com/v1` |
| Ứng dụng khác (LobeChat, NextChat, Dify, n8n…) | Provider OpenAI → API Endpoint | `https://api.shopaikey.com/v1` |

**Claude Code** (`settings.json`):

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.shopaikey.com",
    "ANTHROPIC_AUTH_TOKEN": "sk-your-token-here"
  }
}
```

Hoặc biến môi trường (PowerShell: `$env:ANTHROPIC_BASE_URL = "https://api.shopaikey.com"`). Có script cài tự động do ShopAIKey cung cấp (`cdn.shopaikey.com/claude/setup.sh|ps1`) — **hãy đọc nội dung script trước khi chạy** (không nên pipe thẳng vào shell mà chưa xem).

**Codex CLI** (`config.toml`):

```toml
model_provider = "shopaikey"
model = "gpt-5.2"
[model_providers.shopaikey]
name = "shopaikey"
base_url = "https://api.shopaikey.com/v1"
wire_api = "responses"
requires_openai_auth = true
```

và `auth.json`: `{ "OPENAI_API_KEY": "sk-..." }`. Sau khi sửa phải **khởi động lại** Codex.

**Gemini CLI** (`~/.gemini/.env`):

```
GEMINI_API_KEY=sk-KEY_CUA_BAN
GOOGLE_GEMINI_BASE_URL=https://api.shopaikey.com
```

Lỗi riêng của Claude Code (📘):

- Vẫn hiện màn hình đăng nhập Anthropic → kiểm tra `settings.json` đủ `ANTHROPIC_BASE_URL` và `ANTHROPIC_AUTH_TOKEN`, JSON hợp lệ; mở terminal mới; nếu cần thêm `"hasCompletedOnboarding": true` vào `~/.claude.json`.
- "Auth conflict": máy còn `ANTHROPIC_API_KEY` cũ → xóa biến đó (hoặc `/logout` nếu trước đó đăng nhập Anthropic).
- 404/không kết nối: `ANTHROPIC_BASE_URL` **không** có `/v1`, không có dấu `/` thừa.

---

## 15. Chọn model, group và kiểm soát chi phí

### 15.1. Chọn group

| Mục tiêu | Gợi ý |
| --- | --- |
| Chưa rõ nhu cầu | Giữ **group mặc định** |
| Tối ưu chi phí | Group "tiết kiệm", **nhưng kiểm tra trước nó có model bạn cần** |
| Cần model cao cấp / ưu tiên tốc độ | Group có nhãn "+% giá" chứa model đó |
| Vừa rẻ vừa đủ model | Chọn **nhiều group**: rẻ trước, đầy đủ sau (thứ tự = ưu tiên) |

### 15.2. Đọc bảng giá

Mỗi model có: giá **Input/1M token**, **Output/1M token**, **cache**, hoặc **Lần** (ảnh/video); kèm số **kênh** (channel) upstream và nhà cung cấp. Ví dụ đọc được lúc viết (nhóm Cheap API ×1.2): `deepseek-v4.1-flash` ≈ $3,60 input / $10,80 output mỗi 1M token; `gpt-4.1-mini` ≈ $0,48 / $1,92; `gpt-image-2-all` ≈ $0,144/lần. Giá thay đổi — đừng hard-code, hãy đọc lại bảng giá.

### 15.3. Ước tính chi phí

```
chi_phí_chat ≈ (input_tokens × giá_input + output_tokens × giá_output) / 1.000.000   (đã nhân hệ số group)
chi_phí_ảnh/video ≈ giá_theo_lần × số_lần
```

Mẹo kiểm soát:

- Ghi lại `usage` trả về mỗi lần gọi; đối chiếu với **Lịch sử sử dụng** trên dashboard.
- Ngữ cảnh dài tốn nhiều credit hơn một lần gọi (và có thể báo hết quota dù key còn một ít credit).
- Cache kết quả theo hash (prompt+model+tham số+seed) cho ảnh/âm thanh để không trả tiền lặp.
- Đặt trần ngân sách và cảnh báo ở phía ứng dụng (key hết credit sẽ lỗi 403).
- Cấu hình giá/ảnh trong code là ước tính; cập nhật khi bảng giá đổi.

---

## 16. Mã lỗi và xử lý sự cố

Theo 📘 trang "Xử lý lỗi thường gặp". Chạy lệnh test ở [§5](#5-bắt-đầu-nhanh-gọi-thử-trong-1-phút) trước: nếu lệnh test chạy được mà công cụ vẫn lỗi → lỗi ở cấu hình công cụ.

| HTTP / thông báo | Nguyên nhân | Cách xử lý |
| --- | --- | --- |
| **401** `Invalid token` | Key sai; **chưa đổi Base URL** (hay gặp nhất); thừa dấu cách/xuống dòng; key đang tắt; sai header (OpenAI: `Authorization: Bearer`, Anthropic: `x-api-key`) | Đổi Base URL theo [§4](#4-bảng-endpoint--base-url-quan-trọng-nhất); copy lại key; kiểm tra trạng thái key |
| **403** `token quota is not enough` / `Insufficient quota` | Hết credit, hoặc không đủ cho request này (ngữ cảnh dài), hoặc kênh upstream tạm hết hạn mức | Xem số dư; hết thì nạp; còn thì chờ rồi thử lại |
| **404 / 503** `No available channel for model … under group …` | Model **không thuộc group** của key | Xem cột "Gói model", đổi group hoặc đổi model |
| `This token has no access to model …`, `Model "…" is not supported` | Cùng loại ở trên | Như trên |
| Sai tên model | Tên phải đúng như bảng giá | Dùng `claude-sonnet-4-5`, không dùng tên hiển thị |
| **429** `upstream is overloaded for this group` / `rate limit` | Upstream quá tải hoặc gửi quá nhiều song song | Chờ vài giây; giảm song song; đổi model cùng group; hệ thống đã tự thử lại nhiều lần trước khi trả lỗi này |
| **500/502/503/504** | Lỗi tạm thời của upstream; **không bị trừ tiền** | Thử lại sau ít phút; kéo dài thì gửi `request id` cho hỗ trợ |
| **400** `Unrecognized request argument` | Model không hỗ trợ tham số (ví dụ `reasoning_effort`) | Bỏ tham số hoặc đổi model |
| **400** `content management policy` | Bị bộ lọc an toàn của nhà cung cấp chặn | Sửa prompt; không có dự phòng nào qua được |
| Task video/nhạc `FAILURE`/`FAILED` | Vi phạm chính sách nội dung hoặc lỗi upstream | Xem `fail_reason`; sửa prompt |
| "Model not found" ở ảnh Nano Banana | Key sai group hoặc đang dùng sai endpoint | Xem [§9.2](#92-lưu-ý-thực-tế--2026-11-13) |

Khi liên hệ hỗ trợ: gửi công cụ + hệ điều hành, thông báo lỗi đầy đủ **kèm request id**, 6 ký tự cuối của key, tên model, thời điểm.

---

## 17. Mẫu code production: retry, fallback, async task

### 17.1. Retry có backoff (chỉ retry lỗi tạm thời)

```ts
async function withRetry<T>(fn: () => Promise<T>, { tries = 4, base = 800 } = {}): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e: any) {
      const s = e?.status ?? e?.response?.status;
      const retryable = s === 429 || (s >= 500 && s <= 599) || e?.name === "TimeoutError";
      if (!retryable) throw e;                       // 400/401/403/404: không retry
      last = e;
      await new Promise((r) => setTimeout(r, base * 2 ** i * (0.5 + Math.random())));
    }
  }
  throw last;
}
```

### 17.2. Fallback giữa model/nhà cung cấp

Vì ShopAIKey là bên thứ ba và upstream có thể bị thu hồi bất kỳ lúc nào, hãy **đặt sau interface** và có phương án dự phòng:

```ts
const chain = [
  { client: shopaikey, model: "deepseek-v4.1-flash" },
  { client: shopaikey, model: "gpt-4.1-mini" },      // model khác trong cùng group
  { client: direct,    model: "gpt-4.1-mini" },      // nhà cung cấp gốc, nếu có key
];
for (const step of chain) {
  try { return await withRetry(() => step.client.chat.completions.create({ model: step.model, messages })); }
  catch (e: any) {
    if (e?.status === 400) throw e;                  // lỗi nội dung/tham số: không đổi nhà cung cấp
  }
}
throw new Error("all providers failed");
```

Quy tắc: lỗi kết nối/timeout/429/5xx/hết quota → chuyển tiếp; lỗi **chặn an toàn nội dung** → dừng ngay (nhà cung cấp khác cũng sẽ chặn).

### 17.3. Polling task bất đồng bộ (video, nhạc, TTS MiniMax async)

```ts
async function poll<T>(check: () => Promise<{ done: boolean; failed?: string; value?: T }>,
                       { everyMs = 3000, maxMs = 600_000 } = {}): Promise<T> {
  const end = Date.now() + maxMs;
  while (Date.now() < end) {
    const r = await check();
    if (r.failed) throw new Error(r.failed);
    if (r.done) return r.value as T;
    await new Promise((x) => setTimeout(x, everyMs));
  }
  throw new Error("task timeout");
}

// video
const { data } = await (await fetch("https://api.shopaikey.com/v1/video/generations", {
  method: "POST",
  headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
  body: JSON.stringify({ model: "veo3-fast", prompt, metadata: { aspect_ratio: "16:9" } }),
})).json();

const url = await poll<string>(async () => {
  const t = (await (await fetch(`https://api.shopaikey.com/v1/video/generations/${data.task_id}`,
    { headers: { Authorization: `Bearer ${key}` } })).json()).data;
  const s = String(t.status).toUpperCase();
  return s === "SUCCESS" ? { done: true, value: t.result_url }
       : s === "FAILURE" ? { done: false, failed: t.fail_reason }
       : { done: false };
}, { everyMs: 5000, maxMs: 900_000 });
```

### 17.4. Kiểm tra ảnh trả về

Nếu nhận ảnh dạng base64, kiểm tra **magic bytes** (PNG `89 50 4E 47`, JPEG `FF D8 FF`, WebP `RIFF…WEBP`) trước khi lưu — tránh lưu nhầm một thông báo lỗi dạng text thành file ảnh.

---

## 18. Bảo mật

- Key giữ như mật khẩu: chỉ ở server (`.env`, secret manager); **không** đặt trong client/app/web, không commit, không dán vào chat/ticket/log. Dùng `SHOPAIKEY_API_KEY` trong biến môi trường.
- **Key nằm trên URL** (đường `?key=` của Gemini-compatible): không ghi log URL, cẩn thận với proxy/egress và công cụ debug mạng.
- Mỗi môi trường/dự án một **key riêng** để thu hồi độc lập và theo dõi chi phí.
- Nghi lộ key: **tạo key mới, ngừng key cũ** ngay.
- Chỉ gửi cho hỗ trợ **6 ký tự cuối** của key.
- Không chạy script cài đặt từ xa (`curl … | bash`, `irm … | iex`) mà chưa đọc nội dung.
- Prompt/dữ liệu khách hàng đi qua máy chủ ShopAIKey → coi là **bên xử lý dữ liệu** (sub-processor); đừng gửi dữ liệu nhạy cảm nếu chưa rà soát chính sách bảo mật của họ (`shopaikey.com/privacy`).

---

## 19. Rủi ro, điều khoản, pháp lý

Tóm tắt theo 📘 **Điều khoản dịch vụ** (cập nhật 30/04/2026). **Hãy đọc bản đầy đủ** tại `shopaikey.com/terms`.

| Chủ đề | Nội dung chính |
| --- | --- |
| Bản chất | Dịch vụ **trung gian (reverse proxy)**; không phải nhà phát triển model; nhãn hiệu thuộc chủ sở hữu |
| Hoàn tiền | **Không hoàn tiền** credit đã dùng; thực tế gần như không hoàn tiền trong mọi trường hợp, ngoại lệ duy nhất là key không dùng được do lỗi hệ thống |
| Hiệu lực credit | Không hạn cố định, không phí duy trì |
| Uptime | **Không cam kết uptime**; phụ thuộc upstream; "as is / as available" |
| Trách nhiệm | Bồi thường tối đa = số tiền bạn thanh toán trong **3 tháng gần nhất** |
| Đình chỉ | Có thể khóa/chấm dứt tài khoản **không báo trước** khi vi phạm, nghi gian lận, theo yêu cầu cơ quan chức năng hoặc vì bảo mật |
| Nội dung | Bạn chịu trách nhiệm hoàn toàn về prompt/đầu ra; họ **không kiểm duyệt trước**, chỉ ghi metadata vận hành |
| Bị cấm | Vi phạm pháp luật & chính sách upstream, nội dung bạo lực/khủng bố/CSAM, lừa đảo/phishing/deepfake gây hại, malware, spam, vi phạm bản quyền, vượt rate limit/lạm dụng, share/bán lại key vượt khả năng credit, tạo nhiều tài khoản để trục lợi khuyến mại, reverse-engineer hệ thống |
| Tuổi | Từ 16 tuổi; mỗi người một tài khoản (trừ khi được phép) |
| Luật áp dụng | Pháp luật Việt Nam; tranh chấp tại tòa án Việt Nam |

Ý nghĩa cho sản phẩm của bạn:

1. **Không phải kênh chính thức** của OpenAI/Anthropic/Google; giá thấp hơn nhiều so với niêm yết nên **key upstream có thể bị thu hồi bất kỳ lúc nào** → luôn có phương án dự phòng ([§17.2](#172-fallback-giữa-modelnhà-cung-cấp)).
2. Chỉ **nạp vừa đủ** (không hoàn tiền; $10 tối thiểu).
3. **Quyền thương mại** với nội dung sinh ra (ảnh, video, nhạc, giọng) phụ thuộc điều khoản của nhà cung cấp gốc và tài khoản upstream — chưa được ShopAIKey bảo đảm; hãy tham vấn pháp lý trước khi bán.
4. Ghi ShopAIKey trong chính sách bảo mật của bạn như bên xử lý dữ liệu.
5. Không dùng cho nội dung hoặc mục đích bị cấm; vi phạm có thể khiến tài khoản bị khóa mà không hoàn tiền.
6. Nếu đang dùng nhạc/video/ảnh AI, kiểm tra yêu cầu gắn nhãn nội dung AI theo nền tảng và luật tại nơi bạn phát hành.

---

## 20. Checklist trước khi đưa vào sản phẩm

- [ ] Base URL đúng kiểu SDK (OpenAI `/v1`; Anthropic/Gemini **không** `/v1`).
- [ ] Key ở server; mỗi môi trường một key; không log key/URL chứa key.
- [ ] Key thuộc group có đủ model cần dùng; đã gọi thử từng model thật.
- [ ] Có retry (chỉ lỗi tạm thời), timeout hợp lý (ảnh/video lâu), polling cho task bất đồng bộ.
- [ ] Có fallback model/nhà cung cấp; lỗi chặn nội dung không bị retry vô nghĩa.
- [ ] Ghi `usage`/chi phí mỗi lần gọi; đặt cảnh báo số dư/ngân sách.
- [ ] Cache kết quả ảnh/âm thanh theo hash nội dung.
- [ ] Không để lộ tên nhà cung cấp/lỗi kỹ thuật cho người dùng cuối.
- [ ] Đã đọc Điều khoản & Chính sách bảo mật; đã cập nhật chính sách của bạn.
- [ ] Đã kiểm tra quyền thương mại với nội dung sinh ra.

---

## 21. Điểm chưa kiểm chứng

1. Endpoint chi tiết cho Embeddings, Rerank, Moderation, và các model ảnh khác (Kling, Vidu, GPT Image) — mục Hướng dẫn không có trang riêng; xem `api-docs`.
2. Bảng giá luôn đổi (nhóm, hệ số, đơn giá, tỷ giá 3.250 ₫/$); đừng hard-code.
3. `GET /v1/models` có trả đúng danh sách theo group của key hay không.
4. Chất lượng tiếng Việt của OpenAI TTS / Gemini TTS / MiniMax TTS.
5. Giới hạn rate cụ thể (RPM/TPM) theo group.
6. Số model thực tế (trang giới thiệu "500+", bảng giá "249 / 280+").
7. Vì sao endpoint ảnh riêng trả "Model not found" với một key cụ thể (nghi do group) — chỉ là giả thuyết.

---

## 22. Liên kết & hỗ trợ

- Trang chủ: <https://shopaikey.com> · Bảng giá model: <https://shopaikey.com/models> · API Docs: <https://shopaikey.com/api-docs>
- Hướng dẫn: `/docs/introduction`, `/docs/quickstart`, `/docs/troubleshooting`, `/docs/purchase-topup`, `/docs/openai-format`, `/docs/anthropic-format`, `/docs/google-genai`, `/docs/claude-code`, `/docs/codex`, `/docs/gemini-cli`, `/docs/cline`, `/docs/continue`, `/docs/opencode`, `/docs/openclaw`, `/docs/deepseek-harness`, `/docs/nano-banana`, `/docs/veo-video`, `/docs/tts`, `/docs/suno`, `/docs/seller-api`, `/docs/shopai-dns` (tiền tố `https://shopaikey.com`)
- Điều khoản: <https://shopaikey.com/terms> · Riêng tư: <https://shopaikey.com/privacy>
- Hỗ trợ kỹ thuật & tra soát thanh toán: Telegram `@shopaikey_support` · Mua key/tra đơn: `@shopaikey_bot` · Facebook `facebook.com/shopaikey`
