// 測速照相：警政署「測速執法設置點」開放資料（全國，不需金鑰），找出路線經過、而且拍得到這個行進方向的點
import { daily } from './tdx.js';

// data.gov.tw 資料集 7320 的 CSV 下載網址
const CSV_URL = 'https://opdadm.moi.gov.tw/api/v1/no-auth/resource/api/dataset/EA5E6FCD-B82D-43B7-A5CF-E9893253187E/resource/9805E2BB-5E1B-4CFF-A50B-DF857EB57442/download';
const NEAR_M = 30;        // 離路線多近算在路上
const ANGLE_OK = 60;      // 拍攝方向與行進方向差多少度以內才算同方向

// 方位字 → 角度（0 = 北，順時針）
const BEARING = { 北: 0, 東北: 45, 東: 90, 東南: 135, 南: 180, 西南: 225, 西: 270, 西北: 315 };
const DIR = '(東北|東南|西北|西南|北|東|南|西)';

// 「北向南」「北往南」→ 往南（180）；「往南」「南向」→ 往南；「雙向」「南北雙向」或看不懂的 → null（兩個方向都拍）
function travelBearing(text) {
  const t = String(text || '').replace(/\s/g, '');
  if (!t || /雙向/.test(t)) return null;
  let m = t.match(new RegExp(`^${DIR}[向往]${DIR}`));
  if (m) return BEARING[m[2]];
  m = t.match(new RegExp(`^往${DIR}`)) || t.match(new RegExp(`^${DIR}向$`));
  return m ? BEARING[m[1]] : null;
}

// 簡單的 CSV 解析（欄位可能有引號）
function parseCsv(text) {
  const rows = [];
  for (const line of text.replace(/^﻿/, '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = [];
    let cur = '', quoted = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { if (quoted && line[i + 1] === '"') { cur += '"'; i++; } else quoted = !quoted; }
      else if (c === ',' && !quoted) { cells.push(cur); cur = ''; }
      else cur += c;
    }
    cells.push(cur);
    rows.push(cells);
  }
  return rows;
}

const getCameras = () => daily('speed-cameras', async () => {
  const res = await fetch(CSV_URL, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`測速照相資料 ${res.status}`);
  const [header, , ...rows] = parseCsv(await res.text()); // 第二列是中文欄名
  const col = (name) => header.indexOf(name);
  const [lat, lng, dir, limit, addr] = ['Latitude', 'Longitude', 'direct', 'limit', 'Address'].map(col);
  return rows.map((r) => ({
    lat: Number(r[lat]), lng: Number(r[lng]),
    limit: Number(r[limit]) || null,
    direction: r[dir] || '',
    bearing: travelBearing(r[dir]),
    address: r[addr] || '',
  })).filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lng) && c.lat > 20);
});

// 平面近似（幾公里內誤差很小）：以第一個點為原點換成公尺
function projector(origin) {
  const kx = 111320 * Math.cos((origin.lat * Math.PI) / 180), ky = 110540;
  return (p) => ({ x: (p.lng - origin.lng) * kx, y: (p.lat - origin.lat) * ky });
}

const angleDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

// path：[[lat, lng], …]。回傳路線上的測速點，含從起點算起的距離（along），依序排好
export async function camerasAlong(path) {
  if (!path || path.length < 2) return [];
  const cams = await getCameras().catch(() => []);
  const pts = path.map(([lat, lng]) => ({ lat, lng }));
  const lats = pts.map((p) => p.lat), lngs = pts.map((p) => p.lng);
  const pad = 0.001;
  const box = [Math.min(...lats) - pad, Math.max(...lats) + pad, Math.min(...lngs) - pad, Math.max(...lngs) + pad];
  const near = cams.filter((c) => c.lat >= box[0] && c.lat <= box[1] && c.lng >= box[2] && c.lng <= box[3]);
  if (!near.length) return [];

  const proj = projector(pts[0]);
  const xy = pts.map(proj);
  const found = [];
  for (const c of near) {
    const q = proj(c);
    let best = null, along = 0;
    for (let i = 0; i < xy.length - 1; i++) {
      const a = xy[i], b = xy[i + 1];
      const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
      const len = Math.sqrt(len2);
      const t = len2 ? Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / len2)) : 0;
      const d = Math.hypot(q.x - (a.x + t * dx), q.y - (a.y + t * dy));
      if (d <= NEAR_M && (!best || d < best.d)) {
        best = { d, along: along + t * len, heading: (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360 };
      }
      along += len;
    }
    // 拍的是對向車道就不用提醒
    if (best && (c.bearing == null || angleDiff(c.bearing, best.heading) <= ANGLE_OK)) {
      found.push({ lat: c.lat, lng: c.lng, limit: c.limit, address: c.address, direction: c.direction, along: Math.round(best.along) });
    }
  }
  return found.sort((a, b) => a.along - b.along);
}

export const warmUp = () => getCameras();
