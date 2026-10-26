// Read-only view of Velero backup storage locations.
//
// A location (a bucket, or a prefix of one) holds:
//   backups/<name>/velero-backup.json          the Backup resource (spec and final status)
//   backups/<name>/<name>-resource-list.json.gz the backed-up resources by type
//   backups/<name>/<name>-results.gz           errors and warnings
//   backups/<name>/<name>-volumeinfo.json.gz   the volumes and how they were backed up (1.13+)
//   backups/<name>/<name>-podvolumebackups.json.gz  file-system backups of pod volumes
//   backups/<name>/<name>-logs.gz              the backup's log
//   backups/<name>/<name>.tar.gz               the manifests, including the finished DataUploads
//   kopia/<namespace>/                          one kopia repository per namespace (volume data)
//
// Velero 1.18 writes an empty volumeinfo for data-mover backups; the DataUploads in the tarball
// then link each PVC to its kopia snapshot. Everything here is read, never written.
import { gunzipSync } from 'node:zlib';
import { GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3';
import type { VeleroBackup, VeleroBackupDetails, VeleroVolume } from '../shared/types.ts';
import { describe } from './s3.ts';
import { readTar } from './tar.ts';

/** Kubernetes object names (RFC 1123 subdomains). */
export const BACKUP_NAME = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;

const DETECT_CACHE_MS = 10 * 60_000;
const LIST_CACHE_MS = 60_000;
/** Largest gzipped metadata file read (logs, results, lists). */
const MAX_FILE = 64 * 1024 * 1024;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
const strOrNull = (v: unknown) => (typeof v === 'string' && v ? v : null);
const numOrNull = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const nonNegative = (v: unknown) => {
  const n = numOrNull(v);
  return n !== null && n >= 0 ? n : null;
};
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

async function getObject(s3: S3Client, bucket: string, key: string, max = MAX_FILE): Promise<Buffer | null> {
  try {
    const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if ((r.ContentLength ?? 0) > max) throw new Error(`${key} is larger than ${max} bytes`);
    return Buffer.from(await r.Body!.transformToByteArray());
  } catch (e) {
    if (describe(e).status === 404 || describe(e).code === 'NoSuchKey') return null;
    throw e;
  }
}

const gunzipJson = (b: Buffer | null): unknown =>
  b ? JSON.parse(gunzipSync(b, { maxOutputLength: MAX_FILE }).toString('utf8')) : null;

function selector(v: unknown): string | null {
  const s = obj(v);
  const labels = Object.entries(obj(s.matchLabels)).map(([k, x]) => `${k}=${String(x)}`);
  const exprs = (Array.isArray(s.matchExpressions) ? s.matchExpressions : []).map((e) => {
    const x = obj(e);
    return `${String(x.key)} ${String(x.operator)} (${strings(x.values).join(', ')})`;
  });
  const all = [...labels, ...exprs];
  return all.length ? all.join(', ') : null;
}

export function toBackup(name: string, raw: unknown): VeleroBackup {
  const b = obj(raw);
  const meta = obj(b.metadata);
  const spec = obj(b.spec);
  const st = obj(b.status);
  const progress = obj(st.progress);
  return {
    name,
    schedule: strOrNull(obj(meta.labels)['velero.io/schedule-name']),
    phase: strOrNull(st.phase) ?? 'Unknown',
    startTime: strOrNull(st.startTimestamp),
    completionTime: strOrNull(st.completionTimestamp),
    expiration: strOrNull(st.expiration),
    storageLocation: strOrNull(spec.storageLocation),
    includedNamespaces: strings(spec.includedNamespaces),
    excludedNamespaces: strings(spec.excludedNamespaces),
    includedResources: strings(spec.includedResources),
    excludedResources: strings(spec.excludedResources),
    labelSelector: selector(spec.labelSelector),
    snapshotMoveData: spec.snapshotMoveData === true,
    defaultVolumesToFsBackup: spec.defaultVolumesToFsBackup === true,
    ttl: strOrNull(spec.ttl),
    itemsBackedUp: numOrNull(progress.itemsBackedUp),
    totalItems: numOrNull(progress.totalItems),
    errors: numOrNull(st.errors) ?? 0,
    warnings: numOrNull(st.warnings) ?? 0,
    failureReason: strOrNull(st.failureReason),
    formatVersion: strOrNull(st.formatVersion),
    clusterVersion: strOrNull(obj(meta.annotations)['velero.io/source-cluster-k8s-gitversion']),
    operations: {
      attempted: numOrNull(st.backupItemOperationsAttempted) ?? 0,
      completed: numOrNull(st.backupItemOperationsCompleted) ?? 0,
      failed: numOrNull(st.backupItemOperationsFailed) ?? 0,
    },
  };
}

/** A DataUpload resource (data mover) as stored in the backup tarball. */
export function fromDataUpload(raw: unknown, location: string): VeleroVolume {
  const d = obj(raw);
  const spec = obj(d.spec);
  const st = obj(d.status);
  const ns = strOrNull(spec.sourceNamespace) ?? '';
  const snapshotId = strOrNull(st.snapshotID);
  const uploader = strOrNull(spec.datamover) ?? 'kopia';
  return {
    namespace: ns,
    pvc: strOrNull(spec.sourcePVC),
    pod: null,
    volume: null,
    method: 'data-mover',
    uploader: uploader === 'velero' ? 'kopia' : uploader,
    snapshotId,
    repository: snapshotId && ns ? `${location}kopia/${ns}/` : null,
    phase: strOrNull(st.phase),
    bytes: numOrNull(obj(st.progress).totalBytes),
    // Velero reports a negative value when the volume shrank; that is not an upload size.
    incrementalBytes: nonNegative(st.incrementalBytes),
    startTime: strOrNull(st.startTimestamp),
    completionTime: strOrNull(st.completionTimestamp),
    node: strOrNull(st.node),
    note: null,
  };
}

/** A PodVolumeBackup (file-system backup) from <name>-podvolumebackups.json.gz. */
export function fromPodVolumeBackup(raw: unknown, location: string): VeleroVolume {
  const p = obj(raw);
  const spec = obj(p.spec);
  const st = obj(p.status);
  const pod = obj(spec.pod);
  const ns = strOrNull(pod.namespace) ?? strOrNull(obj(p.metadata).namespace) ?? '';
  const uploader = strOrNull(spec.uploaderType) ?? 'restic';
  const snapshotId = strOrNull(st.snapshotID);
  return {
    namespace: ns,
    pvc: strOrNull(obj(obj(p.metadata).annotations)['velero.io/pvc-name']),
    pod: strOrNull(pod.name),
    volume: strOrNull(spec.volume),
    method: 'fs-backup',
    uploader,
    snapshotId,
    // restic repositories (restic/<namespace>/) are not readable with kopia.
    repository: uploader === 'kopia' && snapshotId && ns ? `${location}kopia/${ns}/` : null,
    phase: strOrNull(st.phase),
    bytes: numOrNull(obj(st.progress).totalBytes),
    incrementalBytes: null,
    startTime: strOrNull(st.startTimestamp),
    completionTime: strOrNull(st.completionTimestamp),
    node: strOrNull(spec.node),
    note: uploader === 'kopia' ? null : `${uploader} repository: not readable here (kopia only)`,
  };
}

/** An entry of <name>-volumeinfo.json.gz (Velero 1.13+). */
export function fromVolumeInfo(raw: unknown, location: string): VeleroVolume {
  const v = obj(raw);
  const method = String(v.backupMethod ?? '');
  const moved = v.snapshotDataMoved === true;
  const dm = obj(v.snapshotDataMovementInfo);
  const pvb = obj(v.pvbInfo);
  const ns = strOrNull(v.pvcNamespace) ?? '';
  const isFs = method === 'PodVolumeBackup';
  const uploader = strOrNull(
    isFs ? pvb.uploaderType : dm.dataMover === 'velero' || !dm.dataMover ? dm.uploaderType : dm.dataMover,
  );
  const snapshotId = strOrNull(isFs ? pvb.snapshotHandle : moved ? dm.snapshotHandle : null);
  const kind: VeleroVolume['method'] = isFs
    ? 'fs-backup'
    : method === 'CSISnapshot'
      ? moved
        ? 'data-mover'
        : 'csi-snapshot'
      : 'native-snapshot';
  return {
    namespace: ns,
    pvc: strOrNull(v.pvcName),
    pod: strOrNull(pvb.podName),
    volume: strOrNull(pvb.volumeName),
    method: kind,
    uploader,
    snapshotId,
    repository: snapshotId && ns && (uploader ?? 'kopia') === 'kopia' ? `${location}kopia/${ns}/` : null,
    phase: strOrNull(obj(v.result).phase) ?? strOrNull(pvb.phase) ?? strOrNull(dm.phase),
    bytes: numOrNull(dm.size) ?? numOrNull(pvb.size),
    incrementalBytes: nonNegative(dm.incrementalSize),
    startTime: strOrNull(v.startTimestamp),
    completionTime: strOrNull(v.completionTimestamp),
    node: null,
    note:
      kind === 'csi-snapshot'
        ? 'CSI snapshot kept in the cluster: its data is not in this bucket'
        : kind === 'native-snapshot'
          ? 'Snapshot kept by the volume provider: its data is not in this bucket'
          : null,
  };
}

export class Velero {
  private readonly detected = new Map<string, { at: number; is: Promise<boolean> }>();
  private readonly lists = new Map<string, { at: number; list: Promise<VeleroBackup[]> }>();
  /** Backup details, by location and the tarball's ETag (it changes when Velero rewrites it). */
  private readonly details = new Map<string, VeleroBackupDetails>();

  /** Whether `prefix` is a Velero backup location: a backups/<name>/velero-backup.json exists. */
  isLocation(s3: S3Client, connId: string, bucket: string, prefix: string): Promise<boolean> {
    const k = `${connId}\u0000${bucket}\u0000${prefix}`;
    const hit = this.detected.get(k);
    if (hit && Date.now() - hit.at < DETECT_CACHE_MS) return hit.is;
    const is = (async () => {
      const r = await s3.send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: `${prefix}backups/`, Delimiter: '/', MaxKeys: 1 }),
      );
      const first = r.CommonPrefixes?.[0]?.Prefix;
      if (!first) return false;
      try {
        await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: `${first}velero-backup.json` }));
        return true;
      } catch (e) {
        if (describe(e).status === 404 || describe(e).denied) return false;
        throw e;
      }
    })().catch((e: unknown) => {
      this.detected.delete(k);
      if (describe(e).denied) return false;
      throw e;
    });
    this.detected.set(k, { at: Date.now(), is });
    return is;
  }

  /** Whether `folder` is managed by Velero: a location's backups/ folder or a backup folder in it. */
  async isManaged(s3: S3Client, connId: string, bucket: string, folder: string): Promise<boolean> {
    const m = /^(.*?)backups\/(?:[^/]+\/)?$/.exec(folder);
    return m ? this.isLocation(s3, connId, bucket, m[1]!) : false;
  }

  /** If `prefix` is a kopia repository of a Velero location (<location>kopia/<namespace>/). */
  async isVeleroRepository(s3: S3Client, connId: string, bucket: string, prefix: string): Promise<boolean> {
    const m = /^(.*?)kopia\/[^/]+\/$/.exec(prefix);
    return m ? this.isLocation(s3, connId, bucket, m[1]!) : false;
  }

  backups(s3: S3Client, connId: string, bucket: string, prefix: string, fresh = false): Promise<VeleroBackup[]> {
    const k = `${connId}\u0000${bucket}\u0000${prefix}`;
    const hit = this.lists.get(k);
    if (hit && !fresh && Date.now() - hit.at < LIST_CACHE_MS) return hit.list;
    const list = (async () => {
      const names: string[] = [];
      let token: string | undefined;
      do {
        const r = await s3.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: `${prefix}backups/`,
            Delimiter: '/',
            ...(token ? { ContinuationToken: token } : {}),
          }),
        );
        for (const p of r.CommonPrefixes ?? []) {
          const name = p.Prefix!.slice(`${prefix}backups/`.length, -1);
          if (BACKUP_NAME.test(name)) names.push(name);
        }
        token = r.IsTruncated ? r.NextContinuationToken : undefined;
      } while (token);
      const out: VeleroBackup[] = [];
      // A few at a time: a location may hold hundreds of backups.
      for (let i = 0; i < names.length; i += 16) {
        const batch = await Promise.all(
          names.slice(i, i + 16).map(async (name) => {
            const raw = await getObject(s3, bucket, `${prefix}backups/${name}/velero-backup.json`, 4 * 1024 * 1024);
            return raw ? toBackup(name, JSON.parse(raw.toString('utf8'))) : null;
          }),
        );
        out.push(...batch.filter((b): b is VeleroBackup => b !== null));
      }
      return out.sort((a, b) => (b.startTime ?? '').localeCompare(a.startTime ?? '') || b.name.localeCompare(a.name));
    })();
    this.lists.set(k, { at: Date.now(), list });
    list.catch(() => this.lists.delete(k));
    return list;
  }

  async backup(s3: S3Client, bucket: string, prefix: string, name: string): Promise<VeleroBackupDetails | null> {
    if (!BACKUP_NAME.test(name)) return null;
    const dir = `${prefix}backups/${name}/`;
    const listing = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: dir }));
    const files = (listing.Contents ?? []).map((o) => ({ name: o.Key!.slice(dir.length), size: o.Size ?? 0 }));
    const tarObj = (listing.Contents ?? []).find((o) => o.Key === `${dir}${name}.tar.gz`);
    const cacheKey = `${bucket}\u0000${dir}\u0000${tarObj?.ETag ?? ''}\u0000${files.length}`;
    const hit = this.details.get(cacheKey);
    if (hit) return hit;

    const raw = await getObject(s3, bucket, `${dir}velero-backup.json`, 4 * 1024 * 1024);
    if (!raw) return null;
    const backup = toBackup(name, JSON.parse(raw.toString('utf8')));
    const [resources, results, volumeInfo, pvbs, tarball] = await Promise.all([
      getObject(s3, bucket, `${dir}${name}-resource-list.json.gz`).then(gunzipJson),
      getObject(s3, bucket, `${dir}${name}-results.gz`).then(gunzipJson),
      getObject(s3, bucket, `${dir}${name}-volumeinfo.json.gz`).then(gunzipJson),
      getObject(s3, bucket, `${dir}${name}-podvolumebackups.json.gz`).then(gunzipJson),
      tarObj ? getObject(s3, bucket, tarObj.Key!, 512 * 1024 * 1024) : null,
    ]);
    const entries = tarball ? readTar(tarball) : [];

    let volumes: VeleroVolume[];
    if (Array.isArray(volumeInfo) && volumeInfo.length) {
      volumes = volumeInfo.map((v) => fromVolumeInfo(v, prefix));
    } else {
      // Data mover: the DataUploads in the tarball (the plain path, not the "-preferredversion" copy).
      const uploads = entries
        .filter((e) => /^resources\/datauploads\.velero\.io\/namespaces\/[^/]+\/[^/]+\.json$/.test(e.name))
        .map((e) => fromDataUpload(JSON.parse(e.data.toString('utf8')), prefix));
      const fs = Array.isArray(pvbs) ? pvbs.map((p) => fromPodVolumeBackup(p, prefix)) : [];
      volumes = [...uploads, ...fs];
    }
    volumes.sort(
      (a, b) =>
        a.namespace.localeCompare(b.namespace) || (a.pvc ?? a.volume ?? '').localeCompare(b.pvc ?? b.volume ?? ''),
    );

    const res: Record<string, string[]> = {};
    for (const [type, items] of Object.entries(obj(resources))) res[type] = strings(items);
    const r = obj(results);
    const details: VeleroBackupDetails = {
      backup,
      resources: res,
      results: results ? { errors: r.errors ?? null, warnings: r.warnings ?? null } : null,
      volumes,
      manifests: entries
        .map((e) => e.name)
        .filter((n) => n.startsWith('resources/') && n.endsWith('.json') && !n.includes('-preferredversion/'))
        .sort(),
      files,
    };
    this.details.set(cacheKey, details);
    return details;
  }

  /** One manifest of the backup's tarball, as listed in `manifests`. */
  async manifest(s3: S3Client, bucket: string, prefix: string, name: string, path: string): Promise<string | null> {
    if (!BACKUP_NAME.test(name) || !path.startsWith('resources/') || !path.endsWith('.json')) return null;
    const tarball = await getObject(s3, bucket, `${prefix}backups/${name}/${name}.tar.gz`, 512 * 1024 * 1024);
    const entry = tarball ? readTar(tarball).find((e) => e.name === path) : undefined;
    return entry ? JSON.stringify(JSON.parse(entry.data.toString('utf8')), null, 2) : null;
  }

  /** The backup's log, decompressed. */
  async logs(s3: S3Client, bucket: string, prefix: string, name: string): Promise<string | null> {
    if (!BACKUP_NAME.test(name)) return null;
    const gz = await getObject(s3, bucket, `${prefix}backups/${name}/${name}-logs.gz`);
    return gz ? gunzipSync(gz, { maxOutputLength: MAX_FILE }).toString('utf8') : null;
  }
}
