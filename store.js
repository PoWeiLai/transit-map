// 一天下載一次的資料也存到 Turso（雲端 SQLite），免費主機休眠重開、沒有永久硬碟時不用再向 TDX 重抓。
// 沒設定 TURSO_DATABASE_URL / TURSO_AUTH_TOKEN 就不使用（只存在本機硬碟，跟原本一樣）
import { gzipSync, gunzipSync } from 'node:zlib';

const CHUNK = 512 * 1024; // 大份資料（例如全台客運班表）切成小段存，避免單次請求太大
const KEEP_DAYS = 9;      // 只留最近幾天（一週抓一次的資料要留到下週一），免費額度不會一直累積
const TIMEOUT_MS = 30000;

const url = () => process.env.TURSO_DATABASE_URL?.replace(/^libsql:\/\//, 'https://');
export const hasStore = () => Boolean(url() && process.env.TURSO_AUTH_TOKEN);

// Turso 的 HTTP API（Hrana）：一次送多個 SQL
async function pipeline(statements) {
  const res = await fetch(`${url()}/v2/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.TURSO_AUTH_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: [
        ...statements.map(([sql, args = []]) => ({
          type: 'execute',
          stmt: { sql, args: args.map((v) => (typeof v === 'number' ? { type: 'integer', value: String(v) } : { type: 'text', value: String(v) })) },
        })),
        { type: 'close' },
      ],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Turso ${res.status}`);
  const body = await res.json();
  const failed = body.results.find((r) => r.type === 'error');
  if (failed) throw new Error(`Turso：${failed.error.message}`);
  return body.results.filter((r) => r.type === 'ok').map((r) => r.response.result);
}

let ready = null;
const init = () => (ready ||= pipeline([
  ['CREATE TABLE IF NOT EXISTS daily_cache (name TEXT NOT NULL, date TEXT NOT NULL, part INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (name, date, part))'],
  ['CREATE TABLE IF NOT EXISTS tdx_usage (date TEXT PRIMARY KEY, calls INTEGER NOT NULL, bytes INTEGER NOT NULL)'],
  ['CREATE TABLE IF NOT EXISTS kv_cache (key TEXT PRIMARY KEY, data TEXT NOT NULL, at INTEGER NOT NULL)'],
]).catch((e) => { ready = null; throw e; }));

// TDX 用量：每天累加呼叫次數與下載量
export async function addUsage(date, calls, bytes) {
  if (!hasStore() || !calls) return;
  await init();
  await pipeline([[
    'INSERT INTO tdx_usage (date, calls, bytes) VALUES (?, ?, ?) ON CONFLICT(date) DO UPDATE SET calls = calls + excluded.calls, bytes = bytes + excluded.bytes',
    [date, calls, bytes],
  ]]);
}

export async function recentUsage(days = 14) {
  if (!hasStore()) return [];
  await init();
  const [result] = await pipeline([['SELECT date, calls, bytes FROM tdx_usage ORDER BY date DESC LIMIT ?', [days]]]);
  return result.rows.map(([d, c, b]) => ({ date: d.value, calls: Number(c.value), bytes: Number(b.value) }));
}

// 讀：沒有這份資料回傳 null
export async function load(name, date) {
  if (!hasStore()) return null;
  await init();
  const [result] = await pipeline([['SELECT data FROM daily_cache WHERE name = ? AND date = ? ORDER BY part', [name, date]]]);
  if (!result.rows.length) return null;
  const base64 = result.rows.map((row) => row[0].value).join('');
  return JSON.parse(gunzipSync(Buffer.from(base64, 'base64')).toString('utf8'));
}

// 寫：壓縮後分段存，同時刪掉太舊的資料
export async function save(name, date, data) {
  if (!hasStore()) return;
  await init();
  const base64 = gzipSync(JSON.stringify(data)).toString('base64');
  const parts = [];
  for (let k = 0; k * CHUNK < base64.length; k++) parts.push(base64.slice(k * CHUNK, (k + 1) * CHUNK));
  const oldest = new Date(Date.parse(date) - KEEP_DAYS * 86400000).toISOString().slice(0, 10);
  await pipeline([
    ['DELETE FROM daily_cache WHERE name = ? AND date = ?', [name, date]],
    ...parts.map((part, k) => ['INSERT INTO daily_cache (name, date, part, data) VALUES (?, ?, ?, ?)', [name, date, k, part]]),
    ['DELETE FROM daily_cache WHERE date < ?', [oldest]],
  ]);
}

// ---------- 很少變動的小資料（票價、門牌座標）：一筆一個 key，存好幾個月 ----------
const KV_KEEP_MS = 180 * 86400000;

// 讀多個 key，只回傳 maxAgeMs 內存的：key → 資料
export async function getKv(keys, maxAgeMs) {
  if (!hasStore() || !keys.length) return new Map();
  await init();
  const [result] = await pipeline([[
    `SELECT key, data FROM kv_cache WHERE at >= ? AND key IN (${keys.map(() => '?').join(',')})`,
    [Date.now() - maxAgeMs, ...keys],
  ]]);
  return new Map(result.rows.map(([k, d]) => [k.value, JSON.parse(d.value)]));
}

// 寫：entries 是 [[key, 資料], …]，同時刪掉太舊的
export async function setKv(entries) {
  if (!hasStore() || !entries.length) return;
  await init();
  const now = Date.now();
  await pipeline([
    ...entries.map(([k, v]) => ['INSERT OR REPLACE INTO kv_cache (key, data, at) VALUES (?, ?, ?)', [k, JSON.stringify(v), now]]),
    ['DELETE FROM kv_cache WHERE at < ?', [now - KV_KEEP_MS]],
  ]);
}

// 這個月（month 例如 '2026-10'）到目前的 TDX 用量合計
export async function monthUsage(month) {
  if (!hasStore()) return null;
  await init();
  const [result] = await pipeline([['SELECT COALESCE(SUM(calls), 0), COALESCE(SUM(bytes), 0) FROM tdx_usage WHERE date LIKE ?', [`${month}-%`]]]);
  const [c, b] = result.rows[0];
  return { calls: Number(c.value), bytes: Number(b.value) };
}
