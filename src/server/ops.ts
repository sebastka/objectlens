// Operations on many objects: folders are prefixes, so deleting, copying or moving one means
// doing it to every object below it. Each request handles at most `limit` objects and reports
// `truncated` when it stopped early; running it again continues where it stopped.
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  type ObjectIdentifier,
  type S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { keyError, parentPrefix, rebase } from '../shared/keys.ts';
import type { BulkResult, ItemRef, ObjectEntry, Resume } from '../shared/types.ts';
import { copyObject, describe, unquote } from './s3.ts';

export function toEntry(o: {
  Key?: string;
  Size?: number;
  LastModified?: Date;
  ETag?: string;
  StorageClass?: string;
}): ObjectEntry {
  return {
    key: o.Key ?? '',
    size: o.Size ?? 0,
    lastModified: o.LastModified?.toISOString() ?? null,
    etag: unquote(o.ETag),
    storageClass: o.StorageClass ?? null,
  };
}

/** Every object under a prefix (no delimiter), page by page, optionally after a key. */
export async function* listAll(
  s3: S3Client,
  bucket: string,
  prefix: string,
  startAfter?: string,
): AsyncGenerator<ObjectEntry> {
  let token: string | undefined;
  do {
    const r = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ...(token ? { ContinuationToken: token } : startAfter ? { StartAfter: startAfter } : {}),
      }),
    );
    for (const o of r.Contents ?? []) yield toEntry(o);
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
}

/** Every version and delete marker under a prefix. */
export async function* listAllVersions(
  s3: S3Client,
  bucket: string,
  prefix: string,
): AsyncGenerator<{ key: string; versionId: string }> {
  let keyMarker: string | undefined;
  let versionMarker: string | undefined;
  do {
    const r = await s3.send(
      new ListObjectVersionsCommand({
        Bucket: bucket,
        Prefix: prefix,
        ...(keyMarker ? { KeyMarker: keyMarker } : {}),
        ...(versionMarker ? { VersionIdMarker: versionMarker } : {}),
      }),
    );
    for (const v of [...(r.Versions ?? []), ...(r.DeleteMarkers ?? [])]) {
      if (v.Key && v.VersionId) yield { key: v.Key, versionId: v.VersionId };
    }
    keyMarker = r.IsTruncated ? r.NextKeyMarker : undefined;
    versionMarker = r.IsTruncated ? r.NextVersionIdMarker : undefined;
  } while (keyMarker);
}

/** Expands items into object identifiers, at most `limit`. */
export async function expand(
  s3: S3Client,
  bucket: string,
  items: ItemRef[],
  limit: number,
  allVersions: boolean,
): Promise<{ ids: ObjectIdentifier[]; truncated: boolean }> {
  const ids: ObjectIdentifier[] = [];
  for (const item of items) {
    if ('key' in item && !allVersions) {
      ids.push({ Key: item.key, ...(item.versionId ? { VersionId: item.versionId } : {}) });
    } else {
      const prefix = 'key' in item ? item.key : item.prefix;
      if (allVersions) {
        for await (const v of listAllVersions(s3, bucket, prefix)) {
          // A key's versions only: not those of "a.txt.bak" when deleting "a.txt". Keys come
          // sorted, so the first later key ends the scan.
          if ('key' in item && v.key !== item.key) {
            if (v.key > item.key) break;
            continue;
          }
          ids.push({ Key: v.key, VersionId: v.versionId });
          if (ids.length > limit) break;
        }
      } else {
        for await (const o of listAll(s3, bucket, prefix)) {
          ids.push({ Key: o.key });
          if (ids.length > limit) break;
        }
      }
    }
    if (ids.length > limit) return { ids: ids.slice(0, limit), truncated: true };
  }
  return { ids, truncated: false };
}

/** Codes meaning the server cannot do DeleteObjects (as asked), not that a key failed. */
const NO_MULTI_DELETE = new Set([
  'NotImplemented',
  'MissingContentMD5',
  'InvalidRequest',
  'XAmzContentSHA256Mismatch',
  // Keys with characters XML 1.0 cannot carry fail the whole batch.
  'MalformedXML',
]);

/** Object Lock refuses deletes with AccessDenied too; that is no lack of permission. */
const LOCKED = /object ?lock|retention|legal ?hold|WORM/i;

export async function deleteIds(s3: S3Client, bucket: string, ids: ObjectIdentifier[]): Promise<BulkResult> {
  const result: BulkResult = { done: 0, failed: [], truncated: false };
  let multi = true;
  for (let i = 0; i < ids.length; i += 1000) {
    const batch = ids.slice(i, i + 1000);
    if (multi) {
      try {
        const r = await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: batch, Quiet: true } }));
        const errors = r.Errors ?? [];
        // DeleteObjects reports denials per key in a 200 response. When nothing at all was
        // allowed, raise it as the denial it is, so that callers learn the capability.
        if (
          errors.length === batch.length &&
          result.done === 0 &&
          errors.every((e) => e.Code === 'AccessDenied' && !LOCKED.test(e.Message ?? ''))
        ) {
          throw new S3ServiceException({
            name: 'AccessDenied',
            $fault: 'client',
            $metadata: { httpStatusCode: 403 },
            message: errors[0]?.Message ?? 'Access Denied',
          });
        }
        for (const e of errors) {
          result.failed.push({ key: e.Key ?? '?', error: `${e.Code ?? 'Error'}: ${e.Message ?? ''}`.trim() });
        }
        result.done += batch.length - (r.Errors?.length ?? 0);
        continue;
      } catch (e) {
        const f = describe(e);
        if (f.denied || !NO_MULTI_DELETE.has(f.code)) throw e;
        // Some S3-compatible servers lack DeleteObjects or its checksum: one by one.
        multi = false;
      }
    }
    for (const id of batch) {
      try {
        await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: id.Key, VersionId: id.VersionId }));
        result.done++;
      } catch (e) {
        if (describe(e).denied && result.done === 0 && !result.failed.length) throw e;
        result.failed.push({ key: id.Key ?? '?', error: describe(e).message });
      }
    }
  }
  return result;
}

