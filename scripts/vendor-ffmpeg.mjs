// Chép lớp vỏ ESM của ffmpeg.wasm vào vendor/ffmpeg/ để Worker cùng origin với app
// (trình duyệt không cho tạo Worker từ CDN khác origin). Lõi .wasm ~32MB vẫn nạp từ jsdelivr khi cần.
import { cp, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const from = path.join(root, 'node_modules', '@ffmpeg', 'ffmpeg', 'dist', 'esm');
const to = path.join(root, 'vendor', 'ffmpeg');
await mkdir(to, { recursive: true });
const files = (await readdir(from)).filter((f) => f.endsWith('.js'));
await Promise.all(files.map((f) => cp(path.join(from, f), path.join(to, f))));
process.stdout.write(`Đã chép ${files.length} file vào vendor/ffmpeg/\n`);
