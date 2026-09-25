import type { EventRecord } from './types';

export type EventListKind = 'all' | 'week' | 'pending' | 'overdue';
export const eventListLabels: Record<EventListKind, string> = {
  all: '全部事件', week: '本周事件', pending: '待提醒', overdue: '到期未完成',
};

/** Qt's calendar-week overlap rule, using local calendar dates (including DST). */
export function eventLists(events: EventRecord[], now = Date.now(), snoozedIds: readonly number[] = []) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (start.getDay() + 6) % 7);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  const snoozed = new Set(snoozedIds);
  const deadline = (e: EventRecord) => e.deadline_ts === null ? null : e.deadline_ts * 1000;
  // Nearest date first; events without a deadline follow in creation order.
  const byDate = (a: EventRecord, b: EventRecord) =>
    (a.deadline_ts === null ? 1 : 0) - (b.deadline_ts === null ? 1 : 0) ||
    (a.deadline_ts ?? a.created_at) - (b.deadline_ts ?? b.created_at) || a.pos - b.pos;
  return {
    all: [...events].sort(byDate),
    week: events.filter(e => {
      const created = e.created_at * 1000;
      const due = deadline(e);
      return created < +end && ((due === null && !e.done) || (due ?? created) >= +start);
    }).sort(byDate),
    pending: events.filter(e => e.deadline_ts !== null && (deadline(e)! > now || (!e.done && snoozed.has(e.id)))).sort(byDate),
    overdue: events.filter(e => !e.done && e.deadline_ts !== null && deadline(e)! < now).sort(byDate),
  };
}

export function filterEventList(events: EventRecord[], query: string) {
  const needle = query.trim().toLocaleLowerCase();
  return needle ? events.filter(e => `${e.content_text}\n${e.deadline_raw}`.toLocaleLowerCase().includes(needle)) : events;
}
