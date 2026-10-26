// Read-only access to kopia repositories stored in a bucket, through the kopia CLI.
//
// Each repository (connection + bucket + prefix) gets a private directory under KOPIA_DIR with
// kopia's configuration, cache and logs. The connection is made with --readonly (kopia then
// refuses to write anything to the repository) and --no-persist-credentials: the password is
// only ever passed to kopia in its environment, never written to disk. The configuration file
// does hold the S3 keys (kopia needs them), so the directory is private to this user.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { HeadObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import type {
  KopiaBrowse,
  KopiaEntry,
  KopiaPasswordSource,
  KopiaSnapshot,
  KopiaStatus,
  KopiaSummary,
} from '../shared/types.ts';
import type { ConnectionConfig } from './config.ts';
import { describe } from './s3.ts';

/** The password Velero gives its kopia repositories when none is configured (velero/pkg/repository). */
export const VELERO_DEFAULT_PASSWORD = 'static-passw0rd';

interface Candidate {
  value: string;
  source: KopiaPasswordSource;
}

export type KopiaErrorCode = 'not-installed' | 'locked' | 'bad-password' | 'not-found' | 'failed';

export class KopiaError extends Error {
  readonly code: KopiaErrorCode;
  constructor(code: KopiaErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** kopia object IDs: optional "I" (indirect) and "Z" (compressed) markers, a content prefix, hex. */
export const OBJECT_ID = /^I*Z?[g-z]?[0-9a-f]{16,128}$/;
const SNAPSHOT_ID = /^[0-9a-f]{16,64}$/;

/** Processes at a time: kopia is CPU- and memory-hungry while it loads indexes. */
const MAX_COMMANDS = 4;
const MAX_STREAMS = 8;
const COMMAND_TIMEOUT_MS = 180_000;
/** Directory listings are kept in memory: object IDs are content hashes, so they never change. */
const DIR_CACHE_ENTRIES = 2000;
const SNAPSHOT_CACHE_MS = 30_000;
const DETECT_CACHE_MS = 10 * 60_000;

/** A simple counting semaphore. */
class Limit {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  private readonly max: number;
  constructor(max: number) {
    this.max = max;
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

interface Repo {
  key: string;
  conn: ConnectionConfig;
  bucket: string;
  prefix: string;
  dir: string;
}

interface KopiaDirectory {
  stream?: string;
  entries?: RawEntry[];
  summary?: RawSummary;
}

interface RawSummary {
  size?: number;
  files?: number;
  dirs?: number;
  symlinks?: number;
  numFailed?: number;
  maxTime?: string;
}

interface RawEntry {
  name?: string;
  type?: string;
  mode?: string;
  mtime?: string;
  uid?: number;
  gid?: number;
  obj?: string;
  size?: number;
  summ?: RawSummary;
}

interface RawSnapshot {
  id?: string;
  source?: { host?: string; userName?: string; path?: string };
  description?: string;
  startTime?: string;
  endTime?: string;
  incomplete?: string;
  retentionReason?: string[];
  pins?: string[];
  stats?: { errorCount?: number };
  rootEntry?: RawEntry;
}

const summary = (s: RawSummary | undefined): KopiaSummary | null =>
  s
    ? {
        size: s.size ?? 0,
        files: s.files ?? 0,
        dirs: s.dirs ?? 0,
        symlinks: s.symlinks ?? 0,
        failed: s.numFailed ?? 0,
        maxTime: s.maxTime ?? null,
      }
    : null;

export function toEntry(e: RawEntry): KopiaEntry {
  return {
    name: e.name ?? '',
    type: e.type ?? '?',
    size: e.type === 'd' ? (e.summ?.size ?? null) : (e.size ?? null),
    mtime: e.mtime ?? null,
    mode: e.mode ?? null,
    uid: e.uid ?? null,
    gid: e.gid ?? null,
    oid: e.obj ?? '',
    summary: summary(e.summ),
  };
}

export function toSnapshot(s: RawSnapshot): KopiaSnapshot {
  return {
    id: s.id ?? '',
    source: { host: s.source?.host ?? '', user: s.source?.userName ?? '', path: s.source?.path ?? '' },
    description: s.description ?? '',
    startTime: s.startTime ?? '',
    endTime: s.endTime ?? null,
    incomplete: s.incomplete || null,
    retention: s.retentionReason ?? [],
    pins: s.pins ?? [],
    rootType: s.rootEntry?.type ?? '?',
    summary: summary(s.rootEntry?.summ),
    errors: s.stats?.errorCount ?? 0,
  };
}

const NS_PER_DAY = 86_400e9;

/**
 * The parts of `kopia repository status --json` worth showing. Picked one by one: the output
 * also holds the S3 keys and the repository's secrets.
 */
export function repositoryInfo(st: Record<string, unknown>): { label: string; value: string }[] {
  const get = (path: string): unknown =>
    path
      .split('.')
      .reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), st);
  const rows: [string, unknown][] = [
    ['Repository ID', get('uniqueIDHex')],
    ['Format version', get('contentFormat.version')],
    ['Hash', get('contentFormat.hash')],
    ['Encryption', get('contentFormat.encryption')],
    ['Error correction', get('contentFormat.ecc')],
    ['Splitter', get('objectFormat.splitter')],
    ['Index version', get('contentFormat.indexVersion')],
    ['Epoch-based indexes', get('contentFormat.epochParameters.Enabled')],
  ];
  const pack = get('contentFormat.maxPackSize');
  if (typeof pack === 'number') rows.push(['Maximum pack size', `${Math.round(pack / 1024 / 1024)} MiB`]);
  const mode = get('blobRetention.retentionMode');
  const period = get('blobRetention.retentionPeriod');
  if (mode) {
    rows.push([
      'Object Lock',
      `${String(mode)}${typeof period === 'number' ? `, ${Math.round(period / NS_PER_DAY)} days` : ''}`,
    ]);
  }
  return rows
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([label, v]) => ({ label, value: typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v) }));
}

