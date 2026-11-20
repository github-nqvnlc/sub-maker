# Implementation Plan: Voice khớp mốc thời gian phụ đề, đa ngôn ngữ, giao diện Sáng/Tối và font tiếng Việt

**Branch**: `003-subtitle-timing-i18n-theme` | **Date**: 2026-11-20 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/003-subtitle-timing-i18n-theme/spec.md`

## Summary

Sáu yêu cầu, chia hai nhóm trên nền hệ thống spec 001:

1. **Voice khớp mốc phụ đề** (P1, phần lớn công việc): đọc cue SRT, bỏ số thứ tự/mốc khỏi văn bản đọc, nhóm các cue cùng một câu thành **đơn vị đọc**, gọi nhà cung cấp một lần cho mỗi đơn vị (dùng lại cache theo đơn vị), rồi **đặt từng đơn vị vào đúng mốc bắt đầu của cue đầu** trên một tệp PCM duy nhất: mượn khoảng nghỉ liền sau → nén `atempo` ≤ 1,25× → nếu vẫn tràn thì cue kế **trượt nhẹ** (≤ 0,5 s, bù lại ở khoảng nghỉ) và đơn vị vượt mức bị cảnh báo. Phụ đề dài được chia **phần theo cửa sổ ~10 phút** tại khoảng nghỉ lớn nhất, nhưng ghép tuần tự vào một tệp theo mốc tuyệt đối nên lỗi không cộng dồn; tiếp tục dựa vào `job_segments` + cache sẵn có.
2. **Nền tảng giao diện**: Sáng/Tối (`next-themes` đã có trong dependencies, khối `.dark` đã có trong theme), **đa ngôn ngữ vi/en** (từ điển có kiểm tra kiểu + lỗi API theo khóa), **font Be Vietnam Pro** (Outfit không có subset tiếng Việt), **token viền ô nhập** riêng (hiện 1,08:1 → ≥ 3:1) và **tab quản trị nổi bật** (`aria-current`).

Hướng kỹ thuật chi tiết và lý do: [research.md](./research.md). Đã bỏ `.skt`, chỉ nhận `.srt` (migration 0004) trước khi lập kế hoạch này.

## Technical Context

**Language/Version**: TypeScript 5.9 (strict), Node.js 22

**Primary Dependencies**: Next.js 16 (App Router), React 19, Tailwind CSS 4 + shadcn/ui, `next-themes` (đã có), `next/font/google` (Be Vietnam Pro), Drizzle ORM, pg-boss, Better Auth, ffmpeg (`atempo`, đã có trong ảnh worker). **Không thêm phụ thuộc mới** (đa ngôn ngữ tự xây — research R8).

**Storage**: PostgreSQL 16 (bảng mới `subtitle_cues`; cột mới ở `subtitle_files`, `users`; `voices.timeline` mở rộng jsonb), MinIO (không đổi: tệp nguồn, audio cache, voice MP3)

**Testing**: Vitest (unit, integration, contract, isolation) + Playwright (desktop + mobile 375 px); nhà cung cấp giả mở rộng (scenario trên đường dẫn) để điều khiển thời lượng đọc, khoảng lặng, 429 và nội dung bị chặn. **Dữ liệu thử tối đa 10 giây** (`tests/fixtures/sample-10s.srt`) theo chỉ thị của người dùng.

**Target Platform**: Linux server (Docker: web + worker + postgres + minio + cloudflared); trình duyệt hiện đại, desktop và điện thoại

**Project Type**: Web application (một mã nguồn Next.js + tiến trình worker pg-boss), như spec 001

**Performance Goals**: đặt mốc và ghép tuần tự không giữ toàn bộ PCM trong RAM; xem trước cue theo trang < 1 s/trang; đổi ngôn ngữ/theme < 1 s không tải lại; thời gian xử lý tệp phụ đề dài bị chặn bởi giới hạn yêu cầu/phút của nhà cung cấp (không phải bởi thuật toán)

**Constraints**: không chồng tiếng, `slip` ≤ 500 ms hoặc có cảnh báo; không cắt cụt lời; không gọi thêm nhà cung cấp chỉ để tăng tốc (chi phí ước tính chính xác); giữ nguyên "Đọc liên tục"; cô lập dữ liệu giữa người dùng cho API mới; không hard-code giá/giới hạn nhà cung cấp

**Scale/Scope**: 1 tệp ≤ giới hạn cài đặt (mặc định 2 MB ≈ vài chục nghìn cue); tệp mẫu 244 cue/11 phút 45 giây (204 đơn vị khi ghép câu); 37 module dùng từ điển `vi` cần chuyển sang từ điển theo ngôn ngữ; ~12 màn hình/trang bị ảnh hưởng bởi theme/font/i18n

## Constitution Check

*GATE: phải qua trước Phase 0. Kiểm tra lại sau Phase 1 (bảng "Sau thiết kế" bên dưới).*

| Nguyên tắc | Đánh giá trước thiết kế | Ghi chú |
|-----------|-------------------------|---------|
| I. Bảo mật và cô lập | ✅ Đạt | Endpoint mới (`cues`, `estimate`) kiểm tra quyền ở máy chủ, tài nguyên người khác trả 404; `subtitle_cues` truy cập qua `subtitle_files.owner_id`; thêm vào `isolation.test.ts` qua `openapi.yaml` |
| II. Bảo vệ khóa API | ✅ Đạt | Không thêm bí mật; `estimate` không lộ khóa; cấu hình riêng không tự chuyển sang chung |
| III. Tiến trình nền bền vững | ✅ Đạt | Chạy trong worker; tiếp tục bằng `job_segments` + cache; log theo phần (không bùng nổ); lỗi tạm/vĩnh viễn giữ nguyên chính sách |
| IV. Kiểm soát chi phí | ✅ Đạt | Cache theo đơn vị (khóa gồm văn bản + giọng + model + tốc độ); nén/trượt không gọi thêm nhà cung cấp; giới hạn yêu cầu/phút lấy từ catalog + ghi đè được (không hard-code như sự thật cố định); tiền chỉ hiện khi đã có `pricePerMillionChars`; hạn mức lưu trữ kiểm ở máy chủ; usage ghi theo lần gọi thật |
| V. Kiểm thử | ✅ Đạt (kế hoạch) | Kiểm thử đơn vị cho `placeUnits`/`buildReadingUnits`/`planParts`, tích hợp với nhà cung cấp giả, E2E theme/i18n/tab, tương phản màu; dữ liệu thử ≤ 10 s |
| VI. Giao diện nhất quán, **tiếng Việt** | ✅ Đã xử lý bằng hiến pháp 1.1.0 | Trước đó "Giao diện MUST dùng tiếng Việt" mâu thuẫn FR-020 (thêm English); nay tiếng Việt là mặc định và luôn đầy đủ, cho phép thêm ngôn ngữ. Phần còn lại đạt: dùng token/thành phần chung (`--field-border`, `AdminNav` dùng token `primary`), trạng thái tải/rỗng/lỗi giữ nguyên, dùng được trên điện thoại, tìm kiếm không dấu giữ ở cả hai ngôn ngữ |
| Ràng buộc kỹ thuật | ✅ Đạt | Next.js + shadcn + theme tweakcn (chỉ thêm token); `.srt` chuẩn SubRip (hiến pháp đã cập nhật); mốc thời gian theo câu/đoạn (mốc nội bộ chia theo ký tự, không theo từng từ) |
| Phạm vi giai đoạn | ✅ Đạt | Không làm xuất phụ đề, highlight theo từng từ, chỉnh văn bản trong ứng dụng, tính phí theo usage |

**Kết quả cổng**: qua, với **một** ngoại lệ phải xử lý bằng sửa hiến pháp (không được bỏ qua âm thầm — Governance).

## Project Structure

### Documentation (this feature)

```text
specs/003-subtitle-timing-i18n-theme/
├── plan.md              # Tệp này
├── research.md          # Phase 0 (R1–R14)
├── data-model.md        # Phase 1
├── quickstart.md        # Phase 1
├── contracts/
│   ├── openapi-delta.yaml   # Phần bổ sung API (hợp nhất vào openapi.yaml của spec 001 khi triển khai)
│   ├── timing-engine.md     # Hợp đồng ba hàm thuần + bất biến
│   └── ui-preferences.md    # Cookie, từ điển, lỗi API, font, token viền, tab quản trị
├── checklists/requirements.md
└── tasks.md             # Phase 2 (/speckit-tasks — KHÔNG tạo ở bước này)
```

### Source Code (repository root)

Cấu trúc Next.js + worker đã có; chỉ liệt kê phần thêm/sửa:

```text
src/
├── lib/
│   ├── parsing/
│   │   ├── srt.ts                    # + parseSrtCues (giữ srtToParagraphs)
│   │   └── reading-units.ts          # MỚI: buildReadingUnits, chia theo mệnh đề
│   ├── audio/
│   │   ├── placement.ts              # MỚI: placeUnits, planParts (hàm thuần)
│   │   ├── trim.ts                   # MỚI: cắt lặng đầu/cuối PCM
│   │   ├── tempo.ts                  # MỚI: nén atempo qua ffmpeg
│   │   └── merge-timed.ts            # MỚI: ghép tuần tự theo mốc tuyệt đối
│   ├── db/schema/{projects,auth,jobs}.ts  # + cột/bảng mới; migrations/0005_*.sql
│   ├── jobs/{service,estimate,manage}.ts  # createJob nhận `timing`; estimate mới; manage tạo lại job_segments khi `timing` đổi
│   ├── i18n/{vi,en,index,fmt}.ts     # từ điển có kiểm tra kiểu, getT/useT, định dạng Intl
│   ├── api/errors.ts                 # HttpError mang messageKey; route() dịch theo ngôn ngữ yêu cầu
│   ├── providers/{catalog,rate-limit}.ts  # requestsPerMinute + token bucket
│   └── settings-defaults.ts          # + 4 khóa timing*
├── worker/
│   ├── jobs/generate-voice.ts        # nhánh `timed`: đơn vị đọc → synthesize → mergeTimed
│   └── pipeline/                     # dùng lại synthesize-segment + cache
├── app/
│   ├── layout.tsx                    # font Be Vietnam Pro, ThemeProvider, I18nProvider, lang động
│   ├── globals.css                   # --font-*, --field-border, @theme inline
│   ├── (admin)/admin/layout.tsx      # dùng AdminNav
│   ├── (dev)/dev/typography/page.tsx # trang kiểm thử chữ (chỉ ngoài production)
│   └── api/
│       ├── files/[fileId]/{cues,estimate}/route.ts   # MỚI
│       └── me/route.ts               # PATCH nhận locale, theme
└── components/
    ├── app/{theme-toggle,locale-switch,i18n-provider}.tsx   # MỚI
    ├── admin/admin-nav.tsx           # MỚI (client)
    ├── jobs/{create-voice-dialog,timing-options,estimate-panel}.tsx  # sửa/MỚI
    ├── projects/cue-preview.tsx      # MỚI: xem trước cue phân trang
    ├── player/{synced-text,voice-view}.tsx   # đọc timeline.text/cues khi có
    └── ui/{input,textarea,select,popover}.tsx # border-field-border

