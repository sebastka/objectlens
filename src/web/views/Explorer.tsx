import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { baseName, breadcrumbs, parentPrefix } from '../../shared/keys.ts';
import type {
  Capabilities,
  ConnectionInfo,
  ItemRef,
  ListResponse,
  ObjectEntry,
  SearchResponse,
} from '../../shared/types.ts';
import { ApiError, api, downloadUrl } from '../api.ts';
import { ago, bytes, dateTime, plural } from '../format.ts';
import { useAsync } from '../hooks.ts';
import { DeleteDialog, NameDialog, ShareDialog, TransferDialog } from '../components/dialogs.tsx';
import { Icon } from '../components/icons.tsx';
import { fileIcon } from '../filetypes.ts';
import { CapButton, ErrorBanner, InfoBanner, Spinner } from '../components/ui.tsx';
import { useToast } from '../toast.ts';
import { droppedFiles, type useUploads } from '../uploads.ts';
import { BucketDrawer } from './BucketDrawer.tsx';
import { ObjectDrawer, type ObjectAction } from './ObjectDrawer.tsx';

type Row =
  | { kind: 'folder'; id: string; prefix: string; name: string }
  | { kind: 'object'; id: string; name: string; o: ObjectEntry };

type SortKey = 'name' | 'size' | 'modified';

type Dialog =
  | { kind: 'newFolder' }
  | { kind: 'rename'; item: ItemRef }
  | { kind: 'delete'; items: ItemRef[] }
  | { kind: 'transfer'; items: ItemRef[]; move: boolean }
  | { kind: 'share'; key: string; versionId: string | null };

const rowItem = (r: Row): ItemRef => (r.kind === 'folder' ? { prefix: r.prefix } : { key: r.o.key });

