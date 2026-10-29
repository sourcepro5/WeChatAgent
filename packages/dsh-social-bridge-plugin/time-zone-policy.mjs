// 提示词时钟的时区设置：留空沿用北京时间，行为与旧版本一致
export const DEFAULT_TIME_ZONE = 'Asia/Shanghai';

export function validateTimeZone(value) {
  if (value === undefined || value === null || value === '') return;
  if (typeof value !== 'string' || !value.trim()) throw new Error('Invalid time_zone');
  try { new Intl.DateTimeFormat('en', { timeZone: value.trim() }); }
  catch { throw new Error('Invalid time_zone'); }
}

export function timeZoneOf(wechat){
  const value = wechat?.time_zone;
  if(typeof value !== 'string' || !value.trim()) return DEFAULT_TIME_ZONE;
  try { new Intl.DateTimeFormat('en', { timeZone: value.trim() }); return value.trim(); }
  catch { return DEFAULT_TIME_ZONE; }
}
