import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { AGREED, blockCdns, claudeError, mockClaude, mockGemini, openApp, pickVideo, serveFfmpegCoreLocally, stubWhisper } from './mock-apis.mjs';

// WebKit của Playwright trên Windows không có codec video lẫn AudioContext (khác Safari thật trên iPhone):
// video đi qua nhánh ffmpeg.wasm, còn các case cần decode audio chỉ chạy được trên Chromium.
const evalVideos = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'eval', 'videos');
const isWebKit = (testInfo) => testInfo.project.name === 'iPhone 13';
const needsAudioDecode = (testInfo) => test.skip(isWebKit(testInfo), 'WebKit Playwright/Windows không có AudioContext');

test.beforeEach(async ({ page }) => {
  await serveFfmpegCoreLocally(page);
  await stubWhisper(page); // mặc định không tải Whisper thật; có test riêng bật bằng REAL_WHISPER=1
});

const answerLines = (page) => page.locator('#answers summary').allInnerTexts().then((rows) => rows.map((r) => r.replace(/\s+/g, ' ').trim()));

test('Chính xác: quay video → tổng số câu, đáp án từng dòng, bấm để xem giải thích, copy, chi phí, lịch sử', async ({ page }, testInfo) => {
  const calls = await mockClaude(page);
  await openApp(page);
  await pickVideo(page);

  await expect(page.locator('#result-total')).toHaveText('Tổng: 2 câu');
  expect(await answerLines(page)).toEqual(['1. B', '2. went']);
  expect(calls.map((c) => c.kind).sort()).toEqual(['extract', 'opus', 'sonnet']);

  // Request trích: header gọi thẳng từ trình duyệt, khung hình có nhãn thời gian, cú pháp thinking/structured output hiện hành
  const extract = calls.find((c) => c.kind === 'extract');
  expect(extract.headers['x-api-key']).toBe('test-claude-key');
  expect(extract.headers['anthropic-dangerous-direct-browser-access']).toBe('true');
  expect(extract.body.thinking).toEqual({ type: 'adaptive' });
  const blocks = extract.body.messages[0].content;
  expect(blocks[0]).toEqual({ type: 'text', text: 'Frame at 00:00' });
  const images = blocks.filter((b) => b.type === 'image');
  expect(images.length).toBeGreaterThanOrEqual(2); // 2 màn hình câu hỏi khác nhau
  expect(images.length).toBeLessThanOrEqual(6); // 9 giây ≠ 9 khung: khung trùng đã bị lọc
  expect(images[0].source.media_type).toBe('image/jpeg');
  expect(images[0].source.data.length).toBeGreaterThan(2000);

  await page.locator('#answers summary').first().tap();
  await expect(page.locator('#answers .detail').first()).toContainText('She ____ to school every day.');
  await expect(page.locator('#answers .detail').first()).toContainText('Giải thích cho câu 1: B');

  await expect(page.locator('#result-cost')).toContainText('Chi phí Claude ước tính: $');
  if (!isWebKit(testInfo)) await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.locator('#btn-copy').tap();
  await expect(page.locator('#toast')).toHaveText('Đã copy đáp án');
  if (!isWebKit(testInfo)) expect((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r/g, '')).toBe('Tổng: 2 câu\n1. B\n2. went'); // Windows tự đổi \n → \r\n

  // Lịch sử lưu trong IndexedDB: còn nguyên sau khi tải lại trang
  await page.reload();
  await page.locator('#nav-history').tap();
  await expect(page.locator('#history-list button')).toHaveCount(1);
  await page.locator('#history-list button').tap();
  await expect(page.locator('#result-total')).toHaveText('Tổng: 2 câu');
});

