// 垃圾車：各縣市環保局的清運點與表定經過時間，加上垃圾車即時位置。
// 全國沒有統一的開放資料，有公開的縣市才查得到（表定：台北、新北、基隆、高雄；即時位置：新北、台中、台南、高雄）
import { daily, cached, taipeiNow, toMinutes } from './tdx.js';
import { distance } from './geo.js';

const NEAR_M = 600;        // 清運點多遠內
const COVER_M = 3000;      // 這麼遠內完全沒有清運點，就當作這個縣市沒有公開資料
const TRUCK_NEAR_M = 2000; // 即時位置：附近多遠內的車
const TRUCK_FRESH_MIN = 20; // 太久沒回報的車（多半已收班）不列
const LIVE_MS = 60 * 1000;
const MAX_STOPS = 6;
const DAYS = '日一二三四五六';
// 台北市週三、週日停收一般垃圾
const TAIPEI_DAYS = [1, 2, 4, 5, 6].reduce((m, d) => m | (1 << d), 0);

// 高雄市各區「垃圾清運路線及時間」資料集
const KAOHSIUNG = ['53fa3c3d-19a6-4bed-b864-9ae8e3734f7b', 'e983ab14-395e-438d-858c-b5da32592c10', '28d23cf4-4b41-43d7-ad2e-57ab1b13470f',
  '6cb25697-b1e3-4dad-9221-3348e42950d2', '229f7031-13a9-410b-9586-3ce04539dd62', '7392cdeb-d7fe-4913-a528-ff7fea13c031',
  '7650abef-10ae-43b8-b584-a678fbfb43cd', '11b45c9e-d5ef-4abc-a970-82a03d4fe758', '89cdab3d-b395-46cc-a1d3-086b3f195e32',
  'ef7e61e0-1e88-4b74-bf26-84defbb32917', '5f29ccae-ad8e-405b-9fc0-20895e4670f7', 'f27d99dd-a453-4674-b260-cef29129e194',
  '0c7c97e7-2b7f-4bec-bc1d-0cbfbff346f3', '885c8c43-3c72-4c45-ab9a-8f466ef3ec98', 'cc1a20ad-5731-46c2-ae8c-4375e138bf2c',
  'b35ae5f6-c622-4a42-9a7b-08adfc43dea0', '13d70f9a-b426-4b6e-a056-fd611171a645', '9854e42e-f38e-416c-915b-df480a102a12',
  '3bf0099f-c848-4983-b238-d99ce9632cec', 'c4b6327f-e53a-45d7-ad49-01c1a3358ccc', 'f13d89e9-33ee-4f12-b5e7-ac967cfdd410',
  '6c9776d0-49bf-42b6-8e00-5bb56a407b9c', '986c3b9a-4784-4972-a54b-22575c0f8d4b', '1ab01cc5-13f1-435c-b3df-55ba1899f7fc',
  '1bbbf953-5758-4d93-97ab-601cac7353b7', 'f313b733-ce41-40d3-8dab-62145770f763', '7ce09ffa-17e1-4f1a-ab72-3d55ca95b2e5',
  '4c170a24-5124-48a0-ba2f-3d3870a6bfc6', 'eb2de68e-6a47-4635-b059-3eab7948d8a7', '2e9d826c-756b-47be-8ee0-1406329bc319',
  '4a8ff3de-043e-40c3-8337-8f9d30a82375', 'a1e813f1-ae52-4b22-9fa7-e15512e41186', '888f41a8-e5cd-4ae5-8855-86e746fa52dc',
  '6bbc7e64-054b-4df0-a7f2-5789d1801496', '5888b615-2c27-411f-9153-15e1fae45bb6', 'eb7ef936-6cc3-41f7-9c2f-934fdb503802',
  'dad491d5-bd94-4ead-9b42-aad8274741f3'];
const KCG = (id) => `https://openapi.kcg.gov.tw/Api/Service/Get/${id}`;

async function get(url, type = 'json') {
  const res = await fetch(url, { signal: AbortSignal.timeout(90000), headers: { 'User-Agent': 'Mozilla/5.0 transit-map' } });
  if (!res.ok) throw new Error(`垃圾車資料 ${res.status}`);
  return type === 'json' ? res.json() : (await res.text()).replace(/^﻿/, '');
}

