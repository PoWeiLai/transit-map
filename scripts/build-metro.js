// 把 fetch-metro.js 抓的原始資料整理成 data/metro.json（網站規劃捷運路線用，進版控）
// 用法：node scripts/fetch-metro.js && node scripts/build-metro.js
import { readFileSync, writeFileSync } from 'node:fs';
import { distance } from '../geo.js';
import { OPERATORS } from './metro-config.js';

const raw = (op, part) => JSON.parse(readFileSync(new URL(`../data/cache/metro-raw-${op}-${part}.json`, import.meta.url), 'utf8'));
const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const DWELL_S = 30;            // 沒有站間時間時，每站停靠秒數
const NEAR_TRANSFER_M = 450;   // 不同系統的車站相距這麼近，視為可步行轉乘
const WALK_MPS = 1.0;          // 站內／站間步行速度（含上下樓）

const stations = {};  // key（業者:站號）→ { name, lat, lng, op, id }
const services = [];  // 一條行駛路線（例：板南線 頂埔—南港展覽館）
const transfers = []; // [站 key, 站 key, 秒]
const fares = {};     // 業者 → { '起站-迄站': 全票單程 }

for (const [op, cfg] of Object.entries(OPERATORS)) {
  for (const s of raw(op, 'Station')) {
    stations[`${op}:${s.StationID}`] = {
      name: s.StationName.Zh_tw.replace(/(?<!車)站$/, ''), lat: s.StationPosition.PositionLat, lng: s.StationPosition.PositionLon, op, id: s.StationID,
    };
  }
  const lines = new Map(raw(op, 'Line').map((l) => [l.LineID, l]));
  const freqs = raw(op, 'Frequency');

  // 班距與營運時間：平日／假日各一組；找不到路線自己的就用同一條線的，再沒有就用預設值
  const schedule = (routeId, lineId) => {
    const own = freqs.filter((f) => f.RouteID === routeId);
    const list = own.length ? own : freqs.filter((f) => f.LineID === lineId);
    const pick = (holiday) => {
      const f = list.find((x) => (holiday ? x.ServiceDay.Saturday || x.ServiceDay.Sunday : x.ServiceDay.Monday)) || list[0];
      if (!f) return { hours: (cfg.hours || ['06:00', '24:00']).map(toMin), headways: [] };
      return {
        hours: [toMin(f.OperationTime.StartTime), toMin(f.OperationTime.EndTime)],
        headways: f.Headways.map((h) => [toMin(h.StartTime), toMin(h.EndTime) || 24 * 60, (h.MinHeadwayMins + h.MaxHeadwayMins) / 2]),
      };
    };
    return { weekday: pick(false), holiday: pick(true) };
  };

  const add = (lineId, routeId, ids, times, suffix = '') => {
    const line = lines.get(lineId);
    // 同一條線反方向的資料只留一份（行駛時間視為雙向相同）
    const set = [...ids].sort().join();
    if (services.some((s) => s.op === op && s.line === lineId && !s.express === !suffix && [...s.stations].map((k) => k.split(':')[1]).sort().join() === set)) return;
    services.push({
      id: `${op}:${routeId}`, op, line: lineId, express: Boolean(suffix),
      name: (line?.LineName.Zh_tw || lineId) + (suffix ? `（${suffix}）` : ''), color: line?.LineColor || null,
      stations: ids.map((id) => `${op}:${id}`), times,
      defaultHeadway: cfg.headway, ...schedule(routeId, lineId),
    });
  };
  const estimate = (a, b) => Math.round(distance(stations[`${op}:${a}`], stations[`${op}:${b}`]) / (cfg.speed / 3.6) + DWELL_S);

  const s2s = raw(op, 'S2STravelTime');
  if (s2s.length) {
    // 站間行駛時間：一筆就是一條路線（含區間車、支線）
    s2s.forEach((r, k) => {
      const tt = r.TravelTimes.filter((t) => stations[`${op}:${t.FromStationID}`] && stations[`${op}:${t.ToStationID}`]);
      if (!tt.length) return;
      // 機場捷運、高雄輕軌給的是「任兩站」的時間表：從第一站到各站的時間排序後就是站序
      const count = new Map();
      for (const t of tt) count.set(t.FromStationID, (count.get(t.FromStationID) || 0) + 1);
      const origin = [...count].sort((a, b) => b[1] - a[1])[0][0]; // 時間表裡出現最多次的出發站
      const fromOrigin = tt.filter((t) => t.FromStationID === origin);
      let ids, times;
      if (fromOrigin.length > 2) {
        // 環狀線會列兩個方向，同一站只取第一次出現（同一方向）的時間
        const seen = new Set([origin]);
        const sorted = fromOrigin.filter((t) => !seen.has(t.ToStationID) && seen.add(t.ToStationID)).sort((a, b) => a.RunTime - b.RunTime);
        ids = [origin, ...sorted.map((t) => t.ToStationID)];
        times = sorted.map((t, n) => t.RunTime - (n ? sorted[n - 1].RunTime : 0));
        // 環狀線：最後一站離起點很近就接回起點
        if (ids.length > 10 && distance(stations[`${op}:${ids.at(-1)}`], stations[`${op}:${origin}`]) < 1500) {
          ids.push(origin);
          times.push(estimate(ids.at(-2), origin));
        }
      } else {
        ids = [origin, ...tt.map((t) => t.ToStationID)];
        times = tt.map((t) => t.RunTime + t.StopTime || estimate(t.FromStationID, t.ToStationID));
      }
      const express = op === 'TYMC' && r.TrainType === 2;
      add(r.LineID, r.RouteID || `${r.LineID}-${k + 1}`, ids, times, express ? '直達車' : '');
    });
    // 有些線沒有站間時間（例如新開的路段），用站序估算
    for (const l of raw(op, 'StationOfLine')) {
      if (s2s.some((r) => r.LineID === l.LineID)) continue;
      sequenceServices(l);
    }
  } else {
    for (const l of raw(op, 'StationOfLine')) sequenceServices(l);
  }

  // 只有站序：相鄰站相連；距離突然變很遠代表換到支線，從支線起點最近的站接回去
  function sequenceServices(l) {
    const ids = l.Stations.sort((a, b) => a.Sequence - b.Sequence).map((s) => s.StationID).filter((id) => stations[`${op}:${id}`]);
    const gap = (a, b) => distance(stations[`${op}:${a}`], stations[`${op}:${b}`]);
    const parts = [[ids[0]]];
    for (let i = 1; i < ids.length; i++) {
      if (gap(ids[i - 1], ids[i]) > 3000) {
        const prev = parts.flat();
        const join = prev.reduce((best, id) => (gap(id, ids[i]) < gap(best, ids[i]) ? id : best), prev[0]);
        parts.push([join, ids[i]]);
      } else parts.at(-1).push(ids[i]);
    }
    // 環狀線：頭尾很近就接起來
    const main = parts[0];
    if (main.length > 10 && gap(main[0], main.at(-1)) < 1500) main.push(main[0]);
    parts.forEach((p, k) => add(l.LineID, parts.length > 1 ? `${l.LineID}-${k + 1}` : l.LineID, p, p.slice(1).map((id, n) => estimate(p[n], id))));
  }

  for (const t of raw(op, 'LineTransfer')) {
    transfers.push([`${op}:${t.FromStationID}`, `${op}:${t.ToStationID}`, Math.round((t.TransferTime || 3) * 60)]);
  }

  const table = {};
  for (const f of raw(op, 'ODFare')) {
    const p = f.Fares.find((x) => x.TicketType === 1 && x.FareClass === 1) || f.Fares.find((x) => x.FareClass === 1);
    if (p && f.OriginStationID !== f.DestinationStationID) table[`${f.OriginStationID}-${f.DestinationStationID}`] = p.Price;
  }
  if (Object.keys(table).length) fares[op] = table;
}

