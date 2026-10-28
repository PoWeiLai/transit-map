// 交通部 TDX API：自動取得／更新 token，並限制請求速度
// 免費金鑰每分鐘只能 5 次，所以大份資料一天抓一次並存到硬碟
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { load, save, getKv, setKv, addUsage, recentUsage, monthUsage } from './store.js';

const CACHE_DIR = new URL('./data/cache/', import.meta.url);
const TOKEN_URL = 'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token';
const API_ROOT = 'https://tdx.transportdata.tw/api/';
const API_BASE = `${API_ROOT}basic/`;
const ADVANCED = 'advanced/';
const MIN_INTERVAL_MS = 300; // 兩個請求之間至少間隔
const MAX_RETRY = 2;
const MAX_RESET_WAIT_S = 65; // 429 時最多等到下一分鐘額度恢復

let token = null;
let tokenExpires = 0;

export const hasTdx = () => Boolean(process.env.TDX_CLIENT_ID && process.env.TDX_CLIENT_SECRET);

async function getToken() {
  if (token && Date.now() < tokenExpires) return token;
  if (!hasTdx()) throw new Error('尚未設定 TDX 金鑰（.env 的 TDX_CLIENT_ID / TDX_CLIENT_SECRET）');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.TDX_CLIENT_ID,
      client_secret: process.env.TDX_CLIENT_SECRET,
    }),
  });
  const body = await res.json();
  if (!body.access_token) throw new Error(`TDX 登入失敗：${body.error_description || res.status}`);
  token = body.access_token;
  tokenExpires = Date.now() + (body.expires_in - 300) * 1000; // 提早 5 分鐘換新
  return token;
}

// 所有請求排隊依序送出
let queue = Promise.resolve();
let lastAt = 0;

function throttled(fn) {
  const job = queue.then(async () => {
    const wait = lastAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastAt = Date.now();
    return fn();
  });
  queue = job.catch(() => {});
  return job;
}

// path 例如 'v3/Rail/TRA/Station'，params 會自動加上 $format=JSON；
// 進階服務（例如地址定位）用 'advanced/V3/Map/...'，參數是 format=JSON；
// timeout：大份資料（例如全台公路客運約 18 MB）從國外主機下載要比較久
// live：即時資料（到站、誤點、座位、路況、空位），這個月額度快用完時先不抓，留給時刻表等規劃必需的資料
export async function tdx(path, params = {}, { timeout = 60000, live = false } = {}) {
  if (live && liveBlocked()) throw new Error('本月 TDX 額度快用完，暫停即時資料');
  const url = path.startsWith(ADVANCED)
    ? `${API_ROOT}${path}?${new URLSearchParams({ format: 'JSON', ...params })}`
    : `${API_BASE}${path}?${new URLSearchParams({ $format: 'JSON', ...params })}`;
  for (let attempt = 0; ; attempt++) {
    const res = await throttled(async () =>
      fetch(url, { headers: { Authorization: `Bearer ${await getToken()}` }, signal: AbortSignal.timeout(timeout) }));
    if (res.status === 429 && attempt < MAX_RETRY) {
      // 回應會告訴我們幾秒後額度恢復
      const reset = Math.min(Number(res.headers.get('ratelimit-reset')) || 10, MAX_RESET_WAIT_S);
      await new Promise((r) => setTimeout(r, reset * 1000));
      continue;
    }
    if (res.status === 401 && attempt < MAX_RETRY) {
      token = null; // token 失效，重新登入
      continue;
    }
    if (!res.ok) throw new Error(`TDX ${res.status}：${path}`);
    const text = await res.text();
    countUsage(path, Buffer.byteLength(text));
    return JSON.parse(text);
  }
}

// 簡單的記憶體快取：同一個 key 在 ms 內重用結果
const cache = new Map();

export function cached(key, ms, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ms) return hit.value;
  const value = Promise.resolve().then(fn);
  cache.set(key, { at: Date.now(), value });
  value.catch(() => cache.delete(key)); // 失敗不快取
  return value;
}

// 一段期間（一天或一週）只抓一次的資料：先找硬碟上的檔案，再找 Turso（免費主機重開後硬碟是空的），都沒有才呼叫 TDX
function periodic(name, date, fn) {
  return cached(`daily:${name}:${date}`, 24 * 60 * 60 * 1000, async () => {
    const file = new URL(`${name}-${date}.json`, CACHE_DIR);
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch { /* 沒有快取檔 */ }
    const writeLocal = (data) => {
      mkdirSync(CACHE_DIR, { recursive: true });
      writeFileSync(file, JSON.stringify(data));
    };
    const stored = await load(name, date).catch((e) => { console.log(`Turso 讀取失敗（${name}）：`, e.message); return null; });
    if (stored) {
      writeLocal(stored);
      return stored;
    }
    const data = await fn();
    writeLocal(data);
    // 存到 Turso 在背景做，失敗也不影響這次查詢
    save(name, date, data).catch((e) => console.log(`Turso 寫入失敗（${name}）：`, e.message));
    return data;
  });
}

// 一天抓一次：當天的時刻表（會停駛、加開）、即時性較高的資料
export const daily = (name, fn) => periodic(name, taipeiNow().date, fn);

// 一週抓一次（每週一換新）：很少變動又很大的資料，例如全台客運班表、路線、票價、路段形狀，省 TDX 用量
export function weekly(name, fn) {
  const today = new Date(`${taipeiNow().date}T00:00:00Z`);
  const monday = new Date(today - ((today.getUTCDay() + 6) % 7) * 86400000).toISOString().slice(0, 10);
  return periodic(name, monday, fn);
}

