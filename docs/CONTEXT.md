# Bối cảnh

## Mục tiêu (theo thứ tự ưu tiên)

1. **Độ chính xác của đáp án.** Chấp nhận chậm và tốn hơn để đúng nhiều hơn; sót câu hỏi là lỗi nặng nhất.
2. **Dùng được trên điện thoại thật** (iPhone Safari, Android Chrome), Wi-Fi hoặc 4G, không cần máy tính bật.
3. **Hosting 0đ** (GitHub Pages). Chi phí duy nhất là Claude API của người dùng.

## Trạng thái (2026-11-21)

| Hạng mục | Trạng thái | Bằng chứng |
|---|---|---|
| Lõi pipeline + unit test | `current` | `npm test`: 46/46 pass |
| PWA + Playwright (iPhone 13, Pixel 7) | `current` | `npm run test:e2e`: 36 pass, 4 bỏ qua có lý do (xem dưới) |
| Whisper thật trong trình duyệt | `current` | `REAL_WHISPER=1` trên Chromium: nghe đúng "Question 1. She … to school every day." |
| Lọc khung trên trình duyệt khớp bản Node | `current` | Playwright trên cả hai profile: `small-change` 12 khung, `scroll` 18, `fill-blank` 4 — bằng đúng số của ffmpeg/Node |
| Video mẫu + script eval | `current` | 6 video, 33 câu trong [`eval/answers.json`](../eval/answers.json); `npm run eval -- --dry` chạy được |
| Đo độ chính xác bằng Claude thật | `building` | Chưa chạy — chưa có `ANTHROPIC_API_KEY` trong `.env` |
| Deploy GitHub Pages | `current` | <https://bbangnguyen.github.io/video-quiz-solver/> — 2026-11-21: mọi file trong `SHELL` của `sw.js` trả 200, service worker đăng ký được, mở lại được khi offline (Chromium) |
| Duyệt giao diện bằng mắt | `building` | Ảnh chụp ở [`docs/review/assets/`](review/assets/), chờ chủ repo xem |

## Quyết định đã chốt với chủ repo

- Kế hoạch 5 bước và các điểm docs khác đề bài (thinking adaptive, `output_config.format`, `anthropic-version: 2026-10-21`, ảnh ≤ 1920px, `gemini-3.5-transcribe`) — đồng ý ngày 2026-11-21.

## Lệch so với đề bài, cần chủ repo biết

- **Ngưỡng lọc khung trùng: 12 / 0.1% thay cho 40 / 0.3%.** Với ngưỡng gốc, video mẫu `small-change` (chữ 22px trên màn 1080p, chỉ thẻ câu hỏi đổi) giữ 2/21 khung và mất 4/6 màn hình câu hỏi; đo được chỉ 0.03–0.11% pixel lệch quá 40. Ngưỡng mới giữ 12/21 khung, đủ cả 6 câu. Hằng số ở [`src/core/constants.js`](../src/core/constants.js#L17).

## Chưa khớp thực tế

| Claim | Ý định | Trạng thái | Bằng chứng |
|---|---|---|---|
| App chạy đúng trên iPhone Safari và Android Chrome thật | `current` | Chưa thử máy thật; mới có Playwright giả lập thiết bị | Checklist thử máy thật trong báo cáo bàn giao |
| Profile iPhone 13 kiểm được đường `<video>`/canvas và audio | `current` | Không: WebKit của Playwright trên Windows không có codec video lẫn `AudioContext`, nên mọi test của profile này đi qua nhánh ffmpeg.wasm và 2 case cần decode audio bị bỏ qua. Đường `<video>`/canvas chỉ được kiểm trên Chromium (Pixel 7) | [`tests/e2e/app.spec.mjs`](../tests/e2e/app.spec.mjs) |