/** Keeps at most `max` entries, dropping the least recently used. */
class Lru<V> {
  private readonly map = new Map<string, V>();
  private readonly max: number;
  constructor(max: number) {
    this.max = max;
  }
  get(k: string): V | undefined {
    const v = this.map.get(k);
    if (v !== undefined) {
      this.map.delete(k);
      this.map.set(k, v);
    }
    return v;
  }
  set(k: string, v: V): void {
    this.map.delete(k);
    this.map.set(k, v);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
  }
  deleteWhere(pred: (k: string) => boolean): void {
    for (const k of [...this.map.keys()]) if (pred(k)) this.map.delete(k);
  }
}

export class Kopia {
  private readonly bin: string;
  private readonly baseDir: string;
  private readonly commands = new Limit(MAX_COMMANDS);
  private readonly streams = new Limit(MAX_STREAMS);
  /** Passwords typed in the UI, by repository; memory only. */
  private readonly typed = new Map<string, string>();
  /** The configured password that opened each repository, and those it rejected. */
  private readonly chosen = new Map<string, { candidate: Candidate; rejected: KopiaPasswordSource[] }>();
  /** Repositories of Velero backup locations, as told by markVelero(). */
  private readonly veleroRepos = new Set<string>();
  private readonly connected = new Map<string, Promise<void>>();
  private readonly dirs = new Lru<KopiaDirectory>(DIR_CACHE_ENTRIES);
  private readonly snapshotsCache = new Map<string, { at: number; list: Promise<KopiaSnapshot[]> }>();
  private readonly infoCache = new Map<string, { label: string; value: string }[]>();
  /** Root object of each listed snapshot, by repository and snapshot ID. */
  private readonly roots = new Map<string, string>();
  private readonly detected = new Map<string, { at: number; is: Promise<boolean> }>();
  private versionPromise: Promise<string | null> | null = null;

  constructor(opts: { bin: string; dir: string }) {
    this.bin = opts.bin;
    this.baseDir = opts.dir;
  }

  private repo(conn: ConnectionConfig, bucket: string, prefix: string): Repo {
    const key = `${conn.id}\u0000${bucket}\u0000${prefix}`;
    // The endpoint is part of the name, so that a changed S3_n_ENDPOINT gets a fresh connection.
    const id = createHash('sha256')
      .update(`${key}\u0000${conn.endpoint ?? 'aws'}`)
      .digest('hex')
      .slice(0, 24);
    return { key, conn, bucket, prefix, dir: join(this.baseDir, id) };
  }

