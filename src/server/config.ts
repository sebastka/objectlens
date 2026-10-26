// Configuration from the environment. Everything is validated at startup: a mistake stops the
// server with a list of every problem rather than surfacing later as a confusing S3 error.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

type Env = Record<string, string | undefined>;

export interface ConnectionConfig {
  /** The n in S3_<n>_…; fixes the order. */
  n: number;
  /** Stable id used in URLs (S3_n_ID, default n). */
  id: string;
  name: string;
  /** null = AWS (the SDK picks the regional endpoint). */
  endpoint: string | null;
  region: string;
  /** null = the AWS SDK default credential chain (environment, profile, SSO, instance role…). */
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string } | null;
  /** AWS shared config profile for the default credential chain (S3_n_PROFILE). */
  profile: string | null;
  forcePathStyle: boolean;
  rejectUnauthorized: boolean;
  /** Buckets shown when ListBuckets is denied or switched off. */
  buckets: string[];
  listBuckets: boolean;
  /** Nothing is ever written through this connection. */
  readOnly: boolean;
  /** Side-effect-free write/delete probes (see capabilities.ts). */
  probe: boolean;
  shareLinks: boolean;
  /** Endpoint written into presigned URLs, when browsers reach S3 under another name. */
  publicEndpoint: string | null;
  /** Password of the kopia repositories reached through this connection (KOPIA_PASSWORD[_FILE]). */
  kopiaPassword: string | null;
}

export interface Config {
  http: {
    host: string;
    port: number;
    /** Host header values accepted besides localhost and the listen address (DNS rebinding guard). */
    allowedHosts: string[];
  };
  connections: ConnectionConfig[];
  limits: {
    /** Objects one copy, move or delete request handles at most. */
    bulk: number;
    /** Keys a search scans at most. */
    searchScan: number;
    /** Largest object shown and edited as text in the browser. */
    textBytes: number;
    shareMaxHours: number;
    capabilityTtlMinutes: number;
  };
  staticDir: string;
  kopia: {
    /** The kopia binary (KOPIA_BIN, default "kopia" on the PATH). */
    bin: string;
    /** Per-repository kopia configuration, cache and logs (KOPIA_DIR). */
    dir: string;
  };
}

function str(env: Env, name: string, fallback?: string): string | undefined {
  const v = env[name]?.trim();
  return v ? v : fallback;
}

function int(env: Env, name: string, fallback: number, errors: string[], min = 0): number {
  const v = str(env, name);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) {
    errors.push(`${name} must be an integer ≥ ${min}, got "${v}"`);
    return fallback;
  }
  return n;
}

function bool(env: Env, name: string, fallback: boolean, errors: string[]): boolean {
  const v = str(env, name)?.toLowerCase();
  if (v === undefined) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  errors.push(`${name} must be true or false, got "${v}"`);
  return fallback;
}

/** A secret from NAME, or from the file NAME_FILE points to (Docker/Kubernetes secrets). */
function secret(env: Env, name: string, errors: string[]): string | null {
  const direct = env[name];
  const file = str(env, `${name}_FILE`);
  if (direct && file) {
    errors.push(`${name} and ${name}_FILE exclude each other`);
    return null;
  }
  if (file) {
    try {
      // Only a trailing newline is dropped: a password may start or end with spaces.
      return readFileSync(file, 'utf8').replace(/\r?\n$/, '') || null;
    } catch (e) {
      errors.push(`${name}_FILE: cannot read ${file} (${(e as Error).message})`);
      return null;
    }
  }
  return direct ? direct : null;
}

