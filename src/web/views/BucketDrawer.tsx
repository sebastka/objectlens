import { useState } from 'react';
import type { Acl, BucketDetails, Capabilities, ConnectionInfo, Section } from '../../shared/types.ts';
import { api } from '../api.ts';
import { bytes, plural } from '../format.ts';
import { useAsync } from '../hooks.ts';
import { CapButton, Drawer, ErrorBanner, InfoBanner, KV, SectionView, Spinner, Tabs } from '../components/ui.tsx';
import { useToast } from '../toast.ts';
import { PairsEditor } from './ObjectDrawer.tsx';

type Tab = 'overview' | 'security' | 'management' | 'tags';

export function BucketDrawer({
  conn,
  bucket,
  caps,
  onDeleted,
  onChanged,
  onClose,
}: {
  conn: ConnectionInfo;
  bucket: string;
  caps: Capabilities | null;
  onDeleted: () => void;
  onChanged: () => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>('overview');
  const [version, setVersion] = useState(0);
  const details = useAsync(() => api.bucketDetails(conn.id, bucket), [conn.id, bucket, version]);
  const reload = () => {
    setVersion((v) => v + 1);
    onChanged();
  };
  const d = details.data;
  return (
    <Drawer title={bucket} subtitle={`Bucket on ${conn.name}`} onClose={onClose} wide>
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'overview', label: 'Overview' },
          { id: 'security', label: 'Security' },
          { id: 'management', label: 'Management' },
          { id: 'tags', label: 'Tags', badge: d?.tags.ok ? d.tags.value.length : null },
        ]}
      />
      {details.error && <ErrorBanner>{details.error.message}</ErrorBanner>}
      {!d && !details.error && <Spinner label="Loading…" />}
      {d && tab === 'overview' && (
        <OverviewTab conn={conn} d={d} caps={caps} onChanged={reload} onDeleted={onDeleted} />
      )}
      {d && tab === 'security' && (
        <>
          <h3>Default encryption</h3>
          <SectionView
            section={d.encryption}
            empty="Not configured (S3 still encrypts with SSE-S3 by default on AWS)"
          />
          <h3>Bucket policy</h3>
          <SectionView section={d.policy} empty="No bucket policy" />
          <h3>Policy status</h3>
          <SectionView
            section={d.policyStatus}
            render={(s) =>
              s.isPublic ? <b className="warn-text">The policy makes this bucket public</b> : 'Not public'
            }
            empty="Unknown"
          />
          <h3>Block public access</h3>
          <SectionView section={d.publicAccessBlock} />
          <h3>Object ownership</h3>
          <SectionView section={d.ownershipControls} />
          <h3>Access control list</h3>
          <AclView section={d.acl} />
          <h3>Object Lock</h3>
          <SectionView section={d.objectLock} empty="Not enabled" />
        </>
      )}
      {d && tab === 'management' && (
        <>
          <h3>Lifecycle rules</h3>
          <SectionView section={d.lifecycle} />
          <h3>Replication</h3>
          <SectionView section={d.replication} />
          <h3>CORS</h3>
          <SectionView section={d.cors} />
          <h3>Static website hosting</h3>
          <SectionView section={d.website} empty="Disabled" />
          <h3>Server access logging</h3>
          <SectionView section={d.logging} empty="Disabled" />
          <h3>Event notifications</h3>
          <SectionView section={d.notification} empty="None" />
          <p className="muted small">These settings are shown read-only; change them with your provider's tools.</p>
        </>
      )}
      {d && tab === 'tags' && <BucketTags key={version} conn={conn} d={d} caps={caps} onSaved={reload} />}
    </Drawer>
  );
}

function AclView({ section }: { section: Section<Acl> }) {
  return (
    <SectionView
      section={section}
      render={(acl) => (
        <>
          <KV rows={[['Owner', acl.owner]]} />
          <ul className="plain small">
            {acl.grants.map((g, i) => (
              <li key={i}>
                {g.grantee} <span className="muted">({g.type})</span>: {g.permission}
              </li>
            ))}
          </ul>
        </>
      )}
    />
  );
}

