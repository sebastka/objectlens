// S3 clients and the object operations that need more than one request.
import { Agent as HttpsAgent } from 'node:https';
import {
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  type CopyObjectCommandInput,
  CreateMultipartUploadCommand,
  AbortMultipartUploadCommand,
  GetObjectAclCommand,
  GetObjectTaggingCommand,
  type Grant,
  HeadObjectCommand,
  type Owner,
  PutObjectAclCommand,
  type HeadObjectCommandOutput,
  S3Client,
  S3ServiceException,
  UploadPartCopyCommand,
} from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import type { ConnectionConfig } from './config.ts';

export function createClient(c: ConnectionConfig, endpoint = c.endpoint): S3Client {
  return new S3Client({
    region: c.region,
    ...(endpoint ? { endpoint } : {}),
    forcePathStyle: c.forcePathStyle,
    ...(c.credentials ? { credentials: c.credentials } : {}),
    ...(c.profile ? { profile: c.profile } : {}),
    // Buckets in other regions than S3_n_REGION answer with a redirect the SDK can follow.
    followRegionRedirects: true,
    // Only compute and require checksums where S3 requires them: several S3-compatible servers
    // reject the newer default CRC checksums.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    ...(c.rejectUnauthorized
      ? {}
      : { requestHandler: new NodeHttpHandler({ httpsAgent: new HttpsAgent({ rejectUnauthorized: false }) }) }),
  });
}

/** S3 error codes that mean "these credentials may not do this". */
const DENIED = new Set(['AccessDenied', 'AllAccessDisabled', 'Forbidden', 'AccessControlListNotSupported']);

export interface S3Failure {
  code: string;
  message: string;
  status: number;
  denied: boolean;
}

/** Normalises SDK and network errors. */
export function describe(e: unknown): S3Failure {
  if (e instanceof S3ServiceException) {
    const status = e.$metadata.httpStatusCode ?? 500;
    // HEAD responses have no body, so the SDK only knows the status.
    const code =
      e.name === 'Unknown' || e.name === 'UnknownError' ? (status === 403 ? 'AccessDenied' : e.name) : e.name;
    return { code, message: e.message || code, status, denied: DENIED.has(code) || status === 403 };
  }
  const err = e as { name?: string; message?: string; code?: string };
  return {
    code: err.code ?? err.name ?? 'Error',
    message: err.message ?? String(e),
    status: 502,
    denied: false,
  };
}

export const isDenied = (e: unknown) => describe(e).denied;

/** "Not configured" answers of the bucket configuration getters. */
const NOT_CONFIGURED = new Set([
  'NoSuchBucketPolicy',
  'NoSuchCORSConfiguration',
  'NoSuchLifecycleConfiguration',
  'NoSuchTagSet',
  'NoSuchTagSetError',
  'NoSuchWebsiteConfiguration',
  'ReplicationConfigurationNotFoundError',
  'ServerSideEncryptionConfigurationNotFoundError',
  'ObjectLockConfigurationNotFoundError',
  'NoSuchPublicAccessBlockConfiguration',
  'OwnershipControlsNotFoundError',
  'NoSuchObjectLockConfiguration',
]);
export const isNotConfigured = (e: unknown) => NOT_CONFIGURED.has(describe(e).code);

/** S3 returns ETags in quotes. */
export const unquote = (etag: string | undefined | null) => (etag ? etag.replace(/^"|"$/g, '') : null);

/** The largest object CopyObject handles in one request (5 GiB). */
export const COPY_SINGLE_MAX = 5 * 1024 ** 3;
const COPY_PART_SIZE = 512 * 1024 ** 2;

/** RFC 3986 encoding of a key for x-amz-copy-source ("/" kept). */
export const copySource = (bucket: string, key: string, versionId?: string) =>
  `${bucket}/${key.split('/').map(encodeURIComponent).join('/')}${versionId ? `?versionId=${encodeURIComponent(versionId)}` : ''}`;

export interface CopyOptions {
  /** Replace metadata and headers instead of copying them (REPLACE directive). */
  replace?: Pick<
    CopyObjectCommandInput,
    | 'ContentType'
    | 'CacheControl'
    | 'ContentDisposition'
    | 'ContentEncoding'
    | 'ContentLanguage'
    | 'Expires'
    | 'WebsiteRedirectLocation'
    | 'Metadata'
  >;
  storageClass?: string;
  sourceVersionId?: string;
  /** HeadObject of the source, when the caller already has it. */
  head?: HeadObjectCommandOutput;
}

/**
 * Copies one object, keeping its encryption (CopyObject would otherwise apply the bucket
 * default) and, unless replaced, its metadata and tags. Objects over 5 GiB are copied with a
 * multipart upload of server-side part copies; nothing goes through this process.
 */
