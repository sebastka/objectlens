import { useState } from 'react';
import { baseName, breadcrumbs, bucketNameError, nameError } from '../../shared/keys.ts';
import type { BulkResult, ItemRef, Resume, ShareLink } from '../../shared/types.ts';
import { api } from '../api.ts';
import { dateTime, plural } from '../format.ts';
import { useAsync } from '../hooks.ts';
import { Icon } from './icons.tsx';
import { ErrorBanner, InfoBanner, Modal, Spinner } from './ui.tsx';

const itemName = (i: ItemRef) => ('key' in i ? baseName(i.key) : `${baseName(i.prefix)}/`);

/** Runs an async submit, showing its error in the dialog. */
function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

export function NameDialog({
  title,
  label,
  initial = '',
  submitLabel,
  onSubmit,
  onClose,
}: {
  title: string;
  label: string;
  initial?: string;
  submitLabel: string;
  onSubmit: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial);
  const { busy, error, run } = useSubmit();
  const invalid = nameError(name);
  const submit = () => {
    if (!invalid && name !== initial) void run(() => onSubmit(name));
  };
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy || Boolean(invalid) || name === initial}
            onClick={submit}
          >
            {busy ? <Spinner /> : null}
            {submitLabel}
          </button>
        </>
      }
    >
      <label className="field-stack">
        {label}
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          onFocus={(e) => {
            // Select the name without its extension, as file managers do.
            const dot = e.target.value.lastIndexOf('.');
            e.target.setSelectionRange(0, dot > 0 ? dot : e.target.value.length);
          }}
        />
      </label>
      {name && invalid && <div className="field-error">{invalid}</div>}
      {error && <ErrorBanner>{error}</ErrorBanner>}
    </Modal>
  );
}

export function DeleteDialog({
  items,
  versioned,
  canDeleteVersions,
  onSubmit,
  onClose,
}: {
  items: ItemRef[];
  /** The bucket keeps versions: a delete only adds delete markers. */
  versioned: boolean;
  canDeleteVersions: boolean;
  onSubmit: (allVersions: boolean) => Promise<void>;
  onClose: () => void;
}) {
  const [allVersions, setAllVersions] = useState(false);
  const { busy, error, run } = useSubmit();
  const folders = items.filter((i) => 'prefix' in i).length;
  const singleVersion = items.length === 1 && 'key' in items[0]! && items[0].versionId;
  return (
    <Modal
      title={singleVersion ? 'Delete this version?' : `Delete ${plural(items.length, 'item')}?`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn-danger-solid"
            disabled={busy}
            onClick={() => void run(() => onSubmit(allVersions))}
          >
            {busy ? <Spinner /> : <Icon name="trash" />}
            {allVersions || singleVersion ? 'Delete permanently' : 'Delete'}
          </button>
        </>
      }
    >
      <ul className="item-list">
        {items.slice(0, 8).map((i) => (
          <li key={'key' in i ? `${i.key}@${i.versionId ?? ''}` : i.prefix} className="mono">
            {itemName(i)}
            {'key' in i && i.versionId ? <span className="muted"> · version {i.versionId}</span> : null}
          </li>
        ))}
        {items.length > 8 && <li className="muted">… and {items.length - 8} more</li>}
      </ul>
      {folders > 0 && <p>Folders are deleted with everything in them.</p>}
      {singleVersion ? (
        <p>This version is removed for good; other versions stay.</p>
      ) : versioned ? (
        <>
          <p>
            Versioning is on: a delete hides the objects behind delete markers, and their data stays available as older
            versions.
          </p>
          <label className="check" title={canDeleteVersions ? undefined : 'Listing versions is not allowed'}>
            <input
              type="checkbox"
              checked={allVersions}
              disabled={!canDeleteVersions}
              onChange={(e) => setAllVersions(e.target.checked)}
            />
            Delete every version too, permanently
          </label>
        </>
      ) : (
        <p>This cannot be undone.</p>
      )}
      {error && <ErrorBanner>{error}</ErrorBanner>}
    </Modal>
  );
}

