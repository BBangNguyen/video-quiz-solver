# Giải đề từ video

PWA cho điện thoại: quay (hoặc chọn) một video có câu hỏi tiếng Anh — trắc nghiệm, điền từ, đọc hiểu, đề nghe — và nhận đáp án từng câu. Chạy hoàn toàn trên trình duyệt, không có server riêng; chi phí duy nhất là Claude API của chính bạn.

## Dùng thế nào

1. Mở link GitHub Pages của app trên điện thoại (iPhone: Safari, Android: Chrome).
2. Thêm vào màn hình chính: Safari → Chia sẻ → **Thêm vào MH chính**; Chrome → ⋮ → **Thêm vào màn hình chính**.
3. Bấm ⚙️ và nhập key (xem bên dưới).
4. Chọn chế độ, bấm **📷 Quay video** hoặc **🖼️ Chọn từ máy**. Giữ màn hình mở trong lúc xử lý.
5. Dòng đầu là tổng số câu đếm được — so với đề để biết có sót câu nào không. Bấm vào từng câu để xem câu hỏi và giải thích. Câu có `(?)` là câu app không chắc.

Lỡ khoá máy, đổi app hay rớt mạng giữa chừng: mở lại app, nó chạy tiếp từ bước đang dở (khung hình và kết quả từng bước đã lưu trong máy).

### Mẹo quay để đúng nhiều hơn

- Mỗi câu hỏi nên hiện trọn vẹn và đứng yên ít nhất 1–2 giây. Cuộn chậm.
- Quay màn hình (screen recording) cho chữ nét hơn quay bằng camera.
- Đề nghe: để âm lượng đủ lớn, tránh tạp âm.
- iPhone: nếu Android/máy khác báo không đọc được video, vào **Cài đặt → Camera → Định dạng → Tương thích nhất**.

## Nhập key

### Claude API key (bắt buộc)

1. Vào <https://console.anthropic.com> → **API keys** → **Create key**.
2. Trong app bấm ⚙️, dán vào ô **Claude API key**, bấm **Lưu**.

Key chỉ nằm trong `localStorage` của trình duyệt trên máy bạn và chỉ được gửi tới `api.anthropic.com`. Nó không có trong mã nguồn. Vì key nằm trên máy, hãy **đặt hạn mức chi tiêu** cho key trong Console, và đừng nhập key trên máy người khác.

### Gemini API key (không bắt buộc, miễn phí)

Claude không nhận audio, nên phần nghe cần một bước chuyển giọng nói thành chữ:

- **Có key Gemini:** dùng model `gemini-3.5-transcribe` gói miễn phí — nhanh và nhẹ máy.
- **Không có key (hoặc Gemini lỗi):** app tự chạy Whisper (`whisper-base.en`) ngay trong trình duyệt. Lần đầu phải tải model (~80MB) nên chậm hơn và tốn dung lượng mạng.

Lấy key: vào <https://aistudio.google.com/apikey> → **Create API key** → dán vào ô **Gemini API key** trong ⚙️.

> ⚠️ **Lưu ý quyền riêng tư:** theo bảng giá của Google, dữ liệu gửi lên Gemini **gói miễn phí có thể được Google dùng để cải thiện sản phẩm**. Nếu audio trong video là thứ bạn không muốn chia sẻ, hãy bỏ trống key Gemini để app nghe bằng Whisper ngay trên máy.

## Hai chế độ

| | 🎯 Chính xác (mặc định) | ⚡ Nhanh |
|---|---|---|
| Trích câu hỏi | `claude-opus-5-5` | `claude-sonnet-5-5` |
| Giải | `claude-opus-5-5` (thinking, effort high) **và** `claude-sonnet-5-5` giải độc lập | `claude-sonnet-5-5`, một lượt |
| Khi hai lượt lệch nhau | Thêm lượt trọng tài Opus, nhận cả hai lập luận | — |
| Đánh dấu `(?)` | Trọng tài không chắc, hoặc cả hai lượt cùng tự nhận không chắc | Model tự nhận không chắc |

## Chi phí Claude ước tính

App hiện chi phí của từng lần giải, tính từ `usage` mà API trả về. Số đo thật trên bộ video mẫu nằm ở [`eval/RESULTS.md`](eval/RESULTS.md).

Bảng dưới là **ước tính theo công thức token, chưa phải số đo**: mỗi khung hình tốn `⌈rộng/28⌉ × ⌈cao/28⌉` token (khung 1920×1080 ≈ 2.700 token, 1280×720 ≈ 1.200 token); giá Opus 5.5 là $4 / $20 và Sonnet 5.5 là $2 / $10 cho mỗi triệu token vào / ra.

| Video | Khung giữ lại | 🎯 Chính xác | ⚡ Nhanh |
|---|---|---|---|
| Quay màn hình 1080p ~1 phút, ~10 câu | ~20 | khoảng $0.8 – $1.1 | khoảng $0.3 |
| Quay màn hình 720p ~30 giây, ~5 câu | ~10 | khoảng $0.3 – $0.5 | khoảng $0.1 |
| Quay bằng camera 1080p ~1 phút (khung nào cũng khác nhau) | ~60 | khoảng $2 – $3 | khoảng $0.8 |

Chi phí tăng gần như tỉ lệ với số khung giữ lại, nên video càng ngắn và càng ít rung thì càng rẻ.

## Triển khai (GitHub Pages, 0đ)

App là file tĩnh, không cần build.

```bash
gh repo create <ten-repo> --public --source . --push
gh api -X POST repos/<user>/<ten-repo>/pages -f "source[branch]=main" -f "source[path]=/"
```

Hoặc trên web: **Settings → Pages → Deploy from a branch → `main` / `/ (root)`**. Sau 1–2 phút app có tại `https://<user>.github.io/<ten-repo>/`. Pages miễn phí yêu cầu repo public.

Mỗi lần phát hành bản mới, tăng số trong `CACHE` ở [`sw.js`](sw.js) để điện thoại lấy bản mới.

## Phát triển

```bash
npm install
npx playwright install chromium webkit
npm start            # http://localhost:4173
npm test             # unit test
npm run test:e2e     # Playwright: iPhone 13 (WebKit) + Pixel 7 (Chromium), API giả lập
```

### Đo độ chính xác

1. Bỏ video thật vào `eval/videos/` và thêm đáp án đúng vào `eval/answers.json`:
   ```json
   { "de-thi-1.mp4": { "answers": { "1": "B", "2": "went", "3": ["color", "colour"] } } }
   ```
2. Tạo file `.env` ở gốc repo (đã gitignore): `ANTHROPIC_API_KEY=...` và tuỳ chọn `GEMINI_API_KEY=...`.
3. Chạy `npm run eval` (tốn tiền Claude). Kết quả ghi vào `eval/RESULTS.md`: % đúng, % sót, % `(?)`, thời gian và chi phí trung bình, so hai chế độ.

`npm run eval -- --dry` chỉ chạy khâu cắt khung + nghe, không gọi Claude. Script eval dùng chung `src/core/` với bản web, chỉ khác ở chỗ lấy khung hình và audio bằng ffmpeg.

**Mỗi khi đổi prompt, model hoặc ngưỡng lọc khung, chạy lại eval.**

## Giới hạn đã biết

- Video > 150MB: bỏ qua phần nghe (tránh đọc cả file vào RAM), vẫn giải theo hình.
- Tối đa 160 khung hình mỗi video; vượt thì lấy mẫu đều.
- Bấm **Huỷ** không dừng được request đang gửi tới Claude, nên lượt đó vẫn bị tính tiền.
- Kiến trúc và các điểm chưa kiểm chứng: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
