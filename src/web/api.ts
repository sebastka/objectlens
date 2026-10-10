import type {
  AppInfo,
  BucketDetails,
  BucketsResponse,
  BulkResult,
  Capabilities,
  EditMetadataRequest,
  ItemRef,
  ListResponse,
  ObjectDetails,
  Resume,
  SearchResponse,
  ShareLink,
  SizeResponse,
  Tag,
  UploadResult,
  VersionEntry,
} from '../shared/types.ts';

/** An API error with its HTTP status and S3 error code. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly body: unknown;
  constructor(status: number, message: string, code: string | null, body: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // not JSON
  }
  if (!res.ok) {
    const b = body as { error?: string; code?: string } | null;
    throw new ApiError(res.status, b?.error ?? `${res.status} ${res.statusText}`, b?.code ?? null, body);
  }
  return body as T;
}

/** Every state-changing request carries X-ObjectLens (the server's CSRF guard). */
const send = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json', 'x-objectlens': '1' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

export function query(f: Record<string, string | number | boolean | null | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

const enc = encodeURIComponent;
const bucketPath = (c: string, b: string) => `/api/c/${enc(c)}/b/${enc(b)}`;

export const downloadUrl = (c: string, b: string, key: string, versionId?: string | null, inline = false) =>
  `${bucketPath(c, b)}/download${query({ key, versionId, inline: inline ? 1 : undefined })}`;

export interface UploadHandle {
  done: Promise<UploadResult>;
  abort: () => void;
}

/** Uploads one file with progress; the body streams to S3 through the server. */
export function upload(
  c: string,
  b: string,
  key: string,
  file: Blob,
  overwrite: boolean,
  onProgress: (loaded: number) => void,
  /** Keep the existing object's metadata and tags (saving an edited file). */
  keep = false,
): UploadHandle {
  const xhr = new XMLHttpRequest();
  const done = new Promise<UploadResult>((resolve, reject) => {
    xhr.open(
      'PUT',
      `${bucketPath(c, b)}/upload${query({ key, overwrite: overwrite ? 1 : undefined, keep: keep ? 1 : undefined })}`,
    );
    xhr.setRequestHeader('x-objectlens', '1');
    xhr.setRequestHeader('x-objectlens-size', String(file.size));
    xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      let body = null as { error?: string; code?: string } | null;
      try {
        body = JSON.parse(xhr.responseText) as typeof body;
      } catch {
        // not JSON
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as unknown as UploadResult);
      else reject(new ApiError(xhr.status, body?.error ?? `${xhr.status} ${xhr.statusText}`, body?.code ?? null, body));
    };
    xhr.onerror = () => reject(new ApiError(0, 'network error', null, null));
    xhr.onabort = () => reject(new ApiError(0, 'cancelled', 'Cancelled', null));
    xhr.send(file);
  });
  return { done, abort: () => xhr.abort() };
}

/**
 * Deletes until done: the server handles at most BULK_LIMIT objects per request, and what it
 * deleted is gone, so asking again continues. Stops when a round makes no progress.
 */
async function deleteAll(c: string, b: string, items: ItemRef[], allVersions: boolean): Promise<BulkResult> {
  let done = 0;
  // A key that fails is listed again by the next round: keep its latest error once.
  const failed = new Map<string, string>();
  for (;;) {
    const r = await request<BulkResult>(`${bucketPath(c, b)}/delete`, send('POST', { items, allVersions }));
    done += r.done;
    for (const f of r.failed) failed.set(f.key, f.error);
    if (!r.truncated || r.done === 0) {
      return { done, failed: [...failed].map(([key, error]) => ({ key, error })), truncated: r.truncated };
    }
  }
}

export const api = {
  info: () => request<AppInfo>('/api/info'),
  buckets: (c: string) => request<BucketsResponse>(`/api/c/${enc(c)}/buckets`),
  createBucket: (c: string, name: string, region: string | null, objectLock: boolean) =>
    request<{ ok: true }>(`/api/c/${enc(c)}/buckets`, send('POST', { name, region, objectLock })),
  deleteBucket: (c: string, b: string) => request<{ ok: true }>(`/api/c/${enc(c)}/buckets/${enc(b)}`, send('DELETE')),
  bucketDetails: (c: string, b: string) => request<BucketDetails>(`${bucketPath(c, b)}/details`),
  capabilities: (c: string, b: string, prefix: string) =>
    request<Capabilities>(`${bucketPath(c, b)}/capabilities${query({ prefix })}`),
  versioning: (c: string, b: string) =>
    request<{ status: 'Enabled' | 'Suspended' | null; known: boolean }>(`${bucketPath(c, b)}/versioning`),
  setVersioning: (c: string, b: string, enabled: boolean) =>
    request<{ ok: true }>(`${bucketPath(c, b)}/versioning`, send('PUT', { enabled })),
  setBucketTags: (c: string, b: string, tags: Tag[]) =>
    request<{ ok: true }>(`${bucketPath(c, b)}/tags`, send('PUT', { tags })),
  list: (c: string, b: string, prefix: string, token?: string | null) =>
    request<ListResponse>(`${bucketPath(c, b)}/list${query({ prefix, token })}`),
  search: (c: string, b: string, prefix: string, q: string) =>
    request<SearchResponse>(`${bucketPath(c, b)}/search${query({ prefix, q })}`),
  size: (c: string, b: string, prefix: string) => request<SizeResponse>(`${bucketPath(c, b)}/size${query({ prefix })}`),
  versions: (c: string, b: string, key: string) =>
    request<VersionEntry[]>(`${bucketPath(c, b)}/versions${query({ key })}`),
  object: (c: string, b: string, key: string, versionId?: string | null) =>
    request<ObjectDetails>(`${bucketPath(c, b)}/object${query({ key, versionId })}`),
  text: async (c: string, b: string, key: string, versionId?: string | null) => {
    const res = await fetch(downloadUrl(c, b, key, versionId, true));
    if (!res.ok) throw new ApiError(res.status, `${res.status} ${res.statusText}`, null, null);
    return res.text();
  },
  createFolder: (c: string, b: string, prefix: string, name: string) =>
    request<{ key: string }>(`${bucketPath(c, b)}/folder`, send('POST', { prefix, name })),
  delete: (c: string, b: string, items: ItemRef[], allVersions = false) => deleteAll(c, b, items, allVersions),
  transfer: (
    c: string,
    b: string,
    req: { items: ItemRef[]; move: boolean; overwrite?: boolean; resume?: Resume | null } & (
      { newName: string } | { toBucket: string; toPrefix: string }
    ),
  ) =>
    request<BulkResult & { conflicts: string[]; resume: Resume | null }>(
      `${bucketPath(c, b)}/transfer`,
      send('POST', req),
    ),
  editMetadata: (c: string, b: string, req: EditMetadataRequest) =>
    request<{ versionId: string | null }>(`${bucketPath(c, b)}/metadata`, send('PUT', req)),
  setObjectTags: (c: string, b: string, key: string, tags: Tag[], versionId?: string | null) =>
    request<{ ok: true }>(`${bucketPath(c, b)}/object-tags`, send('PUT', { key, tags, versionId })),
  restoreVersion: (c: string, b: string, key: string, versionId: string) =>
    request<{ versionId: string | null }>(`${bucketPath(c, b)}/restore-version`, send('POST', { key, versionId })),
  share: (c: string, b: string, key: string, hours: number, versionId?: string | null) =>
    request<ShareLink>(`${bucketPath(c, b)}/share`, send('POST', { key, hours, versionId })),
};