function list(env: Env, name: string): string[] {
  return (env[name] ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function url(env: Env, name: string, errors: string[]): string | null {
  const v = str(env, name);
  if (!v) return null;
  try {
    const u = new URL(v);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error();
    return v.replace(/\/+$/, '');
  } catch {
    errors.push(`${name} must be an http(s) URL, got "${v}"`);
    return null;
  }
}

/** The numbers n for which some <PREFIX>_<n>_* variable is set, in ascending order. */
function numbers(env: Env, prefix: string): number[] {
  const ns = new Set<number>();
  const re = new RegExp(`^${prefix}_(\\d+)_[A-Z0-9_]+$`);
  for (const key of Object.keys(env)) {
    const m = re.exec(key);
    if (m && env[key]?.trim()) ns.add(Number(m[1]));
  }
  return [...ns].sort((a, b) => a - b);
}

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

function connection(env: Env, n: number, errors: string[], ids: Set<string>): ConnectionConfig {
  const p = `S3_${n}_`;
  const endpoint = url(env, `${p}ENDPOINT`, errors);
  const id = str(env, `${p}ID`, String(n))!.toLowerCase();
  if (!ID_RE.test(id)) errors.push(`${p}ID must be lowercase letters, digits, "-" or "_", got "${id}"`);
  if (ids.has(id)) errors.push(`${p}ID "${id}" is used by two connections`);
  ids.add(id);

  const accessKeyId = str(env, `${p}ACCESS_KEY_ID`);
  const secretAccessKey = str(env, `${p}SECRET_ACCESS_KEY`);
  const sessionToken = str(env, `${p}SESSION_TOKEN`);
  if (Boolean(accessKeyId) !== Boolean(secretAccessKey)) {
    errors.push(`${p}ACCESS_KEY_ID and ${p}SECRET_ACCESS_KEY must be set together`);
  }
  const profile = str(env, `${p}PROFILE`) ?? null;
  if (profile && accessKeyId) errors.push(`${p}PROFILE and ${p}ACCESS_KEY_ID exclude each other`);
  const buckets = list(env, `${p}BUCKETS`);
  const listBuckets = bool(env, `${p}LIST_BUCKETS`, true, errors);
  if (!listBuckets && !buckets.length) errors.push(`${p}LIST_BUCKETS=false needs ${p}BUCKETS`);

  return {
    n,
    id,
    name: str(env, `${p}NAME`, endpoint ? new URL(endpoint).host : 'AWS S3')!,
    endpoint,
    region: str(env, `${p}REGION`, 'us-east-1')!,
    credentials:
      accessKeyId && secretAccessKey
        ? { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) }
        : null,
    profile,
    // Path-style addressing works with every S3-compatible server; AWS prefers virtual hosts.
    forcePathStyle: bool(env, `${p}FORCE_PATH_STYLE`, endpoint !== null, errors),
    rejectUnauthorized: bool(env, `${p}TLS_REJECT_UNAUTHORIZED`, true, errors),
    buckets,
    listBuckets,
    readOnly: bool(env, `${p}READ_ONLY`, false, errors),
    probe: bool(env, `${p}PROBE`, true, errors),
    shareLinks: bool(env, `${p}SHARE_LINKS`, true, errors),
    publicEndpoint: url(env, `${p}PUBLIC_ENDPOINT`, errors),
    kopiaPassword: secret(env, `${p}KOPIA_PASSWORD`, errors),
  };
}

export function loadConfig(env: Env = process.env): Config {
  const errors: string[] = [];
  const ids = new Set<string>();
  const connections = numbers(env, 'S3').map((n) => connection(env, n, errors, ids));

  const cfg: Config = {
    http: {
      host: str(env, 'LISTEN_HOST', '127.0.0.1')!,
      port: int(env, 'PORT', 3000, errors, 1),
      allowedHosts: list(env, 'ALLOWED_HOSTS').map((h) => h.toLowerCase()),
    },
    connections,
    limits: {
      bulk: int(env, 'BULK_LIMIT', 10_000, errors, 1),
      searchScan: int(env, 'SEARCH_SCAN_LIMIT', 100_000, errors, 1),
      textBytes: int(env, 'TEXT_EDIT_MAX_BYTES', 2 * 1024 * 1024, errors, 1),
      shareMaxHours: Math.min(168, int(env, 'SHARE_MAX_HOURS', 168, errors, 1)),
      capabilityTtlMinutes: int(env, 'CAPABILITY_TTL_MINUTES', 10, errors, 0),
    },
    staticDir: resolve(str(env, 'STATIC_DIR', resolve(import.meta.dirname, '../../dist/web'))!),
    kopia: {
      bin: str(env, 'KOPIA_BIN', 'kopia')!,
      dir: resolve(
        str(env, 'KOPIA_DIR', join(str(env, 'XDG_CACHE_HOME', join(homedir(), '.cache'))!, 'objectlens', 'kopia'))!,
      ),
    },
  };
  if (errors.length) throw new ConfigError(errors);
  return cfg;
}

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.problems = problems;
  }
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
export const isLoopback = (host: string) => LOOPBACK.has(host) || host.startsWith('127.');
