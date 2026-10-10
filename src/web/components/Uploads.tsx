import { useState } from 'react';
import { keyError } from '../../shared/keys.ts';
import { bytes, plural } from '../format.ts';
import type { useUploads } from '../uploads.ts';
import { Icon } from './icons.tsx';

export function UploadPanel({ uploads }: { uploads: ReturnType<typeof useUploads> }) {
  const { items } = uploads;
  const [collapsed, setCollapsed] = useState(false);
  if (!items.length) return null;
  const active = items.filter((i) => i.status === 'uploading' || i.status === 'queued');
  const conflicts = items.filter((i) => i.status === 'conflict');
  const failed = items.filter((i) => i.status === 'error');
  const total = active.reduce((s, i) => s + i.file.size, 0);
  const loaded = active.reduce((s, i) => s + i.loaded, 0);
  return (
    <section className="uploads" aria-label="Uploads">
      <header className="uploads-head">
        <button type="button" className="btn-link uploads-title" onClick={() => setCollapsed(!collapsed)}>
          <Icon name={collapsed ? 'chevronRight' : 'chevronDown'} />
          {active.length
            ? `Uploading ${plural(active.length, 'file')} · ${bytes(loaded)} of ${bytes(total)}`
            : `Uploads: ${plural(items.filter((i) => i.status === 'done').length, 'file')} done`}
          {failed.length ? ` · ${failed.length} failed` : ''}
          {conflicts.length ? ` · ${conflicts.length} already exist` : ''}
        </button>
        <div className="inline">
          {conflicts.length > 1 && (
            <button type="button" className="btn btn-small" onClick={() => uploads.replace(conflicts.map((i) => i.id))}>
              Replace all {conflicts.length}
            </button>
          )}
          <button type="button" className="btn btn-small" onClick={uploads.clearFinished}>
            Clear finished
          </button>
        </div>
      </header>
      {active.length > 0 && (
        <div className="progress" aria-hidden="true">
          <span style={{ width: `${total ? (loaded / total) * 100 : 0}%` }} />
        </div>
      )}
      {!collapsed && (
        <ul className="upload-list">
          {items.map((i) => (
            <li key={i.id} className={`upload upload-${i.status}`}>
              <div className="grow min0">
                <div className="mono ellipsis" title={`${i.bucket}/${i.key}`}>
                  {i.key}
                </div>
                <div className="small muted">
                  {i.status === 'uploading'
                    ? `${bytes(i.loaded)} of ${bytes(i.file.size)}`
                    : i.status === 'queued'
                      ? `Waiting · ${bytes(i.file.size)}`
                      : i.status === 'done'
                        ? `Uploaded · ${bytes(i.file.size)}`
                        : i.status === 'cancelled'
                          ? 'Cancelled'
                          : i.error}
                </div>
                {i.status === 'uploading' && (
                  <div className="progress progress-thin" aria-hidden="true">
                    <span style={{ width: `${i.file.size ? (i.loaded / i.file.size) * 100 : 100}%` }} />
                  </div>
                )}
              </div>
              {(i.status === 'uploading' || i.status === 'queued') && (
                <button type="button" className="btn btn-small" onClick={() => uploads.cancel(i.id)}>
                  Cancel
                </button>
              )}
              {i.status === 'conflict' && (
                <button type="button" className="btn btn-small" onClick={() => uploads.replace([i.id])}>
                  Replace
                </button>
              )}
              {(i.status === 'error' || i.status === 'cancelled') && !keyError(i.key) && (
                <button type="button" className="btn btn-small" onClick={() => uploads.retry(i.id)}>
                  Retry
                </button>
              )}
              {i.status === 'done' && <Icon name="check" className="ok" />}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
