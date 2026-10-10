// Object and bucket properties, each read with its own request so that one denied or
// unsupported getter does not hide the others.
import {
  GetBucketAclCommand,
  GetBucketCorsCommand,
  GetBucketEncryptionCommand,
  GetBucketLifecycleConfigurationCommand,
  GetBucketLocationCommand,
  GetBucketLoggingCommand,
  GetBucketNotificationConfigurationCommand,
  GetBucketOwnershipControlsCommand,
  GetBucketPolicyCommand,
  GetBucketPolicyStatusCommand,
  GetBucketReplicationCommand,
  GetBucketTaggingCommand,
  GetBucketVersioningCommand,
  GetBucketWebsiteCommand,
  GetObjectAclCommand,
  GetObjectLockConfigurationCommand,
  GetObjectTaggingCommand,
  GetPublicAccessBlockCommand,
  HeadObjectCommand,
  type HeadObjectCommandOutput,
  type Grant as S3Grant,
  type Owner,
  type S3Client,
} from '@aws-sdk/client-s3';
import type { Acl, BucketDetails, ObjectDetails, Section, Tag } from '../shared/types.ts';
import { describe, isNotConfigured, unquote } from './s3.ts';

/** Runs a getter; "not configured" answers become `ok` with null. */
export async function section<T>(fn: () => Promise<T>, notConfigured?: T): Promise<Section<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    if (notConfigured !== undefined && isNotConfigured(e)) return { ok: true, value: notConfigured };
    const f = describe(e);
    return { ok: false, error: f.code === f.message ? f.code : `${f.code}: ${f.message}`, denied: f.denied };
  }
}

/** Strips the SDK's $metadata from a response. */
function plain<T extends object>(o: T): Omit<T, '$metadata'> {
  const { $metadata: _m, ...rest } = o as T & { $metadata?: unknown };
  return rest;
}

const GROUPS: Record<string, string> = {
  'http://acs.amazonaws.com/groups/global/AllUsers': 'Everyone (public)',
  'http://acs.amazonaws.com/groups/global/AuthenticatedUsers': 'Any authenticated AWS account',
  'http://acs.amazonaws.com/groups/s3/LogDelivery': 'S3 log delivery',
};

export function formatAcl(owner: Owner | undefined, grants: S3Grant[] | undefined): Acl {
  return {
    owner: owner?.DisplayName ?? owner?.ID ?? null,
    grants: (grants ?? []).map((g) => {
      const t = g.Grantee;
      const uri = t?.URI ?? null;
      return {
        grantee: (uri && GROUPS[uri]) ?? t?.DisplayName ?? t?.ID ?? t?.EmailAddress ?? uri ?? 'unknown',
        type: t?.Type ?? 'unknown',
        permission: g.Permission ?? 'unknown',
      };
    }),
  };
}

const TEXT_TYPES = /^(text\/|application\/(json|xml|yaml|x-yaml|javascript|x-sh|toml|x-toml|sql|graphql|ld\+json))/;
const TEXT_EXT =
  /\.(txt|md|markdown|csv|tsv|json|jsonl|ndjson|ya?ml|toml|ini|cfg|conf|env|xml|html?|css|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|php|sh|bash|zsh|sql|log|properties|tf|hcl|gitignore|dockerfile|svg)$/i;
/** Image types browsers display; also the only images served inline. */
export const INLINE_IMAGE = /^image\/(png|jpeg|gif|webp|avif|bmp|svg\+xml|x-icon|vnd\.microsoft\.icon)$/;

export function previewKind(key: string, contentType: string | null, size: number, textMax: number) {
  const t = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  if (INLINE_IMAGE.test(t)) return 'image';
  if (t.startsWith('audio/')) return 'audio';
  if (t.startsWith('video/')) return 'video';
  if (t === 'application/pdf') return 'pdf';
  if ((TEXT_TYPES.test(t) || TEXT_EXT.test(key)) && size <= textMax) return 'text';
  // Uploaded without a proper type: fall back to the extension for media too.
  if (t === '' || t === 'application/octet-stream' || t === 'binary/octet-stream') {
    if (/\.(png|jpe?g|gif|webp|avif|bmp)$/i.test(key)) return 'image';
    if (/\.pdf$/i.test(key)) return 'pdf';
  }
  return null;
}

