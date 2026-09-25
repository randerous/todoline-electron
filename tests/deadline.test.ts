// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { countdown, formatDate, parseDeadline } from '../src/shared/deadline';

function local(value: string): Date {
  const [year, month, day, hour, minute, second] = value.split(/[- :]/).map(Number);
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(hour, minute, second || 0, 0);
  return date;
}
const now = () => local('2026-08-21 15:00:00'); // Friday, in the machine's local timezone.
const seconds = (value: string) => local(value).getTime() / 1000;

// Every fixed calendar example from the original tst_deadline_parser.cpp. These
// fixtures are self-contained: running the suite never reads the original repo.
const qtCalendarCases = [
  ['2026-08-21 16:21:20', '2026-08-21 16:21:20'],
  ['2026-08-21 16:21', '2026-08-21 16:21:00'],
  ['2026/8/21 16:21', '2026-08-21 16:21:00'],
  ['2026年8月21日 16:21', '2026-08-21 16:21:00'],
  ['2026年8月21日 16时21分', '2026-08-21 16:21:00'],
  ['2026-08-21T16:21', '2026-08-21 16:21:00'],
  ['2026-08-21', '2026-08-21 23:59:59'],
  ['2026.08.21 16:21', '2026-08-21 16:21:00'],
  ['2020-05-05', '2020-05-05 23:59:59'],
  ['8-21 16:00', '2026-08-21 16:00:00'],
  ['8/21 17:30', '2026-08-21 17:30:00'],
  ['8月21日 16:00', '2026-08-21 16:00:00'],
  ['8/21', '2026-08-21 23:59:59'],
  ['9-1', '2026-09-01 23:59:59'],
  ['8/20 18:00', '2027-08-20 18:00:00'],
  ['1-1', '2027-01-01 23:59:59'],
  ['8/21 14:00', '2027-08-21 14:00:00'],
  ['明天 15:00', '2026-08-22 15:00:00'],
  ['明天', '2026-08-22 23:59:59'],
  ['今天 18:00', '2026-08-21 18:00:00'],
  ['后天 9:30', '2026-08-23 09:30:00'],
  ['大后天', '2026-08-24 23:59:59'],
  ['昨天', '2026-08-20 23:59:59'],
  ['明天下午3点', '2026-08-22 15:00:00'],
  ['明天晚上8点半', '2026-08-22 20:30:00'],
  ['周五 16:00', '2026-08-21 16:00:00'],
  ['周五 14:00', '2026-08-28 14:00:00'],
  ['周五', '2026-08-28 23:59:59'],
  ['下周一 10:00', '2026-08-24 10:00:00'],
  ['周六', '2026-08-22 23:59:59'],
  ['星期三下午3点', '2026-08-26 15:00:00'],
  ['星期天', '2026-08-23 23:59:59'],
  ['礼拜六 9点', '2026-08-22 09:00:00'],
  ['16:21', '2026-08-21 16:21:00'],
  ['14:30', '2026-08-22 14:30:00'],
  ['下午4点', '2026-08-21 16:00:00'],
  ['下午2点半', '2026-08-22 14:30:00'],
  ['3点半', '2026-08-22 03:30:00'],
  ['三点', '2026-08-22 03:00:00'],
  ['十一点半', '2026-08-22 11:30:00'],
  ['晚上8点半', '2026-08-21 20:30:00'],
  ['中午12点', '2026-08-22 12:00:00'],
  ['中午1点', '2026-08-22 13:00:00'],
  ['中午1点半', '2026-08-22 13:30:00'],
  ['中午12点半', '2026-08-22 12:30:00'],
  ['下午', '2026-08-22 15:00:00'],
  ['tomorrow 3pm', '2026-08-22 15:00:00'],
  ['tomorrow', '2026-08-22 23:59:59'],
  ['today 18:00', '2026-08-21 18:00:00'],
  ['3:30pm', '2026-08-21 15:30:00'],
  ['9am', '2026-08-22 09:00:00'],
  ['next friday', '2026-08-28 23:59:59'],
  ['monday 9:00', '2026-08-24 09:00:00'],
  ['tonight', '2026-08-21 20:00:00'],
] as const;

