// Object keys as a file tree: "/" separates folders, a key ending in "/" is a folder marker.

/** The last path segment: "a/b/c.txt" → "c.txt", "a/b/" → "b". */
export function baseName(key: string): string {
  const k = key.endsWith('/') ? key.slice(0, -1) : key;
  return k.slice(k.lastIndexOf('/') + 1);
}

/** The folder containing a key or folder: "a/b/c.txt" → "a/b/", "a/b/" → "a/", "c" → "". */
export function parentPrefix(key: string): string {
  const k = key.endsWith('/') ? key.slice(0, -1) : key;
  const i = k.lastIndexOf('/');
  return i < 0 ? '' : k.slice(0, i + 1);
}

/** Folders from the root down to (and including) `prefix`, for breadcrumbs. */
export function breadcrumbs(prefix: string): { name: string; prefix: string }[] {
  const out: { name: string; prefix: string }[] = [];
  let acc = '';
  for (const part of prefix.split('/').slice(0, -1)) {
    acc += `${part}/`;
    out.push({ name: part, prefix: acc });
  }
  return out;
}

/** UTF-8 length, which is what S3 limits (1024 bytes per key). */
export const byteLength = (s: string) => new TextEncoder().encode(s).length;

export const MAX_KEY_BYTES = 1024;

/**
 * Checks a single file or folder name typed by the user. Slashes are refused (they would create
 * nested folders by accident), as are "." and ".." (a key may contain them, but many tools
 * then mishandle the object) and control characters.
 */
export function nameError(name: string): string | null {
  if (!name) return 'The name is empty.';
  if (name.includes('/')) return 'A name cannot contain "/".';
  if (name === '.' || name === '..') return 'A name cannot be "." or "..".';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return 'A name cannot contain control characters.';
  return null;
}

/** Checks a full key built from a prefix and names. */
export function keyError(key: string): string | null {
  if (!key) return 'The key is empty.';
  if (byteLength(key) > MAX_KEY_BYTES) return `The key is longer than ${MAX_KEY_BYTES} bytes.`;
  return null;
}

/**
 * The key an item lands at when it is copied or moved from `fromPrefix` to `toPrefix`:
 * "a/b/c.txt" from "a/" to "x/" → "x/b/c.txt".
 */
export function rebase(key: string, fromPrefix: string, toPrefix: string): string {
  if (!key.startsWith(fromPrefix)) throw new Error(`"${key}" is not under "${fromPrefix}"`);
  return toPrefix + key.slice(fromPrefix.length);
}

/** Bucket names as S3 accepts them for new buckets (general purpose buckets). */
export function bucketNameError(name: string): string | null {
  if (name.length < 3 || name.length > 63) return 'Bucket names are 3 to 63 characters long.';
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(name))
    return 'Use lowercase letters, digits, dots and hyphens; start and end with a letter or digit.';
  if (name.includes('..')) return 'A bucket name cannot contain two dots in a row.';
  if (/^\d+\.\d+\.\d+\.\d+$/.test(name)) return 'A bucket name cannot look like an IP address.';
  if (name.startsWith('xn--') || name.startsWith('sthree-') || name.endsWith('-s3alias') || name.endsWith('--ol-s3'))
    return 'This prefix or suffix is reserved by S3.';
  return null;
}
