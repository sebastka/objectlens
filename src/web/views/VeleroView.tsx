import { useMemo, useState } from 'react';
import type { ConnectionInfo, VeleroBackup, VeleroBackupDetails, VeleroVolume } from '../../shared/types.ts';
import { api, downloadUrl } from '../api.ts';
import { Icon } from '../components/icons.tsx';
import { Drawer, ErrorBanner, InfoBanner, KV, Spinner } from '../components/ui.tsx';
import { ago, bytes, dateTime, plural } from '../format.ts';
import { useAsync } from '../hooks.ts';

type Go = (l: { vb?: string; vf?: string }, replace?: boolean) => void;

function duration(from: string | null, to: string | null): string {
  if (!from || !to) return '–';
  const s = Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** "in 29 days" / "expired" for an expiration time. */
function expires(s: string | null, now = Date.now()): string {
  if (!s) return '–';
  const days = Math.round((Date.parse(s) - now) / 86_400_000);
  if (days < 0) return 'expired';
  return days === 0 ? 'today' : `in ${plural(days, 'day')}`;
}

function PhaseTag({ phase }: { phase: string }) {
  const cls = phase === 'Completed' ? 'tag-ok' : /Failed|Error/.test(phase) ? 'tag-error' : 'tag-warn';
  return <span className={`tag ${cls}`}>{phase.replace(/([a-z])([A-Z])/g, '$1 $2')}</span>;
}

const METHODS: Record<VeleroVolume['method'], string> = {
  'data-mover': 'Data mover',
  'fs-backup': 'File system',
  'csi-snapshot': 'CSI snapshot',
  'native-snapshot': 'Volume snapshot',
};

const scope = (b: VeleroBackup) => {
  const ns =
    b.includedNamespaces.length && !b.includedNamespaces.includes('*')
      ? b.includedNamespaces.join(', ')
      : 'all namespaces';
  const res =
    b.includedResources.length && !b.includedResources.includes('*') ? b.includedResources.join(', ') : 'all resources';
  return `${ns} · ${res}${b.labelSelector ? ` · ${b.labelSelector}` : ''}`;
};

export function VeleroView({
  conn,
  bucket,
  prefix,
  backup,
  file,
  onGo,
  onObjects,
  onBrowse,
}: {
  conn: ConnectionInfo;
  bucket: string;
  /** The backup location's folder. */
  prefix: string;
  backup: string | null;
  file: string | null;
  onGo: Go;
  onObjects: () => void;
  onBrowse: (repository: string, snapshot: string) => void;
}) {
  return (
    <div className="explorer velero">
      <div className="location">
        <nav className="crumbs" aria-label="Folder">
          <button type="button" className="crumb" onClick={onObjects} title="Back to the objects of this folder">
            <Icon name="bucket" />
            {bucket}
            {prefix ? `/${prefix.replace(/\/$/, '')}` : ''}
          </button>
          <span className="crumb-sep">
            <Icon name="chevronRight" size={12} />
            <button type="button" className="crumb" onClick={() => onGo({})}>
              <Icon name="server" />
              Velero
            </button>
          </span>
          {backup && (
            <span className="crumb-sep">
              <Icon name="chevronRight" size={12} />
              <button type="button" className="crumb" onClick={() => onGo({ vb: backup })}>
                {backup}
              </button>
            </span>
          )}
        </nav>
        <div className="inline">
          <button type="button" className="btn" onClick={onObjects}>
            <Icon name="folder" />
            Objects
          </button>
        </div>
      </div>
      {backup ? (
        <Backup conn={conn} bucket={bucket} prefix={prefix} name={backup} file={file} onGo={onGo} onBrowse={onBrowse} />
      ) : (
        <Backups conn={conn} bucket={bucket} prefix={prefix} onGo={onGo} />
      )}
    </div>
  );
}

function Backups({ conn, bucket, prefix, onGo }: { conn: ConnectionInfo; bucket: string; prefix: string; onGo: Go }) {
  const [fresh, setFresh] = useState(0);
  const [filter, setFilter] = useState('');
  const list = useAsync(() => api.veleroBackups(conn.id, bucket, prefix, fresh > 0), [conn.id, bucket, prefix, fresh]);
  const rows = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (list.data ?? []).filter(
      (b) =>
        !f ||
        b.name.toLowerCase().includes(f) ||
        (b.schedule ?? '').toLowerCase().includes(f) ||
        b.phase.toLowerCase().includes(f),
    );
  }, [list.data, filter]);
  const failed = (list.data ?? []).filter((b) => b.phase !== 'Completed').length;

  return (
    <>
      <div className="toolbar">
        <div className="toolbar-actions">
          <span className="sel-count">{list.data ? plural(list.data.length, 'backup') : 'Backups'}</span>
          {failed > 0 && <span className="tag tag-warn">{failed} not completed</span>}
        </div>
        <div className="inline">
          <div className="toolbar-search" role="search">
            <Icon name="search" />
            <input
              type="search"
              aria-label="Filter"
              placeholder="Filter by name, schedule or status"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
          <button
            type="button"
            className="btn btn-icon"
            aria-label="Refresh"
            title="Refresh"
            onClick={() => setFresh((f) => f + 1)}
          >
            <Icon name="refresh" />
          </button>
        </div>
      </div>
      {list.error && <ErrorBanner>{list.error.message}</ErrorBanner>}
      {!list.data && !list.error && <Spinner label="Reading the backups…" />}
      {list.data && !list.data.length && <div className="empty">No backups in this location.</div>}
      {list.data && list.data.length > 0 && (
        <div className={`table-wrap${list.loading ? ' dim' : ''}`}>
          <table className="table">
            <thead>
              <tr>
                <th>Backup</th>
                <th>Status</th>
                <th>Started</th>
                <th>Duration</th>
                <th>Expires</th>
                <th className="num">Items</th>
                <th className="num">Errors</th>
                <th className="num">Warnings</th>
                <th>Scope</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => (
                <tr key={b.name} className="clickable" onClick={() => onGo({ vb: b.name })}>
                  <td>
                    <button type="button" className="name-btn" onClick={() => onGo({ vb: b.name })}>
                      <span className="ellipsis">{b.name}</span>
                    </button>
                    {b.schedule && <div className="muted small">schedule {b.schedule}</div>}
                  </td>
                  <td>
                    <PhaseTag phase={b.phase} />
                  </td>
                  <td title={dateTime(b.startTime)}>
                    {dateTime(b.startTime)}
                    <div className="muted small">{ago(b.startTime)}</div>
                  </td>
                  <td>{duration(b.startTime, b.completionTime)}</td>
                  <td title={dateTime(b.expiration)}>{expires(b.expiration)}</td>
                  <td className="num">{b.itemsBackedUp ?? '–'}</td>
                  <td className="num">{b.errors || <span className="muted">0</span>}</td>
                  <td className="num">{b.warnings || <span className="muted">0</span>}</td>
                  <td className="small muted">{scope(b)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function Backup({
  conn,
  bucket,
  prefix,
  name,
  file,
  onGo,
  onBrowse,
}: {
  conn: ConnectionInfo;
  bucket: string;
  prefix: string;
  name: string;
  file: string | null;
  onGo: Go;
  onBrowse: (repository: string, snapshot: string) => void;
}) {
  const data = useAsync(() => api.veleroBackup(conn.id, bucket, prefix, name), [conn.id, bucket, prefix, name]);
  const d: VeleroBackupDetails | null = data.data?.backup.name === name ? data.data : null;
  if (data.error) return <ErrorBanner>{data.error.message}</ErrorBanner>;
  if (!d) return <Spinner label="Reading the backup (its manifests and volume records)…" />;
  const b = d.backup;
  const hasResults =
    d.results &&
    [d.results.errors, d.results.warnings].some((x) => x && typeof x === 'object' && Object.keys(x).length > 0);
  const resourceCount = Object.values(d.resources).reduce((n, l) => n + l.length, 0);
  const logFile = d.files.find((f) => f.name === `${name}-logs.gz`);

  return (
    <>
      <section className="card velero-summary">
        <div className="snapshot-head">
          <PhaseTag phase={b.phase} />
          <b>{b.name}</b>
          {b.schedule && <span className="muted small">schedule {b.schedule}</span>}
          <span className="grow" />
          {logFile && (
            <button type="button" className="btn" onClick={() => onGo({ vb: name, vf: 'logs' })}>
              <Icon name="fileText" />
              Log
            </button>
          )}
        </div>
        <KV
          rows={[
            ['Started', `${dateTime(b.startTime)} (${ago(b.startTime)})`],
            [
              'Completed',
              b.completionTime ? `${dateTime(b.completionTime)} · ${duration(b.startTime, b.completionTime)}` : null,
            ],
            ['Expires', b.expiration ? `${dateTime(b.expiration)} (${expires(b.expiration)})` : null],
            ['Storage location', b.storageLocation],
            [
              'Namespaces',
              `${b.includedNamespaces.join(', ') || '*'}${b.excludedNamespaces.length ? `, except ${b.excludedNamespaces.join(', ')}` : ''}`,
            ],
            [
              'Resources',
              `${b.includedResources.join(', ') || '*'}${b.excludedResources.length ? `, except ${b.excludedResources.join(', ')}` : ''}`,
            ],
            ['Label selector', b.labelSelector],
            [
              'Volumes',
              b.snapshotMoveData
                ? 'CSI snapshots, data moved to this bucket (data mover)'
                : b.defaultVolumesToFsBackup
                  ? 'File-system backup of pod volumes'
                  : 'CSI or provider snapshots, unless pods opt in to file-system backup',
            ],
            ['Items', b.totalItems !== null ? `${b.itemsBackedUp ?? 0} of ${b.totalItems} backed up` : null],
            [
              'Async operations',
              b.operations.attempted
                ? `${b.operations.completed} of ${b.operations.attempted} completed${b.operations.failed ? `, ${b.operations.failed} failed` : ''}`
                : null,
            ],
            ['Errors / warnings', `${b.errors} / ${b.warnings}`],
            ['Failure', b.failureReason],
            ['Retention (TTL)', b.ttl],
            ['Format', b.formatVersion],
            ['Cluster', b.clusterVersion ? `Kubernetes ${b.clusterVersion}` : null],
          ]}
        />
      </section>

      {hasResults && (
        <details className="card collapsible" open={b.errors > 0}>
          <summary>
            <b>Errors and warnings</b>
          </summary>
          <pre className="code">{JSON.stringify(d.results, null, 2)}</pre>
        </details>
      )}

      <section className="card snapshot-group">
        <h2>
          <Icon name="archive" /> Volumes <span className="muted small">{plural(d.volumes.length, 'volume')}</span>
        </h2>
        {d.volumes.length === 0 ? (
          <p className="muted">This backup holds no volume data.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Namespace</th>
                  <th>Volume</th>
                  <th>Method</th>
                  <th>Status</th>
                  <th className="num">Size</th>
                  <th className="num">Uploaded</th>
                  <th>Node</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {d.volumes.map((v, i) => (
                  <tr key={`${v.namespace}/${v.pvc ?? v.volume ?? i}`}>
                    <td>{v.namespace}</td>
                    <td>
                      <span className="mono">{v.pvc ?? v.volume ?? '–'}</span>
                      {v.pod && <div className="muted small">pod {v.pod}</div>}
                    </td>
                    <td>
                      {METHODS[v.method]}
                      {v.uploader && <span className="muted small"> · {v.uploader}</span>}
                    </td>
                    <td>{v.phase ? <PhaseTag phase={v.phase} /> : '–'}</td>
                    <td className="num">{bytes(v.bytes)}</td>
                    <td className="num" title="New data this backup uploaded (the rest was already in the repository)">
                      {bytes(v.incrementalBytes)}
                    </td>
                    <td className="small muted">{v.node ?? ''}</td>
                    <td className="volume-actions">
                      {v.repository && v.snapshotId ? (
                        <button
                          type="button"
                          className="btn btn-small"
                          onClick={() => onBrowse(v.repository!, v.snapshotId!)}
                        >
                          <Icon name="folder" />
                          Browse files
                        </button>
                      ) : (
                        <span className="muted small">{v.note ?? 'no data in this bucket'}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card snapshot-group">
        <h2>
          <Icon name="fileText" /> Resources <span className="muted small">{plural(resourceCount, 'item')}</span>
        </h2>
        {Object.entries(d.resources).map(([type, items]) => (
          <div key={type} className="small" style={{ marginBottom: 6 }}>
            <b className="mono">{type}</b> <span className="muted">({items.length})</span>:{' '}
            <span className="mono">{items.join(', ')}</span>
          </div>
        ))}
        {d.manifests.length > 0 && (
          <details className="collapsible">
            <summary className="small">Stored manifests ({d.manifests.length})</summary>
            <ul className="manifest-list small">
              {d.manifests.map((m) => (
                <li key={m}>
                  <button type="button" className="btn-link mono" onClick={() => onGo({ vb: name, vf: m })}>
                    {m.replace(/^resources\//, '')}
                  </button>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <InfoBanner>
        Restoring is Velero's job (<span className="mono">velero restore create --from-backup {name}</span>); ObjectLens
        only reads. Files of a volume can be downloaded one by one from <b>Browse files</b>.
      </InfoBanner>

      {file && (
        <TextDrawer
          conn={conn}
          bucket={bucket}
          prefix={prefix}
          name={name}
          file={file}
          download={
            file === 'logs' && logFile ? downloadUrl(conn.id, bucket, `${prefix}backups/${name}/${logFile.name}`) : null
          }
          onClose={() => onGo({ vb: name }, true)}
        />
      )}
    </>
  );
}

function TextDrawer({
  conn,
  bucket,
  prefix,
  name,
  file,
  download,
  onClose,
}: {
  conn: ConnectionInfo;
  bucket: string;
  prefix: string;
  name: string;
  file: string;
  download: string | null;
  onClose: () => void;
}) {
  const what = file === 'logs' ? ('logs' as const) : { manifest: file };
  const text = useAsync(
    () => api.veleroText(conn.id, bucket, prefix, name, what),
    [conn.id, bucket, prefix, name, file],
  );
  return (
    <Drawer
      title={file === 'logs' ? `Log of ${name}` : file.split('/').at(-1)!}
      subtitle={file === 'logs' ? undefined : file}
      onClose={onClose}
      wide
      actions={
        download ? (
          <a className="btn" href={download} download>
            <Icon name="download" />
            Download (gzip)
          </a>
        ) : undefined
      }
    >
      {text.error && <ErrorBanner>{text.error.message}</ErrorBanner>}
      {text.data === null && !text.error && <Spinner label="Loading…" />}
      {text.data !== null && <pre className={`code${file === 'logs' ? ' log' : ''}`}>{text.data}</pre>}
    </Drawer>
  );
}