const IMAGE_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
};

/**
 * The type an inline preview is served with: chosen by ObjectLens, never taken unchecked from
 * the object (it could say text/html). null = not shown inline (served as an attachment).
 */
export function inlineType(key: string, contentType: string | null): { kind: string; type: string } | null {
  const kind = previewKind(key, contentType, Infinity, Infinity);
  const t = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  switch (kind) {
    case 'text':
      return { kind, type: 'text/plain; charset=utf-8' };
    case 'pdf':
      return { kind, type: 'application/pdf' };
    case 'image': {
      const type = INLINE_IMAGE.test(t) ? t : IMAGE_EXT[key.slice(key.lastIndexOf('.') + 1).toLowerCase()];
      return type ? { kind, type } : null;
    }
    case 'audio':
    case 'video':
      return { kind, type: t };
    default:
      return null;
  }
}

const iso = (d: Date | undefined) => (d ? d.toISOString() : null);

/** HeadObject fields beyond size, date, ETag and HTTP headers, as label/value rows. */
export function s3Rows(h: HeadObjectCommandOutput): { label: string; value: string }[] {
  const rows: [string, unknown][] = [
    ['Storage class', h.StorageClass ?? 'STANDARD'],
    ['Version ID', h.VersionId],
    ['Server-side encryption', h.ServerSideEncryption],
    ['KMS key', h.SSEKMSKeyId],
    ['S3 Bucket Key', h.BucketKeyEnabled === undefined ? undefined : h.BucketKeyEnabled ? 'enabled' : 'disabled'],
    ['Customer-provided key (SSE-C)', h.SSECustomerAlgorithm],
    ['Object lock mode', h.ObjectLockMode],
    ['Retain until', iso(h.ObjectLockRetainUntilDate)],
    ['Legal hold', h.ObjectLockLegalHoldStatus],
    ['Replication status', h.ReplicationStatus],
    ['Archive status', h.ArchiveStatus],
    ['Restore', h.Restore],
    ['Expiration (lifecycle)', h.Expiration],
    ['Checksum type', h.ChecksumType],
    ['CRC32', h.ChecksumCRC32],
    ['CRC32C', h.ChecksumCRC32C],
    ['CRC64NVME', h.ChecksumCRC64NVME],
    ['SHA-1', h.ChecksumSHA1],
    ['SHA-256', h.ChecksumSHA256],
    ['Unreadable metadata entries', h.MissingMeta],
  ];
  // A multipart upload's ETag is the MD5 of the part MD5s, suffixed with the part count.
  const parts = /-(\d+)$/.exec(unquote(h.ETag) ?? '');
  if (parts) rows.push(['Uploaded in parts', `${parts[1]} parts (the ETag is not the MD5 of the content)`]);
  return rows
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([label, v]) => ({ label, value: String(v) }));
}

