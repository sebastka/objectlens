import { useState } from 'react';
import { baseName } from '../../shared/keys.ts';
import type {
  Capabilities,
  ConnectionInfo,
  ObjectDetails,
  SystemMetadata,
  Tag,
  VersionEntry,
} from '../../shared/types.ts';
import { api, downloadUrl, upload } from '../api.ts';
import { bytes, dateTime, exactBytes } from '../format.ts';
import { useAsync } from '../hooks.ts';
import { Icon } from '../components/icons.tsx';
import { CapButton, Drawer, ErrorBanner, InfoBanner, KV, SectionView, Spinner, Tabs } from '../components/ui.tsx';
import { useToast } from '../toast.ts';

export type ObjectAction = 'rename' | 'copy' | 'move' | 'delete' | 'share';

type Tab = 'overview' | 'metadata' | 'tags' | 'versions' | 'permissions';

export function ObjectDrawer({
  conn,
  bucket,
  objectKey,
  versionId,
  caps,
  textMax,
  onVersion,
  onAction,
  refreshVersion,
  onChanged,
  onClose,
}: {
  conn: ConnectionInfo;
  bucket: string;
  objectKey: string;
  /** Viewing an older version; null = the current one. */
  versionId: string | null;
  caps: Capabilities | null;
  textMax: number;
  onVersion: (versionId: string | null) => void;
  onAction: (a: ObjectAction, versionId?: string) => void;
  /** Bumped by the explorer after a change (e.g. a version deleted from its dialog). */
  refreshVersion: number;
  onChanged: () => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>('overview');
  const [local, setLocal] = useState(0);
  const version = `${local}.${refreshVersion}`;
  const reload = () => {
    setLocal((v) => v + 1);
    onChanged();
  };
  const details = useAsync(
    () => api.object(conn.id, bucket, objectKey, versionId),
    [conn.id, bucket, objectKey, versionId, version],
  );
  const d = details.data;
  const old = versionId !== null;

  return (
    <Drawer
      title={baseName(objectKey)}
      subtitle={`${bucket}/${objectKey}`}
      onClose={onClose}
      wide
      actions={
        <>
          <a className="btn" href={downloadUrl(conn.id, bucket, objectKey, versionId)} download>
            <Icon name="download" />
            Download
          </a>
          {conn.shareLinks && (
            <CapButton
              icon="link"
              label="Share"
              cap={caps?.read}
              onClick={() => onAction('share', versionId ?? undefined)}
            />
          )}
          {!old && (
            <>
              <CapButton
                icon="pencil"
                label="Rename"
                cap={[caps?.write, caps?.delete].filter(isCap)}
                onClick={() => onAction('rename')}
              />
              <CapButton icon="copy" label="Copy" cap={caps?.read} onClick={() => onAction('copy')} />
              <CapButton
                icon="move"
                label="Move"
                cap={[caps?.read, caps?.delete].filter(isCap)}
                onClick={() => onAction('move')}
              />
              <CapButton icon="trash" label="Delete" cap={caps?.delete} danger onClick={() => onAction('delete')} />
            </>
          )}
        </>
      }
    >
      {old && (
        <InfoBanner>
          You are looking at an older version ({versionId}).{' '}
          <button type="button" className="btn-link" onClick={() => onVersion(null)}>
            Show the current version
          </button>
        </InfoBanner>
      )}
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'overview', label: 'Overview' },
          { id: 'metadata', label: 'Metadata', badge: d ? Object.keys(d.metadata).length : null },
          { id: 'tags', label: 'Tags', badge: d?.tags.ok ? d.tags.value.length : null },
          { id: 'versions', label: 'Versions' },
          { id: 'permissions', label: 'Permissions' },
        ]}
      />
      {details.error && <ErrorBanner>{details.error.message}</ErrorBanner>}
      {!d && !details.error && <Spinner label="Loading…" />}
      {d && (
        <div className={details.loading ? 'dim' : ''}>
          {tab === 'overview' && (
            <Overview conn={conn} d={d} caps={caps} textMax={textMax} onSaved={reload} old={old} />
          )}
          {tab === 'metadata' && (
            <MetadataTab
              key={`${d.versionId}-${d.etag}-${d.lastModified}`}
              conn={conn}
              d={d}
              caps={caps}
              old={old}
              onSaved={reload}
            />
          )}
          {tab === 'tags' && (
            <TagsTab key={`${d.versionId}-${d.etag}`} conn={conn} d={d} caps={caps} onSaved={reload} />
          )}
          {tab === 'versions' && (
            <VersionsTab
              conn={conn}
              bucket={bucket}
              objectKey={objectKey}
              current={d.versionId}
              caps={caps}
              onVersion={onVersion}
              onDeleteVersion={(v) => onAction('delete', v)}
              onRestored={reload}
              version={version}
            />
          )}
          {tab === 'permissions' && (
            <>
              <h3>Access control list</h3>
              <SectionView
                section={d.acl}
                render={(acl) => (
                  <>
                    <KV rows={[['Owner', acl.owner]]} />
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Grantee</th>
                          <th>Type</th>
                          <th>Permission</th>
                        </tr>
                      </thead>
                      <tbody>
                        {acl.grants.map((g, i) => (
                          <tr key={i}>
                            <td>{g.grantee}</td>
                            <td className="muted">{g.type}</td>
                            <td>{g.permission}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                )}
              />
              <p className="muted small">
                Most buckets today use bucket policies and IAM instead of ACLs; with Object Ownership set to "bucket
                owner enforced", ACLs are ignored.
              </p>
            </>
          )}
        </div>
      )}
    </Drawer>
  );
}

const isCap = <T,>(c: T | undefined): c is T => c !== undefined;

function Overview({
  conn,
  d,
  caps,
  textMax,
  onSaved,
  old,
}: {
  conn: ConnectionInfo;
  d: ObjectDetails;
  caps: Capabilities | null;
  textMax: number;
  onSaved: () => void;
  old: boolean;
}) {
  return (
    <>
      <Preview conn={conn} d={d} caps={caps} textMax={textMax} onSaved={onSaved} old={old} />
      <h3>Properties</h3>
      <KV
        rows={[
          ['Name', <span className="mono">{baseName(d.key)}</span>],
          ['Key', <span className="mono">{d.key}</span>],
          ['Bucket', d.bucket],
          ['Size', `${bytes(d.size)} (${exactBytes(d.size)})`],
          ['Last modified', dateTime(d.lastModified)],
          ['Type', d.system.contentType],
          ['ETag', <span className="mono">{d.etag}</span>],
          ['S3 URI', <span className="mono">{`s3://${d.bucket}/${d.key}`}</span>],
        ]}
      />
      <h3>S3 properties</h3>
      <KV rows={d.s3.map((r): [string, string] => [r.label, r.value])} />
      <h3>HTTP headers</h3>
      <KV
        rows={[
          ['Content-Type', d.system.contentType],
          ['Cache-Control', d.system.cacheControl],
          ['Content-Disposition', d.system.contentDisposition],
          ['Content-Encoding', d.system.contentEncoding],
          ['Content-Language', d.system.contentLanguage],
          ['Expires', d.system.expires],
          ['Website redirect', d.system.websiteRedirectLocation],
        ]}
      />
      {Object.keys(d.metadata).length > 0 && (
        <>
          <h3>User metadata</h3>
          <KV rows={Object.entries(d.metadata).map(([k, v]): [string, string] => [`x-amz-meta-${k}`, v])} />
        </>
      )}
    </>
  );
}

function Preview({
  conn,
  d,
  caps,
  textMax,
  onSaved,
  old,
}: {
  conn: ConnectionInfo;
  d: ObjectDetails;
  caps: Capabilities | null;
  textMax: number;
  onSaved: () => void;
  old: boolean;
}) {
  const src = downloadUrl(conn.id, d.bucket, d.key, d.versionId, true);
  if (!d.preview) return null;
  if (d.preview === 'image')
    return (
      <div className="preview">
        <img src={src} alt={`Preview of ${baseName(d.key)}`} />
      </div>
    );
  if (d.preview === 'audio')
    return (
      <div className="preview">
        <audio controls src={src} preload="metadata" />
      </div>
    );
  if (d.preview === 'video')
    return (
      <div className="preview">
        <video controls src={src} preload="metadata" />
      </div>
    );
  if (d.preview === 'pdf')
    return (
      <div className="preview">
        <iframe src={src} title={`Preview of ${baseName(d.key)}`} className="pdf" />
      </div>
    );
  return <TextPreview conn={conn} d={d} caps={caps} textMax={textMax} onSaved={onSaved} old={old} />;
}

function TextPreview({
  conn,
  d,
  caps,
  textMax,
  onSaved,
  old,
}: {
  conn: ConnectionInfo;
  d: ObjectDetails;
  caps: Capabilities | null;
  textMax: number;
  onSaved: () => void;
  old: boolean;
}) {
  const text = useAsync(
    () => api.text(conn.id, d.bucket, d.key, d.versionId),
    [conn.id, d.bucket, d.key, d.versionId, d.etag],
  );
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const save = async () => {
    if (draft === null) return;
    const blob = new Blob([draft], { type: d.system.contentType ?? 'text/plain' });
    if (blob.size > textMax) {
      setError(`The text is larger than the ${bytes(textMax)} editing limit.`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await upload(conn.id, d.bucket, d.key, blob, true, () => {}, true).done;
      setDraft(null);
      toast(`Saved ${baseName(d.key)}`);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  if (text.error) return <ErrorBanner>Preview failed: {text.error.message}</ErrorBanner>;
  if (text.data === null) return <Spinner label="Loading preview…" />;
  return (
    <div className="preview preview-text">
      <div className="preview-bar">
        <span className="muted small">Text preview</span>
        {draft === null ? (
          !old &&
          !conn.readOnly && (
            <CapButton icon="pencil" label="Edit" cap={caps?.write} onClick={() => setDraft(text.data ?? '')} />
          )
        ) : (
          <span className="inline">
            <button type="button" className="btn" onClick={() => setDraft(null)} disabled={saving}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={saving}>
              {saving ? <Spinner /> : null}
              Save
            </button>
          </span>
        )}
      </div>
      {draft === null ? (
        <pre className="code">{text.data}</pre>
      ) : (
        <textarea
          className="code editor"
          value={draft}
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          aria-label="File content"
        />
      )}
      {draft !== null && (
        <p className="muted small">
          Saving uploads the whole file again; metadata and tags are kept
          {d.versionId ? ', and the previous content stays as an older version' : ''}.
        </p>
      )}
      {error && <ErrorBanner>{error}</ErrorBanner>}
    </div>
  );
}

const SYSTEM_FIELDS: [keyof SystemMetadata, string, string][] = [
  ['contentType', 'Content-Type', 'application/octet-stream'],
  ['cacheControl', 'Cache-Control', 'max-age=3600'],
  ['contentDisposition', 'Content-Disposition', 'attachment; filename="…"'],
  ['contentEncoding', 'Content-Encoding', 'gzip'],
  ['contentLanguage', 'Content-Language', 'en'],
  ['expires', 'Expires', '2030-01-01T00:00:00Z'],
  ['websiteRedirectLocation', 'Website redirect', '/other/page.html'],
];

const STORAGE_CLASSES = [
  'STANDARD',
  'STANDARD_IA',
  'ONEZONE_IA',
  'INTELLIGENT_TIERING',
  'GLACIER_IR',
  'GLACIER',
  'DEEP_ARCHIVE',
  'REDUCED_REDUNDANCY',
];

function MetadataTab({
  conn,
  d,
  caps,
  old,
  onSaved,
}: {
  conn: ConnectionInfo;
  d: ObjectDetails;
  caps: Capabilities | null;
  old: boolean;
  onSaved: () => void;
}) {
  const [system, setSystem] = useState<SystemMetadata>(d.system);
  const [meta, setMeta] = useState<[string, string][]>(Object.entries(d.metadata));
  const [storageClass, setStorageClass] = useState(d.storageClass);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const editable = !old && !conn.readOnly && caps?.write.allowed !== false;
  const names = meta.map(([k]) => k.trim().toLowerCase());
  const dup = names.find((n, i) => n && names.indexOf(n) !== i);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.editMetadata(conn.id, d.bucket, {
        key: d.key,
        system: Object.fromEntries(
          Object.entries(system).map(([k, v]) => [k, typeof v === 'string' && v.trim() ? v.trim() : null]),
        ) as unknown as SystemMetadata,
        metadata: Object.fromEntries(meta.filter(([k]) => k.trim()).map(([k, v]) => [k.trim(), v])),
        ...(storageClass !== d.storageClass ? { storageClass } : {}),
      });
      toast('Metadata saved');
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <fieldset className="form" disabled={!editable || saving}>
      {old && <InfoBanner>Metadata of an older version cannot be changed.</InfoBanner>}
      {!old && caps?.write.allowed === false && (
        <InfoBanner>These credentials may not write here: {caps.write.reason}</InfoBanner>
      )}
      <h3>HTTP headers</h3>
      {SYSTEM_FIELDS.map(([k, label, ph]) => (
        <label key={k} className="form-row">
          <span>{label}</span>
          <input
            className="mono"
            value={system[k] ?? ''}
            placeholder={ph}
            onChange={(e) => setSystem({ ...system, [k]: e.target.value })}
          />
        </label>
      ))}
      <label className="form-row">
        <span>Storage class</span>
        <input
          className="mono"
          list="storage-classes"
          value={storageClass}
          onChange={(e) => setStorageClass(e.target.value.toUpperCase())}
        />
        <datalist id="storage-classes">
          {STORAGE_CLASSES.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      </label>
      <h3>User metadata</h3>
      <p className="muted small">
        Stored as <span className="mono">x-amz-meta-*</span> headers: names are lowercased, values must be ASCII.
      </p>
      <PairsEditor pairs={meta} onChange={setMeta} keyLabel="Name" addLabel="Add metadata" keyPrefix="x-amz-meta-" />
      {dup && <div className="field-error">"{dup}" appears twice.</div>}
      {editable && (
        <div className="form-actions">
          <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={Boolean(dup)}>
            {saving ? <Spinner /> : null}
            Save metadata
          </button>
          <span className="muted small">
            S3 cannot change metadata in place: the object is copied onto itself
            {d.versionId ? ', which creates a new version' : ''}.
          </span>
        </div>
      )}
      {error && <ErrorBanner>{error}</ErrorBanner>}
    </fieldset>
  );
}

function TagsTab({
  conn,
  d,
  caps,
  onSaved,
}: {
  conn: ConnectionInfo;
  d: ObjectDetails;
  caps: Capabilities | null;
  onSaved: () => void;
}) {
  const [tags, setTags] = useState<[string, string][]>(d.tags.ok ? d.tags.value.map((t) => [t.key, t.value]) : []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  if (!d.tags.ok) return <SectionView section={d.tags} />;
  const editable = !conn.readOnly && caps?.tags.allowed !== false;
  const keys = tags.map(([k]) => k);
  const dup = keys.find((k, i) => k && keys.indexOf(k) !== i);
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const list: Tag[] = tags.filter(([k]) => k.trim()).map(([key, value]) => ({ key: key.trim(), value }));
      await api.setObjectTags(conn.id, d.bucket, d.key, list, d.versionId);
      toast('Tags saved');
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <fieldset className="form" disabled={!editable || saving}>
      {caps?.tags.allowed === false && (
        <InfoBanner>These credentials may not change tags: {caps.tags.reason}</InfoBanner>
      )}
      <p className="muted small">Up to 10 tags; tags do not change the object or create a new version.</p>
      <PairsEditor pairs={tags} onChange={setTags} keyLabel="Key" addLabel="Add tag" max={10} />
      {dup && <div className="field-error">"{dup}" appears twice.</div>}
      {editable && (
        <div className="form-actions">
          <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={Boolean(dup)}>
            {saving ? <Spinner /> : null}
            Save tags
          </button>
        </div>
      )}
      {error && <ErrorBanner>{error}</ErrorBanner>}
    </fieldset>
  );
}

/** Editable list of name/value pairs. */
export function PairsEditor({
  pairs,
  onChange,
  keyLabel,
  addLabel,
  keyPrefix,
  max,
}: {
  pairs: [string, string][];
  onChange: (p: [string, string][]) => void;
  keyLabel: string;
  addLabel: string;
  keyPrefix?: string;
  max?: number;
}) {
  const set = (i: number, k: string, v: string) => onChange(pairs.map((p, j) => (j === i ? [k, v] : p)));
  return (
    <div className="pairs">
      {pairs.map(([k, v], i) => (
        <div key={i} className="pair">
          <label className="pair-key">
            {keyPrefix && <span className="muted mono small">{keyPrefix}</span>}
            <input
              className="mono"
              aria-label={keyLabel}
              value={k}
              placeholder={keyLabel}
              onChange={(e) => set(i, e.target.value, v)}
            />
          </label>
          <input
            className="mono"
            aria-label="Value"
            value={v}
            placeholder="Value"
            onChange={(e) => set(i, k, e.target.value)}
          />
          <button
            type="button"
            className="btn btn-icon"
            aria-label={`Remove ${k || 'row'}`}
            onClick={() => onChange(pairs.filter((_, j) => j !== i))}
          >
            <Icon name="x" />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="btn btn-small"
        disabled={max !== undefined && pairs.length >= max}
        onClick={() => onChange([...pairs, ['', '']])}
      >
        <Icon name="plus" />
        {addLabel}
      </button>
    </div>
  );
}

function VersionsTab({
  conn,
  bucket,
  objectKey,
  current,
  caps,
  onVersion,
  onDeleteVersion,
  onRestored,
  version,
}: {
  conn: ConnectionInfo;
  bucket: string;
  objectKey: string;
  current: string | null;
  caps: Capabilities | null;
  onVersion: (v: string | null) => void;
  onDeleteVersion: (v: string) => void;
  onRestored: () => void;
  version: string;
}) {
  const list = useAsync(() => api.versions(conn.id, bucket, objectKey), [conn.id, bucket, objectKey, version]);
  const [busy, setBusy] = useState<string | null>(null);
  const toast = useToast();
  const restore = async (v: VersionEntry) => {
    setBusy(v.versionId);
    try {
      await api.restoreVersion(conn.id, bucket, objectKey, v.versionId);
      toast('Version restored: it is now the current version');
      onVersion(null);
      onRestored();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };
  if (list.error) return <ErrorBanner>{list.error.message}</ErrorBanner>;
  if (!list.data) return <Spinner label="Loading versions…" />;
  if (list.data.length <= 1 && list.data.every((v) => v.versionId === 'null'))
    return (
      <p className="muted">
        This object has no other versions (versioning is off or was enabled after it was written).
      </p>
    );
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Version</th>
          <th>Modified</th>
          <th className="num">Size</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {list.data.map((v) => (
          <tr key={v.versionId} className={v.versionId === current ? 'selected' : ''}>
            <td className="mono small">
              {v.versionId === 'null' ? <span className="muted">null (before versioning)</span> : v.versionId}
              {v.isLatest && <span className="tag">current</span>}
              {v.isDeleteMarker && <span className="tag tag-warn">delete marker</span>}
            </td>
            <td>{dateTime(v.lastModified)}</td>
            <td className="num">{v.isDeleteMarker ? '–' : bytes(v.size)}</td>
            <td className="row-actions">
              <div>
                {!v.isDeleteMarker && (
                  <>
                    <button
                      type="button"
                      className="btn btn-small btn-icon"
                      aria-label="Show this version"
                      title="Show this version"
                      onClick={() => onVersion(v.isLatest ? null : v.versionId)}
                    >
                      <Icon name="eye" />
                    </button>
                    <a
                      className="btn btn-small btn-icon"
                      aria-label="Download this version"
                      title="Download this version"
                      href={downloadUrl(conn.id, bucket, objectKey, v.versionId)}
                      download
                    >
                      <Icon name="download" />
                    </a>
                  </>
                )}
                {!v.isLatest && !v.isDeleteMarker && (
                  <CapButton
                    icon="history"
                    label="Restore"
                    cap={caps?.write}
                    disabled={busy !== null}
                    title="Make this the current version (copies it over the key)"
                    onClick={() => void restore(v)}
                  />
                )}
                <CapButton
                  icon="trash"
                  label="Delete version"
                  iconOnly
                  cap={caps?.delete}
                  onClick={() => onDeleteVersion(v.versionId)}
                />
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