export interface TransferRequest {
  /** Source items and the destination of each: a key → a key, a prefix → a prefix. */
  pairs: { from: ItemRef; to: string }[];
  toBucket: string;
  move: boolean;
  overwrite: boolean;
  /** Where an earlier, truncated run stopped. */
  resume?: Resume | null;
}

/**
 * Copies or moves objects within one connection (server-side copies; no data passes through
 * ObjectLens). A move deletes each source after its copy succeeded.
 */
export async function transfer(
  s3: S3Client,
  bucket: string,
  req: TransferRequest,
  limit: number,
): Promise<BulkResult & { conflicts: string[]; resume: Resume | null }> {
  // At most `limit` objects per run. A copy leaves its sources in place, so a truncated run
  // returns where it stopped (`resume`) rather than starting over.
  const jobs: { from: string; to: string }[] = [];
  let resume: Resume | null = null;
  const first = req.resume?.pair ?? 0;
  outer: for (let i = first; i < req.pairs.length; i++) {
    const { from, to } = req.pairs[i]!;
    if (jobs.length >= limit) {
      resume = { pair: i, after: '' };
      break;
    }
    if ('key' in from) {
      jobs.push({ from: from.key, to });
      continue;
    }
    let last = i === first ? (req.resume?.after ?? '') : '';
    for await (const o of listAll(s3, bucket, from.prefix, last || undefined)) {
      if (jobs.length >= limit) {
        resume = { pair: i, after: last };
        break outer;
      }
      jobs.push({ from: o.key, to: rebase(o.key, from.prefix, to) });
      last = o.key;
    }
  }

  const result = {
    done: 0,
    failed: [] as BulkResult['failed'],
    truncated: resume !== null,
    conflicts: [] as string[],
    resume,
  };
  const same = jobs.filter((j) => j.from === j.to && req.toBucket === bucket);
  if (same.length) {
    return { ...result, failed: same.map((j) => ({ key: j.from, error: 'source and destination are the same' })) };
  }
  for (const j of jobs) {
    const err = keyError(j.to);
    if (err) result.failed.push({ key: j.from, error: err });
  }
  if (result.failed.length) return result;

  // Refuse to overwrite unless asked; checked up front so that nothing is half done.
  if (!req.overwrite) {
    await pool(jobs, 8, async (j) => {
      try {
        await s3.send(new HeadObjectCommand({ Bucket: req.toBucket, Key: j.to }));
        result.conflicts.push(j.to);
      } catch (e) {
        const f = describe(e);
        if (f.status !== 404 && f.code !== 'NotFound' && f.code !== 'NoSuchKey') throw e;
      }
    });
    if (result.conflicts.length) return result;
  }

  const moved: ObjectIdentifier[] = [];
  let denied: unknown = null;
  await pool(jobs, 8, async (j) => {
    if (denied) return;
    try {
      await copyObject(s3, { bucket, key: j.from }, { bucket: req.toBucket, key: j.to });
      result.done++;
      if (req.move) moved.push({ Key: j.from });
    } catch (e) {
      // The first denial ends the job: every other copy would fail the same way.
      if (describe(e).denied && result.done === 0) denied = e;
      else result.failed.push({ key: j.from, error: describe(e).message });
    }
  });
  if (denied) throw denied;
  if (moved.length) {
    const d = await deleteIds(s3, bucket, moved);
    result.failed.push(...d.failed.map((f) => ({ key: f.key, error: `copied, but not deleted: ${f.error}` })));
  }
  return result;
}

/** Runs `fn` over items with at most `n` in flight. */
export async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

/** Case-insensitive substring search in the key names below `prefix`. */
export async function search(s3: S3Client, bucket: string, prefix: string, query: string, scanLimit: number) {
  const q = query.toLowerCase();
  const objects: ObjectEntry[] = [];
  let scanned = 0;
  let truncated = false;
  for await (const o of listAll(s3, bucket, prefix)) {
    if (scanned >= scanLimit) {
      truncated = true;
      break;
    }
    scanned++;
    if (o.key.slice(prefix.length).toLowerCase().includes(q)) {
      objects.push(o);
      if (objects.length >= 1000) {
        truncated = true;
        break;
      }
    }
  }
  return { prefix, query, objects, scanned, truncated };
}

export async function folderSize(s3: S3Client, bucket: string, prefix: string, scanLimit: number) {
  let objects = 0;
  let bytes = 0;
  let truncated = false;
  for await (const o of listAll(s3, bucket, prefix)) {
    if (objects >= scanLimit) {
      truncated = true;
      break;
    }
    objects++;
    bytes += o.size;
  }
  return { prefix, objects, bytes, truncated };
}

/** The folder that decides the capability for an item: its own prefix or the key's folder. */
export const itemFolder = (item: ItemRef) => ('key' in item ? parentPrefix(item.key) : parentPrefix(item.prefix));