tests/
├── fixtures/sample-10s.srt           # MỚI (≤ 10 giây)
├── unit/{srt-cues,reading-units,placement,plan-parts,field-contrast,i18n-dict}.test.ts
├── integration/{timed-job,estimate,cues-api,prefs}.test.ts
├── isolation/                        # đọc openapi.yaml đã hợp nhất
└── e2e/{theme,locale,admin-nav,timed-voice,typography}.spec.ts
scripts/check-i18n.ts                 # mở rộng: đủ khóa/giữ chỗ giữa vi–en
mock-provider/server.ts               # + scenario `ms-<n>`, `pad-<n>`, `429-<k>`, `blocked-<từ khóa>` (qua đường dẫn /s/<scenario>)
```

**Structure Decision**: giữ một dự án Next.js + worker (như spec 001); logic đặt mốc là **hàm thuần** trong `src/lib/audio` để kiểm thử bằng số mà không cần DB/ffmpeg; worker chỉ điều phối I/O. Không tạo bảng `job_parts` (phần là khái niệm suy ra — research R4).

## Phân giai đoạn triển khai (gợi ý cho `/speckit-tasks`)

1. **Nền** (chặn mọi thứ): sửa hiến pháp (cho phép đa ngôn ngữ); migration `0005`; từ điển `vi/en` + `I18nProvider`/`getT`; lỗi API theo `messageKey`.
2. **US1 + US2 (P1)**: `parseSrtCues` + `subtitle_cues` + cảnh báo → `buildReadingUnits` → `placeUnits`/`planParts` (thuần, test trước) → `trim`/`tempo`/`merge-timed` → nhánh `timed` ở worker + giới hạn yêu cầu/phút → `estimate` + `cues` API + giao diện tạo voice/xem trước/trình phát.
3. **US3, US4, US5 (P2)**: theme (provider + nút + `--field-border` + test tương phản); chuyển 37 module sang `useT/getT` + nút ngôn ngữ + `PATCH /api/me`; font + trang kiểm thử chữ.
4. **US6 (P3)**: `AdminNav`.
5. **Hoàn thiện**: rà soát lần cuối phần `openapi-delta.yaml` còn lại (phần `/me` hợp nhất ở bước Nền, phần US1 ở bước US1), mở rộng `check-i18n`, E2E, tài liệu (README, `docs/operations.md`).

> Mọi tác vụ thay đổi giao diện người dùng thấy được PHẢI chạy `ui-consistency:finding-patterns` trước khi giao cho người thực hiện (quy trình dự án); `/speckit-tasks` cần ghi bước này vào giai đoạn tương ứng.

## Constitution Check — sau thiết kế

Thiết kế Phase 1 không phát sinh vi phạm mới: `subtitle_cues` cô lập qua tệp; `estimate` và `cues` yêu cầu đăng nhập và chủ sở hữu; không có bí mật mới; cache theo đơn vị giữ Nguyên tắc IV; mọi giới hạn đặt mốc là cài đặt hệ thống (không hard-code); kiểm thử cô lập bao phủ qua `openapi.yaml`. Ngoại lệ duy nhất vẫn là Nguyên tắc VI (tiếng Việt), được xử lý bằng sửa hiến pháp bên dưới.

## Complexity Tracking

| Vi phạm / độ phức tạp | Vì sao cần | Phương án đơn giản hơn bị loại vì |
|----------------------|------------|----------------------------------|
| Nguyên tắc VI: "Giao diện MUST dùng tiếng Việt" ↔ FR-020 (thêm English) — **ĐÃ XỬ LÝ**: hiến pháp 1.1.0 (2026-11-20) | Người dùng yêu cầu đa ngôn ngữ; tiếng Việt vẫn mặc định và luôn đầy đủ | Bỏ yêu cầu đa ngôn ngữ trái ý người dùng. **Hành động**: sửa hiến pháp lên **1.1.0 (MINOR)** — "Giao diện MUST đầy đủ bằng tiếng Việt (mặc định); MAY có thêm ngôn ngữ khác miễn là mọi ngôn ngữ đủ khóa và tiếng Việt luôn là dự phòng"; cập nhật dòng "Tài liệu và thông báo giao diện dùng tiếng Việt" tương ứng; làm bằng `/speckit-constitution` **trước** task triển khai i18n |
| Lớp i18n tự xây (thay vì thư viện) | Từ điển được dùng ngoài React (zod, `HttpError`, worker) và cần kiểm tra kiểu theo thuộc tính | next-intl: vẫn phải tự giải quyết phần ngoài React, thêm cú pháp khóa chuỗi (mất kiểm tra kiểu hiện có) |
| Token `--field-border` thêm vào theme tweakcn (Nguyên tắc VI: không tự viết kiểu riêng) | `--input`/`--border` của theme chỉ đạt 1,08–1,33:1; spec yêu cầu ≥ 3:1 | Thêm `border-2` từng màn hình: vi phạm VI và dễ sót; sửa `--border` làm đường kẻ/thẻ đậm bất thường |
| Bảng `subtitle_cues` (thêm bảng) | Xem trước phân trang + sinh lại đơn vị xác định mà không phân tích lại tệp nguồn từ MinIO mỗi lần | Phân tích lại tệp theo yêu cầu: tải MinIO + parse mỗi trang xem trước/mỗi lần tiếp tục job; khó kiểm thử cô lập |

## Rủi ro và điểm cần kiểm chứng sớm

1. **Giả thuyết cắt lặng** (R3): số liệu 27% cue tràn khe là thời lượng thô; cần đo lại sau khi cắt lặng bằng ≤ 3 cue thật (quickstart §8) trước khi tinh chỉnh `maxCompress`.
2. **Chất lượng `atempo` ≤ 1,25×** với giọng tiếng Việt: nghe thử thủ công trên cue "Không Putin."; nếu méo rõ, hạ mặc định về 1,15 (cài đặt hệ thống, không đổi mã).
3. **Khối lượng chuyển i18n**: 37 module; làm theo lô có `check-i18n` và `tsc` chặn thiếu khóa.
4. **Google Fonts lúc build**: Docker build cần mạng tới Google Fonts một lần (như Outfit); nếu build offline thì cần tải font vào repo (phương án B, ghi vào `docs/operations.md`).
5. **Giới hạn kích thước tệp**: vẫn 2 MB mặc định (spec 003 không nâng); `subtitle_cues` chịu được vài chục nghìn dòng.