// 不同系統、名字或位置相近的車站（例：台北捷運板橋站 ↔ 新北捷運環狀線板橋站）可步行轉乘
const keys = Object.keys(stations);
const linked = new Set(transfers.map(([a, b]) => [a, b].sort().join('|')));
for (let i = 0; i < keys.length; i++) {
  for (let j = i + 1; j < keys.length; j++) {
    const a = stations[keys[i]], b = stations[keys[j]];
    if (a.op === b.op || linked.has([keys[i], keys[j]].sort().join('|'))) continue;
    const d = distance(a, b);
    if (d <= NEAR_TRANSFER_M) transfers.push([keys[i], keys[j], Math.round(120 + (d * 1.3) / WALK_MPS)]);
  }
}

// 站點座標只保留有路線經過的
const used = new Set(services.flatMap((s) => s.stations));
const out = {
  built: new Date().toISOString().slice(0, 10),
  operators: Object.fromEntries(Object.entries(OPERATORS).map(([op, c]) => [op, c.name])),
  stations: Object.fromEntries(keys.filter((k) => used.has(k)).map((k) => [k, stations[k]])),
  services,
  transfers: transfers.filter(([a, b]) => used.has(a) && used.has(b)),
  fares,
};
writeFileSync(new URL('../data/metro.json', import.meta.url), JSON.stringify(out));
console.log(`${Object.keys(out.stations).length} 站、${services.length} 條路線、${out.transfers.length} 個轉乘`);
for (const s of services) console.log(`  ${s.id} ${s.name}：${s.stations.length} 站，約 ${Math.round(s.times.reduce((a, b) => a + b, 0) / 60)} 分`);
