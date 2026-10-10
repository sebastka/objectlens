// What the credentials of a connection may do in a bucket and prefix.
//
// S3 cannot be asked "what may I do?" (IAM policy simulation is AWS-only and needs extra
// permissions), so each capability is known from one of:
//   - the connection's READ_ONLY setting (never write);
//   - a probe that has no side effect (see probe());
//   - the outcome of the last real request of that kind (learned), which wins over a probe.
// Unknown capabilities are null: the UI keeps the action enabled and a denial is learned.
import { randomUUID } from 'node:crypto';
import {
  DeleteObjectCommand,
  GetBucketVersioningCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  PutObjectCommand,
  PutObjectTaggingCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { type CapKey, CAP_KEYS, type Capabilities, type Capability } from '../shared/types.ts';
import type { ConnectionConfig } from './config.ts';
import { describe } from './s3.ts';

/** Probe keys: never created (see probe()), but recognisable should a server misbehave. */
export const PROBE_PREFIX = '.objectlens-probe-';

/** MD5 of the empty string: cannot match the one-byte body the write probe sends ("x"). */
const WRONG_MD5 = '1B2M2Y8AsgTpgAmY7PhCfg==';

/** Capabilities that belong to the bucket rather than to a prefix. */
const BUCKET_LEVEL: ReadonlySet<CapKey> = new Set(['bucketConfig']);
const WRITE_CAPS: readonly CapKey[] = ['write', 'delete', 'tags', 'bucketConfig'];

const unknown = (reason: string | null = null): Capability => ({ allowed: null, reason });
const time = () => new Date().toISOString().slice(11, 16);

interface Entry {
  cap: Capability;
  at: number;
}

type ProbeResult = Partial<Record<CapKey, Capability>>;

export class CapabilityTracker {
  private readonly ttlMs: number;
  private readonly learned = new Map<string, Entry>();
  private readonly probes = new Map<string, { at: number; result: Promise<ProbeResult> }>();

  constructor(ttlMinutes: number) {
    this.ttlMs = ttlMinutes * 60_000;
  }

  private key(conn: string, bucket: string, prefix: string, cap: CapKey) {
    return `${conn}\u0000${bucket}\u0000${BUCKET_LEVEL.has(cap) ? '' : prefix}\u0000${cap}`;
  }

  /** Records the outcome of a real request. Errors other than denials teach nothing. */
  record(conn: string, bucket: string, prefix: string, cap: CapKey, outcome: 'ok' | unknown): void {
    const k = this.key(conn, bucket, prefix, cap);
    if (outcome === 'ok') {
      this.learned.set(k, { cap: { allowed: true, reason: `Worked at ${time()} UTC` }, at: Date.now() });
      return;
    }
    const f = describe(outcome);
    if (f.denied) {
      this.learned.set(k, {
        cap: { allowed: false, reason: `Denied by S3 at ${time()} UTC (${f.code})` },
        at: Date.now(),
      });
    }
  }

  /** Runs `fn` and records whether the credentials were allowed to. */
  async track<T>(conn: string, bucket: string, prefix: string, cap: CapKey, fn: () => Promise<T>): Promise<T> {
    try {
      const r = await fn();
      this.record(conn, bucket, prefix, cap, 'ok');
      return r;
    } catch (e) {
      this.record(conn, bucket, prefix, cap, e);
      throw e;
    }
  }

  /** Forgets probes and learned outcomes of a bucket (after its configuration changed). */
  forget(conn: string, bucket: string): void {
    const p = `${conn}\u0000${bucket}\u0000`;
    for (const k of [...this.learned.keys()]) if (k.startsWith(p)) this.learned.delete(k);
    for (const k of [...this.probes.keys()]) if (k.startsWith(p)) this.probes.delete(k);
  }

  async get(c: ConnectionConfig, s3: S3Client, bucket: string, prefix: string): Promise<Capabilities> {
    const pk = `${c.id}\u0000${bucket}\u0000${prefix}`;
    let probe = this.probes.get(pk);
    if (!probe || Date.now() - probe.at > this.ttlMs) {
      probe = { at: Date.now(), result: probeCapabilities(c, s3, bucket, prefix).catch(() => ({})) };
      this.probes.set(pk, probe);
    }
    const probed = await probe.result;
    const out = {} as Capabilities;
    for (const cap of CAP_KEYS) {
      if (c.readOnly && WRITE_CAPS.includes(cap)) {
        out[cap] = { allowed: false, reason: 'This connection is read-only (READ_ONLY).' };
        continue;
      }
      const l = this.learned.get(this.key(c.id, bucket, prefix, cap));
      out[cap] = l && Date.now() - l.at <= this.ttlMs ? l.cap : (probed[cap] ?? unknown());
    }
    return out;
  }

  /** Whether creating buckets is allowed, as far as known (connection level). */
  canCreateBucket(c: ConnectionConfig): Capability {
    if (c.readOnly) return { allowed: false, reason: 'This connection is read-only (READ_ONLY).' };
    const l = this.learned.get(this.key(c.id, '', '', 'bucketConfig'));
    return l && Date.now() - l.at <= this.ttlMs ? l.cap : unknown();
  }

  recordCreateBucket(c: ConnectionConfig, outcome: 'ok' | unknown): void {
    this.record(c.id, '', '', 'bucketConfig', outcome);
  }
}

/** Maps a probe's outcome: `allowedCodes` are errors that S3 only returns after authorising. */
function verdict(e: unknown, allowedCodes: string[], what: string): Capability {
  const f = describe(e);
  if (f.denied) return { allowed: false, reason: `Denied by S3 (${f.code}); found by a ${what} probe` };
  if (allowedCodes.includes(f.code)) return { allowed: true, reason: `Allowed; found by a ${what} probe` };
  return unknown(`The ${what} probe was inconclusive (${f.code})`);
}

/**
 * The probes. None of them changes anything in the bucket:
 *   - list:     ListObjectsV2 with MaxKeys=1;
 *   - read:     HeadObject of the first object found (unknown in an empty folder);
 *   - versions: ListObjectVersions with MaxKeys=1;
 *   - write:    PutObject of a one-byte body with a wrong Content-MD5: S3 authorises the
 *               request first, so a denied write answers AccessDenied and an allowed one
 *               BadDigest, and nothing is stored either way;
 *   - tags:     PutObjectTagging of a key that does not exist: NoSuchKey means allowed;
 *   - delete:   DeleteObject of a key that does not exist, only in buckets where versioning
 *               was never enabled (elsewhere it would leave a delete marker): 204 = allowed.
 * The write, tags and delete probes can be switched off per connection (PROBE=false).
 */
export async function probeCapabilities(
  c: ConnectionConfig,
  s3: S3Client,
  bucket: string,
  prefix: string,
): Promise<ProbeResult> {
  const r: ProbeResult = {};
  const probeKey = `${prefix}${PROBE_PREFIX}${randomUUID()}`;

  let sample: string | null = null;
  try {
    const l = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, Delimiter: '/', MaxKeys: 50 }));
    r.list = { allowed: true, reason: 'Allowed; the folder could be listed' };
    sample = l.Contents?.find((o) => o.Key && !o.Key.endsWith('/'))?.Key ?? null;
  } catch (e) {
    r.list = verdict(e, [], 'list');
  }

  const tasks: Promise<void>[] = [];
  if (sample) {
    tasks.push(
      s3.send(new HeadObjectCommand({ Bucket: bucket, Key: sample })).then(
        () => void (r.read = { allowed: true, reason: 'Allowed; an object in this folder could be read' }),
        (e) => void (r.read = verdict(e, [], 'read')),
      ),
    );
  }
  tasks.push(
    s3.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: prefix, MaxKeys: 1 })).then(
      () => void (r.versions = { allowed: true, reason: 'Allowed; versions could be listed' }),
      (e) => {
        const f = describe(e);
        r.versions =
          f.code === 'NotImplemented'
            ? { allowed: false, reason: 'This S3 server does not support listing versions' }
            : verdict(e, [], 'version listing');
      },
    ),
  );

  if (c.probe && !c.readOnly) {
    tasks.push(
      s3.send(new PutObjectCommand({ Bucket: bucket, Key: probeKey, Body: 'x', ContentMD5: WRONG_MD5 })).then(
        async (out) => {
          // The server ignored Content-MD5 and stored the probe: remove it again, by version so
          // that a versioned bucket keeps neither the probe nor a delete marker.
          console.warn(`[probe] ${c.id}/${bucket}: the server accepted a wrong Content-MD5; removing ${probeKey}`);
          await s3
            .send(
              new DeleteObjectCommand({
                Bucket: bucket,
                Key: probeKey,
                ...(out.VersionId ? { VersionId: out.VersionId } : {}),
              }),
            )
            .catch(() => {});
          r.write = { allowed: true, reason: 'Allowed; found by a write probe' };
        },
        (e) => void (r.write = verdict(e, ['BadDigest', 'InvalidDigest'], 'write')),
      ),
      s3.send(new PutObjectTaggingCommand({ Bucket: bucket, Key: probeKey, Tagging: { TagSet: [] } })).then(
        () => void (r.tags = { allowed: true, reason: 'Allowed; found by a tagging probe' }),
        (e) => void (r.tags = verdict(e, ['NoSuchKey', 'NotFound'], 'tagging')),
      ),
      (async () => {
        let status: string | undefined;
        try {
          status = (await s3.send(new GetBucketVersioningCommand({ Bucket: bucket }))).Status;
        } catch {
          r.delete = unknown('Not probed: the versioning state of the bucket is unknown');
          return;
        }
        if (status) {
          r.delete = unknown('Not probed: in a versioned bucket a probe would leave a delete marker');
          return;
        }
        try {
          await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: probeKey }));
          r.delete = { allowed: true, reason: 'Allowed; found by a delete probe' };
        } catch (e) {
          r.delete = verdict(e, ['NoSuchKey'], 'delete');
        }
      })(),
    );
  }
  await Promise.all(tasks);
  return r;
}
