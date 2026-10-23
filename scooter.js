// 共享機車還車：目的地附近有機車格的停車場（台北市公開資料，不需金鑰）
import { distance } from './geo.js';

const DESC_URL = 'https://tcgbusfs.blob.core.windows.net/blobtcmsv/TCMSV_alldesc.json';
const AVAIL_URL = 'https://tcgbusfs.blob.core.windows.net/blobtcmsv/TCMSV_allavailable.json';
const DESC_MS = 24 * 60 * 60 * 1000;
const AVAIL_MS = 60 * 1000;
const SEARCH_M = 1500;
const CANDIDATES = 5;

// TWD97 TM2（中央經線 121°）→ WGS84 經緯度
function twd97ToWgs84(x, y) {
  const a = 6378137, b = 6356752.314245, k0 = 0.9999;
  const lng0 = (121 * Math.PI) / 180;
  const e = Math.sqrt(1 - (b * b) / (a * a));
  const e2 = (e * e) / (1 - e * e);
  x -= 250000;
  const mu = y / k0 / (a * (1 - e ** 2 / 4 - (3 * e ** 4) / 64 - (5 * e ** 6) / 256));
  const e1 = (1 - Math.sqrt(1 - e * e)) / (1 + Math.sqrt(1 - e * e));
  const fp = mu +
    ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) +
    ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) +
    ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);
  const C1 = e2 * Math.cos(fp) ** 2;
  const T1 = Math.tan(fp) ** 2;
  const R1 = (a * (1 - e * e)) / (1 - e * e * Math.sin(fp) ** 2) ** 1.5;
  const N1 = a / Math.sqrt(1 - e * e * Math.sin(fp) ** 2);
  const D = x / (N1 * k0);
  const lat = fp - ((N1 * Math.tan(fp)) / R1) * (
    (D * D) / 2 -
    ((5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * e2) * D ** 4) / 24 +
    ((61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 3 * C1 * C1 - 252 * e2) * D ** 6) / 720);
  const lng = lng0 + (
    D -
    ((1 + 2 * T1 + C1) * D ** 3) / 6 +
    ((5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * e2 + 24 * T1 * T1) * D ** 5) / 120) / Math.cos(fp);
  return { lat: (lat * 180) / Math.PI, lng: (lng * 180) / Math.PI };
}

// 收費說明很長，只留跟機車有關的句子
function motorFee(text) {
  const parts = String(text || '').split(/[；;。\n]/).filter((s) => s.includes('機車'));
  return parts.length ? parts.join('；').trim() : '依現場公告';
}

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`停車場資料 ${res.status}`);
  return JSON.parse((await res.text()).replace(/^﻿/, ''));
}

let lots = null;
let lotsAt = 0;

async function getLots() {
  if (lots && Date.now() - lotsAt < DESC_MS) return lots;
  const { data } = await getJson(DESC_URL);
  lots = data.park
    .filter((p) => Number(p.totalmotor) > 0)
    .map((p) => {
      // 有入口座標就導航到入口，否則用停車場中心
      const entrance = p.EntranceCoord?.EntrancecoordInfo?.[0];
      const pos = entrance && Number(entrance.Xcod)
        ? { lat: Number(entrance.Xcod), lng: Number(entrance.Ycod) }
        : twd97ToWgs84(Number(p.tw97x), Number(p.tw97y));
      return {
        id: p.id,
        name: p.name,
        district: p.area,
        address: p.address,
        totalMotor: Number(p.totalmotor),
        fee: motorFee(p.payex),
        hours: p.serviceTime,
        ...pos,
      };
    })
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  lotsAt = Date.now();
  return lots;
}

let avail = { at: 0, data: new Map(), updated: '' };

async function getAvail() {
  if (Date.now() - avail.at < AVAIL_MS) return avail;
  try {
    const { data } = await getJson(AVAIL_URL);
    avail = {
      at: Date.now(),
      // 負數（-9）代表沒有提供即時資料
      data: new Map(data.park.map((p) => [p.id, Number(p.availablemotor)])),
      updated: data.UPDATETIME,
    };
  } catch {
    // 即時空位抓不到就只顯示總格數
  }
  return avail;
}

// 目的地附近有機車格的停車場；已知「目前 0 格」的排除
export async function nearbyParking(point) {
  const [all, a] = await Promise.all([getLots(), getAvail()]);
  const list = all
    .map((p) => {
      const n = a.data.get(p.id);
      return { ...p, available: n >= 0 ? n : null, distance: Math.round(distance(point, p)) };
    })
    .filter((p) => p.distance <= SEARCH_M && p.available !== 0)
    .sort((x, y) => x.distance - y.distance)
    .slice(0, CANDIDATES);
  return { list, updated: a.updated };
}

export const warmUp = () => Promise.all([getLots(), getAvail()]);
export { twd97ToWgs84 };