const qtDurationCases = [
  ['2天后', 2 * 86400], ['10分钟后', 600], ['半小时后', 1800],
  ['3个小时后', 10800], ['两天后', 2 * 86400], ['1个星期后', 7 * 86400],
  ['2个月后', 60 * 86400], ['1年后', 365 * 86400], ['5分钟之后', 300],
  ['in 2 days', 2 * 86400], ['in 10 minutes', 600], ['2 days later', 2 * 86400], ['1 hour later', 3600],
] as const;

describe('Qt deadline fixtures', () => {
  it.each(qtCalendarCases)('%s → %s', (raw, expected) => {
    expect(parseDeadline(raw, now())).toBe(seconds(expected));
  });
  it.each(qtDurationCases)('%s → +%d seconds', (raw, elapsed) => {
    expect(parseDeadline(raw, now())).toBe(now().getTime() / 1000 + elapsed);
  });
  it.each(['', 'abc', '随便写点什么', '下下周五', '13-40', '25:99', '2026-13-01', '2天后x'])('rejects %j', raw => {
    expect(parseDeadline(raw, now())).toBeNull();
  });
});

describe('calendar and clock boundaries', () => {
  it.each([
    ['15:00', '2026-08-22 15:00:00'],
    ['今天15:00', '2026-08-21 15:00:00'],
    ['今天14:00', '2026-08-21 14:00:00'],
    ['周五15:00', '2026-08-28 15:00:00'],
    ['8/21 15:00', '2027-08-21 15:00:00'],
    ['2026-08-21 15:00', '2026-08-21 15:00:00'],
    ['下周日', '2026-08-23 23:59:59'], // Strictly next occurrence, not next calendar week.
    ['下 周 5 的 16:00', '2026-08-28 16:00:00'],
    ['今日凌晨', '2026-08-21 03:00:00'],
    ['明日早上', '2026-08-22 08:00:00'],
    ['昨日上午', '2026-08-20 09:00:00'],
    ['前天傍晚', '2026-08-19 18:00:00'],
    ['夜里', '2026-08-21 22:00:00'],
    ['夜里三点', '2026-08-22 03:00:00'], // Qt does not apply PM conversion to 夜里.
    ['半夜一点', '2026-08-22 13:00:00'],
    ['今晚', '2026-08-21 20:00:00'],
    ['今早', '2026-08-22 08:00:00'],
    ['12am', '2026-08-22 00:00:00'],
    ['12PM', '2026-08-22 12:00:00'],
    ['13pm', '2026-08-22 13:00:00'], // Qt validates the final 24-hour clock, not AM/PM range.
    ['下午两点一刻', '2026-08-22 14:15:00'],
    ['二十三点二十分', '2026-08-21 23:20:00'],
    ['  16 ： 21 ： 09 分  ', '2026-08-21 16:21:09'],
    ['2026年8月21日16时21分：09秒', '2026-08-21 16:21:09'],
    ['8.21 16时21分：09', '2026-08-21 16:21:09'],
    ['TOMORROW afternoon', '2026-08-22 15:00:00'],
    ['day after tomorrow noon', '2026-08-23 12:00:00'],
    ['monday morning', '2026-08-24 09:00:00'],
    ['tue night', '2026-08-25 21:00:00'],
    ['fri evening', '2026-08-28 19:00:00'], // Qt's unset-second candidate rolls to next week.
    ['fri 19:00', '2026-08-21 19:00:00'],
    ['tonight 9pm', '2026-08-21 20:00:00'], // Qt ignores tonight's suffix.
  ])('%s → %s', (raw, expected) => {
    expect(parseDeadline(raw, now())).toBe(seconds(expected));
  });

  it.each(['   ', '2026-02-29', '2024-02-30', '0000-01-01', '0/1', '1/0', '2/29',
    '24:00', '24点', '10:60', '10:10:60', '3点99分', '二十五点', '3点二十三分',
    '3点 20 分', 'mon', 'next mon', 'tomorrow nonsense', '周五 nonsense', '明天 nonsense',
    '2026-08-21T16:21Z', '8月21日下午3点', '下午3时', '3:3pm'])('rejects %j without Date normalization', raw => {
    expect(parseDeadline(raw, now())).toBeNull();
  });

  it('accepts leap days and clamps Qt addYears rollover to February 28', () => {
    expect(parseDeadline('2024-02-29', now())).toBe(seconds('2024-02-29 23:59:59'));
    expect(parseDeadline('2/29 10:00', local('2024-03-01 12:00:00'))).toBe(seconds('2025-02-28 10:00:00'));
    expect(parseDeadline('明天', local('2026-12-31 15:00:00'))).toBe(seconds('2027-01-01 23:59:59'));
    expect(parseDeadline('0099-01-02 03:04', now())).toBe(seconds('0099-01-02 03:04:00'));
  });

  it('does not mutate now, and keeps calendar days distinct from elapsed durations at DST', () => {
    const date = local('2026-03-07 15:00:00');
    const before = date.getTime();
    expect(parseDeadline('明天15:00', date)).toBe(seconds('2026-03-08 15:00:00'));
    expect(parseDeadline('1天后', date)).toBe(before / 1000 + 86400);
    expect(date.getTime()).toBe(before);
  });

  it('chooses the requested date before resolving a clock inside a DST gap', () => {
    const date = local('2026-03-08 15:00:00'); // US spring-forward Sunday.
    expect(parseDeadline('明天2:30', date)).toBe(seconds('2026-03-09 02:30:00'));
    expect(parseDeadline('周一2:30', date)).toBe(seconds('2026-03-09 02:30:00'));
    expect(parseDeadline('昨天2:30', date)).toBe(seconds('2026-03-07 02:30:00'));
  });

  it('handles invalid now without emitting NaN', () => {
    expect(parseDeadline('明天', new Date(NaN))).toBeNull();
    expect(parseDeadline('2天后', new Date(NaN))).toBeNull();
  });
});