  /** Declares whether a repository belongs to a Velero backup location (decides its passwords). */
  markVelero(conn: ConnectionConfig, bucket: string, prefix: string, velero: boolean): void {
    const { key } = this.repo(conn, bucket, prefix);
    if (velero) this.veleroRepos.add(key);
    else this.veleroRepos.delete(key);
  }

  /** The configured passwords to try, in order. */
  private candidates(r: Repo): Candidate[] {
    const c = r.conn;
    if (this.veleroRepos.has(r.key)) {
      return [
        ...(c.veleroPassword ? [{ value: c.veleroPassword, source: 'velero-env' as const }] : []),
        // Velero creates its repositories with this password unless told otherwise.
        { value: VELERO_DEFAULT_PASSWORD, source: 'velero-default' as const },
      ];
    }
    return c.kopiaPassword ? [{ value: c.kopiaPassword, source: 'env' }] : [];
  }

  /** Whether `prefix` of the bucket holds a kopia repository (its `kopia.repository` blob). */
  isRepository(s3: S3Client, connId: string, bucket: string, prefix: string): Promise<boolean> {
    const k = `${connId}\u0000${bucket}\u0000${prefix}`;
    const hit = this.detected.get(k);
    if (hit && Date.now() - hit.at < DETECT_CACHE_MS) return hit.is;
    const is = s3.send(new HeadObjectCommand({ Bucket: bucket, Key: `${prefix}kopia.repository` })).then(
      () => true,
      (e) => {
        const f = describe(e);
        if (f.status === 404 || f.denied) return false;
        this.detected.delete(k);
        throw e;
      },
    );
    this.detected.set(k, { at: Date.now(), is });
    return is;
  }

