// HTTP API and (in production) the static UI.
import { existsSync } from 'node:fs';
import { relative } from 'node:path';
import { Readable } from 'node:stream';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  GetObjectCommand,
  GetBucketVersioningCommand,
  GetObjectTaggingCommand,
  HeadObjectCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  PutBucketTaggingCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
  type PutObjectCommandInput,
  PutObjectTaggingCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { serveStatic } from '@hono/node-server/serve-static';
import { type Context, Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { bucketNameError, keyError, nameError, baseName, parentPrefix } from '../shared/keys.ts';
import type {
  AppInfo,
  BucketsResponse,
  CapKey,
  EditMetadataRequest,
  ItemRef,
  ListResponse,
  Resume,
  ShareLink,
  Tag,
  UploadResult,
  VersionEntry,
} from '../shared/types.ts';
import { CapabilityTracker } from './capabilities.ts';
import type { Config, ConnectionConfig } from './config.ts';
import { bucketDetails, inlineType, objectDetails } from './details.ts';
import { hostGuard, sameOriginGuard } from './guard.ts';
import { Kopia, KopiaError } from './kopia.ts';
import { Velero } from './velero.ts';
import { deleteIds, expand, folderSize, itemFolder, search, toEntry, transfer } from './ops.ts';
import { copyObject, createClient, describe, unquote } from './s3.ts';

type Env = { Variables: { conn: ConnectionConfig; s3: S3Client } };

/** An error with an HTTP status and a message meant for the user. */
export class HttpError extends Error {
  readonly status: 400 | 403 | 404 | 409;
  constructor(status: 400 | 403 | 404 | 409, message: string) {
    super(message);
    this.status = status;
  }
}

const bad = (message: string) => new HttpError(400, message);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

async function body(c: Context): Promise<Record<string, unknown>> {
  const b: unknown = await c.req.json().catch(() => null);
  if (!isObject(b)) throw bad('expected a JSON object');
  return b;
}

const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string') throw bad(`${name} must be a string`);
  return v;
};

/** Items of a bulk request; `{prefix: ""}` (the whole bucket) only where `wholeBucket` allows it. */
function items(v: unknown, wholeBucket = false): ItemRef[] {
  if (!Array.isArray(v) || !v.length) throw bad('items must be a non-empty list');
  return v.map((i): ItemRef => {
    if (isObject(i) && typeof i.key === 'string' && i.key) {
      return typeof i.versionId === 'string' && i.versionId ? { key: i.key, versionId: i.versionId } : { key: i.key };
    }
    if (isObject(i) && typeof i.prefix === 'string' && (i.prefix.endsWith('/') || (wholeBucket && i.prefix === ''))) {
      return { prefix: i.prefix };
    }
    throw bad('each item is {key} or {prefix} (ending in "/")');
  });
}

function tags(v: unknown): Tag[] {
  if (!Array.isArray(v)) throw bad('tags must be a list');
  const out = v.map((t) => {
    if (!isObject(t) || typeof t.key !== 'string' || typeof t.value !== 'string' || !t.key) {
      throw bad('each tag is {key, value} with a non-empty key');
    }
    return { key: t.key, value: t.value };
  });
  if (new Set(out.map((t) => t.key)).size !== out.length) throw bad('tag keys must be unique');
  return out;
}

const toS3Tags = (t: Tag[]) => t.map((x) => ({ Key: x.key, Value: x.value }));

