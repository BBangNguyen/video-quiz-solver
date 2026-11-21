# Kết quả eval

**Chưa có số đo độ chính xác.** `npm run eval` cần `ANTHROPIC_API_KEY` trong `.env`, và tới ngày 2026-11-21 file đó chưa có. File này sẽ được `npm run eval` ghi đè bằng bảng số liệu thật (% đúng, % sót, % `(?)`, thời gian, chi phí; Chính xác so với Nhanh).

## Đã đo được không cần key (khâu media, `npm run eval -- --dry`, 2026-11-21)

| Video | Số câu | Khung lấy mẫu | Khung giữ lại | STT |
|---|---|---|---|---|
| fill-blank.mp4 | 6 | 15 | 4 | không có tiếng |
| listening.mp4 | 4 | 52 | 4 | Whisper |
| mcq-grammar.mp4 | 5 | 40 | 10 | Whisper |
| reading.mp4 | 4 | 21 | 6 | không có tiếng |
| scroll.mp4 | 8 | 18 | 18 | không có tiếng |
| small-change.mp4 | 6 | 21 | 12 | không có tiếng |

- Whisper (`Xenova/whisper-base.en`, chạy bằng Node) nghe đúng toàn bộ đoạn hội thoại của `listening.mp4`, kể cả các chi tiết là đáp án: "Friday evening", "six of us", "half past seven", "Mr Baker".
- Gemini Transcribe chưa đo: chưa có `GEMINI_API_KEY`.
- Với ngưỡng lọc khung của đề bài gốc (40 / 0.3%), `small-change.mp4` chỉ giữ 2/21 khung → mất 4/6 màn hình câu hỏi. Ngưỡng hiện tại (12 / 0.1%) giữ 12/21.
- Bản web (canvas của Chromium, và nhánh ffmpeg.wasm trên WebKit) giữ đúng số khung như bảng trên với `small-change` (12), `scroll` (18), `fill-blank` (4) — đo bằng Playwright.