test('Chính xác: hai model lệch nhau → gọi trọng tài, câu không chắc đánh dấu (?)', async ({ page }) => {
  const calls = await mockClaude(page, {
    data: {
      sonnet: { answers: [AGREED[0], { ...AGREED[1], answer: 'gone' }] },
      referee: { answers: [{ number: '2', answer: 'went', explanation: 'Quá khứ đơn.', confidence: 'low' }] },
    },
  });
  await openApp(page);
  await pickVideo(page);
  await expect(page.locator('#result-total')).toHaveText('Tổng: 2 câu');
  expect(await answerLines(page)).toEqual(['1. B', '2. went (?)']);
  const referee = calls.find((c) => c.kind === 'referee');
  expect(referee.body.model).toBe('claude-opus-5-5');
  expect(referee.body.messages[0].content.at(-1).text).toContain('Solver 2: "gone"');
});

test('Nhanh: chỉ một lượt Sonnet, không đối chiếu', async ({ page }) => {
  const calls = await mockClaude(page);
  await openApp(page, { mode: 'fast' });
  await expect(page.locator('input[name="mode"][value="fast"]')).toBeChecked();
  await pickVideo(page);
  await expect(page.locator('#result-total')).toHaveText('Tổng: 2 câu');
  expect(calls.map((c) => [c.kind, c.body.model])).toEqual([['extract', 'claude-sonnet-5-5'], ['sonnet', 'claude-sonnet-5-5']]);
});

test('key sai (401) → báo sai key', async ({ page }) => {
  await mockClaude(page, { intercept: (kind, nth, route) => claudeError(route, 401, 'invalid x-api-key') });
  await openApp(page, { claudeKey: 'sk-ant-wrong' });
  await pickVideo(page);
  await expect(page.locator('#progress-error')).toHaveText('Sai API key Claude (401): invalid x-api-key');
  await expect(page.locator('#btn-retry')).toBeVisible();
});

test('lỗi 429 → tự retry có backoff rồi ra kết quả', async ({ page }) => {
  const calls = await mockClaude(page, {
    intercept: (kind, nth, route) => kind === 'extract' && nth === 0 && claudeError(route, 429, 'rate limited', { 'retry-after': '1' }),
  });
  await openApp(page, { mode: 'fast' });
  await pickVideo(page);
  await expect(page.locator('[data-step="extract"] small')).toContainText('API đang bận (429)');
  await expect(page.locator('#result-total')).toHaveText('Tổng: 2 câu');
  expect(calls.filter((c) => c.kind === 'extract')).toHaveLength(2);
});

test('lỗi khác → hiện nguyên văn error.message', async ({ page }) => {
  await mockClaude(page, { intercept: (kind, nth, route) => claudeError(route, 400, 'messages.0.content.3: image exceeds 10 MB maximum') });
  await openApp(page, { mode: 'fast' });
  await pickVideo(page);
  await expect(page.locator('#progress-error')).toHaveText('messages.0.content.3: image exceeds 10 MB maximum');
});

test('video không có tiếng → bỏ qua audio, vẫn ra kết quả', async ({ page }) => {
  const calls = await mockClaude(page);
  const gemini = await mockGemini(page);
  await openApp(page, { geminiKey: 'test-gemini-key', mode: 'fast' });
  await pickVideo(page, 'quiz-silent.mp4');
  await expect(page.locator('#result-total')).toHaveText('Tổng: 2 câu');
  expect(gemini).toHaveLength(0);
  expect(JSON.stringify(calls[0].body.messages[0].content)).toContain('The video has no usable speech transcript.');
  await expect(page.locator('#result-cost')).toContainText('không dùng audio');
});

test('có key Gemini → transcript có mốc [mm:ss] được gửi kèm cho Claude', async ({ page }, testInfo) => {
  needsAudioDecode(testInfo);
  const calls = await mockClaude(page);
  const gemini = await mockGemini(page);
  await openApp(page, { geminiKey: 'test-gemini-key', mode: 'fast' });
  await pickVideo(page);
  await expect(page.locator('#result-total')).toHaveText('Tổng: 2 câu');
  expect(gemini).toHaveLength(1);
  expect(gemini[0].model).toBe('models/gemini-3.5-transcribe');
  expect(gemini[0].input[0].mime_type).toBe('audio/wav');
  expect(JSON.stringify(calls[0].body.messages[0].content)).toContain('[00:00] Question one.');
  await expect(page.locator('#result-cost')).toContainText('nghe bằng Gemini');
});