// CSV → 物件陣列（第一列是欄位名稱，欄位可能有雙引號）
function parseCsv(text) {
  const rows = [];
  let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (ch !== '\r') cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  const [head, ...data] = rows;
  return data.map((r) => Object.fromEntries(head.map((h, k) => [h.trim(), (r[k] ?? '').trim()])));
}

const hhmm = (s) => (/^\d{3,4}$/.test(s) ? `${s.padStart(4, '0').slice(0, 2)}:${s.padStart(4, '0').slice(2)}` : s);
const stop = (city, route, name, lat, lng, start, end = '', days = null, note = '') => {
  lat = Number(lat); lng = Number(lng);
  return Number.isFinite(lat) && Number.isFinite(lng) && lat > 21 && lat < 27 && /^\d{1,2}:\d{2}$/.test(start)
    ? { city, route, name, lat, lng, start, end, days, note } : null;
};

// 各縣市的清運點，抓不到的縣市略過（其他縣市照常）
const SOURCES = {
  async 臺北市() {
    const rows = parseCsv(await get('https://data.taipei/api/dataset/6bb3304b-4f46-4bb0-8cd1-60c66dcd1cae/resource/a6e90031-7ec4-4089-afb5-361a4efe7202/download', 'text'));
    return rows.map((r) => stop('臺北市', `${r['路線']} ${r['車次']}`, r['地點'], r['緯度'], r['經度'], hhmm(r['抵達時間']), hhmm(r['離開時間']), TAIPEI_DAYS, '週三、週日停收'));
  },
  async 新北市() {
    const rows = parseCsv(await get('https://data.ntpc.gov.tw/api/datasets/edc3ad26-8ae7-4916-a00b-bc6048d19bf8/csv/file', 'text'));
    const en = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    return rows.map((r) => {
      const bits = (kind) => en.reduce((m, d, k) => (r[`${kind}${d}`] === 'Y' ? m | (1 << k) : m), 0);
      const recycle = en.map((d, k) => (r[`recycling${d}`] === 'Y' ? DAYS[k] : '')).join('');
      const s = stop('新北市', `${r.city} ${r.linename}`, r.name, r.latitude, r.longitude, r.time, '', bits('garbage') || null,
        recycle ? `資源回收：星期${[...recycle].join('、')}` : '');
      // 路線編號跟即時位置的 lineid 一樣，用來算垃圾車現在的進度
      return s && { ...s, line: `ntpc:${r.lineid}`, rank: Number(r.rank) };
    });
  },
  async 基隆市() {
    const rows = parseCsv(await get('https://opendata-kl.askeycloud.com/route_klepb.csv', 'text'));
    return rows.map((r) => stop('基隆市', r['清運路線名稱'], r['清運點'], r['緯度'], r['經度'], r['預估到達時間'], r['預估離開時間'], null,
      r['回收日(星期幾)'] ? `資源回收：星期${r['回收日(星期幾)'].split(',').map((d) => DAYS[Number(d) % 7]).join('、')}` : ''));
  },
  async 高雄市() {
    const out = [];
    for (const id of KAOHSIUNG) { // 依序抓，避免同時打太多
      const body = await get(KCG(id)).catch(() => null);
      for (const r of body?.data || []) {
        const [s, e] = String(r['停留時間'] || '').split('-');
        out.push(stop('高雄市', `${r['行政區']} ${r['責任區']}責任區 第${r['車次']}車`, r['停留地點'], r['緯度'], r['經度'], s, e, null,
          r['回收日'] ? `資源回收：星期${r['回收日']}` : ''));
      }
    }
    return out;
  },
};

// 每個清運點屬於一條路線（line），路線上的點依順序（新北有清運序，其他依表定時間）
const allStops = () => daily('garbage-stops-v2', async () => {
  const lists = await Promise.all(Object.entries(SOURCES).map(([city, fn]) =>
    fn().catch((e) => { console.log(`${city}垃圾車資料載入失敗：`, e.message); return []; })));
  return lists.flat().filter(Boolean).map((s) => ({ ...s, line: s.line || `${s.city}:${s.route}` }));
});

