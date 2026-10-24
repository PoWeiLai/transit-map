// 汽車、機車（自己的車、共享機車、共享汽車）：目的地附近的停車場與費用估算。
// 停車場用 TDX 全台路外停車場（含汽車、機車即時剩餘車位）；沒有 TDX 金鑰時機車用台北市公開資料
import { distance } from './geo.js';
import { tdx, hasTdx, daily, cached } from './tdx.js';
import { citiesAt } from './cities.js';
import { nearbyParking as taipeiMotoParking } from './scooter.js';

const SEARCH_M = 1500;
const CANDIDATES = 5;
const AVAIL_MS = 2 * 60 * 1000;
const LOAD_WAIT_MS = 8000; // 第一次載入某縣市時最多等這麼久
const DOWNLOAD_MS = 3 * 60 * 1000;
// TDX 車位種類：1 汽車、2 機車
const SPACE = { car: 1, moto: 2 };

// 收費說明很長，只留跟這種車有關的句子
function feeFor(text, kind) {
  const word = kind === 'moto' ? /機車/ : /汽車|小型車|小客車|車輛/;
  const parts = String(text || '').split(/[；;。\n]/).map((s) => s.trim()).filter((s) => word.test(s));
  return parts.length ? parts.join('；') : (String(text || '').trim() || '依現場公告');
}

const lotsOf = (city) => daily(`parking-${city}`, async () => {
  const { CarParks } = await tdx(`v1/Parking/OffStreet/CarPark/City/${city}`, {}, { timeout: DOWNLOAD_MS });
  return CarParks.map((p) => ({
    id: p.CarParkID,
    name: p.CarParkName?.Zh_tw || p.CarParkID,
    address: p.Address || '',
    fare: p.FareDescription || '',
    note: p.Description || '',
    moto: p.IsMotorcycle === 1,
    lat: p.CarParkPosition?.PositionLat,
    lng: p.CarParkPosition?.PositionLon,
  })).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
});

// 停車場 → { car: { total, available }, moto: {…} }；沒有即時資料的停車場不在裡面
const availOf = (city) => cached(`parking-avail:${city}`, AVAIL_MS, async () => {
  const { ParkingAvailabilities } = await tdx(`v1/Parking/OffStreet/ParkingAvailability/City/${city}`);
  return new Map(ParkingAvailabilities.map((a) => {
    const by = {};
    for (const [kind, type] of Object.entries(SPACE)) {
      const x = (a.Availabilities || []).find((y) => y.SpaceType === type);
      if (x) by[kind] = { total: x.NumberOfSpaces, available: x.AvailableSpaces >= 0 ? x.AvailableSpaces : null };
    }
    return [a.CarParkID, { ...by, updated: a.DataCollectTime }];
  }));
});

const within = (promise, ms, fallback) => Promise.race([promise, new Promise((r) => setTimeout(() => r(fallback), ms))]);

// kind：car／moto。回傳距離由近到遠、已知滿位的排除
export async function nearbyLots(point, kind) {
  if (!hasTdx()) {
    if (kind !== 'moto') return { list: [], updated: '' };
    const { list, updated } = await taipeiMotoParking(point);
    return { list: list.map((p) => ({ ...p, total: p.totalMotor, fee: p.fee })), updated };
  }
  const cities = citiesAt([point]);
  const found = await Promise.all(cities.map(async (city) => {
    const [lots, avail] = await Promise.all([
      within(lotsOf(city).catch(() => []), LOAD_WAIT_MS, []),
      within(availOf(city).catch(() => new Map()), LOAD_WAIT_MS, new Map()),
    ]);
    return lots.map((p) => {
      const a = avail.get(p.id)?.[kind];
      return {
        ...p,
        distance: Math.round(distance(point, p)),
        total: a?.total ?? null,
        available: a?.available ?? null,
        fee: feeFor(p.fare, kind),
        updated: avail.get(p.id)?.updated || '',
        // 這種車能不能停：有即時車位數就看格數；沒有時機車要標示為機車停車場，汽車預設可以
        fits: a ? a.total > 0 : kind === 'moto' ? p.moto : !p.moto || /汽車|小型車/.test(p.note + p.fare),
      };
    });
  }));
  const seen = new Set();
  const list = found.flat()
    .filter((p) => p.fits && p.distance <= SEARCH_M && p.available !== 0 && !seen.has(p.id) && seen.add(p.id))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, CANDIDATES);
  return { list, updated: list.find((p) => p.updated)?.updated || '' };
}

// ---------- 費用估算（業者費率會調整，只是參考，實際以 App 為準） ----------
// 共享機車：前 6 分鐘起步價、之後每分鐘；共享汽車：時租（平日～假日）＋里程費
const SCOOTER_FARES = [
  { name: 'GoShare', first: [15, 25], firstMin: 6, perMin: 2.5 },
  { name: 'WeMo', first: [18, 18], firstMin: 6, perMin: 3 },
  { name: 'iRent', first: [15, 15], firstMin: 6, perMin: 2.5 },
];
const CAR_FARES = [{ name: 'iRent', perHour: [130, 205], perKm: 3.1, minHours: 1 }];
const TRAFFIC_EXTRA = 1.3; // 塞車、找車位：時間多抓 3 成當作上限
// 自己的車：油錢（每公升約 30 元；汽車約 12 公里／公升、機車約 30 公里／公升）
const FUEL = { price: 30, car: 12, moto: 30 };

export function costOf(kind, distanceM, durationS) {
  const km = distanceM / 1000;
  const minutes = [durationS / 60, (durationS / 60) * TRAFFIC_EXTRA];
  if (kind === 'scooter') {
    return SCOOTER_FARES.map((f) => {
      const [low, high] = minutes.map((m, i) => f.first[i] + Math.ceil(Math.max(0, m - f.firstMin)) * f.perMin);
      return { name: f.name, low: Math.round(low), high: Math.round(high) };
    });
  }
  if (kind === 'sharecar') {
    return CAR_FARES.map((f) => {
      // 時租以半小時計，至少租 minHours 小時
      const hours = minutes.map((m) => Math.max(f.minHours, Math.ceil(m / 30) / 2));
      return { name: f.name, low: Math.round(hours[0] * f.perHour[0] + km * f.perKm), high: Math.round(hours[1] * f.perHour[1] + km * f.perKm) };
    });
  }
  const liters = km / FUEL[kind === 'car' ? 'car' : 'moto'];
  return [{ name: '油錢', low: Math.round(liters * FUEL.price), high: Math.round(liters * FUEL.price * TRAFFIC_EXTRA) }];
}
