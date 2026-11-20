# Hợp đồng: bộ máy đặt mốc (hàm thuần)

Ba hàm thuần, không I/O, kiểm thử bằng số. Đơn vị thời gian cuối cùng là **số mẫu PCM** (24 kHz mono 16-bit, `SAMPLE_RATE` hiện có); đổi sang ms chỉ khi ghi `timeline` (như `TimelineBuilder`).

## 1. `buildReadingUnits(cues, opts) → ReadingUnit[]`

```ts
type Cue = { idx: number; n: number; startMs: number; endMs: number; text: string; speakable: boolean };
type Opts = { merge: boolean; maxChars: number; maxGapMs: number };
type ReadingUnit = { idx: number; cueFrom: number; cueTo: number; text: string; startMs: number; slotEndMs: number; chars: number };
```

Quy tắc (theo thứ tự):
1. Cue `speakable=false` không thuộc đơn vị nào (để im lặng); nó **ngắt nhóm**.
2. `merge=false`: mỗi cue speakable là một đơn vị.
3. `merge=true`: gom cue liên tiếp; đóng nhóm khi cue hiện tại kết thúc bằng `. ? ! … :` (bỏ qua `"'”’)]»` ở cuối); hoặc `cue[k+1].startMs − cue[k].endMs > maxGapMs`; hoặc cộng thêm cue kế sẽ làm `chars > maxChars`.
4. Một cue đơn lẻ dài hơn `maxChars` được tách theo mệnh đề (`splitLongSentence`); các mảnh chia `startMs..slotEndMs` theo tỷ lệ ký tự.
5. Văn bản đơn vị = các cue nối bằng một khoảng trắng; `chars` đếm theo code point NFC.

Bất biến: các đơn vị phủ **mọi** cue speakable đúng một lần, theo thứ tự; `startMs` tăng dần; kết quả xác định (không phụ thuộc thời điểm chạy).

Ví dụ (tệp mẫu, `merge=true`): cue 10–11 ("Tập nói về một tương lai / mở, dựa trên luật lệ, / công nghệ và thị trường.") → **một** đơn vị `cueFrom=10..11` (cue 10 kết thúc bằng dấu phẩy nên nối với cue 11 kết thúc bằng dấu chấm). Cue 24 "Ông mở đầu:" kết thúc bằng `:` nên là đơn vị riêng.

## 2. `placeUnits(units, audio, params) → Placement`

```ts
type AudioInfo = { idx: number; samples: number };                    // sau khi cắt lặng đầu/cuối
type Params = { maxSlipMs: number; maxCompress: number; minGapMs: number };  // 500, 1.25, 60
type Placed = { idx: number; startSample: number; outSamples: number; compress: number; slipMs: number; overflow: boolean };
type Placement = { placed: Placed[]; totalSamples: number };
```

Thuật toán (mô tả ở research R3), với `cursor` khởi tạo bằng `−minGap` (đơn vị đầu tiên không bị cộng khoảng cách tối thiểu, nên `S_0 = 0` thì bắt đầu đúng tại 0):

```
for unit i in order:
  start   = max(S_i, cursor + minGap)            // không chồng tiếng
  slip    = start - S_i
  avail   = (i is last) ? +inf : S_{i+1} - minGap - start      // mượn khoảng nghỉ liền sau
  need    = samples_i
  if need <= avail:           compress = 1,  out = need
  else:  f = need / avail     // avail có thể <= 0: coi f = +inf
         compress = min(f, maxCompress);  out = ceil(need / compress)
  cursor  = start + out
  overflow = slip > maxSlip
```

**Bất biến cần kiểm thử**:
- I1. `placed[i].startSample ≥ placed[i-1].startSample + placed[i-1].outSamples` (không chồng tiếng, không âm).
- I2. `startSample ≥ S_i` (không bao giờ sớm hơn mốc phụ đề).
- I3. `compress ∈ [1, maxCompress]`; không nén khi `need ≤ avail`.
- I4. `slipMs` chỉ tăng khi đơn vị trước tràn qua `S_i`; gặp khoảng nghỉ đủ dài thì `slipMs = 0` (tự bù).
- I5. Phép tính chỉ dùng số nguyên mẫu ⇒ cùng đầu vào cho cùng kết quả (xác định).
- I6. Không cắt cụt: `out = ceil(need / compress)` (độ dài sau nén bảo toàn lời đọc).
- I7. `overflow = true` ⇔ `slipMs > maxSlipMs`; vẫn đặt đơn vị (không dừng).
- I8. Đơn vị đầu tiên bắt đầu đúng `S_0` (kể cả `S_0 = 0`); `startSample` không bao giờ nhỏ hơn `S_i`.
- I9. Đơn vị đọc thất bại vì nội dung bị chặn **không** nằm trong danh sách `audio` đưa vào `placeUnits` (không có mẫu); khe của nó là im lặng và `mergeTimed` vẫn ghi `TimelineEntry` với `failed: true`, `startMs = S_i`, `endMs = slotEndMs`. Các đơn vị còn lại được đặt như bình thường (đơn vị lỗi không gây trượt).
- I10. Trên chuỗi tổng hợp 3.000 đơn vị (chỉ bằng số, không audio), độ trễ `slipMs` của đơn vị cuối không lớn hơn độ trễ lớn nhất của 100 đơn vị đầu (sai lệch không cộng dồn, SC-003).

Ví dụ số (đơn vị 1 "Không Putin." khe 1,0 s, âm thanh 1,28 s, `S_next − start = 1,08 s`, `minGap = 0,06`): `avail = 1,02 s`; `f = 1,255 > 1,25` ⇒ `compress = 1,25`, `out = 1,024 s` ⇒ tràn 4 ms ⇒ đơn vị kế trượt ≤ 4 ms + `minGap` — nằm trong `maxSlip`.

## 3. `planParts(units, windowMs, gaps) → Part[]`

```ts
type Part = { n: number; fromUnit: number; toUnit: number; startMs: number; endMs: number };
```

- Với mỗi `k·windowMs` (k ≥ 1) tìm khoảng nghỉ lớn nhất giữa hai đơn vị liền nhau nằm trong `[k·windowMs − 0,2·windowMs ; k·windowMs + 0,2·windowMs]`; cắt tại đó. Không có khoảng nghỉ nào trong khoảng ⇒ cắt tại ranh giới đơn vị gần nhất với `k·windowMs`.
- Bất biến: các phần phủ mọi đơn vị đúng một lần; phần cuối có thể ngắn; một đơn vị không bao giờ bị cắt đôi; kết quả xác định.
- Phần chỉ dùng cho **log, tiến độ và ghi nhận điểm cắt**; việc ghép vẫn là một lượt ghi tuần tự vào tệp PCM duy nhất (R4).

## Ghép tuần tự (worker)

`mergeTimed(placement, readPcm)`: duyệt `placed` theo thứ tự; trước mỗi đơn vị ghi `startSample − writtenSamples` mẫu im lặng; đọc PCM đơn vị từ cache (`loadCachedById`), cắt lặng đầu/cuối, nén `atempo=compress` nếu `compress > 1`, ghi vào tệp PCM; ghi `TimelineEntry` (kèm `text`, `slipMs`, `compress`, `overflow`, `cues` chia theo ký tự). Kết thúc: `encodeMp3FromFile` như hiện có. Đơn vị thất bại vĩnh viễn: ghi im lặng đúng `slotEndMs − startMs` (FR-010) và đưa vào danh sách lỗi như hiện nay.