test('không có key Gemini → dùng Whisper fallback trong Web Worker', async ({ page }, testInfo) => {
  needsAudioDecode(testInfo);
  const calls = await mockClaude(page);
  const gemini = await mockGemini(page);
  await openApp(page, { mode: 'fast' });
  await pickVideo(page);
  await expect(page.locator('#result-total')).toHaveText('Tổng: 2 câu');
  expect(gemini).toHaveLength(0);
  expect(JSON.stringify(calls[0].body.messages[0].content)).toMatch(/\[00:01\] whisper heard 14\d{4} samples/); // 9s × 16kHz
  await expect(page.locator('#result-cost')).toContainText('nghe bằng Whisper');
});

test('CDN bị chặn → app không treo', async ({ page }, testInfo) => {
  await page.unrouteAll();
  await mockClaude(page);
  await blockCdns(page);
  await openApp(page, { mode: 'fast' });
  await pickVideo(page);
  if (isWebKit(testInfo)) {
    // WebKit ở đây cần ffmpeg.wasm từ CDN để đọc video → phải báo lỗi rõ ràng chứ không quay mãi
    await expect(page.locator('#progress-error')).toContainText("chọn 'Tương thích nhất'");
  } else {
    // Whisper không tải được → bỏ qua audio, vẫn giải theo hình
    await expect(page.locator('#result-total')).toHaveText('Tổng: 2 câu');
    await expect(page.locator('#result-notes')).toContainText('Không nghe được audio');
  }
});

test('rớt mạng giữa chừng rồi mở lại → chạy tiếp từ bước đang dở, không trích lại', async ({ page }) => {
  let offline = true;
  const calls = await mockClaude(page, {
    intercept: async (kind, nth, route) => {
      if (kind === 'extract' || !offline) return false;
      await route.abort('internetdisconnected');
      return true;
    },
  });
  await openApp(page);
  await pickVideo(page);
  await expect(page.locator('#progress-error')).toContainText('Mất kết nối mạng');
  expect(calls.filter((c) => c.kind === 'extract')).toHaveLength(1);

  offline = false;
  await page.reload(); // như khi khoá máy / đổi app rồi trình duyệt tải lại trang
  await expect(page.locator('#result-total')).toHaveText('Tổng: 2 câu');
  expect(calls.filter((c) => c.kind === 'extract'), 'bước trích lấy từ IndexedDB').toHaveLength(1);
  expect(await answerLines(page)).toEqual(['1. B', '2. went']);
});

test('video HEVC trình duyệt không decode được → fallback ffmpeg.wasm vẫn ra kết quả', async ({ page }) => {
  const calls = await mockClaude(page);
  await openApp(page, { mode: 'fast' });
  await pickVideo(page, 'quiz-hevc.mov');
  await expect(page.locator('#result-total')).toHaveText('Tổng: 2 câu');
  expect(calls[0].body.messages[0].content.filter((b) => b.type === 'image').length).toBeGreaterThanOrEqual(2);
});

test('HEVC mà ffmpeg.wasm cũng không tải được → hướng dẫn chọn "Tương thích nhất"', async ({ page }) => {
  await page.unrouteAll();
  await mockClaude(page);
  await blockCdns(page);
  await openApp(page, { mode: 'fast' });
  await pickVideo(page, 'quiz-hevc.mov');
  await expect(page.locator('#progress-error')).toContainText("Trên iPhone vào Cài đặt → Camera → Định dạng → chọn 'Tương thích nhất'");
});

test('chưa có key → dẫn vào ⚙️, lưu key vào localStorage', async ({ page }) => {
  await openApp(page, { claudeKey: '' });
  await expect(page.locator('#home-notice')).toContainText('Chưa có Claude API key');
  await page.locator('#home-notice button').tap();
  await page.locator('#input-claude-key').fill('sk-ant-test-123');
  await page.locator('#settings-form button[type="submit"]').tap();
  await expect(page.locator('#view-home')).toBeVisible();
  await expect(page.locator('#home-notice')).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem('vqs.claudeKey'))).toBe('sk-ant-test-123');
});

