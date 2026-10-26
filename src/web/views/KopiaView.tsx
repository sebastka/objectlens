import { useMemo, useState } from 'react';
import { previewKind } from '../../shared/preview.ts';
import type {
  ConnectionInfo,
  KopiaEntry,
  KopiaPasswordSource,
  KopiaSnapshot,
  KopiaStatus,
} from '../../shared/types.ts';
import { api, kopiaFileUrl } from '../api.ts';
import { Icon } from '../components/icons.tsx';
import { Drawer, ErrorBanner, InfoBanner, KV, Spinner } from '../components/ui.tsx';
import { fileIcon } from '../filetypes.ts';
import { ago, bytes, dateTime, exactBytes, plural } from '../format.ts';
import { useAsync } from '../hooks.ts';
import { useToast } from '../toast.ts';

type Go = (l: { s?: string; kp?: string; kf?: string }, replace?: boolean) => void;

/** "drwxr-xr-x" from kopia's type and octal mode ("0755"). */
function modeString(type: string, mode: string | null): string {
  if (!mode) return '';
  const m = Number.parseInt(mode, 8);
  if (!Number.isFinite(m)) return mode;
  const t = type === 'd' ? 'd' : type === 's' ? 'l' : '-';
  const bit = (b: number, c: string) => (m & b ? c : '-');
  const exec = (x: number, special: number, on: string, off: string) =>
    m & special ? (m & x ? on : off) : m & x ? 'x' : '-';
  return (
    t +
    bit(0o400, 'r') +
    bit(0o200, 'w') +
    exec(0o100, 0o4000, 's', 'S') +
    bit(0o040, 'r') +
    bit(0o020, 'w') +
    exec(0o010, 0o2000, 's', 'S') +
    bit(0o004, 'r') +
    bit(0o002, 'w') +
    exec(0o001, 0o1000, 't', 'T')
  );
}

/** "0755" from kopia's mode, which may carry Go's file type bits ("020000755"). */
const octalPermissions = (mode: string) => {
  const m = Number.parseInt(mode, 8);
  return Number.isFinite(m) ? `0${(m & 0o7777).toString(8).padStart(3, '0')}` : mode;
};

