// Port of TodoLine's Qt deadline parser. All calendar expressions use local time;
// durations use elapsed seconds (including its 30-day months / 365-day years).
interface Parts {
  year?: number;
  month?: number;
  day?: number;
  weekday?: number;
  relDay?: number;
  nextWeek?: boolean;
  hour?: number;
  minute?: number;
  second?: number;
}

const digits: Record<string, number> = {
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

function chineseNumber(value: string): number {
  if (value in digits) return digits[value];
  if (value === '十') return 10;
  if (/^十[一二三四五六七八九]$/.test(value)) return 10 + digits[value[1]];
  if (value === '二十') return 20;
  if (/^二十[一二三四]$/.test(value)) return 20 + digits[value[2]];
  return -1; // The original lookup table deliberately stops at twenty-four.
}

function clockNumber(value: string): number {
  return value.length <= 2 && /^\d/.test(value) ? Number(value) : chineseNumber(value);
}

function parseClock(raw: string, p: Parts): boolean {
  let m = /^\s*(\d{1,2}|[零一二两三四五六七八九十]{1,3})\s*点\s*(半|一刻|(?:\d{1,2}|[一二两三四五六七八九十]{1,2})\s*分?)?\s*$/.exec(raw);
  if (m) {
    const hour = clockNumber(m[1]);
    const tail = m[2] || '';
    const minute = tail === '半' ? 30 : tail === '一刻' ? 15
      : tail ? clockNumber(tail.replace(/分$/, '')) : 0;
    if (hour < 0 || hour > 24 || minute < 0) return false;
    Object.assign(p, { hour, minute, second: 0 });
    return true;
  }
  m = /^\s*(\d{1,2})\s*[:：]\s*(\d{1,2})(?:\s*[:：]\s*(\d{1,2}))?\s*(?:分)?\s*$/.exec(raw);
  if (!m) return false;
  Object.assign(p, { hour: +m[1], minute: +m[2], second: +(m[3] || 0) });
  return true;
}

const dayParts: Record<string, number> = {
  凌晨: 3, 早上: 8, 今早: 8, 上午: 9, 中午: 12, 下午: 15,
  傍晚: 18, 晚上: 20, 今晚: 20, 夜里: 22, 半夜: 23,
};

function parseTime(raw: string, p: Parts): boolean {
  const value = raw.trim();
  let m = /^(凌晨|早上|今早|上午|中午|下午|傍晚|晚上|今晚|夜里|半夜)\s*(.*)$/.exec(value);
  if (m) {
    const base = dayParts[m[1]];
    if (!m[2].trim()) {
      Object.assign(p, { hour: base, minute: 0, second: 0 });
      return true;
    }
    if (!parseClock(m[2].trim(), p)) return false;
    let hour = p.hour!;
    if ([15, 18, 20, 23].includes(base) && hour < 12) hour += 12;
    if (base === 12 && hour >= 1 && hour <= 6) hour += 12;
    p.hour = hour;
    return true;
  }
  if (parseClock(value, p)) return true;
  m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i.exec(value);
  if (!m) return false;
  let hour = +m[1];
  const pm = m[3].toLowerCase() === 'pm';
  if (pm && hour < 12) hour += 12;
  if (!pm && hour === 12) hour = 0;
  Object.assign(p, { hour, minute: +(m[2] || 0), second: 0 });
  return true;
}

function duration(raw: string): number | null {
  const cn = /^(半|\d{1,4}|[零一两二三四五六七八九十百]{1,4})\s*(?:个)?(秒钟|秒|分钟|分|小时|钟头|时|天|日|星期|周|礼拜|个月|月|年)\s*(后|之后|以后)?$/.exec(raw);
  const en = cn ? null : /^(?:in\s+)?(\d+(?:\.\d+)?)\s*(second|minute|hour|day|week|month|year)s?\s*(?:later|from now)?$/i.exec(raw);
  const m = cn || en;
  if (!m) return null;
  const n = m[1] === '半' ? 0.5 : /^\d/.test(m[1]) ? Number(m[1]) : chineseNumber(m[1]);
  if (n <= 0 || !Number.isFinite(n)) return null;
  const unit = m[2].toLowerCase();
  const multiplier = /^(秒|second)/.test(unit) ? 1
    : /^(分|minute)/.test(unit) ? 60
    : /^(小时|钟头|时|hour)/.test(unit) ? 3600
    : /^(天|日|day)/.test(unit) ? 86400
    : /^(星期|周|礼拜|week)/.test(unit) ? 7 * 86400
    : /^(个月|月|month)/.test(unit) ? 30 * 86400 : 365 * 86400;
  return Math.trunc(n * multiplier);
}

function parseParts(raw: string): Parts | null {
  const p: Parts = {};
  let m = /^(\d{4})\s*(?:年|[-/.])\s*(\d{1,2})\s*(?:月|[-/.])\s*(\d{1,2})\s*日?\s*(?:[T ]\s*)?(?:(\d{1,2})\s*[:点时]\s*(\d{1,2})\s*分?(?:\s*[:：]\s*(\d{1,2})\s*秒?)?)?\s*$/.exec(raw);
  if (m) {
    Object.assign(p, { year: +m[1], month: +m[2], day: +m[3] });
    if (m[4]) Object.assign(p, { hour: +m[4], minute: +m[5], second: +(m[6] || 0) });
    return p;
  }
  m = /^(\d{1,2})\s*(?:月|[-/.])\s*(\d{1,2})\s*日?\s+(\d{1,2})\s*[:点时]\s*(\d{1,2})\s*分?(?:\s*[:：]\s*(\d{1,2}))?\s*$/.exec(raw);
  if (m) return { month: +m[1], day: +m[2], hour: +m[3], minute: +m[4], second: +(m[5] || 0) };
  m = /^(\d{1,2})\s*(?:月|[-/.])\s*(\d{1,2})\s*日?\s*$/.exec(raw);
  if (m) return { month: +m[1], day: +m[2] };

  m = /^(今天|今日|明天|明日|后天|大后天|昨天|昨日|前天)\s*(.*?)\s*$/.exec(raw);
  if (m) {
    const relativeDays: Record<string, number> = { 今天: 0, 今日: 0, 明天: 1, 明日: 1, 后天: 2, 大后天: 3, 昨天: -1, 昨日: -1, 前天: -2 };
    p.relDay = relativeDays[m[1]];
    return !m[2] || parseTime(m[2], p) ? p : null;
  }
  m = /^(下\s*)?(周|星期|礼拜)\s*([一二三四五六日天1-7])\s*的?\s*(.*?)\s*$/.exec(raw);
  if (m) {
    p.weekday = /[日天]/.test(m[3]) ? 7 : digits[m[3]] ?? +m[3];
    p.nextWeek = !!m[1];
    return !m[4] || parseTime(m[4], p) ? p : null;
  }
  if (parseTime(raw, p)) return p;

  const english = raw.toLowerCase();
  const englishParts: Record<string, number> = { morning: 9, noon: 12, afternoon: 15, evening: 19, night: 21 };
  const parseEnglishTime = (rest: string): boolean => {
    if (!rest) return true;
    if (rest in englishParts) {
      p.hour = englishParts[rest];
      p.minute = 0;
      return true;
    }
    return parseTime(rest, p);
  };
  m = /^(today|tomorrow|tonight|day after tomorrow)\s*(.*?)\s*$/.exec(english);
  if (m) {
    p.relDay = m[1] === 'tomorrow' ? 1 : m[1] === 'day after tomorrow' ? 2 : 0;
    if (m[1] === 'tonight') {
      p.hour = 20; // Qt accepts and ignores any suffix after "tonight".
      return p;
    }
    return parseEnglishTime(m[2]) ? p : null;
  }
  m = /^(next\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\s*(.*?)\s*$/.exec(english);
  if (!m) return null;
  const weekdays: Record<string, number> = {
    monday: 1, tue: 2, tuesday: 2, wed: 3, wednesday: 3, thu: 4, thursday: 4,
    fri: 5, friday: 5, sat: 6, saturday: 6, sun: 7, sunday: 7,
  }; // "mon" is missing from the Qt lookup table, despite matching its regex.
  p.weekday = weekdays[m[2]];
  p.nextWeek = !!m[1];
  return p.weekday && parseEnglishTime(m[3]) ? p : null;
}

function daysInMonth(year: number, month: number): number {
  return [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
    31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] || 0;
}

function localDate(year: number, month: number, day: number, hour: number, minute: number, second: number): Date {
  const date = new Date(0);
  date.setFullYear(year, month - 1, day); // Avoid JS's special treatment of years 0–99.
  date.setHours(hour, minute, second, 0);
  return date;
}

/** Parse a Qt-compatible deadline into Unix seconds; unrecognized/invalid input is null. */
export function parseDeadline(raw: string, now = new Date()): number | null {
  raw = raw.trim();
  if (!raw || !Number.isFinite(now.getTime())) return null;
  const elapsed = duration(raw);
  if (elapsed !== null) {
    const timestamp = new Date(now.getTime() + elapsed * 1000).getTime();
    return Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : null;
  }
  const p = parseParts(raw);
  if (!p) return null;
  const hasTime = p.hour !== undefined;
  const hour = p.hour ?? 23;
  const minute = hasTime ? p.minute ?? 0 : 59;
  const second = hasTime ? p.second ?? 0 : 59;
  if (hour > 23 || minute > 59 || second > 59 || hour < 0 || minute < 0 || second < 0) return null;
  const dayAtTime = (offset = 0) => localDate(now.getFullYear(), now.getMonth() + 1, now.getDate() + offset, hour, minute, second);
  let date = dayAtTime();
  if (p.relDay !== undefined) {
    date = dayAtTime(p.relDay);
  } else if (p.weekday !== undefined) {
    const today = now.getDay() || 7;
    let offset = (p.weekday - today + 7) % 7;
    // Qt compares an invalid QTime for English day-parts (second remains -1),
    // so an explicitly named current weekday rolls forward even before that time.
    if (offset === 0 && (p.nextWeek || !hasTime || p.second === undefined || date <= now)) offset = 7;
    date = dayAtTime(offset);
  } else if (p.month !== undefined && p.day !== undefined) {
    let year = p.year ?? now.getFullYear();
    if (year < 1 || p.month < 1 || p.month > 12 || p.day < 1 || p.day > daysInMonth(year, p.month)) return null;
    date = localDate(year, p.month, p.day, hour, minute, second);
    if (p.year === undefined && date <= now) {
      year += 1;
      date = localDate(year, p.month, Math.min(p.day, daysInMonth(year, p.month)), hour, minute, second);
    }
  } else {
    if (!hasTime) return null;
    if (date <= now) date.setDate(date.getDate() + 1);
  }
  return Number.isFinite(date.getTime()) ? Math.floor(date.getTime() / 1000) : null;
}

/** Local yyyy-MM-dd HH:mm:ss, with Unix seconds as input. */
export function formatDate(seconds: number): string {
  const date = new Date(seconds * 1000);
  if (!Number.isFinite(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${String(date.getFullYear()).padStart(4, '0')}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Both deadline and now are Unix seconds; labels and rounding match DividerWidget. */
export function countdown(seconds: number, now = Date.now() / 1000): string {
  if (!Number.isFinite(seconds) || !Number.isFinite(now)) return '';
  const remaining = Math.trunc(seconds - now);
  if (remaining <= 0) return '已到期';
  const minutes = Math.max(1, Math.floor(remaining / 60));
  if (minutes >= 1440) return `剩 ${Math.floor(minutes / 1440)}天${Math.floor((minutes % 1440) / 60)}时`;
  if (minutes >= 60) return `剩 ${Math.floor(minutes / 60)}时${minutes % 60}分`;
  return `剩 ${minutes}分钟`;
}