test('yêu cầu riêng cho điện thoại: nút ≥ 48px, input ≥ 16px, capture camera, manifest', async ({ page }) => {
  await openApp(page);
  for (const id of ['#btn-record', '#btn-pick', '#nav-settings', '#nav-history']) {
    expect((await page.locator(id).boundingBox()).height, id).toBeGreaterThanOrEqual(48);
  }
  await expect(page.locator('#input-record')).toHaveAttribute('capture', 'environment');
  await expect(page.locator('#input-record')).toHaveAttribute('accept', 'video/*');
  await expect(page.locator('html')).toHaveAttribute('lang', 'vi');
  await page.locator('#nav-settings').tap();
  for (const id of ['#input-claude-key', '#input-gemini-key']) {
    expect(parseFloat(await page.locator(id).evaluate((n) => getComputedStyle(n).fontSize)), id).toBeGreaterThanOrEqual(16);
  }
  const manifest = await (await page.request.get('manifest.webmanifest')).json();
  expect(manifest.display).toBe('standalone');
  expect(manifest.icons.map((i) => i.sizes)).toContain('512x512');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'không tràn ngang').toBe(true);
});

test('Whisper THẬT tải từ CDN và nghe đúng giọng đọc (chỉ chạy khi REAL_WHISPER=1)', async ({ page }, testInfo) => {
  test.skip(!process.env.REAL_WHISPER, 'cần mạng thật để tải model ~80MB');
  needsAudioDecode(testInfo);
  test.setTimeout(300_000);
  await page.unrouteAll();
  const calls = await mockClaude(page);
  await openApp(page, { mode: 'fast' });
  await pickVideo(page);
  await expect(page.locator('#result-total')).toHaveText('Tổng: 2 câu', { timeout: 280_000 });
  const transcript = JSON.stringify(calls[0].body.messages[0].content);
  expect(transcript).toMatch(/\[00:0\d\] Question 1/i);
  expect(transcript).toMatch(/to school every day/i);
});

test('PWA: service worker cache vỏ app, mở lại được khi mất mạng', async ({ browser }, testInfo) => {
  const context = await browser.newContext({ ...testInfo.project.use, serviceWorkers: 'allow' });
  const page = await context.newPage();
  await page.goto('./');
  expect(await page.evaluate(() => navigator.serviceWorker.ready.then((r) => Boolean(r.active)))).toBe(true);
  await page.reload(); // lần tải này đi qua service worker → được cache
  await expect(page.locator('#btn-record')).toBeVisible();
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('#btn-record')).toBeVisible();
  await expect(page.locator('h1')).toContainText('Quay đề tiếng Anh');
  await context.close();
});

for (const [video, expectedMin, expectedMax, why] of [
  ['small-change.mp4', 6, 14, '6 màn hình câu hỏi chỉ khác nhau một vùng chữ nhỏ (Node giữ 12)'],
  ['scroll.mp4', 14, 19, 'trang cuộn liên tục (Node giữ 18)'],
  ['fill-blank.mp4', 2, 5, '2 màn hình đứng yên (Node giữ 4)'],
]) {
  // Ngưỡng lọc khung được chỉnh trên thumbnail của ffmpeg; canvas của trình duyệt thu nhỏ khác đi nên phải kiểm riêng.
  test(`lọc khung trên trình duyệt với ${video}: ${why}`, async ({ page }, testInfo) => {
    test.setTimeout(600_000);
    const calls = await mockClaude(page);
    await openApp(page, { mode: 'fast' });
    await page.setInputFiles('#input-pick', path.join(evalVideos, video));
    await expect(page.locator('#result-total')).toHaveText('Tổng: 2 câu', { timeout: 580_000 });
    const images = calls[0].body.messages[0].content.filter((b) => b.type === 'image').length;
    testInfo.annotations.push({ type: 'frames', description: `${video}: giữ ${images} khung` });
    expect(images, `${video} giữ ${images} khung`).toBeGreaterThanOrEqual(expectedMin);
    expect(images, `${video} giữ ${images} khung`).toBeLessThanOrEqual(expectedMax);
  });
}
