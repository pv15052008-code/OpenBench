/** Dates and times. The institution runs on India Standard Time (UTC+05:30, no daylight saving). */
export const TZ = "Asia/Kolkata";
const IST_OFFSET_MIN = 330;

const dayFmt = new Intl.DateTimeFormat("en-IN", { timeZone: TZ, weekday: "short", day: "numeric", month: "short" });
const timeFmt = new Intl.DateTimeFormat("en-IN", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });
const fullFmt = new Intl.DateTimeFormat("en-IN", { timeZone: TZ, day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });

export const day = (iso: string | Date) => dayFmt.format(new Date(iso));
export const time = (iso: string | Date) => timeFmt.format(new Date(iso));
export const full = (iso: string | Date) => fullFmt.format(new Date(iso));

export function range(start: string, end: string): string {
  const s = new Date(start), e = new Date(end);
  const sameDay = istDate(s) === istDate(e);
  return sameDay ? `${day(s)}, ${time(s)}–${time(e)}` : `${day(s)} ${time(s)} – ${day(e)} ${time(e)}`;
}

/** YYYY-MM-DD of a moment, as seen in India */
export function istDate(d: Date): string {
  const shifted = new Date(d.getTime() + IST_OFFSET_MIN * 60000);
  return shifted.toISOString().slice(0, 10);
}

/** Minutes since midnight in India */
export function istMinutes(d: Date): number {
  const shifted = new Date(d.getTime() + IST_OFFSET_MIN * 60000);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

/** Weekday (0 = Sunday) of an IST calendar date string */
export function istWeekday(date: string): number {
  return new Date(`${date}T12:00:00+05:30`).getUTCDay();
}

/** A real instant from an IST calendar date and minutes since midnight */
export function istInstant(date: string, minutes: number): Date {
  const base = new Date(`${date}T00:00:00+05:30`);
  return new Date(base.getTime() + minutes * 60000);
}

export function hhmm(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24, m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function ago(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} d ago`;
  return day(iso);
}

export function hours(minutes: number): string {
  const h = minutes / 60;
  return h === Math.floor(h) ? `${h} h` : `${h.toFixed(1)} h`;
}
