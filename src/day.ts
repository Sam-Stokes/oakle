// Shared by the page, the Worker and the scripts. A "day" is a calendar date in TZ, so it rolls over at local midnight
// for the group instead of at UTC midnight (which was 1pm in Auckland). Oakle #1 is 2026-10-13.
// ponytail: one fixed zone for everyone; make it per-player later only if people in different zones join.
export const TZ = 'Pacific/Auckland';
const LAUNCH = '2026-10-13';

const ymd = (ms: number) => new Intl.DateTimeFormat('en-CA', {timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'}).format(ms); // YYYY-MM-DD
const utcDay = (s: string) => Date.parse(s + 'T00:00:00Z') / 864e5;

export const dayNumber = (d = new Date()) => Math.round(utcDay(ymd(+d)) - utcDay(LAUNCH)) + 1;

/** Timestamp (ms) of the first instant of that day in TZ. */
export const dayStart = (day: number) => {
  const target = new Date((utcDay(LAUNCH) + day - 1) * 864e5).toISOString().slice(0, 10);
  let t = Date.parse(target + 'T00:00:00Z') - 15 * 3600e3; // before any zone's midnight for that date
  while (ymd(t) < target) t += 15 * 60e3;
  return t;
};