export async function objectDetails(
  s3: S3Client,
  bucket: string,
  key: string,
  versionId: string | null,
  textMax: number,
): Promise<ObjectDetails> {
  const v = versionId ? { VersionId: versionId } : {};
  const [head, tags, acl] = await Promise.all([
    s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key, ChecksumMode: 'ENABLED', ...v })),
    section(async () => {
      const r = await s3.send(new GetObjectTaggingCommand({ Bucket: bucket, Key: key, ...v }));
      return (r.TagSet ?? []).map((t): Tag => ({ key: t.Key ?? '', value: t.Value ?? '' }));
    }),
    section(async () => {
      const r = await s3.send(new GetObjectAclCommand({ Bucket: bucket, Key: key, ...v }));
      return formatAcl(r.Owner, r.Grants);
    }),
  ]);
  const size = head.ContentLength ?? 0;
  const contentType = head.ContentType ?? null;
  return {
    key,
    bucket,
    versionId: head.VersionId ?? null,
    size,
    lastModified: iso(head.LastModified),
    etag: unquote(head.ETag),
    storageClass: head.StorageClass ?? 'STANDARD',
    system: {
      contentType,
      cacheControl: head.CacheControl ?? null,
      contentDisposition: head.ContentDisposition ?? null,
      contentEncoding: head.ContentEncoding ?? null,
      contentLanguage: head.ContentLanguage ?? null,
      // ExpiresString keeps unparseable values; Expires is the parsed date.
      expires: head.ExpiresString ?? iso(head.Expires),
      websiteRedirectLocation: head.WebsiteRedirectLocation ?? null,
    },
    metadata: head.Metadata ?? {},
    s3: s3Rows(head),
    tags,
    acl,
    preview: previewKind(key, contentType, size, textMax),
  };
}

export async function bucketDetails(s3: S3Client, bucket: string): Promise<BucketDetails> {
  const B = { Bucket: bucket };
  const [
    region,
    versioning,
    encryption,
    objectLock,
    publicAccessBlock,
    ownershipControls,
    policy,
    policyStatus,
    acl,
    cors,
    lifecycle,
    tags,
    website,
    logging,
    replication,
    notification,
  ] = await Promise.all([
    section(async () => {
      const r = await s3.send(new GetBucketLocationCommand(B));
      // An empty location constraint is us-east-1 (historic); "EU" is eu-west-1.
      return r.LocationConstraint || 'us-east-1';
    }),
    section(async () => {
      const r = await s3.send(new GetBucketVersioningCommand(B));
      return { status: r.Status ?? 'Never enabled', mfaDelete: r.MFADelete ?? null };
    }),
    section(async () => plain(await s3.send(new GetBucketEncryptionCommand(B))), null),
    section(async () => plain(await s3.send(new GetObjectLockConfigurationCommand(B))), null),
    section(async () => plain(await s3.send(new GetPublicAccessBlockCommand(B))), null),
    section(async () => plain(await s3.send(new GetBucketOwnershipControlsCommand(B))), null),
    section<unknown>(async () => {
      const r = await s3.send(new GetBucketPolicyCommand(B));
      try {
        return r.Policy ? JSON.parse(r.Policy) : null;
      } catch {
        return r.Policy;
      }
    }, null),
    section(async () => {
      const r = await s3.send(new GetBucketPolicyStatusCommand(B));
      return { isPublic: r.PolicyStatus?.IsPublic ?? false };
    }, null),
    section(async () => {
      const r = await s3.send(new GetBucketAclCommand(B));
      return formatAcl(r.Owner, r.Grants);
    }),
    section(async () => plain(await s3.send(new GetBucketCorsCommand(B))), null),
    section(async () => plain(await s3.send(new GetBucketLifecycleConfigurationCommand(B))), null),
    section(async () => {
      const r = await s3.send(new GetBucketTaggingCommand(B));
      return (r.TagSet ?? []).map((t): Tag => ({ key: t.Key ?? '', value: t.Value ?? '' }));
    }, []),
    section(async () => plain(await s3.send(new GetBucketWebsiteCommand(B))), null),
    section(async () => {
      const r = plain(await s3.send(new GetBucketLoggingCommand(B)));
      return r.LoggingEnabled ? r : null;
    }, null),
    section(async () => plain(await s3.send(new GetBucketReplicationCommand(B))), null),
    section(async () => {
      const r = plain(await s3.send(new GetBucketNotificationConfigurationCommand(B)));
      return Object.values(r).some((v) => Array.isArray(v) && v.length) ? r : null;
    }, null),
  ]);
  return {
    name: bucket,
    region,
    versioning,
    encryption,
    objectLock,
    publicAccessBlock,
    ownershipControls,
    policy,
    policyStatus,
    acl,
    cors,
    lifecycle,
    tags,
    website,
    logging,
    replication,
    notification,
  };
}
