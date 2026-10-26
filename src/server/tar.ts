// A minimal reader for (gzipped) tar archives, as Velero writes them with Go's archive/tar:
// ustar headers, long paths through the ustar prefix field, PAX extended headers ("x"/"g") and
// GNU long names ("L"). Only regular files are returned.
import { gunzipSync } from 'node:zlib';

export interface TarEntry {
  name: string;
  data: Buffer;
}

const BLOCK = 512;

const text = (b: Buffer, start: number, len: number) => {
  const s = b.subarray(start, start + len);
  const end = s.indexOf(0);
  return s.subarray(0, end < 0 ? s.length : end).toString('utf8');
};

const octal = (b: Buffer, start: number, len: number) => {
  // Large sizes may use base-256 (high bit set); Velero's files never come near 8 GiB.
  if (b[start]! & 0x80) throw new Error('tar: base-256 sizes are not supported');
  const s = text(b, start, len).trim();
  return s ? Number.parseInt(s, 8) : 0;
};

/** Parses PAX records: "<length> <key>=<value>\n" … */
export function paxRecords(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(0x20, i);
    if (space < 0) break;
    const len = Number.parseInt(data.subarray(i, space).toString('ascii'), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const record = data.subarray(space + 1, i + len - 1).toString('utf8');
    const eq = record.indexOf('=');
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    i += len;
  }
  return out;
}

/** The regular files of a tar archive, gzipped or not, up to `maxBytes` uncompressed. */
export function readTar(input: Buffer, maxBytes = 512 * 1024 * 1024): TarEntry[] {
  const tar = input[0] === 0x1f && input[1] === 0x8b ? gunzipSync(input, { maxOutputLength: maxBytes }) : input;
  const entries: TarEntry[] = [];
  let longName: string | null = null;
  let pax: Record<string, string> = {};
  let off = 0;
  while (off + BLOCK <= tar.length) {
    const h = tar.subarray(off, off + BLOCK);
    if (h.every((x) => x === 0)) break; // end of archive
    const size = octal(h, 124, 12);
    const type = String.fromCharCode(h[156] || 0x30);
    const data = tar.subarray(off + BLOCK, off + BLOCK + size);
    off += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    if (type === 'x') {
      pax = paxRecords(data);
      continue;
    }
    if (type === 'g') continue;
    if (type === 'L') {
      longName = text(data, 0, data.length);
      continue;
    }
    const magic = text(h, 257, 6);
    const prefix = magic.startsWith('ustar') ? text(h, 345, 155) : '';
    const name = pax.path ?? longName ?? (prefix ? `${prefix}/${text(h, 0, 100)}` : text(h, 0, 100));
    pax = {};
    longName = null;
    if (type === '0' || type === '\0' || type === '7') entries.push({ name, data: Buffer.from(data) });
  }
  return entries;
}