/** RFC 6266 Content-Disposition with an ASCII fallback and the UTF-8 name. */
export function contentDisposition(type: 'inline' | 'attachment', name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

/**
 * Headers of a file download. Inline only for types the preview shows, and never as active
 * content: the response is sandboxed (no scripts, no same-origin access) and its type is fixed,
 * so an uploaded HTML or SVG file cannot run code in ObjectLens' origin.
 */
export function fileHeaders(name: string, inline: { kind: string; type: string } | null): Headers {
  const headers = new Headers({
    'content-type': inline?.type ?? 'application/octet-stream',
    'content-disposition': contentDisposition(inline ? 'inline' : 'attachment', name || 'download'),
    'x-content-type-options': 'nosniff',
    'cache-control': 'private, no-store',
  });
  // Chrome's PDF viewer does not run in a sandboxed document.
  if (inline?.kind !== 'pdf') {
    headers.set('content-security-policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'");
  }
  return headers;
}

/** Leaves user-supplied header values out when empty. */
const opt = <K extends string>(k: K, v: string | null | undefined) => (v ? ({ [k]: v } as Record<K, string>) : {});

export function createApp(cfg: Config): Hono<Env> {
  const app = new Hono<Env>();
  const caps = new CapabilityTracker(cfg.limits.capabilityTtlMinutes);
  const kopia = new Kopia(cfg.kopia);
  const velero = new Velero();
  const clients = new Map<string, S3Client>();
  const presigners = new Map<string, S3Client>();
  const client = (c: ConnectionConfig) => {
    let s3 = clients.get(c.id);
    if (!s3) clients.set(c.id, (s3 = createClient(c)));
    return s3;
  };
  const presigner = (c: ConnectionConfig) => {
    if (!c.publicEndpoint) return client(c);
    let s3 = presigners.get(c.id);
    if (!s3) presigners.set(c.id, (s3 = createClient(c, c.publicEndpoint)));
    return s3;
  };

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    if (err instanceof KopiaError) {
      const status = { 'not-installed': 501, locked: 423, 'bad-password': 400, 'not-found': 404, failed: 502 } as const;
      if (err.code === 'failed') console.error(`[${c.req.method} ${c.req.path}] kopia: ${err.message}`);
      return c.json({ error: err.message, code: `kopia-${err.code}` }, status[err.code]);
    }
    const f = describe(err);
    if (f.status >= 500 || f.code === 'Error') console.error(`[${c.req.method} ${c.req.path}]`, err);
    const status = f.denied ? 403 : f.status === 404 ? 404 : f.status >= 400 && f.status < 500 ? 400 : 502;
    return c.json({ error: f.code === f.message ? f.code : `${f.code}: ${f.message}`, code: f.code }, status);
  });

  app.use('*', hostGuard(cfg.http));
  // Downloads set their own, stricter policy (see the download route); the middleware runs
  // after the handler and would overwrite it.
  const downloadHeaders = secureHeaders({ crossOriginEmbedderPolicy: false });
  const pageHeaders = secureHeaders({
    crossOriginEmbedderPolicy: false,
    // Previews load media from our own API; blob: for text edited before upload.
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      mediaSrc: ["'self'", 'blob:'],
      frameSrc: ["'self'"],
      objectSrc: ["'none'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      connectSrc: ["'self'"],
      frameAncestors: ["'self'"],
      baseUri: ["'none'"],
      formAction: ["'none'"],
    },
  });
  app.use('*', (c, next) =>
    /\/(download|kopia\/file|velero\/(manifest|logs))$/.test(c.req.path)
      ? downloadHeaders(c, next)
      : pageHeaders(c, next),
  );
  app.use('/api/*', sameOriginGuard());

  app.get('/api/health', (c) => c.json({ ok: true }));

  app.get('/api/info', (c) =>
    c.json<AppInfo>({
      connections: cfg.connections.map((x) => ({
        id: x.id,
        name: x.name,
        endpoint: x.endpoint ? new URL(x.endpoint).host : 'AWS S3',
        region: x.region,
        readOnly: x.readOnly,
        shareLinks: x.shareLinks,
      })),
      limits: { bulk: cfg.limits.bulk, textBytes: cfg.limits.textBytes, shareMaxHours: cfg.limits.shareMaxHours },
    }),
  );

  // --- Connection-scoped routes ------------------------------------------------------

  const conns = new Map(cfg.connections.map((x) => [x.id, x]));
  app.use('/api/c/:conn/*', async (c, next) => {
    const conn = conns.get(c.req.param('conn') ?? '');
    if (!conn) return c.json({ error: 'unknown connection' }, 404);
    c.set('conn', conn);
    c.set('s3', client(conn));
    return next();
  });

  /** Refuses writes through read-only connections before S3 is asked. */
  const writable = (c: Context<Env>) => {
    if (c.get('conn').readOnly) throw new HttpError(403, 'this connection is read-only');
  };
  const track = <T>(c: Context<Env>, prefix: string, cap: CapKey, fn: () => Promise<T>) =>
    caps.track(c.get('conn').id, c.req.param('bucket') ?? '', prefix, cap, fn);
  /** Why a folder's objects must not be changed: a kopia repository or Velero's backup folders. */
  const protectedReason = async (c: Context<Env>, folder: string): Promise<string | null> => {
    const [s3, id, bucket] = [c.get('s3'), c.get('conn').id, c.req.param('bucket') ?? ''];
    if (await kopia.isRepository(s3, id, bucket, folder)) {
      return 'This folder holds a kopia repository: changing its objects would corrupt the backups.';
    }
    if (await velero.isManaged(s3, id, bucket, folder).catch(() => false)) {
      return 'This folder belongs to a Velero backup location: Velero keeps its backups here (delete them with velero).';
    }
    return null;
  };
  /**
   * Refuses changes inside a kopia repository (a deleted, renamed or overwritten blob corrupts
   * the backups) and in a Velero location's backups/ folders. Deleting the whole folder from its
   * parent is left possible, for repositories that are really no longer wanted.
   */
  const notInKopia = async (c: Context<Env>, folders: string[]) => {
    for (const f of new Set(folders)) {
      const why = await protectedReason(c, f);
      if (why) throw new HttpError(403, `"${f || '/'}": ${why}`);
    }
  };
  const audit = (c: Context<Env>, what: string) =>
    console.log(`[write] ${c.get('conn').id}/${c.req.param('bucket') ?? ''}: ${what}`);

  app.get('/api/c/:conn/buckets', async (c) => {
    const conn = c.get('conn');
    const fromConfig = conn.buckets.map((name) => ({ name, createdAt: null }));
    const res: BucketsResponse = {
      buckets: fromConfig,
      source: 'config',
      error: null,
      canCreate: caps.canCreateBucket(conn),
    };
    if (conn.listBuckets) {
      try {
        const r = await c.get('s3').send(new ListBucketsCommand({}));
        const listed = (r.Buckets ?? []).map((b) => ({
          name: b.Name ?? '',
          createdAt: b.CreationDate?.toISOString() ?? null,
        }));
        // Configured buckets the credentials cannot list (e.g. another account's) are kept.
        const names = new Set(listed.map((b) => b.name));
        res.buckets = [...listed, ...fromConfig.filter((b) => !names.has(b.name))];
        res.source = 'list';
      } catch (e) {
        const f = describe(e);
        res.error = f.denied
          ? 'These credentials may not list buckets (s3:ListAllMyBuckets). Name the buckets in BUCKETS.'
          : `Listing buckets failed: ${f.message}`;
        if (!fromConfig.length && !f.denied) throw e;
      }
    }
    res.buckets.sort((a, b) => a.name.localeCompare(b.name));
    return c.json(res);
  });

  app.post('/api/c/:conn/buckets', async (c) => {
    writable(c);
    const b = await body(c);
    const name = str(b.name, 'name');
    const err = bucketNameError(name);
    if (err) throw bad(err);
    const conn = c.get('conn');
    const region = typeof b.region === 'string' && b.region ? b.region : conn.region;
    try {
      await c.get('s3').send(
        new CreateBucketCommand({
          Bucket: name,
          // us-east-1 must not be named as a location constraint.
          ...(region !== 'us-east-1' ? { CreateBucketConfiguration: { LocationConstraint: region as never } } : {}),
          ...(b.objectLock === true ? { ObjectLockEnabledForBucket: true } : {}),
        }),
      );
      caps.recordCreateBucket(conn, 'ok');
    } catch (e) {
      caps.recordCreateBucket(conn, e);
      throw e;
    }
    audit(c, `create bucket ${name} (${region})`);
    return c.json({ ok: true }, 201);
  });

  app.delete('/api/c/:conn/buckets/:bucket', async (c) => {
    writable(c);
    const bucket = c.req.param('bucket');
    await track(c, '', 'bucketConfig', () => c.get('s3').send(new DeleteBucketCommand({ Bucket: bucket })));
    caps.forget(c.get('conn').id, bucket);
    audit(c, 'delete bucket');
    return c.json({ ok: true });
  });

  // --- Bucket ---------------------------------------------------------------------------

  app.get('/api/c/:conn/b/:bucket/details', async (c) =>
    c.json(await bucketDetails(c.get('s3'), c.req.param('bucket'))),
  );

  app.get('/api/c/:conn/b/:bucket/capabilities', async (c) => {
    const prefix = c.req.query('prefix') ?? '';
    const bucket = c.req.param('bucket');
    const [result, why] = await Promise.all([
      caps.get(c.get('conn'), c.get('s3'), bucket, prefix),
      protectedReason(c, prefix).catch(() => null),
    ]);
    if (why) {
      const no = { allowed: false, reason: why };
      return c.json({ ...result, write: no, delete: no, tags: no });
    }
    return c.json(result);
  });

  /** "Enabled", "Suspended", null (never enabled) — or unknown when it may not be read. */
  app.get('/api/c/:conn/b/:bucket/versioning', async (c) => {
    try {
      const r = await c.get('s3').send(new GetBucketVersioningCommand({ Bucket: c.req.param('bucket') }));
      return c.json({ status: r.Status ?? null, known: true });
    } catch (e) {
      if (!describe(e).denied && describe(e).code !== 'NotImplemented') throw e;
      return c.json({ status: null, known: false });
    }
  });

  app.put('/api/c/:conn/b/:bucket/versioning', async (c) => {
    writable(c);
    const b = await body(c);
    if (typeof b.enabled !== 'boolean') throw bad('enabled must be true or false');
    const Bucket = c.req.param('bucket');
    await track(c, '', 'bucketConfig', () =>
      c.get('s3').send(
        new PutBucketVersioningCommand({
          Bucket,
          VersioningConfiguration: { Status: b.enabled ? 'Enabled' : 'Suspended' },
        }),
      ),
    );
    // The delete probe depends on the versioning state.
    caps.forget(c.get('conn').id, Bucket);
    audit(c, `versioning ${b.enabled ? 'enabled' : 'suspended'}`);
    return c.json({ ok: true });
  });

  app.put('/api/c/:conn/b/:bucket/tags', async (c) => {
    writable(c);
    const t = tags((await body(c)).tags);
    await track(c, '', 'bucketConfig', () =>
      c
        .get('s3')
        .send(new PutBucketTaggingCommand({ Bucket: c.req.param('bucket'), Tagging: { TagSet: toS3Tags(t) } })),
    );
    audit(c, `bucket tags (${t.length})`);
    return c.json({ ok: true });
  });

  // --- Listing ---------------------------------------------------------------------------

  app.get('/api/c/:conn/b/:bucket/list', async (c) => {
    const prefix = c.req.query('prefix') ?? '';
    const token = c.req.query('token');
    const r = await track(c, prefix, 'list', () =>
      c.get('s3').send(
        new ListObjectsV2Command({
          Bucket: c.req.param('bucket'),
          Prefix: prefix,
          Delimiter: '/',
          MaxKeys: 1000,
          ...(token ? { ContinuationToken: token } : {}),
        }),
      ),
    );
    return c.json<ListResponse>({
      prefix,
      folders: (r.CommonPrefixes ?? []).map((p) => p.Prefix ?? '').filter(Boolean),
      // The folder's own marker object ("prefix/") is the folder itself, not an entry in it.
      objects: (r.Contents ?? []).filter((o) => o.Key !== prefix).map(toEntry),
      nextToken: r.IsTruncated ? (r.NextContinuationToken ?? null) : null,
    });
  });

  app.get('/api/c/:conn/b/:bucket/search', async (c) => {
    const prefix = c.req.query('prefix') ?? '';
    const q = (c.req.query('q') ?? '').trim();
    if (!q) throw bad('q is required');
    return c.json(
      await track(c, prefix, 'list', () =>
        search(c.get('s3'), c.req.param('bucket'), prefix, q, cfg.limits.searchScan),
      ),
    );
  });

  app.get('/api/c/:conn/b/:bucket/size', async (c) => {
    const prefix = c.req.query('prefix') ?? '';
    return c.json(
      await track(c, prefix, 'list', () =>
        folderSize(c.get('s3'), c.req.param('bucket'), prefix, cfg.limits.searchScan),
      ),
    );
  });

  app.get('/api/c/:conn/b/:bucket/versions', async (c) => {
    const key = str(c.req.query('key'), 'key');
    const Bucket = c.req.param('bucket');
    const out: VersionEntry[] = [];
    let keyMarker: string | undefined;
    let versionMarker: string | undefined;
    // Versions of one key: listed by prefix, so later keys ("a.txt.bak") end the scan.
    do {
      const r = await track(c, parentPrefix(key), 'versions', () =>
        c.get('s3').send(
          new ListObjectVersionsCommand({
            Bucket,
            Prefix: key,
            ...(keyMarker ? { KeyMarker: keyMarker } : {}),
            ...(versionMarker ? { VersionIdMarker: versionMarker } : {}),
          }),
        ),
      );
      for (const v of r.Versions ?? []) {
        if (v.Key !== key) continue;
        out.push({
          key,
          versionId: v.VersionId ?? 'null',
          isLatest: v.IsLatest ?? false,
          isDeleteMarker: false,
          size: v.Size ?? null,
          lastModified: v.LastModified?.toISOString() ?? null,
          etag: unquote(v.ETag),
          storageClass: v.StorageClass ?? null,
        });
      }
      for (const m of r.DeleteMarkers ?? []) {
        if (m.Key !== key) continue;
        out.push({
          key,
          versionId: m.VersionId ?? 'null',
          isLatest: m.IsLatest ?? false,
          isDeleteMarker: true,
          size: null,
          lastModified: m.LastModified?.toISOString() ?? null,
          etag: null,
          storageClass: null,
        });
      }
      const past = (r.Versions ?? []).some((v) => v.Key && v.Key > key);
      keyMarker = r.IsTruncated && !past && out.length < 10_000 ? r.NextKeyMarker : undefined;
      versionMarker = keyMarker ? r.NextVersionIdMarker : undefined;
    } while (keyMarker);
    out.sort((a, b) => (b.lastModified ?? '').localeCompare(a.lastModified ?? ''));
    return c.json(out);
  });

  // --- Objects -----------------------------------------------------------------------

  app.get('/api/c/:conn/b/:bucket/object', async (c) => {
    const key = str(c.req.query('key'), 'key');
    return c.json(
      await track(c, parentPrefix(key), 'read', () =>
        objectDetails(c.get('s3'), c.req.param('bucket'), key, c.req.query('versionId') || null, cfg.limits.textBytes),
      ),
    );
  });

  app.get('/api/c/:conn/b/:bucket/download', async (c) => {
    const key = str(c.req.query('key'), 'key');
    const versionId = c.req.query('versionId');
    const range = c.req.header('range');
    const r = await track(c, parentPrefix(key), 'read', () =>
      c.get('s3').send(
        new GetObjectCommand({
          Bucket: c.req.param('bucket'),
          Key: key,
          ...(versionId ? { VersionId: versionId } : {}),
          ...(range ? { Range: range } : {}),
        }),
        { abortSignal: c.req.raw.signal },
      ),
    );
    const headers = fileHeaders(
      baseName(key),
      c.req.query('inline') === '1' ? inlineType(key, r.ContentType ?? null) : null,
    );
    headers.set('accept-ranges', 'bytes');
    if (r.ContentLength !== undefined) headers.set('content-length', String(r.ContentLength));
    if (r.ContentRange) headers.set('content-range', r.ContentRange);
    if (r.ETag) headers.set('etag', r.ETag);
    if (r.LastModified) headers.set('last-modified', r.LastModified.toUTCString());
    const stream = Readable.toWeb(r.Body as Readable) as ReadableStream;
    return new Response(stream, { status: r.ContentRange ? 206 : 200, headers });
  });

  app.put('/api/c/:conn/b/:bucket/upload', async (c) => {
    writable(c);
    const key = str(c.req.query('key'), 'key');
    const err = keyError(key);
    if (err) throw bad(err);
    await notInKopia(c, [parentPrefix(key)]);
    const Bucket = c.req.param('bucket');
    const s3 = c.get('s3');
    if (c.req.query('overwrite') !== '1') {
      const exists = await s3.send(new HeadObjectCommand({ Bucket, Key: key })).then(
        () => true,
        (e) => {
          const f = describe(e);
          // Write-only credentials cannot look: upload without the check.
          if (f.status === 404 || f.denied) return false;
          throw e;
        },
      );
      if (exists) throw new HttpError(409, `"${key}" already exists`);
    }
    const size = Number(c.req.header('x-objectlens-size') ?? NaN);
    // S3 allows 10,000 parts: grow the part size for very large files.
    const partSize = Math.max(8 * 1024 ** 2, Number.isFinite(size) ? Math.ceil(size / 9_000) : 0);
    let contentType = c.req.header('content-type') || 'application/octet-stream';
    // keep=1 (saving an edited file): a new upload would drop the metadata and tags, so carry
    // the existing object's over.
    let kept: Partial<PutObjectCommandInput> = {};
    if (c.req.query('keep') === '1') {
      const [head, tagging] = await Promise.all([
        s3.send(new HeadObjectCommand({ Bucket, Key: key })).catch(() => null),
        s3.send(new GetObjectTaggingCommand({ Bucket, Key: key })).catch(() => null),
      ]);
      if (head) {
        contentType = head.ContentType ?? contentType;
        kept = {
          ...opt('CacheControl', head.CacheControl),
          ...opt('ContentDisposition', head.ContentDisposition),
          ...opt('ContentEncoding', head.ContentEncoding),
          ...opt('ContentLanguage', head.ContentLanguage),
          ...opt('WebsiteRedirectLocation', head.WebsiteRedirectLocation),
          ...(head.Expires ? { Expires: head.Expires } : {}),
          ...(head.StorageClass ? { StorageClass: head.StorageClass } : {}),
          ...(head.ServerSideEncryption ? { ServerSideEncryption: head.ServerSideEncryption } : {}),
          ...opt('SSEKMSKeyId', head.SSEKMSKeyId),
          Metadata: head.Metadata ?? {},
        };
      }
      if (tagging?.TagSet?.length) {
        kept.Tagging = new URLSearchParams(tagging.TagSet.map((t) => [t.Key ?? '', t.Value ?? ''])).toString();
      }
    }
    const raw = c.req.raw.body;
    const upload = new Upload({
      client: s3,
      params: {
        ...kept,
        Bucket,
        Key: key,
        Body: raw ? Readable.fromWeb(raw as never) : '',
        ContentType: contentType,
      },
      partSize,
      queueSize: 4,
      leavePartsOnError: false,
    });
    const onAbort = () => void upload.abort().catch(() => {});
    c.req.raw.signal.addEventListener('abort', onAbort);
    try {
      const out = await track(c, parentPrefix(key), 'write', () => upload.done());
      audit(c, `upload ${key}${Number.isFinite(size) ? ` (${size} bytes)` : ''}`);
      return c.json<UploadResult>({
        key,
        etag: unquote(out.ETag),
        versionId: 'VersionId' in out ? (out.VersionId ?? null) : null,
      });
    } finally {
      c.req.raw.signal.removeEventListener('abort', onAbort);
    }
  });

  app.post('/api/c/:conn/b/:bucket/folder', async (c) => {
    writable(c);
    const b = await body(c);
    const parent = str(b.prefix ?? '', 'prefix');
    const name = str(b.name, 'name');
    const nerr = nameError(name);
    if (nerr) throw bad(nerr);
    const key = `${parent}${name}/`;
    const kerr = keyError(key);
    if (kerr) throw bad(kerr);
    await notInKopia(c, [parent]);
    await track(c, parent, 'write', () =>
      c.get('s3').send(new PutObjectCommand({ Bucket: c.req.param('bucket'), Key: key, Body: '' })),
    );
    audit(c, `create folder ${key}`);
    return c.json({ key }, 201);
  });

  app.post('/api/c/:conn/b/:bucket/delete', async (c) => {
    writable(c);
    const b = await body(c);
    // {prefix: ""} empties the whole bucket.
    const list = items(b.items, true);
    const allVersions = b.allVersions === true;
    await notInKopia(c, list.map(itemFolder));
    const s3 = c.get('s3');
    const Bucket = c.req.param('bucket');
    // Listing what to delete is not deleting: only the deletes teach the capability.
    const { ids, truncated } = await expand(s3, Bucket, list, cfg.limits.bulk, allVersions);
    const r = { ...(await track(c, itemFolder(list[0]!), 'delete', () => deleteIds(s3, Bucket, ids))), truncated };
    audit(c, `delete ${list.length} item(s)${allVersions ? ' with all versions' : ''}: ${r.done} object(s)`);
    return c.json(r);
  });

  /**
   * Copy or move: items keep their names below `toPrefix` (in `toBucket`, default this bucket).
   * Rename is a move of one item with `newName`.
   */
  app.post('/api/c/:conn/b/:bucket/transfer', async (c) => {
    writable(c);
    const b = await body(c);
    const bucket = c.req.param('bucket');
    const list = items(b.items);
    const move = b.move === true;
    const toBucket = typeof b.toBucket === 'string' && b.toBucket ? b.toBucket : bucket;
    let pairs: { from: ItemRef; to: string }[];
    if (typeof b.newName === 'string') {
      const nerr = nameError(b.newName);
      if (nerr) throw bad(nerr);
      if (list.length !== 1) throw bad('rename takes one item');
      const it = list[0]!;
      const parent = itemFolder(it);
      pairs = [{ from: it, to: 'key' in it ? parent + b.newName : `${parent}${b.newName}/` }];
    } else {
      const toPrefix = str(b.toPrefix ?? '', 'toPrefix');
      if (toPrefix && !toPrefix.endsWith('/')) throw bad('toPrefix must end with "/"');
      pairs = list.map((it) => ({
        from: it,
        to: 'key' in it ? toPrefix + baseName(it.key) : `${toPrefix}${baseName(it.prefix)}/`,
      }));
      for (const p of pairs) {
        if ('prefix' in p.from && toBucket === bucket && p.to.startsWith(p.from.prefix)) {
          throw bad(`cannot put "${p.from.prefix}" inside itself`);
        }
      }
    }
    // A copy out of a repository is fine; a move would delete its blobs.
    await notInKopia(c, [...pairs.map((p) => parentPrefix(p.to)), ...(move ? list.map(itemFolder) : [])]);
    let resume: Resume | null = null;
    if (isObject(b.resume)) {
      const { pair, after } = b.resume;
      if (!Number.isInteger(pair) || (pair as number) < 0 || typeof after !== 'string') throw bad('invalid resume');
      resume = { pair: pair as number, after };
    }
    const r = await transfer(
      c.get('s3'),
      bucket,
      { pairs, toBucket, move, overwrite: b.overwrite === true, resume },
      cfg.limits.bulk,
    );
    // A denied copy may be the source's read or the destination's write (S3 does not say
    // which), so only success is recorded.
    if (r.done > 0) caps.record(c.get('conn').id, toBucket, parentPrefix(pairs[0]!.to), 'write', 'ok');
    if (r.conflicts.length) return c.json(r, 409);
    audit(c, `${move ? 'move' : 'copy'} ${list.length} item(s) to ${toBucket}: ${r.done} object(s)`);
    return c.json(r);
  });

  app.put('/api/c/:conn/b/:bucket/metadata', async (c) => {
    writable(c);
    const b = (await body(c)) as unknown as EditMetadataRequest;
    const key = str(b.key, 'key');
    await notInKopia(c, [parentPrefix(key)]);
    if (!isObject(b.system) || !isObject(b.metadata)) throw bad('system and metadata are required');
    const metadata: Record<string, string> = {};
    for (const [k, v] of Object.entries(b.metadata)) {
      if (typeof v !== 'string') throw bad('metadata values must be strings');
      // HTTP header names: S3 lowercases them and refuses other characters.
      if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/i.test(k)) throw bad(`"${k}" is not a valid metadata name`);
      if (/[^\x20-\x7e]/.test(v)) throw bad(`metadata "${k}": use printable ASCII (S3 headers are ASCII)`);
      metadata[k.toLowerCase()] = v;
    }
    const s = b.system;
    const Bucket = c.req.param('bucket');
    const expires = s.expires ? new Date(s.expires) : null;
    if (expires && Number.isNaN(expires.getTime())) throw bad('expires is not a valid date');
    const r = await track(c, parentPrefix(key), 'write', () =>
      copyObject(
        c.get('s3'),
        { bucket: Bucket, key },
        { bucket: Bucket, key },
        {
          replace: {
            ContentType: s.contentType || 'application/octet-stream',
            ...opt('CacheControl', s.cacheControl),
            ...opt('ContentDisposition', s.contentDisposition),
            ...opt('ContentEncoding', s.contentEncoding),
            ...opt('ContentLanguage', s.contentLanguage),
            ...opt('WebsiteRedirectLocation', s.websiteRedirectLocation),
            ...(expires ? { Expires: expires } : {}),
            Metadata: metadata,
          },
          ...(typeof b.storageClass === 'string' && b.storageClass ? { storageClass: b.storageClass } : {}),
        },
      ),
    );
    audit(c, `metadata of ${key}`);
    return c.json(r);
  });

  app.put('/api/c/:conn/b/:bucket/object-tags', async (c) => {
    writable(c);
    const b = await body(c);
    const key = str(b.key, 'key');
    await notInKopia(c, [parentPrefix(key)]);
    const t = tags(b.tags);
    if (t.length > 10) throw bad('S3 allows at most 10 tags per object');
    await track(c, parentPrefix(key), 'tags', () =>
      c.get('s3').send(
        new PutObjectTaggingCommand({
          Bucket: c.req.param('bucket'),
          Key: key,
          ...(typeof b.versionId === 'string' && b.versionId ? { VersionId: b.versionId } : {}),
          Tagging: { TagSet: toS3Tags(t) },
        }),
      ),
    );
    audit(c, `tags of ${key} (${t.length})`);
    return c.json({ ok: true });
  });

  /** Makes an older version the current one again, by copying it over the key. */
  app.post('/api/c/:conn/b/:bucket/restore-version', async (c) => {
    writable(c);
    const b = await body(c);
    const key = str(b.key, 'key');
    await notInKopia(c, [parentPrefix(key)]);
    const versionId = str(b.versionId, 'versionId');
    const Bucket = c.req.param('bucket');
    const r = await track(c, parentPrefix(key), 'write', () =>
      copyObject(c.get('s3'), { bucket: Bucket, key }, { bucket: Bucket, key }, { sourceVersionId: versionId }),
    );
    audit(c, `restore ${key} version ${versionId}`);
    return c.json(r);
  });

  app.post('/api/c/:conn/b/:bucket/share', async (c) => {
    const conn = c.get('conn');
    if (!conn.shareLinks) throw new HttpError(403, 'share links are switched off for this connection');
    const b = await body(c);
    const key = str(b.key, 'key');
    const hours = Number(b.hours);
    if (!Number.isFinite(hours) || hours <= 0 || hours > cfg.limits.shareMaxHours) {
      throw bad(`hours must be between 0 and ${cfg.limits.shareMaxHours}`);
    }
    const seconds = Math.round(hours * 3600);
    // Signing is local: whether the link works is only known when it is used.
    const url = await getSignedUrl(
      presigner(conn),
      new GetObjectCommand({
        Bucket: c.req.param('bucket'),
        Key: key,
        ...(typeof b.versionId === 'string' && b.versionId ? { VersionId: b.versionId } : {}),
      }),
      { expiresIn: seconds },
    );
    return c.json<ShareLink>({ url, expiresAt: new Date(Date.now() + seconds * 1000).toISOString() });
  });

  // --- kopia repositories (read-only) ---------------------------------------------------
  // `prefix` is the folder holding the repository's kopia.repository blob.

  const kopiaRepo = async (c: Context<Env>, prefix: string) => {
    if (prefix && !prefix.endsWith('/')) throw bad('prefix must be empty or end with "/"');
    const [s3, conn, bucket] = [c.get('s3'), c.get('conn'), c.req.param('bucket') ?? ''];
    if (!(await kopia.isRepository(s3, conn.id, bucket, prefix))) {
      throw new HttpError(404, 'no kopia repository in this folder');
    }
    // Velero's repositories have their own password (S3_n_VELERO_PASSWORD, else Velero's default).
    kopia.markVelero(
      conn,
      bucket,
      prefix,
      await velero.isVeleroRepository(s3, conn.id, bucket, prefix).catch(() => false),
    );
    return [conn, bucket, prefix] as const;
  };

  /** Whether the folder holds a kopia repository (one HEAD request; never runs kopia). */
  app.get('/api/c/:conn/b/:bucket/kopia/detect', async (c) => {
    const prefix = c.req.query('prefix') ?? '';
    const repository = await kopia
      .isRepository(c.get('s3'), c.get('conn').id, c.req.param('bucket'), prefix)
      .catch(() => false);
    return c.json({ repository });
  });

  app.get('/api/c/:conn/b/:bucket/kopia/status', async (c) =>
    c.json(await kopia.status(...(await kopiaRepo(c, c.req.query('prefix') ?? '')))),
  );

  app.post('/api/c/:conn/b/:bucket/kopia/unlock', async (c) => {
    const b = await body(c);
    const password = str(b.password, 'password');
    if (!password) throw bad('the password is empty');
    await kopia.unlock(...(await kopiaRepo(c, str(b.prefix ?? '', 'prefix'))), password);
    return c.json({ ok: true });
  });

  app.post('/api/c/:conn/b/:bucket/kopia/lock', async (c) => {
    const b = await body(c);
    await kopia.lock(...(await kopiaRepo(c, str(b.prefix ?? '', 'prefix'))));
    return c.json({ ok: true });
  });

  app.get('/api/c/:conn/b/:bucket/kopia/snapshots', async (c) =>
    c.json(await kopia.snapshots(...(await kopiaRepo(c, c.req.query('prefix') ?? '')), c.req.query('fresh') === '1')),
  );

  app.get('/api/c/:conn/b/:bucket/kopia/browse', async (c) =>
    c.json(
      await kopia.browse(
        ...(await kopiaRepo(c, c.req.query('prefix') ?? '')),
        str(c.req.query('snapshot'), 'snapshot'),
        c.req.query('path') ?? '',
      ),
    ),
  );

  app.get('/api/c/:conn/b/:bucket/kopia/file', async (c) => {
    const path = str(c.req.query('path'), 'path');
    const { entry, stream } = await kopia.open(
      ...(await kopiaRepo(c, c.req.query('prefix') ?? '')),
      str(c.req.query('snapshot'), 'snapshot'),
      path,
      c.req.raw.signal,
    );
    // Content types are not stored in a snapshot: chosen from the name, as for previews.
    const headers = fileHeaders(entry.name, c.req.query('inline') === '1' ? inlineType(entry.name, null) : null);
    if (entry.size !== null) headers.set('content-length', String(entry.size));
    if (entry.mtime) headers.set('last-modified', new Date(entry.mtime).toUTCString());
    return new Response(Readable.toWeb(stream) as ReadableStream, { headers });
  });

  // --- Velero backup locations (read-only) -----------------------------------------------
  // `prefix` is the location's folder (holding backups/ and kopia/).

  const veleroLocation = async (c: Context<Env>, prefix: string) => {
    if (prefix && !prefix.endsWith('/')) throw bad('prefix must be empty or end with "/"');
    const [s3, id, bucket] = [c.get('s3'), c.get('conn').id, c.req.param('bucket') ?? ''];
    if (!(await velero.isLocation(s3, id, bucket, prefix))) throw new HttpError(404, 'no Velero backup location here');
    return { s3, id, bucket, prefix };
  };

  /** Whether the folder is a Velero backup location (two requests; cached). */
  app.get('/api/c/:conn/b/:bucket/velero/detect', async (c) => {
    const location = await velero
      .isLocation(c.get('s3'), c.get('conn').id, c.req.param('bucket'), c.req.query('prefix') ?? '')
      .catch(() => false);
    return c.json({ location });
  });

  app.get('/api/c/:conn/b/:bucket/velero/backups', async (c) => {
    const l = await veleroLocation(c, c.req.query('prefix') ?? '');
    return c.json(await velero.backups(l.s3, l.id, l.bucket, l.prefix, c.req.query('fresh') === '1'));
  });

  app.get('/api/c/:conn/b/:bucket/velero/backup', async (c) => {
    const l = await veleroLocation(c, c.req.query('prefix') ?? '');
    const d = await velero.backup(l.s3, l.bucket, l.prefix, str(c.req.query('name'), 'name'));
    return d ? c.json(d) : c.json({ error: 'no such backup' }, 404);
  });

  /** Text views (a manifest of the tarball, the log): sandboxed plain text, as previews are. */
  const textResponse = (name: string, text: string) => {
    const headers = fileHeaders(name, { kind: 'text', type: 'text/plain; charset=utf-8' });
    return new Response(text, { headers });
  };

  app.get('/api/c/:conn/b/:bucket/velero/manifest', async (c) => {
    const l = await veleroLocation(c, c.req.query('prefix') ?? '');
    const path = str(c.req.query('path'), 'path');
    const text = await velero.manifest(l.s3, l.bucket, l.prefix, str(c.req.query('name'), 'name'), path);
    return text === null ? c.json({ error: 'no such manifest' }, 404) : textResponse(baseName(path), text);
  });

  app.get('/api/c/:conn/b/:bucket/velero/logs', async (c) => {
    const l = await veleroLocation(c, c.req.query('prefix') ?? '');
    const name = str(c.req.query('name'), 'name');
    const text = await velero.logs(l.s3, l.bucket, l.prefix, name);
    return text === null ? c.json({ error: 'no log for this backup' }, 404) : textResponse(`${name}.log`, text);
  });

  app.all('/api/*', (c) => c.json({ error: 'not found' }, 404));

  if (existsSync(cfg.staticDir)) {
    // serveStatic resolves paths relative to the working directory.
    const root = relative(process.cwd(), cfg.staticDir) || '.';
    app.use('/*', serveStatic({ root }));
    app.get('*', serveStatic({ root, path: 'index.html' }));
  } else {
    app.get('/', (c) =>
      c.text('UI not built. Run "npm run build", or use "npm run dev" and open the Vite dev server.', 404),
    );
  }

  return app;
}