export async function copyObject(
  s3: S3Client,
  src: { bucket: string; key: string },
  dst: { bucket: string; key: string },
  opts: CopyOptions = {},
): Promise<{ versionId: string | null }> {
  const head =
    opts.head ??
    (await s3.send(
      new HeadObjectCommand({
        Bucket: src.bucket,
        Key: src.key,
        ...(opts.sourceVersionId ? { VersionId: opts.sourceVersionId } : {}),
      }),
    ));
  const encryption = {
    ...(head.ServerSideEncryption ? { ServerSideEncryption: head.ServerSideEncryption } : {}),
    ...(head.SSEKMSKeyId ? { SSEKMSKeyId: head.SSEKMSKeyId } : {}),
    ...(head.BucketKeyEnabled !== undefined ? { BucketKeyEnabled: head.BucketKeyEnabled } : {}),
  };
  const storageClass = opts.storageClass ?? head.StorageClass;
  const source = copySource(src.bucket, src.key, opts.sourceVersionId);
  const size = head.ContentLength ?? 0;
  const srcVersion = opts.sourceVersionId ? { VersionId: opts.sourceVersionId } : {};
  // Read before copying: when copying onto itself, the source is replaced by the copy.
  const acl = await s3
    .send(new GetObjectAclCommand({ Bucket: src.bucket, Key: src.key, ...srcVersion }))
    .catch(() => null);
  const restoreAcl = async (versionId: string | undefined) => {
    // CopyObject never copies ACLs: the copy would be private. Only non-default ACLs are
    // reapplied (best effort: buckets with "bucket owner enforced" refuse ACLs anyway).
    if (!acl?.Owner || !hasExtraGrants(acl.Owner, acl.Grants)) return;
    await s3
      .send(
        new PutObjectAclCommand({
          Bucket: dst.bucket,
          Key: dst.key,
          ...(versionId ? { VersionId: versionId } : {}),
          AccessControlPolicy: { Owner: acl.Owner, Grants: acl.Grants },
        }),
      )
      .catch((e: unknown) =>
        console.warn(`[copy] ACL of ${dst.bucket}/${dst.key} not restored: ${describe(e).message}`),
      );
  };

  if (size <= COPY_SINGLE_MAX) {
    const out = await s3.send(
      new CopyObjectCommand({
        Bucket: dst.bucket,
        Key: dst.key,
        CopySource: source,
        ...encryption,
        ...(storageClass ? { StorageClass: storageClass as CopyObjectCommandInput['StorageClass'] } : {}),
        ...(opts.replace ? { MetadataDirective: 'REPLACE', ...opts.replace } : { MetadataDirective: 'COPY' }),
        TaggingDirective: 'COPY',
      }),
    );
    await restoreAcl(out.VersionId);
    return { versionId: out.VersionId ?? null };
  }

  // Multipart copy: neither metadata nor tags are copied by CreateMultipartUpload, so they are
  // passed explicitly (tags read first: when copying onto itself the source is replaced).
  const meta = opts.replace ?? {
    ContentType: head.ContentType,
    CacheControl: head.CacheControl,
    ContentDisposition: head.ContentDisposition,
    ContentEncoding: head.ContentEncoding,
    ContentLanguage: head.ContentLanguage,
    Expires: head.Expires,
    WebsiteRedirectLocation: head.WebsiteRedirectLocation,
    Metadata: head.Metadata,
  };
  const tags = await s3
    .send(new GetObjectTaggingCommand({ Bucket: src.bucket, Key: src.key, ...srcVersion }))
    .catch(() => null);
  const tagging = tags?.TagSet?.length
    ? new URLSearchParams(tags.TagSet.map((t) => [t.Key ?? '', t.Value ?? ''])).toString()
    : undefined;
  const { UploadId } = await s3.send(
    new CreateMultipartUploadCommand({
      Bucket: dst.bucket,
      Key: dst.key,
      ...encryption,
      ...(storageClass ? { StorageClass: storageClass as CopyObjectCommandInput['StorageClass'] } : {}),
      ...(tagging ? { Tagging: tagging } : {}),
      ...Object.fromEntries(Object.entries(meta).filter(([, v]) => v !== undefined)),
    }),
  );
  try {
    const parts: { ETag: string; PartNumber: number }[] = [];
    for (let start = 0, n = 1; start < size; start += COPY_PART_SIZE, n++) {
      const end = Math.min(size, start + COPY_PART_SIZE) - 1;
      const r = await s3.send(
        new UploadPartCopyCommand({
          Bucket: dst.bucket,
          Key: dst.key,
          UploadId,
          PartNumber: n,
          CopySource: source,
          CopySourceRange: `bytes=${start}-${end}`,
        }),
      );
      parts.push({ ETag: r.CopyPartResult!.ETag!, PartNumber: n });
    }
    const out = await s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: dst.bucket,
        Key: dst.key,
        UploadId,
        MultipartUpload: { Parts: parts },
      }),
    );
    await restoreAcl(out.VersionId);
    return { versionId: out.VersionId ?? null };
  } catch (e) {
    await s3.send(new AbortMultipartUploadCommand({ Bucket: dst.bucket, Key: dst.key, UploadId })).catch(() => {});
    throw e;
  }
}

/** Whether an ACL grants anything beyond the owner's own FULL_CONTROL (the default). */
export function hasExtraGrants(owner: Owner, grants: Grant[] | undefined): boolean {
  return (grants ?? []).some(
    (g) =>
      !(
        g.Grantee?.Type === 'CanonicalUser' &&
        // Some servers (RustFS) leave out the owner's ID in its own grant.
        (!g.Grantee.ID || g.Grantee.ID === owner.ID) &&
        g.Permission === 'FULL_CONTROL'
      ),
  );
}