// 路線 → 依順序排好的清運點
let routeIndex = { from: null, map: new Map() };
async function routes() {
  const stops = await allStops();
  if (routeIndex.from !== stops) {
    const map = new Map();
    for (const s of stops) (map.get(s.line) || map.set(s.line, []).get(s.line)).push(s);
    for (const list of map.values()) list.sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0) || toMinutes(a.start) - toMinutes(b.start));
    routeIndex = { from: stops, map };
  }
  return routeIndex.map;
}

// 高雄市今天的預估到點時間（依垃圾車實際進度推算），用行政區＋地點對應清運點
const kaohsiungEta = () => cached('garbage-kcg-eta', 5 * 60 * 1000, async () => {
  const body = await get(KCG('14fe516d-ac62-4905-9325-70daae7616bd'));
  return new Map((body.data || []).filter((r) => r.estime_s).map((r) => [`${r.area}|${r.caption}`, r.estime_s]));
});

// ---------- 即時位置 ----------

// 各家時間格式不同：2026/10/26 22:54:44、20261027T005949、2026-10-27T01:15:44
function minutesAgo(text) {
  const d = String(text).replace(/\D/g, '');
  if (d.length < 12) return null;
  const t = Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), +d.slice(8, 10) - 8, +d.slice(10, 12), +(d.slice(12, 14) || 0));
  return Math.round((Date.now() - t) / 60000);
}

const LIVE = {
  新北市: async () => (await get('https://data.ntpc.gov.tw/api/datasets/28ab4122-60e1-4065-98e5-abccb69aaca6/json?page=0&size=1000'))
    .map((r) => ({ car: r.car, location: r.location, lat: +r.latitude, lng: +r.longitude, time: r.time, line: `ntpc:${r.lineid}` })),
  臺中市: async () => (await get('https://newdatacenter.taichung.gov.tw/api/v1/no-auth/resource.download?rid=c923ad20-2ec6-43b9-b3ab-54527e99f7bc'))
    .map((r) => ({ car: r.car, location: r.location, lat: +r.Y, lng: +r.X, time: r.time })),
  臺南市: async () => ((await get('https://soa.tainan.gov.tw/Api/Service/Get/2c8a70d5-06f2-4353-9e92-c40d33bcd969')).data || [])
    .map((r) => ({ car: r.car, location: r.location, lat: +r.y, lng: +r.x, time: r.time })),
  高雄市: async () => ((await get(KCG('aaf4ce4b-4ca8-43de-bfaf-6dc97e89cac0'))).data || [])
    .map((r) => ({ car: r.car, location: r.location, lat: +r.y, lng: +r.x, time: r.time })),
};

const liveTrucks = () => cached('garbage-live', LIVE_MS, async () => {
  const lists = await Promise.all(Object.values(LIVE).map((fn) => fn().catch(() => [])));
  return lists.flat().filter((t) => Number.isFinite(t.lat) && Number.isFinite(t.lng));
});

// ---------- 查詢 ----------

// 下一次經過：有星期資料就找今天（還沒過）或之後最近的一天，沒有就只給表定時間
function nextPass(s, now, day) {
  if (!s.days) return { when: `表定 ${s.start}`, soon: null };
  for (let k = 0; k < 7; k++) {
    const d = (day + k) % 7;
    if (!((s.days >> d) & 1)) continue;
    if (k === 0 && toMinutes(s.start) < now) continue;
    const label = k === 0 ? '今天' : k === 1 ? '明天' : `星期${DAYS[d]}`;
    return { when: `${label} ${s.start}`, soon: k === 0 ? toMinutes(s.start) - now : null };
  }
  return { when: `表定 ${s.start}`, soon: null };
}

const freshTrucks = async () => (await liveTrucks().catch(() => []))
  .map((t) => ({ ...t, ago: minutesAgo(t.time) }))
  .filter((t) => t.ago != null && t.ago >= -5 && t.ago <= TRUCK_FRESH_MIN)
  .map((t) => ({ ...t, ago: Math.max(0, t.ago) }));

