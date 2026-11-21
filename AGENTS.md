# AGENTS.md

PWA tĩnh giải câu hỏi tiếng Anh từ video bằng Claude API. Không backend, không bundler, không framework.
File này chỉ ghi phần KHÁC so với luật global (`~/.claude/templates/AGENTS.template.md` không tồn tại trên máy lúc tạo, nên viết tay).

## Cấu trúc

| Thư mục | Vai trò |
|---|---|
| `src/core/` | Logic pipeline dùng chung cho web và Node: ESM thuần, KHÔNG đụng DOM, `fetch` được truyền vào |
| `src/web/` | Phần chỉ chạy trên trình duyệt: giao diện, `<video>`/canvas, Web Audio, Worker, IndexedDB |
| `vendor/ffmpeg/` | Lớp vỏ ESM của `@ffmpeg/ffmpeg`, sinh bằng `npm run vendor` — không sửa tay |
| `eval/` | Video mẫu, `answers.json`, script đo độ chính xác, `RESULTS.md` |
| `tests/unit/`, `tests/e2e/` | `node:test` và Playwright |
| `scripts/` | Server tĩnh local, script vendor |

## Luật riêng của repo

- **Không hardcode API key** ở bất kỳ đâu. Web đọc từ `localStorage`, script eval đọc từ `.env` (đã gitignore).
- **Không đoán tên model / tham số API.** Tra docs hiện hành rồi sửa ở [`src/core/constants.js`](src/core/constants.js) và [`src/core/claude-client.js`](src/core/claude-client.js).
- **Đổi prompt, model, hoặc ngưỡng lọc khung → chạy lại `npm run eval`** và cập nhật `eval/RESULTS.md` trong cùng task.
- `src/core/` phải chạy được cả trong trình duyệt lẫn Node: không `document`, không `Buffer`, không `node:*`.
- Mọi đường dẫn trong HTML/JS/manifest/service worker là **tương đối** (GitHub Pages phục vụ dưới `/<repo>/`).
- Thêm file vào app → thêm vào danh sách `SHELL` trong [`sw.js`](sw.js) và tăng số phiên bản `CACHE`.
- Nội dung từ model hiển thị bằng `textContent`, không bao giờ `innerHTML`.
- Không dùng `alert` / `confirm` / `prompt`. Nút cao ≥ 48px, input font ≥ 16px.

## Lệnh

| Lệnh | Việc |
|---|---|
| `npm start` | Server tĩnh tại `http://localhost:4173` |
| `npm test` | Unit test (`node:test`) |
| `npm run test:e2e` | Playwright: iPhone 13 (WebKit) + Pixel 7 (Chromium), mọi API đều giả lập |
| `npm run eval:samples` | Tạo lại video mẫu + fixture (cần Windows TTS) |
| `npm run eval` | Đo độ chính xác thật — **tốn tiền Claude API**; `-- --dry` để chỉ thử khâu media |

## Ngôn ngữ

Tài liệu, giao diện, comment và tên test: tiếng Việt. Tên biến/hàm và prompt gửi model: tiếng Anh.