function OverviewTab({
  conn,
  d,
  caps,
  onChanged,
  onDeleted,
}: {
  conn: ConnectionInfo;
  d: BucketDetails;
  caps: Capabilities | null;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState('');
  const [size, setSize] = useState<{ objects: number; bytes: number; truncated: boolean } | null>(null);
  const [sizing, setSizing] = useState(false);
  const status = d.versioning.ok ? d.versioning.value.status : null;
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast(ok);
      onChanged();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <KV
        rows={[
          ['Name', d.name],
          ['Region', d.region.ok ? d.region.value : <span className="muted">unknown ({d.region.error})</span>],
          ['Connection', `${conn.name} (${conn.endpoint})`],
          ['S3 URI', <span className="mono">{`s3://${d.name}`}</span>],
        ]}
      />
      <h3>Versioning</h3>
      <SectionView
        section={d.versioning}
        render={(v) => (
          <div className="inline">
            <span>
              <b>{v.status}</b>
              {v.mfaDelete ? <span className="muted"> · MFA delete {v.mfaDelete}</span> : null}
            </span>
            {status === 'Enabled' ? (
              <CapButton
                label="Suspend"
                cap={caps?.bucketConfig}
                disabled={busy}
                onClick={() => void act(() => api.setVersioning(conn.id, d.name, false), 'Versioning suspended')}
              />
            ) : (
              <CapButton
                label="Enable"
                cap={caps?.bucketConfig}
                disabled={busy}
                onClick={() => void act(() => api.setVersioning(conn.id, d.name, true), 'Versioning enabled')}
              />
            )}
          </div>
        )}
      />
      <p className="muted small">
        With versioning, overwritten and deleted objects stay available as older versions. Once enabled, it can only be
        suspended, not switched off.
      </p>
      <h3>Size</h3>
      {size ? (
        <p>
          {plural(size.objects, 'object')}, {bytes(size.bytes)}
          {size.truncated ? ' (counting stopped at the limit; the bucket is larger)' : ''}. Current versions only.
        </p>
      ) : (
        <button
          type="button"
          className="btn"
          disabled={sizing}
          onClick={() => {
            setSizing(true);
            api
              .size(conn.id, d.name, '')
              .then(setSize, (e: Error) => toast(e.message, 'error'))
              .finally(() => setSizing(false));
          }}
        >
          {sizing ? <Spinner /> : null}
          Count objects and size
        </button>
      )}
      {!conn.readOnly && (
        <>
          <h3 className="danger-text">Empty or delete the bucket</h3>
          <p className="muted small">
            Emptying removes every object, version and delete marker, for good. S3 only deletes empty buckets. Type the
            bucket name to confirm.
          </p>
          <div className="inline">
            <input
              aria-label="Type the bucket name to confirm"
              placeholder={d.name}
              value={confirmDelete}
              onChange={(e) => setConfirmDelete(e.target.value)}
            />
            <CapButton
              label="Empty bucket"
              icon="trash"
              danger
              cap={caps?.delete}
              disabled={busy || confirmDelete !== d.name}
              onClick={() =>
                void act(async () => {
                  // Versions only exist where versioning was ever on; some servers cannot list them.
                  const versions = status !== 'Never enabled';
                  const r = await api.delete(conn.id, d.name, [{ prefix: '' }], versions);
                  if (r.failed.length)
                    throw new Error(`${r.failed.length} failed, e.g. ${r.failed[0]!.key}: ${r.failed[0]!.error}`);
                  if (r.truncated)
                    throw new Error(`Deleted ${plural(r.done, 'object')}; stopped at the limit: run it again.`);
                }, 'Bucket emptied')
              }
            />
            <CapButton
              label="Delete bucket"
              icon="trash"
              danger
              cap={caps?.bucketConfig}
              disabled={busy || confirmDelete !== d.name}
              onClick={() =>
                void (async () => {
                  setBusy(true);
                  try {
                    await api.deleteBucket(conn.id, d.name);
                    toast(`Bucket ${d.name} deleted`);
                    onDeleted();
                  } catch (e) {
                    toast((e as Error).message, 'error');
                  } finally {
                    setBusy(false);
                  }
                })()
              }
            />
          </div>
        </>
      )}
    </>
  );
}

function BucketTags({
  conn,
  d,
  caps,
  onSaved,
}: {
  conn: ConnectionInfo;
  d: BucketDetails;
  caps: Capabilities | null;
  onSaved: () => void;
}) {
  const [tags, setTags] = useState<[string, string][]>(d.tags.ok ? d.tags.value.map((t) => [t.key, t.value]) : []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  if (!d.tags.ok) return <SectionView section={d.tags} />;
  const editable = !conn.readOnly && caps?.bucketConfig.allowed !== false;
  return (
    <fieldset className="form" disabled={!editable || saving}>
      {caps?.bucketConfig.allowed === false && (
        <InfoBanner>These credentials may not change bucket settings: {caps.bucketConfig.reason}</InfoBanner>
      )}
      <PairsEditor pairs={tags} onChange={setTags} keyLabel="Key" addLabel="Add tag" max={50} />
      {editable && (
        <div className="form-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() =>
              void (async () => {
                setSaving(true);
                setError(null);
                try {
                  await api.setBucketTags(
                    conn.id,
                    d.name,
                    tags.filter(([k]) => k.trim()).map(([key, value]) => ({ key: key.trim(), value })),
                  );
                  toast('Bucket tags saved');
                  onSaved();
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setSaving(false);
                }
              })()
            }
          >
            {saving ? <Spinner /> : null}
            Save tags
          </button>
        </div>
      )}
      {error && <ErrorBanner>{error}</ErrorBanner>}
    </fieldset>
  );
}
