import { useCallback, useEffect, useState } from 'react';
import type { ConnectionInfo } from '../shared/types.ts';
import { api } from './api.ts';
import { CreateBucketDialog } from './components/dialogs.tsx';
import { Icon } from './components/icons.tsx';
import { CapButton, ErrorBanner, InfoBanner, Spinner, ToastProvider } from './components/ui.tsx';
import { useToast } from './toast.ts';
import { UploadPanel } from './components/Uploads.tsx';
import { useUploads } from './uploads.ts';
import { dateTime } from './format.ts';
import { useAsync } from './hooks.ts';
import logo from './logo.svg';
import { Explorer } from './views/Explorer.tsx';
import { KopiaView } from './views/KopiaView.tsx';
import { VeleroView } from './views/VeleroView.tsx';

/** Where we are: kept in the query string so that reload, back and links work. */
interface Location {
  c: string;
  b: string;
  p: string;
  o: string;
  v: string;
  /** "1": the kopia repository in folder p, read-only. */
  k: string;
  /** kopia snapshot ID. */
  s: string;
  /** Folder inside the snapshot ("a/b"). */
  kp: string;
  /** File of that folder shown in the drawer. */
  kf: string;
  /** "1": the Velero backup location in folder p. */
  vel: string;
  /** Velero backup name. */
  vb: string;
  /** Shown in the drawer: "logs" or a manifest path of the backup. */
  vf: string;
}

const KEYS = ['c', 'b', 'p', 'o', 'v', 'k', 's', 'kp', 'kf', 'vel', 'vb', 'vf'] as const;

const readLocation = (): Location => {
  const q = new URLSearchParams(location.search);
  return Object.fromEntries(KEYS.map((k) => [k, q.get(k) ?? ''])) as unknown as Location;
};

const href = (l: Partial<Location>) => {
  const q = new URLSearchParams();
  for (const k of KEYS) if (l[k]) q.set(k, l[k]!);
  const s = q.toString();
  return s ? `/?${s}` : '/';
};

function ThemeToggle() {
  const [theme, setTheme] = useState<string>(() => document.documentElement.getAttribute('data-theme') ?? 'auto');
  const set = (t: string) => {
    setTheme(t);
    if (t === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
    try {
      localStorage.setItem('theme', t);
    } catch {
      // storage unavailable
    }
  };
  return (
    <div className="segmented" role="group" aria-label="Theme">
      {['auto', 'light', 'dark'].map((t) => (
        <button key={t} type="button" aria-pressed={theme === t} onClick={() => set(t)}>
          {t[0]!.toUpperCase() + t.slice(1)}
        </button>
      ))}
    </div>
  );
}

export function App() {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  );
}