/** Browses folders of a bucket, for picking a destination. */
function FolderPicker({
  conn,
  bucket,
  prefix,
  onPrefix,
}: {
  conn: string;
  bucket: string;
  prefix: string;
  onPrefix: (p: string) => void;
}) {
  const list = useAsync(() => api.list(conn, bucket, prefix), [conn, bucket, prefix]);
  return (
    <div className="picker">
      <div className="crumbs small">
        <button type="button" className="btn-link" onClick={() => onPrefix('')}>
          {bucket}
        </button>
        {breadcrumbs(prefix).map((c) => (
          <span key={c.prefix}>
            <Icon name="chevronRight" size={12} />
            <button type="button" className="btn-link" onClick={() => onPrefix(c.prefix)}>
              {c.name}
            </button>
          </span>
        ))}
      </div>
      <ul className="picker-list">
        {list.loading && !list.data && (
          <li>
            <Spinner />
          </li>
        )}
        {list.error && <li className="field-error">{list.error.message}</li>}
        {list.data?.folders.map((f) => (
          <li key={f}>
            <button type="button" className="picker-item" onClick={() => onPrefix(f)}>
              <Icon name="folder" /> {baseName(f)}
            </button>
          </li>
        ))}
        {list.data && !list.data.folders.length && <li className="muted small">No subfolders</li>}
      </ul>
    </div>
  );
}

export function TransferDialog({
  conn,
  bucket,
  items,
  move,
  buckets,
  initialPrefix,
  onDone,
  onClose,
}: {
  conn: string;
  bucket: string;
  items: ItemRef[];
  move: boolean;
  buckets: string[];
  initialPrefix: string;
  onDone: (msg: string, toBucket: string, toPrefix: string) => void;
  onClose: () => void;
}) {
  const [toBucket, setToBucket] = useState(bucket);
  const [toPrefix, setToPrefix] = useState(initialPrefix);
  const [conflicts, setConflicts] = useState<string[] | null>(null);
  const { busy, error, run } = useSubmit();
  const verb = move ? 'Move' : 'Copy';
  const prefixOk = toPrefix === '' || toPrefix.endsWith('/');

  // The server handles at most BULK_LIMIT objects per request: continue until done.
  const [progress, setProgress] = useState<{ done: number; failed: BulkResult['failed']; resume: Resume } | null>(null);
  const go = (overwrite: boolean) =>
    run(async () => {
      let done = progress?.done ?? 0;
      const failed = [...(progress?.failed ?? [])];
      let resume: Resume | null = progress?.resume ?? null;
      for (;;) {
        let r;
        try {
          r = await api.transfer(conn, bucket, { items, move, overwrite, toBucket, toPrefix, resume });
        } catch (e) {
          const body = (e as { body?: { conflicts?: string[] } }).body;
          if ((e as { status?: number }).status === 409 && body?.conflicts) {
            setConflicts(body.conflicts);
            if (resume) setProgress({ done, failed, resume });
            return;
          }
          throw e;
        }
        done += r.done;
        failed.push(...r.failed);
        if (!r.resume) break;
        resume = r.resume;
        setProgress({ done, failed, resume });
      }
      const f = failed.length ? `, ${failed.length} failed: ${failed[0]!.key}: ${failed[0]!.error}` : '';
      onDone(`${move ? 'Moved' : 'Copied'} ${plural(done, 'object')}${f}`, toBucket, toPrefix);
    });

  return (
    <Modal
      title={`${verb} ${plural(items.length, 'item')}`}
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          {conflicts ? (
            <button type="submit" className="btn btn-danger-solid" disabled={busy} onClick={() => void go(true)}>
              {busy ? <Spinner /> : null}
              Overwrite {plural(conflicts.length, 'object')}
            </button>
          ) : (
            <button
              type="submit"
              className="btn btn-primary"
              disabled={busy || !prefixOk}
              onClick={() => void go(false)}
            >
              {busy ? <Spinner /> : <Icon name={move ? 'move' : 'copy'} />}
              {verb} here
            </button>
          )}
        </>
      }
    >
      <p className="muted small">
        {items.slice(0, 4).map(itemName).join(', ')}
        {items.length > 4 ? ` and ${items.length - 4} more` : ''}
      </p>
      <div className="form-grid">
        <label className="field-stack">
          Bucket
          <select
            value={toBucket}
            onChange={(e) => {
              setToBucket(e.target.value);
              setToPrefix('');
              setConflicts(null);
            }}
          >
            {buckets.map((b) => (
              <option key={b}>{b}</option>
            ))}
          </select>
        </label>
        <label className="field-stack">
          Folder
          <input
            className="mono"
            value={toPrefix}
            placeholder="(bucket root)"
            onChange={(e) => {
              setToPrefix(e.target.value);
              setConflicts(null);
            }}
          />
        </label>
      </div>
      {!prefixOk && <div className="field-error">A folder ends with "/".</div>}
      <FolderPicker
        conn={conn}
        bucket={toBucket}
        prefix={prefixOk ? toPrefix : ''}
        onPrefix={(p) => {
          setToPrefix(p);
          setConflicts(null);
        }}
      />
      {move && <InfoBanner>A move copies each object, then deletes the original.</InfoBanner>}
      {progress && busy && (
        <Spinner label={`${move ? 'Moved' : 'Copied'} ${plural(progress.done, 'object')} so far…`} />
      )}
      {conflicts && (
        <ErrorBanner>
          {plural(conflicts.length, 'object')} already exist at the destination, e.g.{' '}
          <span className="mono">{conflicts[0]}</span>.{' '}
          {progress
            ? `${plural(progress.done, 'object')} were ${move ? 'moved' : 'copied'} before them.`
            : `Nothing was ${move ? 'moved' : 'copied'} yet.`}
        </ErrorBanner>
      )}
      {error && <ErrorBanner>{error}</ErrorBanner>}
    </Modal>
  );
}

