// The API contract between the server and the UI.

export interface ConnectionInfo {
  id: string;
  name: string;
  /** Endpoint host for display ("AWS S3" when the SDK default is used). */
  endpoint: string;
  region: string;
  /** S3_n_READ_ONLY: nothing is ever written through this connection. */
  readOnly: boolean;
  /** Presigned share links are enabled for this connection. */
  shareLinks: boolean;
}

export interface AppInfo {
  connections: ConnectionInfo[];
  limits: { bulk: number; textBytes: number; shareMaxHours: number };
}

/**
 * What the S3 credentials may do in a bucket (and prefix). S3 has no "what may I do" API, so
 * each one is known from a side-effect-free probe, the connection's READ_ONLY setting or the
 * outcome of an earlier request; null = not known yet (the UI then lets the user try).
 */
export const CAP_KEYS = ['list', 'read', 'write', 'delete', 'tags', 'versions', 'bucketConfig'] as const;
export type CapKey = (typeof CAP_KEYS)[number];

export interface Capability {
  allowed: boolean | null;
  /** Why it is denied or how it is known, for the tooltip. */
  reason: string | null;
}
export type Capabilities = Record<CapKey, Capability>;

export interface BucketEntry {
  name: string;
  createdAt: string | null;
}

export interface BucketsResponse {
  buckets: BucketEntry[];
  /** "list" = ListBuckets; "config" = S3_n_BUCKETS (ListBuckets denied or not wanted). */
  source: 'list' | 'config';
  /** Why ListBuckets failed, when it did. */
  error: string | null;
  canCreate: Capability;
}

export interface ObjectEntry {
  key: string;
  size: number;
  lastModified: string | null;
  etag: string | null;
  storageClass: string | null;
}

export interface ListResponse {
  prefix: string;
  /** Common prefixes ("sub/folders/"), full keys. */
  folders: string[];
  objects: ObjectEntry[];
  /** Continuation token for the next page; null on the last page. */
  nextToken: string | null;
}

export interface SearchResponse {
  prefix: string;
  query: string;
  objects: ObjectEntry[];
  /** Number of keys looked at. */
  scanned: number;
  /** The scan stopped at the limit before the end of the prefix. */
  truncated: boolean;
}

export interface SizeResponse {
  prefix: string;
  objects: number;
  bytes: number;
  truncated: boolean;
}

export interface VersionEntry {
  key: string;
  versionId: string;
  isLatest: boolean;
  isDeleteMarker: boolean;
  size: number | null;
  lastModified: string | null;
  etag: string | null;
  storageClass: string | null;
}

/** One part of a details page that is read with its own S3 request and may fail on its own. */
export type Section<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      error: string;
      /** AccessDenied rather than another failure. */
      denied: boolean;
    };

export interface Tag {
  key: string;
  value: string;
}

export interface Grant {
  grantee: string;
  type: string;
  permission: string;
}

export interface Acl {
  owner: string | null;
  grants: Grant[];
}

/** The standard HTTP headers stored with an object, as editable fields. */
export interface SystemMetadata {
  contentType: string | null;
  cacheControl: string | null;
  contentDisposition: string | null;
  contentEncoding: string | null;
  contentLanguage: string | null;
  expires: string | null;
  websiteRedirectLocation: string | null;
}

export interface ObjectDetails {
  key: string;
  bucket: string;
  versionId: string | null;
  size: number;
  lastModified: string | null;
  etag: string | null;
  system: SystemMetadata;
  /** x-amz-meta-* (user-defined) metadata, without the prefix. */
  metadata: Record<string, string>;
  /** Everything else HeadObject says about the object, as label → value. */
  s3: { label: string; value: string }[];
  storageClass: string;
  tags: Section<Tag[]>;
  acl: Section<Acl>;
  /** Whether a sensible text or media preview exists (by type and size). */
  preview: 'text' | 'image' | 'audio' | 'video' | 'pdf' | null;
}

export interface BucketDetails {
  name: string;
  region: Section<string>;
  versioning: Section<{ status: string; mfaDelete: string | null }>;
  encryption: Section<unknown>;
  objectLock: Section<unknown>;
  publicAccessBlock: Section<unknown>;
  ownershipControls: Section<unknown>;
  policy: Section<unknown>;
  policyStatus: Section<{ isPublic: boolean } | null>;
  acl: Section<Acl>;
  cors: Section<unknown>;
  lifecycle: Section<unknown>;
  tags: Section<Tag[]>;
  website: Section<unknown>;
  logging: Section<unknown>;
  replication: Section<unknown>;
  notification: Section<unknown>;
}

export interface BulkResult {
  /** Objects done. */
  done: number;
  failed: { key: string; error: string }[];
  /** Stopped at BULK_LIMIT before everything was done; running it again continues. */
  truncated: boolean;
}

/** Where a truncated copy or move continues: item `pair`, after its source key `after`. */
export interface Resume {
  pair: number;
  after: string;
}

export interface UploadResult {
  key: string;
  etag: string | null;
  versionId: string | null;
}

export interface ShareLink {
  url: string;
  expiresAt: string;
}

/** Item of a copy, move or delete request: a single key or a whole prefix ("folder/"). */
export type ItemRef = { key: string; versionId?: string } | { prefix: string };

export interface EditMetadataRequest {
  key: string;
  system: SystemMetadata;
  metadata: Record<string, string>;
  storageClass?: string;
}

// --- kopia repositories (read-only) ---------------------------------------------------------

export interface KopiaStatus {
  /** The kopia binary could be run. */
  installed: boolean;
  kopiaVersion: string | null;
  /** No password known yet: the UI asks for one. */
  locked: boolean;
  /** Where the password came from: the connection's KOPIA_PASSWORD, or typed in the UI. */
  passwordSource: 'env' | 'ui' | null;
  /** Format and storage settings, only once unlocked (never keys or secrets). */
  repository: { label: string; value: string }[] | null;
  /** Why the repository could not be opened. */
  error: string | null;
}

export interface KopiaSummary {
  size: number;
  files: number;
  dirs: number;
  symlinks: number;
  /** Entries kopia could not read when it took the snapshot. */
  failed: number;
  /** Latest modification time below this folder. */
  maxTime: string | null;
}

export interface KopiaSnapshot {
  id: string;
  source: { host: string; user: string; path: string };
  description: string;
  startTime: string;
  endTime: string | null;
  /** null = complete; otherwise kopia's reason, e.g. "checkpoint" or "canceled". */
  incomplete: string | null;
  /** Retention reasons ("latest-1", "daily-3", "incomplete", …). */
  retention: string[];
  pins: string[];
  rootType: string;
  summary: KopiaSummary | null;
  errors: number;
}

export interface KopiaEntry {
  name: string;
  /** "f" file, "d" directory, "s" symlink, other kopia types as reported. */
  type: string;
  size: number | null;
  mtime: string | null;
  /** Unix permission bits as an octal string ("0644"). */
  mode: string | null;
  uid: number | null;
  gid: number | null;
  /** kopia object ID (content-addressed). */
  oid: string;
  /** Folders: what is below them. */
  summary: KopiaSummary | null;
}

export interface KopiaBrowse {
  snapshot: KopiaSnapshot;
  /** Path inside the snapshot, "" for its root. */
  path: string;
  entries: KopiaEntry[];
  summary: KopiaSummary | null;
}