// 垃圾車現在的進度：用即時位置找出它在路線上的哪一站，比表定晚／早多少，推算到 mine 這站的時間
function progressOf(list, truck, mine, now) {
  if (!truck) return null;
  let at = 0;
  list.forEach((s, k) => { if (distance(truck, s) < distance(truck, list[at])) at = k; });
  const late = now - toMinutes(list[at].start); // 正的是比表定晚
  const left = mine - at;
  const eta = left > 0 ? toMinutes(list[mine].start) + late : null;
  return {
    at: list[at].name, atIndex: at, left, late,
    eta: eta != null ? `${String(Math.floor(eta / 60) % 24).padStart(2, '0')}:${String(Math.round(eta) % 60).padStart(2, '0')}` : null,
    car: truck.car, location: truck.location, ago: truck.ago, lat: truck.lat, lng: truck.lng,
  };
}

export async function garbageNear(point) {
  const [stops, trucks, eta, byLine] = await Promise.all([
    allStops().catch(() => []),
    freshTrucks(),
    kaohsiungEta().catch(() => new Map()),
    routes().catch(() => new Map()),
  ]);
  const truckOf = new Map(trucks.filter((t) => t.line).map((t) => [t.line, t]));
  const { minutes: now, date } = taipeiNow();
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();

  let covered = false;
  const near = [];
  for (const s of stops) {
    const d = distance(point, s);
    if (d <= COVER_M) covered = true;
    if (d <= NEAR_M) near.push({ ...s, distance: Math.round(d) });
  }
  near.sort((a, b) => a.distance - b.distance);
  // 同一條路線只留最近的清運點，依下一次經過時間排序
  const seen = new Set();
  const list = near.filter((s) => !seen.has(s.route) && seen.add(s.route)).slice(0, MAX_STOPS).map((s) => {
    const next = nextPass(s, now, day);
    const area = s.route.split(' ')[0];
    const estimate = s.city === '高雄市' ? eta.get(`${area}|${s.name}`) : null; // 今天依車子實際進度的預估
    // 新北：路線上的垃圾車正在跑，就算出它現在到哪、幾點會到這裡
    const route = byLine.get(s.line) || [];
    const mine = route.findIndex((x) => x.name === s.name && x.start === s.start);
    const progress = mine >= 0 ? progressOf(route, truckOf.get(s.line), mine, now) : null;
    const when = progress?.eta ? `預計 ${progress.eta}（表定 ${s.start}）`
      : estimate ? `今天預估 ${estimate}（表定 ${s.start}）` : next.when;
    const soonAt = progress?.eta || estimate;
    return {
      city: s.city, route: s.route, line: s.line, name: s.name, distance: s.distance, lat: s.lat, lng: s.lng,
      start: s.start, end: s.end, when, progress,
      soon: soonAt ? toMinutes(soonAt) - now : next.soon, note: s.note,
    };
  }).sort((a, b) => (a.soon ?? 9999) - (b.soon ?? 9999));

  const nearTrucks = trucks
    .map((t) => ({ ...t, distance: Math.round(distance(point, t)) }))
    .filter((t) => t.distance <= TRUCK_NEAR_M)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 5)
    .map(({ car, location, distance: d, ago, lat, lng }) => ({ car, location, distance: d, ago, lat, lng }));

  return { stops: list, trucks: nearTrucks, covered: covered || nearTrucks.length > 0 };
}

// 一條路線的所有清運點（依順序）與垃圾車現在的位置，畫面列出整條路線的進度
export async function garbageRoute(line) {
  const [byLine, trucks] = await Promise.all([routes(), freshTrucks()]);
  const list = byLine.get(line);
  if (!list) return null;
  const truck = trucks.find((t) => t.line === line);
  const progress = progressOf(list, truck, list.length - 1, taipeiNow().minutes);
  return {
    route: list[0].route, city: list[0].city,
    stops: list.map(({ name, lat, lng, start, end }) => ({ name, lat, lng, start, end })),
    progress,
  };
}

export const warmUp = () => allStops();
