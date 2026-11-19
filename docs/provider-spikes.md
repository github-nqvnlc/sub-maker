# Spike S1–S3: kiểm chứng nhà cung cấp AI bằng khóa thật

> Trạng thái: **ĐÃ CHẠY (2026-11-19)** — FPT AI Marketplace ✅ và ShopAIKey MiniMax ✅ chạy trọn đường với khóa thật; ShopAIKey OpenAI TTS ❌ do group của khóa (xem "Kết quả lần chạy 2026-11-19"). FPT.AI Speech đã bị gỡ khỏi hệ thống (không còn dùng).
> Mọi adapter hiện được kiểm thử bằng máy chủ giả
> (`mock-provider/`), nên các điểm ⚠️ dưới đây vẫn là giả định lấy từ `docs/fpt-ai-voice-guide.md`
> và `docs/shopaikey-guide.md`.

## Cách chạy

Đặt khóa vào biến môi trường của phiên terminal (KHÔNG ghi vào file, KHÔNG commit):

```powershell
$env:SPIKE_FPT_SPEECH_KEY = "..."        # console.fpt.ai
$env:SPIKE_FPT_MARKETPLACE_KEY = "..."   # marketplace.fptcloud.com (sk-...)
$env:SPIKE_SHOPAIKEY_KEY = "..."         # shopaikey.com (sk-...)
npx tsx scripts/spike-providers.ts
```

Script gọi từng adapter với một câu tiếng Việt ngắn, in độ trễ, kích thước, định dạng, và lưu file nghe thử vào
`tmp/spike/` (đã nằm ngoài kho mã). Khóa không bao giờ được in ra.

## Việc cần ghi lại

| ID | Câu hỏi | Kết quả |
| --- | --- | --- |
| S1 | Chất lượng tiếng Việt của từng adapter/giọng (nghe thử) | _chưa có_ |
| S1 | Độ trễ và kích thước audio cho ~60 và ~400 ký tự | **Marketplace**: 69 ký tự → 409 ms, 170 KB, 3,9 s audio; 385 ký tự → 1.305 ms, 939 KB, 21,3 s audio (WAV PCM s16le 22.050 Hz mono). **MiniMax**: 69 ký tự → 3,8 s, 385 ký tự → 4,2 s (WAV 24 kHz mono) |
| S2 | ~~FPT Speech: link `async`~~ | Không còn áp dụng (đã gỡ FPT Speech) |
| S3 | Marketplace: khoảng `speed` hợp lệ | **0,25–4** (0,25/0,5/0,75/1,25/1,5/2/3/4 → 200, độ dài audio đổi đúng chiều; 5 và 10 → 422). Đã cập nhật `catalog.ts` |
| S3 | Marketplace: có hỗ trợ `response_format: mp3` | **Có** (`audio/mpeg`, bắt đầu bằng ID3). Hiện vẫn dùng `wav` để ghép chính xác theo mẫu |
| S3 | Marketplace: giới hạn ký tự thực tế mỗi yêu cầu (catalog ghi 10.000) | 1.500 ký tự → 200 (4,4 MB WAV); 10.001 ký tự → 422. Giữ giới hạn an toàn 5.000 (đoạn thực tế ≤ 400) |
| S7 | Độ dài đoạn tối ưu cho ngữ điệu/chất lượng (thử 150, 300, 500 ký tự) | _chưa có_ |

## Sau khi có kết quả

Cập nhật các nơi sau cho khớp thực tế:

- `src/lib/providers/catalog.ts`: `speed` của `fpt_marketplace`, `maxCharsPerRequest`, danh sách giọng.
- `specs/001-voice-sub-projects/contracts/tts-provider.md` và `research.md` (R7, R8): bỏ dấu ⚠️ đã xác nhận.
- Mặc định `maxCharsPerSegment` (hiện 400) nếu S7 cho kết quả khác.

## Kết quả lần chạy 2026-11-19

| Nhà cung cấp | Kết quả | Nguyên nhân / việc cần làm |
| --- | --- | --- |
| FPT AI Marketplace | ✅ Hoạt động (chi tiết ở bảng trên). Mẫu nghe thử: `tmp/spike/fpt_marketplace-*.wav` | — |
| ~~FPT AI Speech~~ (đã gỡ khỏi hệ thống) | ❌ HTTP 401 `Invalid authentication credentials` (chạy lại lần 2 và thử cả header `api_key`, `api-key`, `Authorization: Bearer` — đều bị từ chối) | Máy chủ FPT từ chối khóa. Khóa ở `SPIKE_FPT_SPEECH_KEY` **trùng byte-by-byte với khóa Marketplace** (`sk-…`, 47 ký tự); khóa này chạy ở Marketplace nhưng không phải khóa của api.fpt.ai. Adapter gửi đúng header `api_key` theo tài liệu. Cần khóa từ console.fpt.ai nếu muốn dùng FPT Speech. S2 chưa kiểm chứng |
| ShopAIKey — OpenAI TTS (`/tts/openai/speech`) | ❌ `tts-1`/`tts-1-hd`/`tts-1-1106` → 404 `not_found` (lặp lại nhiều lần, thêm 503 "quá tải" thoáng qua); `gpt-4o-mini-tts` → 503 `No available channel … under group image`; `/v1/audio/speech` cũng 404 | Khóa **không dùng được kênh OpenAI TTS** (group `image`). Adapter gọi đúng endpoint/body như tài liệu §11.1 |
| ShopAIKey — MiniMax TTS (`/tts/minimax/t2a_v2`) | ✅ 200, trả MP3 (hex trong `data.audio`, bắt đầu ID3) với `speech-02-hd` + `language_boost: Vietnamese` | **Khóa này dùng được MiniMax.** Đã thêm adapter `shopaikey_minimax`; chạy trọn đường với khóa thật bằng `tests/integration/real-providers.test.ts` (3 đoạn → voice hoàn tất, usage đúng) |
| ShopAIKey — Gemini TTS (`/tts/google/generations`) | ⚠️ 503 "dịch vụ quá tải" (chưa xác định được) | Thử lại sau |
