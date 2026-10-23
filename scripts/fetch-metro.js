// 抓全台捷運／輕軌的原始資料存到 data/cache/metro-raw-*.json（給 build-metro.js 用）
// TDX 免費金鑰每分鐘只能 5 次，全部約 60 次請求，要跑十幾分鐘；已經抓過的會跳過
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tdx } from '../tdx.js';
import { OPERATORS, RAW_PARTS } from './metro-config.js';

try { process.loadEnvFile(); } catch { /* 沒有 .env */ }
const dir = new URL('../data/cache/', import.meta.url);
mkdirSync(dir, { recursive: true });

for (const op of Object.keys(OPERATORS)) {
  for (const part of RAW_PARTS) {
    const file = new URL(`metro-raw-${op}-${part}.json`, dir);
    if (existsSync(file)) continue;
    // 部分業者沒有提供某些資料（例如輕軌沒有班距），TDX 回 400 就存空陣列
    const data = await tdx(`v2/Rail/Metro/${part}/${op}`).catch((e) => (console.log(`${op} ${part}：${e.message}`), []));
    writeFileSync(file, JSON.stringify(data));
    console.log(`${op} ${part}：${data.length} 筆`);
  }
}