describe('relative duration grammar', () => {
  it.each([
    ['半秒', 0], ['1秒钟后', 1], ['2分以后', 120], ['半个小时之后', 1800],
    ['一钟头', 3600], ['二时', 7200], ['3日', 259200], ['半周', 302400],
    ['一礼拜', 604800], ['1月', 2592000], ['半个月', 1296000], ['二十四天', 2073600],
    ['IN 1.5 HOURS FROM NOW', 5400], ['0.1 seconds', 0], ['1.9 seconds', 1],
    ['2 weeks', 1209600], ['1 month later', 2592000], ['0.5 years', 15768000],
  ])('%s uses elapsed seconds', (raw, elapsed) => {
    const date = new Date(now().getTime() + 900);
    expect(parseDeadline(raw, date)).toBe(Math.floor(date.getTime() / 1000) + elapsed);
  });
  it.each(['0天', '零小时', '0 seconds', '-1 day', '二十五天', '一百天', '10000天',
    '1.5小时', 'in half an hour', 'in 2 days please', `${'9'.repeat(400)} years`])('rejects %j', raw => {
    expect(parseDeadline(raw, now())).toBeNull();
  });
});

describe('formatDate and countdown', () => {
  afterEach(() => vi.useRealTimers());
  it('formats local time with seconds and zero padding', () => {
    expect(formatDate(seconds('2026-01-02 03:04:05'))).toBe('2026-01-02 03:04:05');
    expect(formatDate(seconds('0099-01-02 03:04:05'))).toBe('0099-01-02 03:04:05');
    expect(formatDate(NaN)).toBe('');
  });
  it.each([
    [-1, '已到期'], [0, '已到期'], [0.9, '已到期'], [1, '剩 1分钟'], [59, '剩 1分钟'], [119, '剩 1分钟'],
    [120, '剩 2分钟'], [619, '剩 10分钟'], [3599, '剩 59分钟'], [3600, '剩 1时0分'],
    [3660, '剩 1时1分'], [86399, '剩 23时59分'], [86400, '剩 1天0时'], [183600, '剩 2天3时'],
  ])('matches Qt countdown for %+d seconds', (remaining, label) => {
    expect(countdown(1000 + remaining, 1000)).toBe(label);
  });
  it('uses the real-time default clock in Unix seconds', () => {
    vi.useFakeTimers();
    vi.setSystemTime(now());
    expect(parseDeadline('明天')).toBe(seconds('2026-08-22 23:59:59'));
    expect(countdown(now().getTime() / 1000 + 600)).toBe('剩 10分钟');
    expect(countdown(Infinity)).toBe('');
    expect(countdown(100, NaN)).toBe('');
  });
});