// 很少變動的小資料（例如兩站間票價、門牌座標）：記憶體 → Turso → TDX，days 天內都不重抓
export function remembered(key, days, fn) {
  return cached(`kv:${key}`, 24 * 60 * 60 * 1000, async () => {
    const hit = (await getKv([key], days * 86400000).catch(() => new Map())).get(key);
    if (hit !== undefined) return hit;
    const data = await fn();
    setKv([[key, data]]).catch((e) => console.log(`Turso 寫入失敗（${key}）：`, e.message));
    return data;
  });
}

// 一次要很多筆時（例如好幾條客運路線的票價）：Turso 有的直接用，沒有的才交給 fetchMissing 一次向 TDX 查（回傳 key → 資料）
export async function rememberedMany(keys, days, fetchMissing) {
  const known = await getKv(keys, days * 86400000).catch(() => new Map());
  const missing = keys.filter((k) => !known.has(k));
  if (missing.length) {
    const got = await fetchMissing(missing);
    for (const k of missing) known.set(k, got.get(k) ?? []);
    setKv(missing.map((k) => [k, known.get(k)])).catch((e) => console.log('Turso 寫入失敗：', e.message));
  }
  return known;
}

// ---------- TDX 用量紀錄：每天呼叫幾次、下載多少，和 TDX 會員中心對照，接近上限前就知道 ----------
const FLUSH_MS = 60 * 1000;
const usage = { date: '', calls: 0, bytes: 0, paths: new Map() }; // 這次開機以來、今天的用量
let pending = { calls: 0, bytes: 0 }; // 還沒寫進 Turso 的
let flushTimer = null;

function countUsage(path, bytes) {
  const { date } = taipeiNow();
  if (usage.date !== date) Object.assign(usage, { date, calls: 0, bytes: 0, paths: new Map() });
  usage.calls++;
  usage.bytes += bytes;
  const key = path.replace(/\/[^/]*%[^/]*$/, '/…'); // 地址查詢等帶參數的路徑合併計算
  const p = usage.paths.get(key) || { calls: 0, bytes: 0 };
  usage.paths.set(key, { calls: p.calls + 1, bytes: p.bytes + bytes });
  pending = { calls: pending.calls + 1, bytes: pending.bytes + bytes };
  const month = date.slice(0, 7);
  if (local.month !== month) Object.assign(local, { month, calls: 0, bytes: 0 });
  local.calls++;
  local.bytes += bytes;
  // 累積一分鐘寫一次 Turso，不要每次呼叫都寫
  flushTimer ||= setTimeout(() => {
    flushTimer = null;
    const { calls, bytes: b } = pending;
    pending = { calls: 0, bytes: 0 };
    addUsage(date, calls, b).catch(() => { pending.calls += calls; pending.bytes += b; });
  }, FLUSH_MS);
  flushTimer.unref?.();
}

// ---------- 每月額度：免費會員每月 3 點（1 點約 1,000～1,500 次或 150 MB），用到 80% 就暫停即時資料，避免帳號又被停權 ----------
const MONTHLY_POINTS = Number(process.env.TDX_MONTHLY_POINTS) || 3;
const LIVE_STOP_RATIO = 0.8;
const POINT_CALLS = 1000;  // 保守估計：次數、流量哪個用得多就算哪個
const POINT_BYTES = 150e6;
const MONTH_REFRESH_MS = 10 * 60 * 1000;
const local = { month: '', calls: 0, bytes: 0 }; // 沒有 Turso 時，只能算這次開機以來的
let stored = { month: '', calls: 0, bytes: 0, at: 0 }; // Turso 記錄的本月合計（已寫入的部分）
let refreshing = null;

function refreshMonth() {
  const month = taipeiNow().date.slice(0, 7);
  if (stored.month === month && Date.now() - stored.at < MONTH_REFRESH_MS) return Promise.resolve();
  return (refreshing ||= monthUsage(month)
    .then((x) => { if (x) stored = { month, ...x, at: Date.now() }; })
    .catch(() => {})
    .finally(() => { refreshing = null; }));
}

function monthTotals() {
  const month = taipeiNow().date.slice(0, 7);
  if (stored.month === month) return { calls: stored.calls + pending.calls, bytes: stored.bytes + pending.bytes };
  return local.month === month ? local : { calls: 0, bytes: 0 };
}

const usedPoints = () => {
  const m = monthTotals();
  return Math.max(m.calls / POINT_CALLS, m.bytes / POINT_BYTES);
};

function liveBlocked() {
  refreshMonth(); // 背景更新，不等它
  return usedPoints() >= MONTHLY_POINTS * LIVE_STOP_RATIO;
}

// 今天（這台主機）的用量明細，加上 Turso 記錄的最近幾天
export async function tdxUsage() {
  const top = [...usage.paths].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 15)
    .map(([path, x]) => ({ path, calls: x.calls, mb: +(x.bytes / 1e6).toFixed(2) }));
  const days = await recentUsage().catch(() => []);
  await refreshMonth();
  const m = monthTotals();
  return {
    month: { month: taipeiNow().date.slice(0, 7), calls: m.calls, mb: +(m.bytes / 1e6).toFixed(2),
             points: +usedPoints().toFixed(2), limit: MONTHLY_POINTS, livePaused: liveBlocked() },
    sinceStart: { date: usage.date, calls: usage.calls, mb: +(usage.bytes / 1e6).toFixed(2), top },
    days: days.map((d) => ({ ...d, mb: +(d.bytes / 1e6).toFixed(2) })),
  };
}

// 台灣時間的日期（YYYY-MM-DD）與現在是當天第幾分鐘
export function taipeiNow() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).map((p) => [p.type, p.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

export const toMinutes = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
};
