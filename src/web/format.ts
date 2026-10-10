// Formatting. Times are shown in the browser's time zone.

const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];

/** "1.4 MiB"; bytes below 1 KiB as "512 B". */
export function bytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '–';
  let v = n;
  let u = 0;
  while (v >= 1024 && u < UNITS.length - 1) {
    v /= 1024;
    u++;
  }
  return u === 0 ? `${n} B` : `${v < 10 ? v.toFixed(1) : Math.round(v)} ${UNITS[u]}`;
}

export const exactBytes = (n: number) => `${n.toLocaleString('en')} bytes`;

const dtf = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

export function dateTime(s: string | null | undefined): string {
  if (!s) return '–';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : dtf.format(d);
}

export function ago(s: string | null | undefined, now = Date.now()): string {
  if (!s) return '–';
  const sec = Math.round((now - Date.parse(s)) / 1000);
  if (sec < 0) return dateTime(s);
  if (sec < 45) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 36) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 60) return `${d} days ago`;
  return dateTime(s);
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en')} ${n === 1 ? one : many}`;