export function Explorer({
  conn,
  bucket,
  prefix,
  objectKey,
  versionId,
  buckets,
  limits,
  uploads,
  uploadedVersion,
  onNavigate,
  onOpenObject,
  onBucketDeleted,
  onKopia,
}: {
  conn: ConnectionInfo;
  bucket: string;
  prefix: string;
  objectKey: string | null;
  versionId: string | null;
  buckets: string[];
  limits: { textBytes: number; shareMaxHours: number };
  uploads: ReturnType<typeof useUploads>;
  /** Bumped when an upload into this bucket finished. */
  uploadedVersion: number;
  onNavigate: (prefix: string) => void;
  onOpenObject: (key: string | null, versionId?: string | null) => void;
  onBucketDeleted: () => void;
  /** Opens the kopia repository of this folder. */
  onKopia: () => void;
}) {
  const toast = useToast();
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  const where = `${conn.id}/${bucket}/${prefix}`;

  // Listing: the first page reloads with the location; further pages are appended on demand.
  const first = useAsync(() => api.list(conn.id, bucket, prefix), [conn.id, bucket, prefix, version, uploadedVersion]);
  const [more, setMore] = useState<{ at: string; pages: ListResponse[]; loading: boolean }>({
    at: '',
    pages: [],
    loading: false,
  });
  const listKey = `${where}#${version}#${uploadedVersion}`;
  // While another folder loads, the previous folder's listing is not shown; while this one
  // reloads it is shown dimmed, but not paged (its token may be outdated).
  const listing = first.data?.prefix === prefix ? first.data : null;
  const pages = useMemo(
    () => (listing ? [listing, ...(more.at === listKey ? more.pages : [])] : []),
    [listing, more, listKey],
  );
  const nextToken = pages.length && !first.loading ? pages[pages.length - 1]!.nextToken : null;
  const loadMore = async () => {
    if (!nextToken) return;
    setMore((m) => ({ at: listKey, pages: m.at === listKey ? m.pages : [], loading: true }));
    try {
      const page = await api.list(conn.id, bucket, prefix, nextToken);
      setMore((m) => ({ at: listKey, pages: [...(m.at === listKey ? m.pages : []), page], loading: false }));
    } catch (e) {
      setMore((m) => ({ ...m, loading: false }));
      toast((e as Error).message, 'error');
    }
  };

  const caps = useAsync(() => api.capabilities(conn.id, bucket, prefix), [conn.id, bucket, prefix, version]);
  const kopiaRepo = useAsync(() => api.kopiaDetect(conn.id, bucket, prefix), [conn.id, bucket, prefix]);
  const isKopia = kopiaRepo.data?.repository === true;
  const c: Capabilities | null = caps.data;
  const versioning = useAsync(() => api.versioning(conn.id, bucket), [conn.id, bucket, version]);

  // Filter (loaded entries) and search (the whole subtree, on the server).
  const [filter, setFilter] = useState('');
  const [search, setSearch] = useState<{
    at: string;
    q: string;
    result: SearchResponse | null;
    error: string | null;
  } | null>(null);
  const searching = search?.at === where ? search : null;
  const searchId = useRef(0);
  const runSearch = async () => {
    const q = filter.trim();
    if (!q) return;
    // Only the latest search may show its result.
    const id = ++searchId.current;
    setSearch({ at: where, q, result: null, error: null });
    try {
      const result = await api.search(conn.id, bucket, prefix, q);
      if (id === searchId.current) setSearch({ at: where, q, result, error: null });
    } catch (e) {
      if (id === searchId.current) setSearch({ at: where, q, result: null, error: (e as Error).message });
    }
  };

  const [sort, setSort] = useState<{ by: SortKey; desc: boolean }>({ by: 'name', desc: false });
  const rows: Row[] = useMemo(() => {
    let folders: Row[] = [];
    let objects: Row[];
    if (searching?.result) {
      objects = searching.result.objects.map((o) => ({
        kind: 'object',
        id: `o:${o.key}`,
        name: o.key.slice(prefix.length),
        o,
      }));
    } else {
      folders = pages.flatMap((p) =>
        p.folders.map((f): Row => ({ kind: 'folder', id: `f:${f}`, prefix: f, name: baseName(f) })),
      );
      objects = pages.flatMap((p) =>
        p.objects.map((o): Row => ({ kind: 'object', id: `o:${o.key}`, name: baseName(o.key), o })),
      );
      const f = filter.trim().toLowerCase();
      if (f) {
        folders = folders.filter((r) => r.name.toLowerCase().includes(f));
        objects = objects.filter((r) => r.name.toLowerCase().includes(f));
      }
    }
    const dir = sort.desc ? -1 : 1;
    const cmp = (a: Row, b: Row) => {
      if (sort.by === 'size' && a.kind === 'object' && b.kind === 'object') return (a.o.size - b.o.size) * dir;
      if (sort.by === 'modified' && a.kind === 'object' && b.kind === 'object')
        return (a.o.lastModified ?? '').localeCompare(b.o.lastModified ?? '') * dir;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) * dir;
    };
    // Folders first, as in file managers.
    return [...folders.sort(cmp), ...objects.sort(cmp)];
  }, [pages, filter, sort, searching, prefix]);

  // Selection, scoped to one visit of a folder: it is gone after navigating away and back.
  const [visit, setVisit] = useState({ where, n: 0 });
  if (visit.where !== where) setVisit({ where, n: visit.n + 1 });
  const selKey = `${where}#${visit.n}`;
  const [sel, setSel] = useState<{ at: string; ids: Set<string> }>({ at: '', ids: new Set() });
  const selected = useMemo(() => (sel.at === selKey ? sel.ids : new Set<string>()), [sel, selKey]);
  const anchor = useRef<string | null>(null);
  const selectedRows = rows.filter((r) => selected.has(r.id));
  const selectedItems = selectedRows.map(rowItem);
  const toggle = (r: Row, e?: { shiftKey: boolean }) => {
    const ids = new Set(selected);
    if (e?.shiftKey && anchor.current) {
      const a = rows.findIndex((x) => x.id === anchor.current);
      const b = rows.findIndex((x) => x.id === r.id);
      if (a >= 0 && b >= 0) for (const x of rows.slice(Math.min(a, b), Math.max(a, b) + 1)) ids.add(x.id);
    } else if (ids.has(r.id)) ids.delete(r.id);
    else ids.add(r.id);
    anchor.current = r.id;
    setSel({ at: selKey, ids });
  };
  const selectAll = (on: boolean) => setSel({ at: selKey, ids: on ? new Set(rows.map((r) => r.id)) : new Set() });

  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [bucketOpen, setBucketOpen] = useState(false);

  const afterChange = (msg: string | null, level: 'ok' | 'error' = 'ok') => {
    setDialog(null);
    setSel({ at: selKey, ids: new Set() });
    refresh();
    if (msg) toast(msg, level);
  };

  const bulkMessage = (
    verb: string,
    r: { done: number; failed: { key: string; error: string }[]; truncated: boolean },
  ) =>
    `${verb} ${plural(r.done, 'object')}` +
    (r.failed.length ? `; ${r.failed.length} failed (${r.failed[0]!.key}: ${r.failed[0]!.error})` : '') +
    (r.truncated ? '. Stopped at the limit: run it again to continue.' : '');

  const download = (keys: string[]) => {
    // One download per file; browsers may ask to allow multiple downloads.
    keys.forEach((k, i) =>
      setTimeout(() => {
        const a = document.createElement('a');
        a.href = downloadUrl(conn.id, bucket, k);
        a.download = baseName(k);
        a.click();
      }, i * 400),
    );
  };

  const folderSize = async (p: string) => {
    toast(`Counting ${p}…`, 'info');
    try {
      const r = await api.size(conn.id, bucket, p);
      toast(
        `${baseName(p)}/: ${plural(r.objects, 'object')}, ${bytes(r.bytes)}${r.truncated ? ' (stopped at the limit)' : ''}`,
      );
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const addFiles = (files: { file: File; path: string }[]) => {
    if (!files.length) return;
    uploads.add(
      conn.id,
      bucket,
      files.map((f) => ({ file: f.file, key: prefix + f.path })),
    );
  };

  // Drag and drop anywhere on the explorer.
  const [dragging, setDragging] = useState(0);
  const canWrite = c?.write.allowed !== false && !conn.readOnly;

  // Keyboard shortcuts (not while typing in a field or with a dialog open).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (
        t.closest('input:not([type="checkbox"]), textarea, select, dialog, [role="dialog"]') ||
        dialog ||
        objectKey ||
        bucketOpen
      )
        return;
      if ((e.key === 'a' || e.key === 'A') && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        selectAll(true);
      } else if (e.key === 'Escape') {
        selectAll(false);
      } else if (e.key === 'Delete' && selectedItems.length && c?.delete.allowed !== false && !conn.readOnly) {
        setDialog({ kind: 'delete', items: selectedItems });
      } else if (e.key === 'F2' && selectedItems.length === 1 && canWrite) {
        setDialog({ kind: 'rename', item: selectedItems[0]! });
      } else if ((e.key === 'Backspace' || (e.key === 'ArrowUp' && e.altKey)) && prefix) {
        e.preventDefault();
        onNavigate(parentPrefix(prefix));
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  const onObjectAction = (a: ObjectAction, v?: string) => {
    if (!objectKey) return;
    const item: ItemRef = { key: objectKey };
    if (a === 'share') setDialog({ kind: 'share', key: objectKey, versionId: v ?? null });
    else if (a === 'rename') setDialog({ kind: 'rename', item });
    else if (a === 'copy' || a === 'move') setDialog({ kind: 'transfer', items: [item], move: a === 'move' });
    else if (a === 'delete') setDialog({ kind: 'delete', items: [v ? { key: objectKey, versionId: v } : item] });
  };

  const single = selectedRows.length === 1 ? selectedRows[0]! : null;
  const onlyObjects = selectedRows.length > 0 && selectedRows.every((r) => r.kind === 'object');
  const writeCaps = [c?.write].filter(isCap);
  const moveCaps = [c?.read, c?.delete].filter(isCap);

  let toolbar: ReactNode;
  if (selectedRows.length) {
    toolbar = (
      <>
        <span className="sel-count">{plural(selectedRows.length, 'selected', 'selected')}</span>
        {onlyObjects && (
          <CapButton
            icon="download"
            label="Download"
            cap={c?.read}
            onClick={() => download(selectedRows.map((r) => (r.kind === 'object' ? r.o.key : '')))}
          />
        )}
        {!conn.readOnly && (
          <>
            <CapButton
              icon="pencil"
              label="Rename"
              cap={[...writeCaps, ...moveCaps]}
              disabled={!single}
              title={single ? undefined : 'Select one item to rename'}
              onClick={() => single && setDialog({ kind: 'rename', item: rowItem(single) })}
            />
            <CapButton
              icon="copy"
              label="Copy"
              cap={c?.read}
              onClick={() => setDialog({ kind: 'transfer', items: selectedItems, move: false })}
            />
            <CapButton
              icon="move"
              label="Move"
              cap={moveCaps}
              onClick={() => setDialog({ kind: 'transfer', items: selectedItems, move: true })}
            />
            <CapButton
              icon="trash"
              label="Delete"
              cap={c?.delete}
              danger
              onClick={() => setDialog({ kind: 'delete', items: selectedItems })}
            />
          </>
        )}
        {single?.kind === 'folder' && (
          <CapButton icon="sum" label="Size" cap={c?.list} onClick={() => void folderSize(single.prefix)} />
        )}
        <button type="button" className="btn-link small" onClick={() => selectAll(false)}>
          Clear selection
        </button>
      </>
    );
  } else {
    toolbar = (
      <>
        {!conn.readOnly && (
          <>
            <CapButton
              icon="upload"
              label="Upload files"
              cap={c?.write}
              primary
              onClick={() => fileInput.current?.click()}
            />
            <CapButton
              icon="upload"
              label="Upload folder"
              cap={c?.write}
              onClick={() => folderInput.current?.click()}
            />
            <CapButton
              icon="folderPlus"
              label="New folder"
              cap={c?.write}
              onClick={() => setDialog({ kind: 'newFolder' })}
            />
          </>
        )}
      </>
    );
  }

  const allChecked = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const sortHeader = (k: SortKey, label: string, cls = '') => (
    <th className={cls} aria-sort={sort.by === k ? (sort.desc ? 'descending' : 'ascending') : 'none'}>
      <button
        type="button"
        className="th-sort"
        onClick={() => setSort({ by: k, desc: sort.by === k ? !sort.desc : k !== 'name' })}
      >
        {label}
        {sort.by === k && <Icon name={sort.desc ? 'chevronDown' : 'up'} size={12} />}
      </button>
    </th>
  );

  const listError = first.error;
  const denied = listError instanceof ApiError && listError.status === 403;

  return (
    <div
      className={`explorer${dragging ? ' dragging' : ''}`}
      onDragEnter={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDragging((n) => n + 1);
      }}
      onDragLeave={() => setDragging((n) => Math.max(0, n - 1))}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) e.preventDefault();
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(0);
        if (!canWrite) {
          toast(
            conn.readOnly ? 'This connection is read-only.' : `Uploading here is not allowed: ${c?.write.reason ?? ''}`,
            'error',
          );
          return;
        }
        void droppedFiles(e.dataTransfer).then(addFiles);
      }}
    >
      <div className="location">
        <nav className="crumbs" aria-label="Folder">
          <button type="button" className="crumb" onClick={() => onNavigate('')}>
            <Icon name="bucket" />
            {bucket}
          </button>
          {breadcrumbs(prefix).map((b) => (
            <span key={b.prefix} className="crumb-sep">
              <Icon name="chevronRight" size={12} />
              <button type="button" className="crumb" onClick={() => onNavigate(b.prefix)}>
                {b.name}
              </button>
            </span>
          ))}
        </nav>
        <div className="inline">
          <button type="button" className="btn btn-icon" aria-label="Refresh" title="Refresh" onClick={refresh}>
            <Icon name="refresh" />
          </button>
          <button type="button" className="btn" onClick={() => setBucketOpen(true)}>
            <Icon name="settings" />
            Bucket properties
          </button>
        </div>
      </div>

      <div className="toolbar">
        <div className="toolbar-actions">{toolbar}</div>
        <div className="toolbar-search" role="search">
          <Icon name="search" />
          <input
            type="search"
            aria-label="Filter or search"
            placeholder="Filter; Enter searches subfolders"
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              if (searching) setSearch(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void runSearch();
              if (e.key === 'Escape') {
                setFilter('');
                setSearch(null);
              }
            }}
          />
        </div>
      </div>
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          addFiles([...(e.target.files ?? [])].map((file) => ({ file, path: file.name })));
          e.target.value = '';
        }}
      />
      <input
        ref={folderInput}
        type="file"
        hidden
        {...{ webkitdirectory: '' }}
        onChange={(e) => {
          addFiles([...(e.target.files ?? [])].map((file) => ({ file, path: file.webkitRelativePath || file.name })));
          e.target.value = '';
        }}
      />

      {isKopia ? (
        <div className="banner banner-kopia">
          <Icon name="archive" />
          <div className="grow">
            <b>This folder is a kopia backup repository.</b> Browse its snapshots and restore files; its objects
            themselves are read-only here, since changing them would corrupt the backups.
          </div>
          <button type="button" className="btn btn-primary" onClick={onKopia}>
            <Icon name="history" />
            Browse backups
          </button>
        </div>
      ) : (
        caps.data &&
        caps.data.list.allowed !== false &&
        caps.data.write.allowed === false &&
        !conn.readOnly && <InfoBanner>Read-only here: {caps.data.write.reason}</InfoBanner>
      )}
      {conn.readOnly && (
        <InfoBanner>This connection is configured read-only (READ_ONLY): nothing can be changed.</InfoBanner>
      )}
      {searching && (
        <div className="search-state">
          {searching.error ? (
            <ErrorBanner>{searching.error}</ErrorBanner>
          ) : !searching.result ? (
            <Spinner label={`Searching for "${searching.q}"…`} />
          ) : (
            <span>
              {plural(searching.result.objects.length, 'match', 'matches')} for "{searching.q}" in{' '}
              {prefix || 'the bucket'} ({plural(searching.result.scanned, 'key')} scanned
              {searching.result.truncated ? '; stopped at the limit' : ''}).{' '}
              <button type="button" className="btn-link" onClick={() => setSearch(null)}>
                Back to the folder
              </button>
            </span>
          )}
        </div>
      )}

      {listError ? (
        <ErrorBanner>
          {denied ? 'These credentials may not list this folder.' : 'Listing failed.'} {listError.message}
        </ErrorBanner>
      ) : !listing ? (
        <div className="empty">
          <Spinner label="Loading…" />
        </div>
      ) : (
        <div className={`table-wrap${first.loading ? ' dim' : ''}`}>
          <table className="table files">
            <thead>
              <tr>
                <th className="col-check">
                  <input
                    type="checkbox"
                    aria-label="Select all"
                    checked={allChecked}
                    onChange={(e) => selectAll(e.target.checked)}
                  />
                </th>
                {sortHeader('name', 'Name')}
                {sortHeader('size', 'Size', 'num')}
                {sortHeader('modified', 'Modified', 'col-date')}
                <th className="col-class">Storage class</th>
                <th className="col-actions" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {prefix && !searching && (
                <tr className="row-up">
                  <td />
                  <td colSpan={5}>
                    <button type="button" className="name-btn" onClick={() => onNavigate(parentPrefix(prefix))}>
                      <Icon name="up" />
                      ..
                    </button>
                  </td>
                </tr>
              )}
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className={selected.has(r.id) ? 'selected' : ''}
                  onDoubleClick={() => (r.kind === 'folder' ? onNavigate(r.prefix) : onOpenObject(r.o.key))}
                >
                  <td className="col-check">
                    <input
                      type="checkbox"
                      aria-label={`Select ${r.name}`}
                      checked={selected.has(r.id)}
                      onClick={(e) => toggle(r, e)}
                      onChange={() => {}}
                    />
                  </td>
                  <td className="col-name">
                    {r.kind === 'folder' ? (
                      <button type="button" className="name-btn" onClick={() => onNavigate(r.prefix)}>
                        <Icon name="folder" className="folder-icon" />
                        <span className="ellipsis">{r.name}</span>
                      </button>
                    ) : (
                      <button type="button" className="name-btn" onClick={() => onOpenObject(r.o.key)} title={r.o.key}>
                        <Icon name={r.o.key.endsWith('/') ? 'folder' : fileIcon(r.o.key)} className="file-icon" />
                        <span className="ellipsis mono-ish">
                          {r.name || <span className="muted">(empty name)</span>}
                        </span>
                      </button>
                    )}
                  </td>
                  <td className="num">{r.kind === 'object' ? bytes(r.o.size) : <span className="muted">–</span>}</td>
                  <td className="col-date" title={r.kind === 'object' ? dateTime(r.o.lastModified) : undefined}>
                    {r.kind === 'object' ? ago(r.o.lastModified) : ''}
                  </td>
                  <td className="col-class muted small">
                    {r.kind === 'object' && r.o.storageClass !== 'STANDARD' ? r.o.storageClass : ''}
                  </td>
                  <td className="col-actions">
                    {r.kind === 'object' ? (
                      <a
                        className="btn btn-small btn-icon row-hover"
                        href={downloadUrl(conn.id, bucket, r.o.key)}
                        download
                        aria-label={`Download ${r.name}`}
                        title="Download"
                      >
                        <Icon name="download" />
                      </a>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-small btn-icon row-hover"
                        aria-label={`Size of ${r.name}`}
                        title="Count objects and size"
                        onClick={() => void folderSize(r.prefix)}
                      >
                        <Icon name="sum" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length && (
            <div className="empty">
              {searching?.result
                ? 'Nothing found.'
                : filter
                  ? 'Nothing matches the filter in the loaded entries. Press Enter to search subfolders.'
                  : canWrite
                    ? 'This folder is empty. Drop files here to upload them.'
                    : 'This folder is empty.'}
            </div>
          )}
          {nextToken && !searching && (
            <div className="pager">
              <span className="muted small">
                {plural(rows.length, 'entry', 'entries')} loaded{filter ? ' (filtered)' : ''}
              </span>
              <button type="button" className="btn" disabled={more.loading} onClick={() => void loadMore()}>
                {more.loading ? <Spinner /> : null}
                Load more
              </button>
            </div>
          )}
        </div>
      )}

      {dragging > 0 && (
        <div className="drop-overlay" aria-hidden="true">
          <Icon name="upload" size={32} />
          {canWrite ? `Drop to upload to ${bucket}/${prefix}` : 'Uploading here is not allowed'}
        </div>
      )}

      {objectKey && (
        <ObjectDrawer
          key={objectKey}
          conn={conn}
          bucket={bucket}
          objectKey={objectKey}
          versionId={versionId}
          caps={parentPrefix(objectKey) === prefix ? c : null}
          textMax={limits.textBytes}
          onVersion={(v) => onOpenObject(objectKey, v)}
          onAction={onObjectAction}
          refreshVersion={version}
          onChanged={refresh}
          onClose={() => onOpenObject(null)}
        />
      )}
      {bucketOpen && (
        <BucketDrawer
          conn={conn}
          bucket={bucket}
          caps={c}
          onChanged={refresh}
          onDeleted={() => {
            setBucketOpen(false);
            onBucketDeleted();
          }}
          onClose={() => setBucketOpen(false)}
        />
      )}

      {dialog?.kind === 'newFolder' && (
        <NameDialog
          title="New folder"
          label="Folder name"
          submitLabel="Create"
          onClose={() => setDialog(null)}
          onSubmit={async (name) => {
            await api.createFolder(conn.id, bucket, prefix, name);
            afterChange(null);
            onNavigate(`${prefix}${name}/`);
          }}
        />
      )}
      {dialog?.kind === 'rename' && (
        <NameDialog
          title="Rename"
          label="New name"
          initial={'key' in dialog.item ? baseName(dialog.item.key) : baseName(dialog.item.prefix)}
          submitLabel="Rename"
          onClose={() => setDialog(null)}
          onSubmit={async (name) => {
            const item = dialog.item;
            const r = await api
              .transfer(conn.id, bucket, { items: [item], newName: name, move: true })
              .catch((e: ApiError) => {
                if (e.status === 409) throw new Error(`"${name}" already exists.`);
                throw e;
              });
            if ('key' in item && objectKey === item.key) onOpenObject(parentPrefix(item.key) + name);
            afterChange(
              r.failed.length ? bulkMessage('Renamed', r) : `Renamed to ${name}`,
              r.failed.length ? 'error' : 'ok',
            );
          }}
        />
      )}
      {dialog?.kind === 'delete' && (
        <DeleteDialog
          items={dialog.items}
          versioned={versioning.data?.status === 'Enabled' || versioning.data?.status === 'Suspended'}
          canDeleteVersions={c?.versions.allowed !== false}
          onClose={() => setDialog(null)}
          onSubmit={async (allVersions) => {
            const r = await api.delete(conn.id, bucket, dialog.items, allVersions);
            const one = dialog.items.length === 1 ? dialog.items[0]! : null;
            const versionDeleted = one && 'key' in one ? (one.versionId ?? null) : null;
            if (objectKey && !versionDeleted && dialog.items.some((i) => 'key' in i && i.key === objectKey))
              onOpenObject(null);
            if (versionDeleted && versionId === versionDeleted) onOpenObject(objectKey, null);
            afterChange(bulkMessage('Deleted', r), r.failed.length ? 'error' : 'ok');
          }}
        />
      )}
      {dialog?.kind === 'transfer' && (
        <TransferDialog
          conn={conn.id}
          bucket={bucket}
          items={dialog.items}
          move={dialog.move}
          buckets={buckets.length ? buckets : [bucket]}
          initialPrefix={prefix}
          onClose={() => setDialog(null)}
          onDone={(msg) => {
            if (dialog.move && objectKey && dialog.items.some((i) => 'key' in i && i.key === objectKey))
              onOpenObject(null);
            afterChange(msg, /failed/.test(msg) ? 'error' : 'ok');
          }}
        />
      )}
      {dialog?.kind === 'share' && (
        <ShareDialog
          conn={conn.id}
          bucket={bucket}
          objectKey={dialog.key}
          versionId={dialog.versionId}
          maxHours={limits.shareMaxHours}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}

const isCap = <T,>(c: T | undefined): c is T => c !== undefined;