  private env(r: Repo, password: string | null): NodeJS.ProcessEnv {
    const c = r.conn;
    return {
      // Nothing of ObjectLens' own environment is passed on (it holds every connection's keys).
      PATH: process.env.PATH,
      HOME: r.dir,
      TMPDIR: join(r.dir, 'tmp'),
      KOPIA_CHECK_FOR_UPDATES: 'false',
      KOPIA_LOG_DIR: join(r.dir, 'logs'),
      ...(password !== null ? { KOPIA_PASSWORD: password } : {}),
      ...(c.credentials
        ? {
            AWS_ACCESS_KEY_ID: c.credentials.accessKeyId,
            AWS_SECRET_ACCESS_KEY: c.credentials.secretAccessKey,
            ...(c.credentials.sessionToken ? { AWS_SESSION_TOKEN: c.credentials.sessionToken } : {}),
          }
        : {
            // The AWS default chain: whatever ObjectLens itself was given.
            ...pick(process.env, ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN']),
            ...(c.profile ? { AWS_PROFILE: c.profile } : pick(process.env, ['AWS_PROFILE'])),
            ...(process.env.HOME ? { AWS_SHARED_CREDENTIALS_FILE: join(process.env.HOME, '.aws', 'credentials') } : {}),
          }),
    };
  }

  private globalArgs(r: Repo): string[] {
    return ['--config-file', join(r.dir, 'repository.config'), '--log-dir', join(r.dir, 'logs')];
  }

  /** Runs kopia and returns its standard output. */
  private exec(r: Repo, args: string[], password: string | null, maxBytes = 512 * 1024 * 1024): Promise<string> {
    return this.commands.run(
      () =>
        new Promise<string>((resolve, reject) => {
          const child = spawn(this.bin, [...args, ...this.globalArgs(r)], {
            env: this.env(r, password),
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          const out: Buffer[] = [];
          let size = 0;
          let err = '';
          const timer = setTimeout(() => child.kill('SIGKILL'), COMMAND_TIMEOUT_MS);
          child.stdout.on('data', (b: Buffer) => {
            size += b.length;
            if (size > maxBytes) child.kill('SIGKILL');
            else out.push(b);
          });
          child.stderr.on('data', (b: Buffer) => {
            err = (err + b.toString()).slice(-8192);
          });
          child.on('error', (e: NodeJS.ErrnoException) => {
            clearTimeout(timer);
            reject(
              e.code === 'ENOENT'
                ? new KopiaError('not-installed', `kopia is not installed (KOPIA_BIN=${this.bin})`)
                : e,
            );
          });
          child.on('close', (code, signal) => {
            clearTimeout(timer);
            if (code === 0) return resolve(Buffer.concat(out).toString('utf8'));
            if (size > maxBytes) return reject(new KopiaError('failed', 'kopia output too large'));
            if (signal) return reject(new KopiaError('failed', `kopia was stopped (${signal}), probably a timeout`));
            reject(classify(err));
          });
        }),
    );
  }

  version(): Promise<string | null> {
    this.versionPromise ??= new Promise<string | null>((resolve) => {
      const child = spawn(this.bin, ['--version'], {
        env: { PATH: process.env.PATH },
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      let out = '';
      child.stdout.on('data', (b: Buffer) => (out += b.toString()));
      child.on('error', () => resolve(null));
      child.on('close', (code) => resolve(code === 0 ? (out.trim().split(/\s+/)[0] ?? '') : null));
    }).then((v) => {
      // Not installed yet: ask again next time, so installing kopia needs no restart.
      if (v === null) this.versionPromise = null;
      return v;
    });
    return this.versionPromise;
  }

  /** Writes kopia's configuration for the repository (read-only, no stored password). */
  private async connect(r: Repo, password: string): Promise<void> {
    await mkdir(join(r.dir, 'tmp'), { recursive: true, mode: 0o700 });
    await mkdir(join(r.dir, 'logs'), { recursive: true, mode: 0o700 });
    const c = r.conn;
    const endpoint = c.endpoint ? new URL(c.endpoint) : null;
    await this.exec(
      r,
      [
        'repository',
        'connect',
        's3',
        '--bucket',
        r.bucket,
        '--endpoint',
        endpoint ? endpoint.host : `s3.${c.region}.amazonaws.com`,
        '--region',
        c.region,
        ...(r.prefix ? ['--prefix', r.prefix] : []),
        ...(endpoint?.protocol === 'http:' ? ['--disable-tls'] : []),
        ...(c.rejectUnauthorized ? [] : ['--disable-tls-verification']),
        '--readonly',
        '--no-persist-credentials',
        '--no-check-for-updates',
        '--no-use-keyring',
        '--cache-directory',
        join(r.dir, 'cache'),
        '--content-cache-size-mb',
        '256',
        '--metadata-cache-size-mb',
        '512',
        '--description',
        `ObjectLens: ${c.name}`,
      ],
      password,
    );
  }

  /** Connects once per process (and again after a failure or a new password). */
  private ensureConnected(r: Repo, password: string): Promise<void> {
    let p = this.connected.get(r.key);
    if (!p) {
      p = this.connect(r, password).catch((e: unknown) => {
        this.connected.delete(r.key);
        throw e;
      });
      this.connected.set(r.key, p);
    }
    return p;
  }

  /**
   * The password and a connection: the typed password, else the first configured one that opens
   * the repository. KopiaError("locked") when there is none, "bad-password" when none works.
   */
  private async ready(r: Repo): Promise<string> {
    const typed = this.typed.get(r.key);
    if (typed !== undefined) {
      await this.ensureConnected(r, typed);
      return typed;
    }
    const known = this.chosen.get(r.key);
    if (known) {
      await this.ensureConnected(r, known.candidate.value);
      return known.candidate.value;
    }
    const candidates = this.candidates(r);
    if (!candidates.length) throw new KopiaError('locked', 'the repository password is needed');
    const rejected: KopiaPasswordSource[] = [];
    for (const candidate of candidates) {
      this.connected.delete(r.key);
      try {
        await this.ensureConnected(r, candidate.value);
        this.chosen.set(r.key, { candidate, rejected });
        return candidate.value;
      } catch (e) {
        if (!(e instanceof KopiaError && e.code === 'bad-password')) throw e;
        rejected.push(candidate.source);
      }
    }
    throw new KopiaError(
      'bad-password',
      candidates.length > 1 ? 'None of the configured passwords opens this repository.' : 'The password is wrong.',
    );
  }

  /** Where the working password came from, and what the user should know about it. */
  private passwordInfo(r: Repo): { source: KopiaPasswordSource | null; warning: string | null } {
    if (this.typed.has(r.key)) return { source: 'ui', warning: null };
    const known = this.chosen.get(r.key);
    if (!known) return { source: null, warning: null };
    const rejectedEnv = known.rejected.includes('velero-env')
      ? ` S3_${r.conn.n}_VELERO_PASSWORD was tried first and does not open it.`
      : '';
    return {
      source: known.candidate.source,
      warning:
        known.candidate.source === 'velero-default'
          ? `Opened with Velero's built-in default password ("${VELERO_DEFAULT_PASSWORD}"): anyone who can read ` +
            `this bucket can decrypt these backups. Give Velero a password of its own (secret ` +
            `velero-repo-credentials) and change it on existing repositories.${rejectedEnv}`
          : null,
    };
  }

  async status(conn: ConnectionConfig, bucket: string, prefix: string): Promise<KopiaStatus> {
    const r = this.repo(conn, bucket, prefix);
    const version = await this.version();
    const velero = this.veleroRepos.has(r.key);
    const base: KopiaStatus = {
      installed: version !== null,
      kopiaVersion: version,
      locked: true,
      passwordSource: null,
      warning: null,
      velero,
      repository: null,
      error: null,
    };
    if (version === null) return { ...base, error: `kopia is not installed (KOPIA_BIN=${this.bin})` };
    if (!this.typed.has(r.key) && !this.candidates(r).length) return base;
    try {
      let info = this.infoCache.get(r.key);
      if (!info) {
        const password = await this.ready(r);
        info = repositoryInfo(JSON.parse(await this.exec(r, ['repository', 'status', '--json'], password)));
        this.infoCache.set(r.key, info);
      }
      const { source, warning } = this.passwordInfo(r);
      return { ...base, locked: false, passwordSource: source, warning, repository: info };
    } catch (e) {
      const k = e instanceof KopiaError ? e : new KopiaError('failed', (e as Error).message);
      // Configured passwords that do not work: let the user type the right one.
      return { ...base, locked: k.code === 'bad-password' || k.code === 'locked', error: k.message };
    }
  }

  /** Checks a typed password by connecting with it; kept in memory only when it works. */
  async unlock(conn: ConnectionConfig, bucket: string, prefix: string, password: string): Promise<void> {
    const r = this.repo(conn, bucket, prefix);
    this.connected.delete(r.key);
    const attempt = this.connect(r, password);
    this.connected.set(r.key, attempt);
    try {
      await attempt;
    } catch (e) {
      this.connected.delete(r.key);
      throw e;
    }
    this.typed.set(r.key, password);
    this.chosen.delete(r.key);
    this.forgetCaches(r);
  }

  /** Forgets a typed password and removes kopia's configuration (it holds the S3 keys) and cache. */
  async lock(conn: ConnectionConfig, bucket: string, prefix: string): Promise<void> {
    const r = this.repo(conn, bucket, prefix);
    this.typed.delete(r.key);
    this.chosen.delete(r.key);
    this.connected.delete(r.key);
    this.forgetCaches(r);
    await rm(r.dir, { recursive: true, force: true });
  }

  private forgetCaches(r: Repo): void {
    this.snapshotsCache.delete(r.key);
    this.infoCache.delete(r.key);
    this.dirs.deleteWhere((k) => k.startsWith(`${r.key}\u0000`));
  }

  async snapshots(conn: ConnectionConfig, bucket: string, prefix: string, fresh = false): Promise<KopiaSnapshot[]> {
    const r = this.repo(conn, bucket, prefix);
    const hit = this.snapshotsCache.get(r.key);
    if (hit && !fresh && Date.now() - hit.at < SNAPSHOT_CACHE_MS) return hit.list;
    const list = (async () => {
      const password = await this.ready(r);
      const raw = JSON.parse(
        await this.exec(r, ['snapshot', 'list', '--all', '--incomplete', '--json'], password),
      ) as RawSnapshot[];
      // Root object IDs stay on the server: the UI addresses folders by path.
      for (const x of raw) if (x.id && x.rootEntry?.obj) this.roots.set(`${r.key}\u0000${x.id}`, x.rootEntry.obj);
      // Newest first; checkpoints of one run share their start time, so the end time decides.
      return raw
        .map(toSnapshot)
        .sort((a, b) => b.startTime.localeCompare(a.startTime) || (b.endTime ?? '').localeCompare(a.endTime ?? ''));
    })();
    this.snapshotsCache.set(r.key, { at: Date.now(), list });
    list.catch(() => this.snapshotsCache.delete(r.key));
    return list;
  }

  private async directory(r: Repo, oid: string): Promise<KopiaDirectory> {
    const k = `${r.key}\u0000${oid}`;
    const hit = this.dirs.get(k);
    if (hit) return hit;
    const password = await this.ready(r);
    const d = JSON.parse(await this.exec(r, ['show', oid], password)) as KopiaDirectory;
    if (d.stream !== 'kopia:directory') throw new KopiaError('not-found', 'not a folder');
    this.dirs.set(k, d);
    return d;
  }

  /** A folder of a snapshot, by its path below the snapshot's root ("a/b", "" = root). */
  async browse(
    conn: ConnectionConfig,
    bucket: string,
    prefix: string,
    snapshotId: string,
    path: string,
  ): Promise<KopiaBrowse> {
    if (!SNAPSHOT_ID.test(snapshotId)) throw new KopiaError('not-found', 'no such snapshot');
    const r = this.repo(conn, bucket, prefix);
    let snapshot = (await this.snapshots(conn, bucket, prefix)).find((s) => s.id === snapshotId);
    // A snapshot taken in the last 30 s is not in the cached list yet.
    snapshot ??= (await this.snapshots(conn, bucket, prefix, true)).find((s) => s.id === snapshotId);
    const root = this.roots.get(`${r.key}\u0000${snapshotId}`);
    if (!snapshot || !root || !OBJECT_ID.test(root)) throw new KopiaError('not-found', 'no such snapshot');
    if (snapshot.rootType !== 'd') throw new KopiaError('not-found', 'this snapshot is a single file');
    let dir = await this.directory(r, root);
    const parts = path ? path.split('/') : [];
    for (const name of parts) {
      const e = dir.entries?.find((x) => x.name === name && x.type === 'd');
      if (!e?.obj || !OBJECT_ID.test(e.obj)) throw new KopiaError('not-found', `no folder "${name}" here`);
      dir = await this.directory(r, e.obj);
    }
    return {
      snapshot,
      path: parts.join('/'),
      entries: (dir.entries ?? []).map(toEntry),
      summary: summary(dir.summary),
    };
  }

  /**
   * The content of a file as a stream. The file must be an entry of a folder that was listed
   * through this repository (so an object ID cannot be guessed into reading something else).
   */
  async open(
    conn: ConnectionConfig,
    bucket: string,
    prefix: string,
    snapshotId: string,
    path: string,
    signal: AbortSignal,
  ): Promise<{ entry: KopiaEntry; stream: Readable }> {
    const i = path.lastIndexOf('/');
    const folder = i < 0 ? '' : path.slice(0, i);
    const name = path.slice(i + 1);
    const listing = await this.browse(conn, bucket, prefix, snapshotId, folder);
    const entry = listing.entries.find((e) => e.name === name && e.type === 'f');
    if (!entry || !OBJECT_ID.test(entry.oid)) throw new KopiaError('not-found', `no file "${name}" here`);
    const r = this.repo(conn, bucket, prefix);
    const password = await this.ready(r);

    let release!: () => void;
    const slot = new Promise<void>((resolve) => (release = resolve));
    // Holds a stream slot until the process ends.
    await new Promise<void>((started) => void this.streams.run(() => (started(), slot)));
    const child = spawn(this.bin, ['show', entry.oid, ...this.globalArgs(r)], {
      env: this.env(r, password),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = '';
    child.stderr.on('data', (b: Buffer) => (err = (err + b.toString()).slice(-4096)));
    child.on('close', (code) => {
      release();
      if (code && !signal.aborted) child.stdout.destroy(classify(err));
    });
    child.on('error', () => release());
    signal.addEventListener('abort', () => child.kill(), { once: true });
    return { entry, stream: child.stdout };
  }
}

const pick = (env: NodeJS.ProcessEnv, keys: string[]) =>
  Object.fromEntries(keys.filter((k) => env[k]).map((k) => [k, env[k]!]));

/** Turns kopia's error output into a KopiaError with a short message. */
export function classify(stderr: string): KopiaError {
  if (/invalid repository password/i.test(stderr)) return new KopiaError('bad-password', 'The password is wrong.');
  if (/repository not initialized|BLOB not found.*kopia\.repository/i.test(stderr)) {
    return new KopiaError('not-found', 'No kopia repository was found here.');
  }
  const lines = stderr
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const last = lines.findLast((l) => /error|unable|failed|denied/i.test(l)) ?? lines.at(-1) ?? 'kopia failed';
  return new KopiaError('failed', last.replace(/^(kopia: )?error: /i, '').slice(0, 500));
}
