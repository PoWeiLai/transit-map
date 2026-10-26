// 車站置物櫃清單（台鐵、高鐵、捷運沒有公開的置物櫃資料，這裡依官方公告與整理文章建立），
// 位置用 TDX 的車站座標。實際收費、數量以現場為準
import { readFileSync } from 'node:fs';
import { railStations } from './rail.js';

// 台鐵：「自動存物箱服務說明」各車站寄存一覽表（最後更新 2025/09/25），每 3 小時收費
const TRA = {
  基隆: '40–70', 七堵: '40–70', 汐止: '40–70', 南港: '40–70', 松山: '40–70', 臺北: '40–110', 板橋: '40–70',
  樹林: '40–70', 鶯歌: '40–70', 桃園: '40–70', 中壢: '40–70', 新莊: '40–70', 新竹: '40–70', 竹南: '40–70',
  苗栗: '40–70', 豐原: '40–70', 臺中: '40–70', 新烏日: '40–60', 彰化: '50–70', 員林: '40–70', 田中: '40–70',
  斗六: '40–70', 嘉義: '40–70', 新營: '30–60', 善化: '30–60', 新市: '40–60', 大湖: '40–60', 長榮大學: '30–60',
  岡山: '30–60', 橋頭: '30–60', 左營: '30–60', 高雄: '30–60', 鳳山: '30–60', 屏東: '30–60', 西勢: '40–60',
  潮州: '30–60', 瑞芳: '40–70', 雙溪: '40–70', 福隆: '40–70', 礁溪: '50–70', 宜蘭: '40–70', 羅東: '40–70',
  新城: '50–70', 花蓮: '40–70', 壽豐: '50–70', 鳳林: '50–70', 光復: '50–70', 玉里: '50–70', 關山: '50–70', 臺東: '50–70',
};

// 臺北捷運：大格 20 元／小時、小格 10 元／小時（整理文章，2024/01 更新）
const TRTC = {
  淡水: '出口 1、2 附近', 台北車站: 'M3 出口往臺鐵無障礙坡道旁、高鐵捷運連通道', 北門: '往機場捷運通道', 東門: '5 號出口旁',
  西門: '2 號、5 號出口', '台北101/世貿': '2 號出口、4 號出口轉乘通道', 三重: '1 號出口', 北投: '站廳（付費區）',
  新北投: '站廳（付費區）', 士林: '1 號出口附近（付費區）', 劍潭: '1、2 號出口附近（付費區）', 圓山: '2 號出口附近（付費區）',
  中正紀念堂: '6 號出口附近', 公館: '2 號出口附近', 新店: '站廳（付費區）', 大安森林公園: '5 號出口附近',
  國父紀念館: '2 號出口附近', 松山: '5 號出口附近', 板橋: '3A 出口附近', 忠孝復興: '文湖線 3 樓站廳',
  南港展覽館: '2A 出口', 府中: '2 號出口', 動物園: '2 號出口', 中山: '1 號出口', 象山: '2 號出口附近',
  新埔: '4 號出口', 忠孝敦化: '5 號出口附近',
};

// 桃園機場捷運：小格 20 元、大格 50 元／3 小時，只收硬幣、不找零
const TYMC = ['台北車站', '新北產業園區', '體育大學', '長庚醫院', '林口', '機場第一航廈', '高鐵桃園', '桃園體育園區'];

// 高雄捷運：官方公告的設置車站（西子灣站現名哈瑪星），收費以現場為準
const KRTC = ['三多商圈', '中央公園', '高雄車站', '巨蛋', '左營', '哈瑪星', '鹽埕埔', '美麗島'];

const norm = (s) => String(s).replace(/台/g, '臺').replace(/站$/, '');

let list = null;
export async function stationLockers() {
  if (list) return list;
  const metro = JSON.parse(readFileSync(new URL('./data/metro.json', import.meta.url), 'utf8')).stations;
  const metroAt = (op, name) => Object.entries(metro).find(([k, s]) => k.startsWith(`${op}:`) && norm(s.name) === norm(name))?.[1];
  const out = [];
  for (const [name, where] of Object.entries(TRTC)) {
    const s = metroAt('TRTC', name);
    if (s) out.push({ name: `臺北捷運${s.name}站置物櫃`, lat: s.lat, lng: s.lng, hours: `${where}・依捷運營運時間`, fee: '大格 20 元、小格 10 元／小時' });
  }
  for (const name of TYMC) {
    const s = metroAt('TYMC', name);
    if (s) out.push({ name: `機場捷運${s.name}站置物櫃`, lat: s.lat, lng: s.lng, hours: '依捷運營運時間', fee: '小格 20 元、大格 50 元／3 小時（只收硬幣）' });
  }
  for (const name of KRTC) {
    const s = metroAt('KRTC', name);
    if (s) out.push({ name: `高雄捷運${s.name}站置物櫃`, lat: s.lat, lng: s.lng, hours: '依捷運營運時間', fee: '收費以現場為準' });
  }
  // 台鐵、高鐵車站座標要 TDX，抓不到就只列捷運
  const [tra, thsr] = await Promise.all(['tra', 'thsr'].map((sys) => railStations(sys).catch(() => [])));
  for (const s of tra) {
    const fee = TRA[norm(s.name)];
    if (fee) out.push({ name: `台鐵${s.name}站自動存物箱`, lat: s.lat, lng: s.lng, hours: '依車站營業時間', fee: `${fee} 元／3 小時` });
  }
  // 台灣高鐵：各車站都有寄物櫃（官方「服務與設施總覽」）
  for (const s of thsr) out.push({ name: `高鐵${s.name}站寄物櫃`, lat: s.lat, lng: s.lng, hours: '依車站營業時間', fee: '收費以現場為準' });
  if (tra.length) list = out; // 台鐵、高鐵抓到了才記住，否則下次再試
  return out;
}
