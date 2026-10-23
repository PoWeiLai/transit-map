// 全台捷運／輕軌業者（TDX 代碼）與沒有官方資料時的估算值
export const OPERATORS = {
  TRTC: { name: '台北捷運', speed: 35, headway: 8 },
  NTMC: { name: '新北捷運', speed: 35, headway: 10 },
  NTDLRT: { name: '淡海輕軌', speed: 20, headway: 15 },
  NTALRT: { name: '安坑輕軌', speed: 20, headway: 15 },
  TRTCMG: { name: '貓空纜車', speed: 15, headway: 1, hours: ['09:00', '21:00'] },
  TYMC: { name: '桃園機場捷運', speed: 50, headway: 15 },
  TMRT: { name: '台中捷運', speed: 35, headway: 10 },
  KRTC: { name: '高雄捷運', speed: 35, headway: 8 },
  KLRT: { name: '高雄輕軌', speed: 18, headway: 15 },
};

export const RAW_PARTS = ['Station', 'StationOfLine', 'Line', 'S2STravelTime', 'Frequency', 'LineTransfer', 'ODFare', 'FirstLastTimetable'];