/** "4 min", "2 h 5 min" between two ISO times. */
function duration(from: string, to: string | null): string {
  if (!to) return '–';
  const s = Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

function StatusTag({ s }: { s: KopiaSnapshot }) {
  if (!s.incomplete) return <span className="tag tag-ok">Complete</span>;
  const label = s.incomplete === 'checkpoint' ? 'Checkpoint' : s.incomplete === 'canceled' ? 'Canceled' : s.incomplete;
  return (
    <span
      className="tag tag-warn"
      title="An incomplete snapshot: kopia saves checkpoints during long uploads, and keeps what a canceled run had uploaded."
    >
      {label}
    </span>
  );
}

const sourceLabel = (s: KopiaSnapshot) => `${s.source.user}@${s.source.host}:${s.source.path}`;

export function KopiaView({
  conn,
  bucket,
  prefix,
  snapshot,
  path,
  file,
  textBytes,
  onGo,
  onObjects,
  onVelero,
}: {
  conn: ConnectionInfo;
  bucket: string;
  /** Folder holding the repository. */
  prefix: string;
  snapshot: string | null;
  path: string;
  file: string | null;
  textBytes: number;
  onGo: Go;
  onObjects: () => void;
  /** Opens a Velero backup location (for repositories under its kopia/ folder). */
  onVelero: (location: string) => void;
}) {
  const [version, setVersion] = useState(0);
  const status = useAsync(() => api.kopiaStatus(conn.id, bucket, prefix), [conn.id, bucket, prefix, version]);
  const st = status.data;
  const toast = useToast();

  const lock = async () => {
    try {
      await api.kopiaLock(conn.id, bucket, prefix);
      toast('Password forgotten');
      onGo({}, true);
      setVersion((v) => v + 1);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <div className="explorer kopia">
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
              <Icon name="history" />
              Backups
            </button>
          </span>
          {snapshot && (
            <SnapshotCrumbs conn={conn} bucket={bucket} prefix={prefix} snapshot={snapshot} path={path} onGo={onGo} />
          )}
        </nav>
        <div className="inline">
          {st?.velero && (
            <button
              type="button"
              className="btn"
              onClick={() => onVelero(prefix.replace(/kopia\/[^/]+\/$/, ''))}
              title="The Velero backups of this location"
            >
              <Icon name="server" />
              Velero backups
            </button>
          )}
          <button type="button" className="btn" onClick={onObjects}>
            <Icon name="folder" />
            Objects
          </button>
          {st?.passwordSource === 'ui' && (
            <button type="button" className="btn" onClick={() => void lock()} title="Forget the typed password">
              <Icon name="lock" />
              Lock
            </button>
          )}
        </div>
      </div>

      {status.error && <ErrorBanner>{status.error.message}</ErrorBanner>}
      {!st && !status.error && <Spinner label="Opening the repository (the first time takes a few seconds)…" />}
      {st && !st.installed && (
        <ErrorBanner>
          kopia is not installed where ObjectLens runs. Install it (e.g.{' '}
          <span className="mono">nix shell nixpkgs#kopia</span> or the release from kopia.io) or set{' '}
          <span className="mono">KOPIA_BIN</span> to its path. The container image includes it.
        </ErrorBanner>
      )}
      {st?.installed && st.locked && (
        <Unlock conn={conn} bucket={bucket} prefix={prefix} status={st} onUnlocked={() => setVersion((v) => v + 1)} />
      )}
      {st?.installed && !st.locked && st.error && <ErrorBanner>{st.error}</ErrorBanner>}
      {st?.installed && !st.locked && st.warning && (
        <div className="banner banner-warn" role="alert">
          <Icon name="lock" />
          <div>{st.warning}</div>
        </div>
      )}
      {st?.installed && !st.locked && !st.error && (
        <>
          {!snapshot && <RepositoryInfo status={st} />}
          {snapshot ? (
            <Browser
              conn={conn}
              bucket={bucket}
              prefix={prefix}
              snapshot={snapshot}
              path={path}
              file={file}
              textBytes={textBytes}
              onGo={onGo}
            />
          ) : (
            <Snapshots conn={conn} bucket={bucket} prefix={prefix} onGo={onGo} />
          )}
        </>
      )}
    </div>
  );
}

function Unlock({
  conn,
  bucket,
  prefix,
  status,
  onUnlocked,
}: {
  conn: ConnectionInfo;
  bucket: string;
  prefix: string;
  status: KopiaStatus;
  onUnlocked: () => void;
}) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.kopiaUnlock(conn.id, bucket, prefix, password);
      setPassword('');
      onUnlocked();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="card unlock"
      onSubmit={(e) => {
        e.preventDefault();
        if (password) void submit();
      }}
    >
      <h2>
        <Icon name="lock" /> Repository password
      </h2>
      {status.error && (
        <ErrorBanner>
          {status.velero
            ? "Neither S3_n_VELERO_PASSWORD nor Velero's default password opens this repository"
            : 'The password from the configuration does not open this repository'}
          : {status.error}
        </ErrorBanner>
      )}
      <p className="muted small">
        kopia encrypts everything in the repository. The password is kept in ObjectLens' memory only (never on disk)
        until it restarts or you lock the repository; it can also be set as{' '}
        <span className="mono">{status.velero ? 'S3_n_VELERO_PASSWORD' : 'S3_n_KOPIA_PASSWORD'}</span>
        {status.velero && (
          <>
            {' '}
            (Velero keeps it in the secret <span className="mono">velero-repo-credentials</span>, key{' '}
            <span className="mono">repository-password</span>)
          </>
        )}
        .
      </p>
      <div className="inline">
        <input
          type="password"
          autoFocus
          autoComplete="current-password"
          aria-label="Repository password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button type="submit" className="btn btn-primary" disabled={busy || !password}>
          {busy ? <Spinner /> : <Icon name="lock" />}
          Unlock
        </button>
      </div>
      {error && <ErrorBanner>{error}</ErrorBanner>}
    </form>
  );
}

const PASSWORD_SOURCES: Record<KopiaPasswordSource, string> = {
  ui: 'the UI',
  env: 'S3_n_KOPIA_PASSWORD',
  'velero-env': 'S3_n_VELERO_PASSWORD',
  'velero-default': "Velero's default",
};

function RepositoryInfo({ status }: { status: KopiaStatus }) {
  return (
    <details className="card collapsible">
      <summary>
        <b>kopia repository</b>{' '}
        <span className="muted small">
          read-only · kopia {status.kopiaVersion} · password from {PASSWORD_SOURCES[status.passwordSource ?? 'ui']}
        </span>
      </summary>
      <KV rows={(status.repository ?? []).map((r): [string, string] => [r.label, r.value])} />
    </details>
  );
}

function Snapshots({ conn, bucket, prefix, onGo }: { conn: ConnectionInfo; bucket: string; prefix: string; onGo: Go }) {
  const [fresh, setFresh] = useState(0);
  // By default: complete snapshots, and only the newest incomplete one of each source (a long
  // upload leaves a checkpoint every 45 minutes).
  const [showIncomplete, setShowIncomplete] = useState(false);
  const list = useAsync(() => api.kopiaSnapshots(conn.id, bucket, prefix, fresh > 0), [conn.id, bucket, prefix, fresh]);
  const groups = useMemo(() => {
    const m = new Map<string, KopiaSnapshot[]>();
    const newestIncomplete = new Set<string>();
    // The list comes newest first.
    for (const s of list.data ?? []) {
      const src = sourceLabel(s);
      if (s.incomplete && !showIncomplete) {
        if (newestIncomplete.has(src)) continue;
        newestIncomplete.add(src);
      }
      m.set(src, [...(m.get(src) ?? []), s]);
    }
    return [...m].sort(([a], [b]) => a.localeCompare(b));
  }, [list.data, showIncomplete]);
  const incomplete = list.data?.filter((s) => s.incomplete).length ?? 0;
  const shown = groups.reduce((n, [, snaps]) => n + snaps.length, 0);

  return (
    <>
      <div className="toolbar">
        <div className="toolbar-actions">
          <span className="sel-count">
            {list.data ? plural(list.data.length, 'snapshot') : 'Snapshots'}
            {list.data && groups.length ? ` of ${plural(new Set(list.data.map(sourceLabel)).size, 'source')}` : ''}
          </span>
          {incomplete > 0 && (
            <label
              className="check small"
              title="Without this, only the newest incomplete snapshot of each source is listed"
            >
              <input type="checkbox" checked={showIncomplete} onChange={(e) => setShowIncomplete(e.target.checked)} />
              Show all {plural(incomplete, 'incomplete snapshot')}
              {!showIncomplete && list.data ? ` (${(list.data.length - shown).toLocaleString('en')} hidden)` : ''}
            </label>
          )}
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
      {list.error && <ErrorBanner>{list.error.message}</ErrorBanner>}
      {!list.data && !list.error && <Spinner label="Listing snapshots…" />}
      {list.data && !list.data.length && <div className="empty">No snapshots yet.</div>}
      <div className={list.loading ? 'dim' : ''}>
        {groups.map(([source, snaps]) => (
          <section key={source} className="card snapshot-group">
            <h2 className="mono">
              <Icon name="server" /> {source}
            </h2>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Started</th>
                    <th>Duration</th>
                    <th>Status</th>
                    <th className="num">Size</th>
                    <th className="num">Files</th>
                    <th className="num">Folders</th>
                    <th className="num">Errors</th>
                    <th>Retention</th>
                  </tr>
                </thead>
                <tbody>
                  {snaps.map((s) => (
                    <tr key={s.id} className="clickable" onClick={() => onGo({ s: s.id })}>
                      <td>
                        <button type="button" className="name-btn" onClick={() => onGo({ s: s.id })}>
                          <span>{dateTime(s.startTime)}</span>
                        </button>
                        <div className="muted small">{ago(s.startTime)}</div>
                      </td>
                      <td>{duration(s.startTime, s.endTime)}</td>
                      <td>
                        <StatusTag s={s} />
                      </td>
                      <td className="num">{bytes(s.summary?.size)}</td>
                      <td className="num">{s.summary?.files.toLocaleString('en') ?? '–'}</td>
                      <td className="num">{s.summary?.dirs.toLocaleString('en') ?? '–'}</td>
                      <td className="num">{s.errors || s.summary?.failed || <span className="muted">0</span>}</td>
                      <td className="small">
                        {s.retention
                          .filter((r) => r !== 'incomplete')
                          .map((r) => (
                            <span key={r} className="tag">
                              {r}
                            </span>
                          ))}
                        {s.pins.map((p) => (
                          <span key={p} className="tag" title="pinned">
                            📌 {p}
                          </span>
                        ))}
                        {s.description && <div className="muted">{s.description}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))}
      </div>
    </>
  );
}

function SnapshotCrumbs({
  conn,
  bucket,
  prefix,
  snapshot,
  path,
  onGo,
}: {
  conn: ConnectionInfo;
  bucket: string;
  prefix: string;
  snapshot: string;
  path: string;
  onGo: Go;
}) {
  // The snapshot list is cached on the server; this finds the label of the open one.
  const list = useAsync(() => api.kopiaSnapshots(conn.id, bucket, prefix), [conn.id, bucket, prefix]);
  const s = list.data?.find((x) => x.id === snapshot);
  const parts = path ? path.split('/') : [];
  return (
    <>
      <span className="crumb-sep">
        <Icon name="chevronRight" size={12} />
        <button
          type="button"
          className="crumb"
          onClick={() => onGo({ s: snapshot })}
          title={s ? sourceLabel(s) : snapshot}
        >
          {s
            ? `${s.source.path.split('/').filter(Boolean).at(-1) ?? s.source.path} · ${dateTime(s.startTime)}`
            : snapshot.slice(0, 8)}
        </button>
      </span>
      {parts.map((name, i) => (
        <span key={i} className="crumb-sep">
          <Icon name="chevronRight" size={12} />
          <button
            type="button"
            className="crumb"
            onClick={() => onGo({ s: snapshot, kp: parts.slice(0, i + 1).join('/') })}
          >
            {name}
          </button>
        </span>
      ))}
    </>
  );
}

const ROWS_SHOWN = 1000;

function Browser({
  conn,
  bucket,
  prefix,
  snapshot,
  path,
  file,
  textBytes,
  onGo,
}: {
  conn: ConnectionInfo;
  bucket: string;
  prefix: string;
  snapshot: string;
  path: string;
  file: string | null;
  textBytes: number;
  onGo: Go;
}) {
  const data = useAsync(
    () => api.kopiaBrowse(conn.id, bucket, prefix, snapshot, path),
    [conn.id, bucket, prefix, snapshot, path],
  );
  const [filter, setFilter] = useState('');
  const [all, setAll] = useState(false);
  const d = data.data && data.data.path === path && data.data.snapshot.id === snapshot ? data.data : null;
  const rows = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const list = (d?.entries ?? []).filter((e) => !f || e.name.toLowerCase().includes(f));
    // Folders first, then by name, as in file managers.
    return list.sort(
      (a, b) =>
        Number(b.type === 'd') - Number(a.type === 'd') ||
        a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
    );
  }, [d, filter]);
  const join = (name: string) => (path ? `${path}/${name}` : name);
  const open = file ? (d?.entries.find((e) => e.name === file && e.type === 'f') ?? null) : null;
  const s = d?.snapshot;

  return (
    <>
      {s && (
        <div className="snapshot-head">
          <StatusTag s={s} />
          <span className="mono small">{sourceLabel(s)}</span>
          <span className="muted small">
            {dateTime(s.startTime)} · {bytes(d.summary?.size ?? null)} · {plural(d.summary?.files ?? 0, 'file')},{' '}
            {plural(d.summary?.dirs ?? 0, 'folder')} in this folder and below
          </span>
        </div>
      )}
      {s?.incomplete && (
        <InfoBanner>
          This snapshot is incomplete ({s.incomplete}): it holds what kopia had uploaded by{' '}
          {dateTime(s.endTime ?? s.startTime)}. Folders not reached yet are missing or partial.
        </InfoBanner>
      )}
      <div className="toolbar">
        <div className="toolbar-actions">
          <span className="sel-count">{d ? plural(d.entries.length, 'entry', 'entries') : ''}</span>
        </div>
        <div className="toolbar-search" role="search">
          <Icon name="search" />
          <input
            type="search"
            aria-label="Filter"
            placeholder="Filter this folder"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
      </div>
      {data.error && <ErrorBanner>{data.error.message}</ErrorBanner>}
      {!d && !data.error && (
        <div className="empty">
          <Spinner label="Reading the folder from the backup…" />
        </div>
      )}
      {d && (
        <div className={`table-wrap${data.loading ? ' dim' : ''}`}>
          <table className="table files">
            <thead>
              <tr>
                <th className="col-name">Name</th>
                <th className="num">Size</th>
                <th className="col-date">Modified</th>
                <th className="col-mode">Permissions</th>
                <th className="col-owner">Owner</th>
              </tr>
            </thead>
            <tbody>
              {path && (
                <tr className="row-up">
                  <td colSpan={5}>
                    <button
                      type="button"
                      className="name-btn"
                      onClick={() => onGo({ s: snapshot, kp: path.split('/').slice(0, -1).join('/') })}
                    >
                      <Icon name="up" />
                      ..
                    </button>
                  </td>
                </tr>
              )}
              {(all ? rows : rows.slice(0, ROWS_SHOWN)).map((e) => (
                <tr key={e.name} className={open?.name === e.name ? 'selected' : ''}>
                  <td className="col-name">
                    {e.type === 'd' ? (
                      <button
                        type="button"
                        className="name-btn"
                        onClick={() => onGo({ s: snapshot, kp: join(e.name) })}
                      >
                        <Icon name="folder" className="folder-icon" />
                        <span className="ellipsis">{e.name}</span>
                      </button>
                    ) : e.type === 'f' ? (
                      <button
                        type="button"
                        className="name-btn"
                        onClick={() => onGo({ s: snapshot, kp: path, kf: e.name })}
                      >
                        <Icon name={fileIcon(e.name)} className="file-icon" />
                        <span className="ellipsis">{e.name}</span>
                      </button>
                    ) : (
                      <span
                        className="name-btn muted"
                        title={e.type === 's' ? 'Symbolic link' : `kopia entry type ${e.type}`}
                      >
                        <Icon name="link" />
                        <span className="ellipsis">{e.name}</span>
                      </span>
                    )}
                  </td>
                  <td className="num">{bytes(e.size)}</td>
                  <td className="col-date" title={dateTime(e.mtime)}>
                    {ago(e.mtime)}
                  </td>
                  <td className="col-mode mono small">{modeString(e.type, e.mode)}</td>
                  <td className="col-owner small muted">{e.uid !== null ? `${e.uid}:${e.gid ?? ''}` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length && (
            <div className="empty">{filter ? 'Nothing matches the filter.' : 'This folder is empty.'}</div>
          )}
          {!all && rows.length > ROWS_SHOWN && (
            <div className="pager">
              <span className="muted small">
                {ROWS_SHOWN.toLocaleString('en')} of {rows.length.toLocaleString('en')} shown
              </span>
              <button type="button" className="btn" onClick={() => setAll(true)}>
                Show all
              </button>
            </div>
          )}
        </div>
      )}
      {open && s && (
        <FileDrawer
          conn={conn}
          bucket={bucket}
          prefix={prefix}
          snapshot={s}
          path={join(open.name)}
          entry={open}
          textBytes={textBytes}
          onClose={() => onGo({ s: snapshot, kp: path }, true)}
        />
      )}
    </>
  );
}

function FileDrawer({
  conn,
  bucket,
  prefix,
  snapshot,
  path,
  entry,
  textBytes,
  onClose,
}: {
  conn: ConnectionInfo;
  bucket: string;
  prefix: string;
  snapshot: KopiaSnapshot;
  path: string;
  entry: KopiaEntry;
  textBytes: number;
  onClose: () => void;
}) {
  const kind = previewKind(entry.name, null, entry.size ?? Infinity, textBytes);
  const src = kopiaFileUrl(conn.id, bucket, prefix, snapshot.id, path, true);
  const original = `${snapshot.source.path.replace(/\/$/, '')}/${path}`;
  return (
    <Drawer
      title={entry.name}
      subtitle={`${snapshot.source.host}:${original}`}
      onClose={onClose}
      wide
      actions={
        <a className="btn btn-primary" href={kopiaFileUrl(conn.id, bucket, prefix, snapshot.id, path)} download>
          <Icon name="download" />
          Download
        </a>
      }
    >
      {kind === 'image' && (
        <div className="preview">
          <img src={src} alt={`Preview of ${entry.name}`} />
        </div>
      )}
      {kind === 'audio' && (
        <div className="preview">
          <audio controls src={src} preload="metadata" />
        </div>
      )}
      {kind === 'video' && (
        <div className="preview">
          <video controls src={src} preload="metadata" />
        </div>
      )}
      {kind === 'pdf' && (
        <div className="preview">
          <iframe src={src} title={`Preview of ${entry.name}`} className="pdf" />
        </div>
      )}
      {kind === 'text' && (
        <TextPreview conn={conn} bucket={bucket} prefix={prefix} snapshot={snapshot.id} path={path} />
      )}
      <h3>Properties</h3>
      <KV
        rows={[
          ['Name', <span className="mono">{entry.name}</span>],
          ['Original path', <span className="mono">{original}</span>],
          ['Source', `${snapshot.source.user}@${snapshot.source.host}`],
          ['Size', entry.size !== null ? `${bytes(entry.size)} (${exactBytes(entry.size)})` : null],
          ['Modified', dateTime(entry.mtime)],
          [
            'Permissions',
            entry.mode ? `${modeString(entry.type, entry.mode)} (${octalPermissions(entry.mode)})` : null,
          ],
          ['Owner', entry.uid !== null ? `uid ${entry.uid}, gid ${entry.gid ?? '–'}` : null],
          ['Snapshot', `${dateTime(snapshot.startTime)} (${snapshot.id})`],
          ['kopia object ID', <span className="mono wrap">{entry.oid}</span>],
        ]}
      />
      <p className="muted small">
        The file is read from the backup by kopia and streamed through ObjectLens; nothing is written to the repository.
      </p>
    </Drawer>
  );
}

function TextPreview({
  conn,
  bucket,
  prefix,
  snapshot,
  path,
}: {
  conn: ConnectionInfo;
  bucket: string;
  prefix: string;
  snapshot: string;
  path: string;
}) {
  const text = useAsync(
    () => api.kopiaText(conn.id, bucket, prefix, snapshot, path),
    [conn.id, bucket, prefix, snapshot, path],
  );
  if (text.error) return <ErrorBanner>Preview failed: {text.error.message}</ErrorBanner>;
  if (text.data === null) return <Spinner label="Loading preview…" />;
  return (
    <div className="preview preview-text">
      <pre className="code">{text.data}</pre>
    </div>
  );
}