function Shell() {
  const [loc, setLoc] = useState(readLocation);
  const info = useAsync(() => api.info(), []);
  const [bucketsVersion, setBucketsVersion] = useState(0);
  const [uploaded, setUploaded] = useState<{ at: string; n: number }>({ at: '', n: 0 });
  const [navOpen, setNavOpen] = useState(false);
  const toast = useToast();

  const onUploaded = useCallback((c: string, b: string) => {
    setUploaded((u) => ({ at: `${c}/${b}`, n: u.n + 1 }));
  }, []);
  const uploads = useUploads(onUploaded);

  useEffect(() => {
    const onPop = () => setLoc(readLocation());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const go = useCallback((l: Partial<Location>, replace = false) => {
    const next = { ...(Object.fromEntries(KEYS.map((k) => [k, ''])) as unknown as Location), ...l };
    if (replace) history.replaceState(null, '', href(next));
    else history.pushState(null, '', href(next));
    setLoc(next);
    setNavOpen(false);
  }, []);

  // Leave the page only after confirming while uploads run.
  useEffect(() => {
    const busy = uploads.items.some((i) => i.status === 'uploading' || i.status === 'queued');
    if (!busy) return;
    const onUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [uploads.items]);

  const connections = info.data?.connections ?? [];
  // A single connection opens directly.
  const current = loc.c || (connections.length === 1 ? connections[0]!.id : '');
  const conn = connections.find((c) => c.id === current) ?? null;

  const buckets = useAsync(
    () => (conn ? api.buckets(conn.id) : Promise.resolve(null)),
    [conn?.id ?? '', bucketsVersion],
  );
  const bucketNames = buckets.data?.buckets.map((b) => b.name) ?? [];

  useEffect(() => {
    const t = [loc.b && `${loc.b}/${loc.p}`, conn?.name, 'ObjectLens'].filter(Boolean).join(' · ');
    document.title = t;
  }, [loc.b, loc.p, conn?.name]);

  return (
    <div className="app">
      <header className="header">
        <button
          type="button"
          className="btn btn-icon nav-toggle"
          aria-label="Show navigation"
          onClick={() => setNavOpen(!navOpen)}
        >
          <Icon name="bucket" />
        </button>
        <a
          href="/"
          className="brand"
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
            e.preventDefault();
            go({});
          }}
        >
          <img src={logo} alt="" width="28" height="28" />
          <span className="brand-name">ObjectLens</span>
        </a>
        <div className="header-actions">
          <ThemeToggle />
        </div>
      </header>

      <div className="layout">
        <nav className={`sidebar${navOpen ? ' open' : ''}`} aria-label="Connections and buckets">
          {info.error && <ErrorBanner>{info.error.message}</ErrorBanner>}
          {!info.data && !info.error && <Spinner />}
          {connections.map((c) => (
            <div key={c.id} className="side-conn">
              <button
                type="button"
                className={`side-item side-conn-name${c.id === current && !loc.b ? ' active' : ''}`}
                aria-expanded={c.id === current}
                onClick={() => go({ c: c.id })}
              >
                <Icon name={c.id === current ? 'chevronDown' : 'chevronRight'} size={12} />
                <Icon name="server" />
                <span className="ellipsis">{c.name}</span>
                {c.readOnly && <Icon name="lock" size={12} className="muted" />}
              </button>
              {c.id === current && (
                <ul className="side-buckets">
                  {buckets.loading && !buckets.data && (
                    <li className="side-note">
                      <Spinner />
                    </li>
                  )}
                  {buckets.error && <li className="side-note error-text">{buckets.error.message}</li>}
                  {buckets.data?.buckets.map((b) => (
                    <li key={b.name}>
                      <a
                        href={href({ c: c.id, b: b.name })}
                        className={`side-item${b.name === loc.b ? ' active' : ''}`}
                        aria-current={b.name === loc.b ? 'page' : undefined}
                        onClick={(e) => {
                          if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                          e.preventDefault();
                          go({ c: c.id, b: b.name });
                        }}
                      >
                        <Icon name="bucket" />
                        <span className="ellipsis">{b.name}</span>
                      </a>
                    </li>
                  ))}
                  {buckets.data && !buckets.data.buckets.length && <li className="side-note muted">No buckets</li>}
                </ul>
              )}
            </div>
          ))}
        </nav>

        <main className="main">
          {info.data && !connections.length && (
            <div className="welcome">
              <h1>No S3 connection is configured</h1>
              <p>
                Set <span className="mono">S3_1_ENDPOINT</span>, <span className="mono">S3_1_ACCESS_KEY_ID</span> and{' '}
                <span className="mono">S3_1_SECRET_ACCESS_KEY</span> in <span className="mono">.env</span> and restart
                ObjectLens. See <span className="mono">.env.example</span>.
              </p>
            </div>
          )}
          {info.data && connections.length > 0 && !conn && (
            <ConnectionList connections={connections} onOpen={(c) => go({ c })} />
          )}
          {conn && !loc.b && (
            <BucketList
              conn={conn}
              data={buckets.data}
              error={buckets.error}
              onOpen={(b) => go({ c: conn.id, b })}
              onCreated={(b) => {
                setBucketsVersion((v) => v + 1);
                toast(`Bucket ${b} created`);
                go({ c: conn.id, b });
              }}
            />
          )}
          {conn && loc.b && info.data && loc.vel === '1' && (
            <VeleroView
              key={`${conn.id}/${loc.b}/${loc.p}`}
              conn={conn}
              bucket={loc.b}
              prefix={loc.p}
              backup={loc.vb || null}
              file={loc.vf || null}
              onGo={(l, replace) => go({ c: conn.id, b: loc.b, p: loc.p, vel: '1', ...l }, replace)}
              onObjects={() => go({ c: conn.id, b: loc.b, p: loc.p })}
              onBrowse={(repository, snapshot) => go({ c: conn.id, b: loc.b, p: repository, k: '1', s: snapshot })}
            />
          )}
          {conn && loc.b && info.data && loc.k === '1' && (
            <KopiaView
              key={`${conn.id}/${loc.b}/${loc.p}`}
              conn={conn}
              bucket={loc.b}
              prefix={loc.p}
              snapshot={loc.s || null}
              path={loc.kp}
              file={loc.kf || null}
              textBytes={info.data.limits.textBytes}
              onGo={(l, replace) => go({ c: conn.id, b: loc.b, p: loc.p, k: '1', ...l }, replace)}
              onObjects={() => go({ c: conn.id, b: loc.b, p: loc.p })}
              onVelero={(location) => go({ c: conn.id, b: loc.b, p: location, vel: '1' })}
            />
          )}
          {conn && loc.b && info.data && loc.k !== '1' && loc.vel !== '1' && (
            <Explorer
              key={`${conn.id}/${loc.b}`}
              conn={conn}
              bucket={loc.b}
              prefix={loc.p}
              objectKey={loc.o || null}
              versionId={loc.v || null}
              buckets={bucketNames}
              limits={info.data.limits}
              uploads={uploads}
              uploadedVersion={uploaded.at === `${conn.id}/${loc.b}` ? uploaded.n : 0}
              onNavigate={(p) => go({ c: conn.id, b: loc.b, p })}
              onKopia={() => go({ c: conn.id, b: loc.b, p: loc.p, k: '1' })}
              onVelero={() => go({ c: conn.id, b: loc.b, p: loc.p, vel: '1' })}
              onOpenObject={(o, v) => go({ c: conn.id, b: loc.b, p: loc.p, o: o ?? '', v: v ?? '' }, !o)}
              onBucketDeleted={() => {
                setBucketsVersion((v) => v + 1);
                go({ c: conn.id });
              }}
            />
          )}
        </main>
      </div>
      <UploadPanel uploads={uploads} />
    </div>
  );
}

function ConnectionList({ connections, onOpen }: { connections: ConnectionInfo[]; onOpen: (id: string) => void }) {
  return (
    <div className="welcome">
      <h1>Connections</h1>
      <div className="cards">
        {connections.map((c) => (
          <button key={c.id} type="button" className="card card-button" onClick={() => onOpen(c.id)}>
            <Icon name="server" size={20} />
            <div>
              <div className="card-title">{c.name}</div>
              <div className="muted small">
                {c.endpoint} · {c.region}
                {c.readOnly ? ' · read-only' : ''}
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function BucketList({
  conn,
  data,
  error,
  onOpen,
  onCreated,
}: {
  conn: ConnectionInfo;
  data: Awaited<ReturnType<typeof api.buckets>> | null;
  error: Error | null;
  onOpen: (b: string) => void;
  onCreated: (b: string) => void;
}) {
  const [creating, setCreating] = useState(false);
  return (
    <div className="welcome">
      <div className="page-head">
        <div>
          <h1>{conn.name}</h1>
          <div className="muted small">
            {conn.endpoint} · {conn.region}
            {conn.readOnly ? ' · read-only' : ''}
          </div>
        </div>
        {!conn.readOnly && (
          <CapButton icon="plus" label="New bucket" primary cap={data?.canCreate} onClick={() => setCreating(true)} />
        )}
      </div>
      {error && <ErrorBanner>{error.message}</ErrorBanner>}
      {data?.error && <InfoBanner>{data.error}</InfoBanner>}
      {!data && !error && <Spinner label="Loading buckets…" />}
      {data && (
        <div className="cards">
          {data.buckets.map((b) => (
            <button key={b.name} type="button" className="card card-button" onClick={() => onOpen(b.name)}>
              <Icon name="bucket" size={20} />
              <div className="min0">
                <div className="card-title ellipsis">{b.name}</div>
                <div className="muted small">
                  {b.createdAt ? `Created ${dateTime(b.createdAt)}` : 'From the configuration'}
                </div>
              </div>
            </button>
          ))}
          {!data.buckets.length && <p className="muted">No buckets.</p>}
        </div>
      )}
      {creating && (
        <CreateBucketDialog
          conn={conn.id}
          defaultRegion={conn.region}
          onClose={() => setCreating(false)}
          onDone={(b) => {
            setCreating(false);
            onCreated(b);
          }}
        />
      )}
    </div>
  );
}
