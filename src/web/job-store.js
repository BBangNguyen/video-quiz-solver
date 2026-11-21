// IndexedDB: `kv` giữ bài đang xử lý dở (khung hình, transcript, kết quả từng bước), `history` giữ lịch sử.
const DB_NAME = 'video-quiz-solver';
const DB_VERSION = 1;

let dbPromise;
function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('kv');
      req.result.createObjectStore('history', { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new Error(`Không mở được IndexedDB: ${req.error?.message}`));
  });
  return dbPromise;
}

async function tx(storeName, mode, run) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const req = run(transaction.objectStore(storeName));
    transaction.oncomplete = () => resolve(req?.result);
    transaction.onerror = () => reject(new Error(`Lỗi IndexedDB: ${transaction.error?.message}`));
    transaction.onabort = () => reject(new Error(`IndexedDB bị huỷ: ${transaction.error?.message ?? 'hết dung lượng?'}`));
  });
}

export const kv = {
  get: (key) => tx('kv', 'readonly', (s) => s.get(key)),
  set: (key, value) => tx('kv', 'readwrite', (s) => s.put(value, key)),
  clear: () => tx('kv', 'readwrite', (s) => s.clear()),
};

export const history = {
  add: (entry) => tx('history', 'readwrite', (s) => s.add(entry)),
  all: async () => (await tx('history', 'readonly', (s) => s.getAll())).reverse(),
  get: (id) => tx('history', 'readonly', (s) => s.get(id)),
  clear: () => tx('history', 'readwrite', (s) => s.clear()),
};
