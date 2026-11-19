# Hướng dẫn chi tiết dùng FPT.AI Voice (Text-to-Speech & Speech-to-Text)

> Tài liệu **dùng chung cho nhiều dự án**, không gắn với dự án cụ thể nào.
> Cập nhật: 2026-11-19. Nguồn: tài liệu chính thức `docs.fpt.ai`, kho `github.com/fpt-corp/ai-marketplace`, và các lần gọi thật
> vào cổng Marketplace ngày 2026-11-12.

## Mục lục

1. [Hiểu đúng: "FPT.AI Voice" gồm hai dịch vụ](#1-hiểu-đúng-fptai-voice-gồm-hai-dịch-vụ)
2. [Chọn dịch vụ nào?](#2-chọn-dịch-vụ-nào)
3. [PHẦN A — FPT.AI Speech (api.fpt.ai)](#3-phần-a--fptai-speech-apifptai)
4. [PHẦN B — FPT AI Marketplace TTS (OpenAI-compatible)](#4-phần-b--fpt-ai-marketplace-tts-openai-compatible)
5. [Speech-to-Text (STT) của cả hai](#5-speech-to-text-stt-của-cả-hai)
6. [Mẹo viết văn bản để đọc tự nhiên](#6-mẹo-viết-văn-bản-để-đọc-tự-nhiên)
7. [Mẫu kiến trúc dùng TTS trong ứng dụng](#7-mẫu-kiến-trúc-dùng-tts-trong-ứng-dụng)
8. [Xử lý lỗi, retry, giới hạn](#8-xử-lý-lỗi-retry-giới-hạn)
9. [Bảo mật, chi phí, pháp lý](#9-bảo-mật-chi-phí-pháp-lý)
10. [Troubleshooting](#10-troubleshooting)
11. [Checklist tích hợp](#11-checklist-tích-hợp)
12. [Điểm chưa kiểm chứng](#12-điểm-chưa-kiểm-chứng)
13. [Liên kết chính thức](#13-liên-kết-chính-thức)

**Quy ước độ tin cậy**

| Ký hiệu | Nghĩa |
| :-: | --- |
| 📘 | Lấy trực tiếp từ tài liệu chính thức của FPT |
| ✅ | Đã tự gọi thật và quan sát kết quả (2026-11-12) |
| ⚠️ | Chưa kiểm chứng / suy ra — hãy tự thử trước khi dựa vào |

---

## 1. Hiểu đúng: "FPT.AI Voice" gồm hai dịch vụ

Cùng là giọng nói tiếng Việt của FPT nhưng có **hai cổng, hai kiểu API, hai bộ key khác nhau**:

| | **A. FPT.AI Speech** | **B. FPT AI Marketplace (Token Factory)** |
| --- | --- | --- |
| Cổng quản trị | `console.fpt.ai` | `marketplace.fptcloud.com` |
| Base URL | `https://api.fpt.ai` | `https://mkp-api.fptcloud.com` |
| Endpoint TTS | `POST /hmi/tts/v5` | `POST /v1/audio/speech` |
| Kiểu API | Riêng của FPT | **Tương thích OpenAI** |
| Xác thực | Header `api_key: <key>` | `Authorization: Bearer <key>` |
| Trả kết quả | **Bất đồng bộ**: trả JSON chứa link file, file xuất hiện sau 5 giây–2 phút (📘) | **Đồng bộ**: trả thẳng nhị phân audio (✅) |
| Định dạng audio | `mp3` (mặc định) hoặc `wav` | Chọn qua `response_format` (✅ `wav` chạy được) |
| Giới hạn độ dài | ≤ **5.000 ký tự**/request, ≥ 3 ký tự (📘) | Catalog ghi 10.000 ký tự/request (⚠️) |
| Model/giọng | 7 giọng (v5) | 3 model: `FPT.AI-VITs`, `FPT.TTS-pro`, `FPT.TTS-ultra` + nhiều giọng |
| Tính phí | Xem trong console (⚠️ không có giá công khai trên trang tài liệu) | Theo ký tự: $16.5 hoặc $99 / 1 triệu ký tự (catalog) |
| STT | Có (`/hmi/asr/general`) | Có (`/v1/audio/transcriptions`, tùy model) |

> Trang giới thiệu FPT cũng có công cụ web **FPT Voice Maker** (`voicemaker.fpt.ai`) để thử giọng bằng giao diện.

---

## 2. Chọn dịch vụ nào?

| Nhu cầu | Gợi ý |
| --- | --- |
| Đã quen OpenAI SDK, muốn đổi nhà cung cấp chỉ bằng `baseURL`; cần xử lý audio ngay trong luồng request | **B – Marketplace** |
| Cần **WAV** để cắt/ghép/mix chính xác | **B** (hoặc A với `format: wav`) |
| Hệ thống IVR/tổng đài, đã dùng hệ sinh thái FPT.AI từ trước, chấp nhận bất đồng bộ + callback | **A – Speech** |
| Cần thử nhiều model chất lượng khác nhau (VITs / pro / ultra) | **B** |
| Dịch vụ rất đơn giản, một request → một link mp3 | **A** |

Không bắt buộc chọn một: nhiều hệ thống đặt TTS sau một interface (`synthesize(text, voice) → audio`) để đổi nhà cung cấp bằng cấu hình (xem [§7](#7-mẫu-kiến-trúc-dùng-tts-trong-ứng-dụng)).

---

## 3. PHẦN A — FPT.AI Speech (api.fpt.ai)

### 3.1. Lấy API key

1. Tạo tài khoản và đăng nhập **Console FPT.AI**: <https://console.fpt.ai>.
2. Tạo/lấy API key của dịch vụ **Speech** (📘 "get from console.fpt.ai").
3. Lưu key vào biến môi trường, không đặt trong mã nguồn phía client/trình duyệt:

```bash
export FPT_SPEECH_API_KEY="xxxxxxxx"
```

### 3.2. Đặc tả TTS v5 (📘)

```
POST https://api.fpt.ai/hmi/tts/v5
Content-Type: application/json   (theo tài liệu; thực tế body là văn bản thuần, xem ví dụ)
```

**Headers**

| Header | Bắt buộc | Mặc định | Ý nghĩa |
| --- | :-: | --- | --- |
| `api_key` | ✔ | — | API key lấy từ console |
| `voice` | ✖ | `female` | Mã giọng (xem bảng dưới) |
| `speed` | ✖ | `0` | Tốc độ: `-3` (chậm nhất) … `0` (bình thường) … `+3` (nhanh nhất). Truyền dạng chuỗi số: `"-1"`, `"2"` |
| `format` | ✖ | `mp3` | `mp3` hoặc `wav` |
| `callback_url` | ✖ | — | URL của bạn để FPT báo khi file đã sẵn sàng |
| `Cache-Control` | ✖ | — | Ví dụ chính thức dùng `no-cache` |

**Body**: nội dung văn bản cần đọc (thuần văn bản).
**Giới hạn**: tối đa **5.000 ký tự**, tối thiểu **3 ký tự** mỗi request.

**Các giọng v5 theo tài liệu chính thức (📘)**

| `voice` | Mô tả theo tài liệu |
| --- | --- |
| `banmai` | Nữ, miền Bắc |
| `thuminh` | Nữ, miền Bắc |
| `leminh` | Nam, miền Bắc |
| `giahuy` | Nam, miền Trung |
| `myan` | Nữ, miền Trung |
| `lannhi` | Nữ, miền Nam |
| `linhsan` | Nữ, miền Nam |

> Danh sách có thể được FPT bổ sung/đổi tên theo thời gian. Luôn nghe thử bằng Voice Maker hoặc kiểm tra console trước khi chốt.

### 3.3. Phản hồi (📘)

```json
{
  "async": "https://s3-ap-southeast-1.amazonaws.com/text2speech-v4/male.0.pro.4b5b…mp3",
  "error": 0,
  "message": "The content will be returned after a few seconds under the async link.",
  "request_id": "4b5b15285847e83acbb3beb945434453"
}
```

| Trường | Ý nghĩa |
| --- | --- |
| `error` | `0` = thành công; khác `0` = lỗi |
| `async` | Link file mp3 (hoặc wav) sẽ có sau khi xử lý xong |
| `request_id` | Mã yêu cầu — lưu lại để đối soát/hỗ trợ |
| `message` | Thông điệp chi tiết |

⚠️ **Quan trọng — file chưa chắc có ngay.** Tài liệu nêu thời gian chờ **5 giây đến 2 phút** tùy độ dài văn bản. Có hai cách lấy file:

1. **Callback**: đặt header `callback_url`; FPT gọi về URL của bạn khi xong.
2. **Polling**: lặp `GET <async>` cho đến khi trả về thành công (trước đó có thể trả lỗi/không tồn tại — hành vi chính xác chưa được tài liệu mô tả, hãy thử và xử lý mọi mã khác 200 là "chưa sẵn sàng").

### 3.4. Ví dụ gọi

**cURL (đúng như mẫu chính thức, thêm `speed`/`format`)**

```bash
curl -X POST \
  -H "api_key: $FPT_SPEECH_API_KEY" \
  -H "voice: banmai" \
  -H "speed: 0" \
  -H "format: mp3" \
  -H "Cache-Control: no-cache" \
  -d 'Bạn thấy dịch vụ TTS của FPT có tốt không?' \
  "https://api.fpt.ai/hmi/tts/v5"
```

**Node.js (fetch) — gửi, rồi polling lấy file**

```js
const API = "https://api.fpt.ai/hmi/tts/v5";

async function tts(text, { voice = "banmai", speed = "0", format = "mp3" } = {}) {
  const res = await fetch(API, {
    method: "POST",
    headers: {
      api_key: process.env.FPT_SPEECH_API_KEY,
      voice, speed, format,
      "Cache-Control": "no-cache",
    },
    body: text.normalize("NFC"),            // UTF-8, chuẩn hóa dấu tiếng Việt
  });
  const json = await res.json();
  if (json.error !== 0) throw new Error(`FPT TTS error ${json.error}: ${json.message}`);

  // Chờ file sẵn sàng (tối đa ~2 phút theo tài liệu)
  const deadline = Date.now() + 150_000;
  let delay = 1500;
  while (Date.now() < deadline) {
    const f = await fetch(json.async);
    if (f.ok) return { audio: Buffer.from(await f.arrayBuffer()), requestId: json.request_id };
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.5, 8000);
  }
  throw new Error("FPT TTS: file chưa sẵn sàng sau 150s");
}
```

**Python (requests)**

```python
import os, time, requests

def tts(text, voice="banmai", speed="0", fmt="mp3", timeout=150):
    r = requests.post(
        "https://api.fpt.ai/hmi/tts/v5",
        headers={"api_key": os.environ["FPT_SPEECH_API_KEY"], "voice": voice,
                 "speed": speed, "format": fmt, "Cache-Control": "no-cache"},
        data=text.encode("utf-8"),
        timeout=30,
    )
    j = r.json()
    if j.get("error") != 0:
        raise RuntimeError(f"FPT TTS error {j.get('error')}: {j.get('message')}")
    end, delay = time.time() + timeout, 1.5
    while time.time() < end:
        f = requests.get(j["async"], timeout=30)
        if f.ok:
            return f.content
        time.sleep(delay); delay = min(delay * 1.5, 8)
    raise TimeoutError("FPT TTS: file chưa sẵn sàng")
```

**Nhận callback (Express)**

```js
app.post("/fpt/tts-callback", express.json(), (req, res) => {
  // Nội dung chính xác của callback do FPT quy định (⚠️ tài liệu chỉ nói sẽ gửi "JSON file").
  // Hãy log thử một lần để biết cấu trúc, và LUÔN xác thực bằng request_id đã lưu.
  console.log(req.body);
  res.sendStatus(200);
});
```

### 3.5. Chia văn bản dài (> 5.000 ký tự)

Tách theo **câu/đoạn**, không cắt giữa từ. Gửi từng phần song song có giới hạn (ví dụ 3–4 request cùng lúc), rồi nối audio theo thứ tự. Với `wav` cùng tần số mẫu, có thể nối PCM; với `mp3`, nên giải mã rồi ghép (hoặc dùng `ffmpeg -f concat`).

```bash
# nối các file wav cùng định dạng
printf "file '%s'\n" part_*.wav > list.txt
ffmpeg -f concat -safe 0 -i list.txt -c copy full.wav
```

---

## 4. PHẦN B — FPT AI Marketplace TTS (OpenAI-compatible)

Cổng: <https://marketplace.fptcloud.com> (còn gọi **FPT Token Factory**), tài liệu gốc: <https://github.com/fpt-corp/ai-marketplace>.

> ⚠️ Kho GitHub chính thức **chưa có tài liệu riêng cho TTS** (chỉ có LLM, VLM, Embedding, Rerank, Speech-to-text, Responses, Tokenizer, LoRA). Phần TTS dưới đây dựa trên **catalog model của cổng** và **các lần gọi thật** (✅), chứ không phải một trang đặc tả chính thức.

### 4.1. Lấy API key và quyền model

1. Đăng nhập cổng → **My Account → My API Key** → tạo key dạng `sk-…`.
2. **Mỗi key có danh sách model được cấp.** Gọi model chưa được cấp trả **403** (✅ từng gặp với `FPT.TTS-pro/ultra` khi key mới chỉ có VITs).
3. Kiểm tra nhanh key dùng được model nào:

```bash
curl -s https://mkp-api.fptcloud.com/v1/models -H "Authorization: Bearer $FPT_AI_API_KEY"
```

Tên model **phân biệt hoa/thường** (✅ `FPT.AI-VITs`, `FPT.TTS-pro`, `FPT.TTS-ultra` là `id` thực trả về).

### 4.2. Endpoint

| | |
| --- | --- |
| Base URL | `https://mkp-api.fptcloud.com/v1` |
| TTS | `POST /audio/speech` |
| Header | `Authorization: Bearer <key>`, `Content-Type: application/json` |
| Phản hồi | Nhị phân audio (✅) |

Kho chính thức mô tả header xác thực là `Authorization: Bearer {api_key}`; cũng nhắc "api-key header" ở đoạn mô tả chung — nếu một client lạ không chạy, hãy dùng `Authorization: Bearer` (đã chạy thật).

### 4.3. Ba model TTS

| Model | Giá / 1 triệu ký tự (catalog) | Số giọng (✅) | Đặc điểm |
| --- | --: | --: | --- |
| `FPT.AI-VITs` | $16.5 | 9 | Đủ 3 miền Bắc/Trung/Nam; độ trễ mẫu ~1.3–2.5 s cho ~600 ký tự |
| `FPT.TTS-pro` | $16.5 | 5 | Giọng "cao cấp" `std_*`, `fci_*` |
| `FPT.TTS-ultra` | $99 | 7 | Chất lượng cao nhất theo mô tả của FPT (24 kHz) |

### 4.4. Giọng đọc đã xác thực (✅ — API trả danh sách hợp lệ khi gửi voice sai)

**`FPT.AI-VITs`**

| voice | giới tính | miền |
| --- | --- | --- |
| `banmai` | nữ | Bắc |
| `thuminh` | nữ | Bắc |
| `leminh` | nam | Bắc |
| `minhquan` | nam | Bắc |
| `ngoclam` | nữ | Trung |
| `giahuy` | nam | Trung |
| `kimngan` | nữ | Nam |
| `hatieumai` | nữ | Nam |
| `huyphong` | nam | Nam |

**`FPT.TTS-pro`**: `std_banmai` (nữ, Bắc), `std_quanganh` (nam, Bắc), `fci_phuongan` (nữ), `fci_vietkhoa` (nam), `fci_xuantoan` (nam).

**`FPT.TTS-ultra`**: `std_banmai`, `std_kimngan` (nữ, Nam), `std_quanganh`, `std_minhquang` (nam), `std_vietkhoa` (nam), `fci_phuongan` (nữ), `fci_xuantoan` (nam).

> **Voice không dùng chéo model.** Gửi sai cặp model–voice, API trả lỗi kèm danh sách voice hợp lệ. Danh sách đổi theo thời gian: dùng cơ chế này để cập nhật.
> Cẩn thận với tài liệu bên thứ ba liệt kê giọng như `myan`, `lananh`: những giọng đó thuộc dịch vụ **A** (Speech v5), **không** nằm trong danh sách đã xác thực của Marketplace.

### 4.5. Tham số request

| Trường | Bắt buộc | Ghi chú |
| --- | :-: | --- |
| `model` | ✔ | Đúng hoa/thường |
| `input` | ✔ | Văn bản. Nên `normalize("NFC")` và `trim()` |
| `voice` | ✔ | Mã giọng gốc, không tiền tố model |
| `response_format` | ✖ | ✅ `wav` chạy thật. ⚠️ `mp3` có trong tài liệu bên thứ ba nhưng chưa tự kiểm chứng; thử nếu cần |
| `speed` | ✖ | ✅ Kiểm chứng 2026-11-19: hợp lệ 0.25–4 (≥ 5 → 422); chỉ gửi khi khác 1 |

### 4.6. Ví dụ

**cURL**

```bash
curl -sS -X POST "https://mkp-api.fptcloud.com/v1/audio/speech" \
  -H "Authorization: Bearer $FPT_AI_API_KEY" \
  -H "Content-Type: application/json" \
  -o hello.wav \
  -d '{"model":"FPT.AI-VITs","voice":"banmai","input":"Xin chào các bạn.","response_format":"wav"}'
```

**PowerShell (nhớ gửi UTF-8, nếu không mất dấu)**

```powershell
$body = @{ model="FPT.AI-VITs"; voice="banmai"; input="Xin chào các bạn."; response_format="wav" } | ConvertTo-Json
Invoke-WebRequest -Method Post -Uri "https://mkp-api.fptcloud.com/v1/audio/speech" `
  -Headers @{ Authorization = "Bearer $env:FPT_AI_API_KEY" } `
  -ContentType "application/json; charset=utf-8" `
  -Body ([Text.Encoding]::UTF8.GetBytes($body)) -OutFile hello.wav
```

**Node.js (OpenAI SDK)**

```ts
import OpenAI from "openai";
import { writeFile } from "node:fs/promises";

const client = new OpenAI({
  apiKey: process.env.FPT_AI_API_KEY,
  baseURL: "https://mkp-api.fptcloud.com/v1",
  timeout: 120_000,
  maxRetries: 2,
});

const res = await client.audio.speech.create({
  model: "FPT.TTS-pro",
  voice: "std_banmai" as "alloy",       // type của SDK chỉ liệt kê voice OpenAI
  input: "Chào mừng bạn.".normalize("NFC"),
  response_format: "wav",
});
await writeFile("out.wav", Buffer.from(await res.arrayBuffer()));
```

**Python (OpenAI SDK)**

```python
import os
from openai import OpenAI

client = OpenAI(api_key=os.environ["FPT_AI_API_KEY"], base_url="https://mkp-api.fptcloud.com/v1")
with client.audio.speech.with_streaming_response.create(
    model="FPT.AI-VITs", voice="giahuy", input="Giọng nam miền Trung.", response_format="wav"
) as r:
    r.stream_to_file("giahuy.wav")
```

### 4.7. Tính chi phí

```
chi_phí = số_ký_tự × đơn_giá_theo_model / 1.000.000
```

| Model | 1.000 ký tự | ~1.000 từ (~5.000 ký tự) |
| --- | --: | --: |
| VITs / pro | $0.0165 | ≈ $0.083 |
| ultra | $0.099 | ≈ $0.50 |

Đếm theo **ký tự Unicode** (không phải byte): ví dụ JavaScript `[...text].length`. Dấu cách và dấu câu đều tính. Retry của SDK có thể bị tính lặp — đối chiếu số dư định kỳ. Giá có thể đổi; xem trang giá của cổng.

---

## 5. Speech-to-Text (STT) của cả hai

### 5.1. FPT.AI Speech STT (📘)

```bash
curl -X POST -H "api_key: $FPT_SPEECH_API_KEY" \
  -T "/path/to/voice.wav" \
  "https://api.fpt.ai/hmi/asr/general"
```

Phản hồi:

```json
{ "status": 0, "hypotheses": [ { "utterance": "chào mừng bạn" } ], "id": "adab73e2-…" }
```

| `status` | Ý nghĩa |
| :-: | --- |
| 0 | Thành công |
| 1 | Không có giọng nói |
| 2 | Bị hủy |
| 9 | Hệ thống bận (thử lại) |

Tiếng Việt trong JSON được mã hóa UTF-8 (có thể hiện dạng `\uXXXX`; parse JSON bình thường là ra đúng).

### 5.2. Marketplace STT (📘 kho chính thức)

```bash
curl --request POST "https://mkp-api.fptcloud.com/v1/audio/transcriptions" \
  --header "Authorization: Bearer $FPT_AI_API_KEY" \
  --form "model=<tên-model>" --form "file=@speech.mp3" \
  --form "language=vi" --form "response_format=json" --max-time 60
```

Tên model STT lấy từ `GET /v1/models` của key bạn (⚠️ tài liệu chính thức để placeholder `your-model-name`).

Mẹo chuẩn bị audio (📘 script mẫu trong kho): chuyển về **WAV, mono, 16 kHz, 16-bit** trước khi gửi:

```bash
sox input.mp3 -c 1 -r 16000 -b 16 input_norm.wav
# hoặc
ffmpeg -i input.mp3 -ac 1 -ar 16000 -sample_fmt s16 input_norm.wav
```

---

## 6. Mẹo viết văn bản để đọc tự nhiên

Đây là kinh nghiệm chung cho TTS tiếng Việt (⚠️ không phải đặc tả của FPT; luôn nghe thử):

- **Viết số/ngày/đơn vị thành chữ** khi cần đọc đúng: "hai mươi phần trăm" thay "20%"; "mười chín tháng mười một" thay "19/11".
- **Từ viết tắt, tiếng Anh, tên riêng nước ngoài**: có thể đọc sai; viết theo cách đọc ("ây ai") hoặc thử trực tiếp.
- **Dấu câu = nhịp thở**: câu quá dài (> ~200 ký tự) đọc hụt hơi, hãy tách câu. Dấu phẩy tạo ngắt nhẹ, dấu chấm ngắt rõ hơn.
- **Chuẩn hóa Unicode NFC** trước khi gửi (chuỗi NFD có thể phát âm lỗi).
- Bỏ emoji, markdown (`**`, `#`), URL dài khỏi văn bản đọc.
- Thử 2–3 giọng/model với cùng một câu rồi mới chọn giọng chủ đạo.

---

## 7. Mẫu kiến trúc dùng TTS trong ứng dụng

### 7.1. Interface độc lập nhà cung cấp

```ts
export interface TtsProvider {
  synthesize(req: { text: string; voiceId: string; speed?: number }):
    Promise<{ audio: Buffer; mime: string; chars: number; costUsd?: number }>;
}
```

Hai cài đặt: `FptSpeechProvider` (phần A, có polling) và `FptMarketplaceProvider` (phần B, OpenAI SDK). Ứng dụng chỉ biết `TtsProvider`.

### 7.2. Quy trình tổng hợp văn bản dài

1. Chuẩn hóa NFC, loại ký tự lạ.
2. Tách thành **câu**; gộp câu ngắn tới tối đa ~200–500 ký tự một request.
3. Gửi song song với giới hạn đồng thời (3–4).
4. Cắt khoảng lặng đầu/cuối từng clip (nếu cần ghép khít).
5. Ghép theo thứ tự, chèn khoảng nghỉ theo dấu câu (ví dụ ~380 ms sau `. ! ?`, ~220 ms sau `, ; :`).
6. Lưu kết quả + `request_id`/hash.

### 7.3. Cache theo nội dung

Khóa cache: `sha256(provider + model + voice + speed + format + textNFC)`. Gặp lại → trả file cũ, **không tốn tiền**, đồng thời giúp kết quả ổn định giữa các lần chạy.

### 7.4. Cần mốc thời gian từng từ (karaoke, phụ đề)?

Cả hai dịch vụ **không trả timestamp theo từ**. Cách xử lý:

- Mốc **đầu mỗi câu** chính xác nếu bạn tổng hợp **từng câu riêng** rồi ghép.
- Muốn mốc từng từ: dùng **forced alignment** (ví dụ Montreal Forced Aligner với từ điển tiếng Việt) trên audio + văn bản đã biết; hoặc nội suy theo độ dài ký tự (kém chính xác hơn).

### 7.5. Cấu hình qua biến môi trường

```env
# Phần A
FPT_SPEECH_API_KEY=
FPT_SPEECH_VOICE=banmai
# Phần B
FPT_AI_API_KEY=
FPT_TTS_BASE_URL=https://mkp-api.fptcloud.com/v1
FPT_TTS_MODEL=FPT.AI-VITs
FPT_TTS_VOICE=banmai
```

---

## 8. Xử lý lỗi, retry, giới hạn

### 8.1. Phần A (api.fpt.ai)

| Tình huống | Cách xử lý |
| --- | --- |
| `error != 0` trong JSON | Ghi `message` + `request_id`; đa số là sai key/văn bản không hợp lệ |
| Văn bản < 3 hoặc > 5.000 ký tự | Kiểm tra trước khi gửi; tách văn bản dài |
| Link `async` chưa mở được | Chờ + polling có backoff, tối đa ~2–3 phút; hoặc dùng `callback_url` |
| STT `status = 9` (bận) | Thử lại sau vài giây |

### 8.2. Phần B (Marketplace)

| HTTP | Nguyên nhân thường gặp | Cách xử lý |
| :-: | --- | --- |
| 400 | JSON sai; `model`/`voice` sai hoặc không khớp nhau | Đối chiếu bảng giọng (lỗi trả danh sách voice hợp lệ) |
| 401 | Thiếu/sai key | Kiểm tra `Authorization: Bearer` |
| 403 | **Key chưa được cấp model đó** (✅); hoặc hết credit (model resell) | Xin cấp quyền / nạp credit |
| 429 | Vượt RPM/TPM (⚠️ ngưỡng chưa đo) | Exponential backoff + jitter; giảm song song |
| 5xx | Quá tải | Thử lại sau 1–3 s |

Không retry vô hạn: 400/401/403 sẽ không tự hết. Đặt timeout rõ ràng (ví dụ 120 s cho Marketplace, 30 s cho request gửi của Speech).

---

## 9. Bảo mật, chi phí, pháp lý

- **Key là bí mật**: chỉ nằm ở server (`.env`, secret manager). Không nhúng vào app web/mobile; không commit; không log.
- Nếu nghi lộ key: thu hồi/tạo lại trong console/cổng.
- **Dữ liệu**: văn bản bạn gửi đi sẽ đi qua máy chủ của FPT; nếu sản phẩm của bạn xử lý dữ liệu cá nhân của khách, hãy ghi FPT là bên xử lý dữ liệu trong chính sách bảo mật.
- **Quyền thương mại**: kiểm tra điều khoản của FPT về dùng audio sinh ra cho sản phẩm thương mại/bán lại **trước khi** phát hành (chưa có thông tin công khai được xác minh ở đây).
- **Chi phí**: giám sát số ký tự đã dùng; đặt hạn mức/ngân sách; cache để tránh trả tiền lặp.

---

## 10. Troubleshooting

| Triệu chứng | Nguyên nhân/Cách xử lý |
| --- | --- |
| `error != 0` ngay lần gọi đầu (Speech) | Sai/thiếu header `api_key`; key thuộc sản phẩm khác (key Marketplace không dùng cho `api.fpt.ai` và ngược lại) |
| Link `async` báo lỗi/không tải được | File chưa xử lý xong; chờ thêm hoặc dùng callback |
| `403` ở Marketplace với model pro/ultra | Key chưa được cấp; gọi `GET /v1/models` kiểm tra |
| Báo "voice not available" | Sai cặp model–voice; xem [§4.4](#44-giọng-đọc-đã-xác-thực--api-trả-danh-sách-hợp-lệ-khi-gửi-voice-sai) |
| Dấu tiếng Việt thành `???` | Body không phải UTF-8 (hay gặp ở PowerShell/Windows); gửi bytes UTF-8 |
| File `.wav` không mở được | Bạn đã lưu nhầm phản hồi lỗi (JSON) vào file; mở file bằng trình soạn thảo xem |
| Đọc sai số/viết tắt | Viết lại văn bản thành chữ, xem [§6](#6-mẹo-viết-văn-bản-để-đọc-tự-nhiên) |
| Ghép audio bị "lách tách" | Các clip khác tần số/kênh; chuẩn hóa về cùng sample rate trước khi nối |
| Tốc độ đọc không đổi | `speed` ở Speech là chuỗi số `-3..3`; ở Marketplace là hệ số (≈1.0); đừng nhầm hai thang |

---

## 11. Checklist tích hợp

- [ ] Xác định dịch vụ A hay B (hoặc cả hai) và lấy đúng loại key.
- [ ] Key nằm ở server, đã đưa vào `.env.example` (không có giá trị thật).
- [ ] Văn bản được NFC-normalize, tách câu, kiểm tra độ dài.
- [ ] Có timeout, retry có backoff, xử lý riêng 401/403.
- [ ] (Speech) Có polling/callback cho link `async`.
- [ ] Có cache theo hash nội dung.
- [ ] Ghi `request_id`, ký tự, chi phí mỗi lần gọi.
- [ ] Đã nghe thử và chốt giọng/model với người quyết định sản phẩm.
- [ ] Đã đọc điều khoản thương mại/quyền riêng tư của FPT.

---

## 12. Điểm chưa kiểm chứng

1. Giá của FPT.AI Speech (phần A) — không công bố trên trang tài liệu; xem trong console.
2. Cấu trúc JSON callback của Speech và hành vi của link `async` trước khi sẵn sàng.
3. Rate limit thực tế của cả hai dịch vụ.
4. Marketplace TTS: khoảng hợp lệ của `speed`, hỗ trợ `mp3`/định dạng khác, giới hạn 10.000 ký tự/request.
5. Tên model STT cụ thể trên Marketplace (xem `GET /v1/models`).
6. Điều khoản thương mại hóa audio.

---

## 13. Liên kết chính thức

- Tài liệu FPT.AI Speech — TTS: <https://docs.fpt.ai/docs/en/speech/api/text-to-speech>
- Tài liệu FPT.AI Speech — STT: <https://docs.fpt.ai/docs/en/speech/api/speech-to-text>
- Tổng quan: <https://docs.fpt.ai/docs/en/speech/documentation/text-to-speech>
- Console: <https://console.fpt.ai> · Voice Maker: <https://voicemaker.fpt.ai>
- Marketplace: <https://marketplace.fptcloud.com> · API key: <https://marketplace.fptcloud.com/en/my-account#my-api-key>
- Kho đặc tả Marketplace: <https://github.com/fpt-corp/ai-marketplace>
