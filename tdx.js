// 交通部 TDX API：自動取得／更新 token，並限制請求速度
// 免費金鑰每分鐘只能 5 次，所以大份資料一天抓一次並存到硬碟
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { load, save } from './store.js';

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
export async function tdx(path, params = {}, { timeout = 60000 } = {}) {
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
    return res.json();
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

// 一天只抓一次的資料：先找硬碟上當天的檔案，再找 Turso（免費主機重開後硬碟是空的），都沒有才呼叫 TDX
export function daily(name, fn) {
  const { date } = taipeiNow();
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
