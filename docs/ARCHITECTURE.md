# Kiến trúc

PWA tĩnh trên GitHub Pages. Không backend: trình duyệt gọi thẳng Claude API và Gemini API bằng key người dùng nhập.

## Luồng xử lý

```
video ─┬─ cắt khung 1 khung/giây ─ lọc trùng ─┐
       └─ audio → PCM 16kHz → STT ────────────┴→ A. trích câu hỏi → B. giải (Opus ∥ Sonnet) → C. đối chiếu/trọng tài → kết quả
```

| Khâu | Hành vi | Code |
|---|---|---|
| Cắt khung (web) | `<video>` ẩn, seek từng giây (timeout 3s), vẽ canvas, JPEG 0.85, cạnh dài ≤ 1920px | [extractFrames](../src/web/video-frames.js#L188) `current` |
| Cắt khung (Node/eval) | ffmpeg xuất JPEG + thumbnail xám, rồi dùng cùng reducer lọc trùng | [extractFrames](../eval/node-media.mjs#L15) `current` |
| Lọc khung trùng | Tỉ lệ pixel lệch độ sáng trên thumbnail 160×90; giữ thêm khung cuối trước khi màn hình đổi | [selectFrame](../src/core/frame-dedupe.js#L27) `current` |
| Video không decode được | Thử ffmpeg.wasm một luồng; hỏng nữa thì báo cách đổi định dạng trên iPhone | [ffmpegFrames](../src/web/video-frames.js#L92) `current` |
| Audio | `decodeAudioData` → resample 16kHz mono; file > 150MB thì bỏ qua audio | [decodeAudioTo16k](../src/web/audio-pcm.js#L23) `current` |
| Speech-to-text | Gemini Transcribe nếu có key, lỗi/không key → Whisper; cả hai hỏng → bỏ audio | [transcribe](../src/core/speech-to-text.js#L99) `current` |
| Whisper trong trình duyệt | Web Worker + transformers.js từ jsdelivr; có `onerror` và timeout im lặng | [whisperInWorker](../src/web/whisper-client.js#L10) `current` |
| Gọi Claude | fetch + SSE, thinking adaptive, JSON schema; 429/529 retry có backoff, 401 báo sai key | [callClaude](../src/core/claude-client.js#L123) `current` |
| A. Trích câu hỏi | Chia lô ≤ 80 khung/request, gộp theo số câu | [extractQuestions](../src/core/extract-questions.js#L117) `current` |
| B. Giải / trọng tài | Gửi lại khung liên quan + JSON câu hỏi | [solveQuestions](../src/core/solve-questions.js#L66) `current` |
| C. Đối chiếu | So đáp án đã chuẩn hoá; lệch thì trọng tài quyết; không chắc thì `(?)` | [finalizeCrossChecked](../src/core/cross-check.js#L55) `current` |
| Điều phối + checkpoint | Mỗi bước lưu vào store; chạy lại sẽ bỏ qua bước đã xong | [runPipeline](../src/core/pipeline.js#L27) `current` |
| Giao diện + chạy tiếp | IndexedDB giữ khung/transcript/kết quả từng bước; mở lại app thì tự chạy tiếp | [init](../src/web/app.js#L416) `current` |
| Service worker | Cache vỏ app, mạng trước cache sau, không đụng request khác origin | [fetch handler](../sw.js#L25) `current` |

## Quyết định chính

- **Một lõi, hai vỏ.** `src/core/` không biết DOM lẫn Node. Web và `eval/run-eval.mjs` chỉ khác nhau ở cách lấy khung hình/audio, nên số đo của eval phản ánh đúng logic bản web. `current`
- **Cú pháp API theo docs 2026-11.** `budget_tokens` và ép `tool_choice` đều trả 400 trên Opus 5.5 / Sonnet 5.5, nên dùng `thinking: {type: "adaptive"}` + `output_config.effort` + `output_config.format`. `current`
- **Ngưỡng lọc khung 12 / 0.1%** thay cho 40 / 0.3% của đề bài gốc: đo trên `eval/videos/small-change.mp4`, ngưỡng gốc làm mất 4/6 màn hình câu hỏi. `current`
- **Ảnh gửi dưới dạng base64 trong từng request.** Trần: video quay bằng camera (khung nào cũng khác nhau) có thể tạo request vài chục MB, gửi lại 3–4 lần. Hướng nâng cấp: Files API (tải một lần, tham chiếu `file_id`). `decided` — chưa làm, chờ số đo trên 4G thật.
- **Không dùng prompt caching.** Schema output khác nhau giữa các bước làm mất cache; chỉ có lượt trọng tài hưởng lợi. `decided`

## Giới hạn đã biết

- ffmpeg.wasm chạy một luồng (GitHub Pages không đặt được COOP/COEP) và phải đọc cả file vào RAM → chỉ dùng cho file ≤ 150MB, chậm với video 4K. Nó xuất PNG theo từng đoạn 20s vì bộ mã hoá JPEG của lõi wasm sập với khung từ 720p trở lên; có đồng hồ canh 60s để không treo khi lõi sập.
- Huỷ giữa chừng không huỷ được request đang bay tới Claude; request đó vẫn bị tính tiền.

## Chưa khớp thực tế

| Claim | Ý định | Trạng thái | Bằng chứng |
|---|---|---|---|
| Gemini `gemini-3.5-transcribe` nhận audio WAV inline qua `/v1beta/interactions` | `current` | Chưa kiểm chứng bằng key thật — chỉ có test với API giả lập và CORS preflight | [geminiTranscribeChunk](../src/core/speech-to-text.js#L55) |
| Cắt khung bằng `<video>` chạy trên iOS Safari thật | `current` | Chưa thử trên máy thật — WebKit của Playwright trên Windows không có codec video | [videoElementFrames](../src/web/video-frames.js#L40) |
| Fallback ffmpeg.wasm giải mã được HEVC 4K từ iPhone | `current` | Mới thử HEVC 640×360 tự tạo và H.264 720p/1080p (qua profile WebKit); chưa có video HEVC thật từ iPhone | [tests/e2e/app.spec.mjs](../tests/e2e/app.spec.mjs) |