const SHARE_CHOICES = [
  { hours: 1, label: '1 hour' },
  { hours: 24, label: '1 day' },
  { hours: 72, label: '3 days' },
  { hours: 168, label: '7 days' },
];

export function ShareDialog({
  conn,
  bucket,
  objectKey,
  versionId,
  maxHours,
  onClose,
}: {
  conn: string;
  bucket: string;
  objectKey: string;
  versionId: string | null;
  maxHours: number;
  onClose: () => void;
}) {
  const choices = SHARE_CHOICES.filter((c) => c.hours <= maxHours);
  const [hours, setHours] = useState(choices[1]?.hours ?? choices[0]?.hours ?? 1);
  const [link, setLink] = useState<ShareLink | null>(null);
  const [copied, setCopied] = useState(false);
  const { busy, error, run } = useSubmit();
  return (
    <Modal
      title="Share link"
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                setLink(await api.share(conn, bucket, objectKey, hours, versionId));
                setCopied(false);
              })
            }
          >
            {busy ? <Spinner /> : <Icon name="link" />}
            {link ? 'New link' : 'Create link'}
          </button>
        </>
      }
    >
      <p>
        A presigned URL: anyone who has it can download <span className="mono">{baseName(objectKey)}</span> directly
        from S3 until it expires, without ObjectLens. It cannot be revoked, except by changing the credentials.
      </p>
      <label className="field-stack">
        Valid for
        <select value={hours} onChange={(e) => setHours(Number(e.target.value))}>
          {choices.map((c) => (
            <option key={c.hours} value={c.hours}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      {link && (
        <div className="share-link">
          <textarea readOnly value={link.url} rows={4} className="mono" onFocus={(e) => e.target.select()} />
          <div className="inline">
            <button
              type="button"
              className="btn"
              onClick={() => void navigator.clipboard.writeText(link.url).then(() => setCopied(true))}
            >
              <Icon name={copied ? 'check' : 'copy'} />
              {copied ? 'Copied' : 'Copy'}
            </button>
            <span className="muted small">Expires {dateTime(link.expiresAt)}</span>
          </div>
          <p className="muted small">
            Temporary credentials (session tokens, SSO) end sooner: the link stops working when they do.
          </p>
        </div>
      )}
      {error && <ErrorBanner>{error}</ErrorBanner>}
    </Modal>
  );
}

export function CreateBucketDialog({
  conn,
  defaultRegion,
  onDone,
  onClose,
}: {
  conn: string;
  defaultRegion: string;
  onDone: (name: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [region, setRegion] = useState(defaultRegion);
  const [objectLock, setObjectLock] = useState(false);
  const { busy, error, run } = useSubmit();
  const invalid = bucketNameError(name);
  const submit = () => {
    if (!invalid)
      void run(async () => {
        await api.createBucket(conn, name, region || null, objectLock);
        onDone(name);
      });
  };
  return (
    <Modal
      title="New bucket"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || Boolean(invalid)} onClick={submit}>
            {busy ? <Spinner /> : null}
            Create
          </button>
        </>
      }
    >
      <label className="field-stack">
        Name
        <input autoFocus value={name} onChange={(e) => setName(e.target.value.toLowerCase())} />
      </label>
      {name && invalid && <div className="field-error">{invalid}</div>}
      <label className="field-stack">
        Region
        <input value={region} onChange={(e) => setRegion(e.target.value)} />
      </label>
      <label className="check">
        <input type="checkbox" checked={objectLock} onChange={(e) => setObjectLock(e.target.checked)} />
        Enable Object Lock (also turns on versioning; cannot be turned off)
      </label>
      {error && <ErrorBanner>{error}</ErrorBanner>}
    </Modal>
  );
}
