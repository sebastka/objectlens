import { useCallback, useEffect, useRef, useState } from 'react';
import { keyError } from '../shared/keys.ts';
import { type ApiError, upload, type UploadHandle } from './api.ts';

export interface UploadItem {
  id: number;
  conn: string;
  bucket: string;
  key: string;
  file: File;
  loaded: number;
  status: 'queued' | 'uploading' | 'done' | 'error' | 'conflict' | 'cancelled';
  error: string | null;
  overwrite: boolean;
}

const CONCURRENCY = 3;

/** The upload queue: a few files at a time, with progress, cancel and "replace" on conflicts. */
export function useUploads(onUploaded: (conn: string, bucket: string, key: string) => void) {
  // The queue lives in a ref (uploads finish asynchronously and start the next ones); every
  // change is mirrored into state for rendering.
  const store = useRef<UploadItem[]>([]);
  const [items, setItems] = useState<UploadItem[]>([]);
  const handles = useRef(new Map<number, UploadHandle>());
  const nextId = useRef(1);
  const onUploadedRef = useRef(onUploaded);
  useEffect(() => {
    onUploadedRef.current = onUploaded;
  });

  const set = useCallback((next: UploadItem[]) => {
    store.current = next;
    setItems(next);
  }, []);
  const patch = useCallback(
    (ids: number[], p: Partial<UploadItem>) => set(store.current.map((i) => (ids.includes(i.id) ? { ...i, ...p } : i))),
    [set],
  );

  // A finished upload starts the next one through this ref (pump cannot name itself).
  const pumpRef = useRef(() => {});

  /** Starts queued uploads while fewer than CONCURRENCY run. */
  const pump = useCallback(() => {
    const running = store.current.filter((i) => i.status === 'uploading').length;
    const next = store.current.filter((i) => i.status === 'queued').slice(0, Math.max(0, CONCURRENCY - running));
    if (!next.length) return;
    patch(
      next.map((i) => i.id),
      { status: 'uploading', loaded: 0, error: null },
    );
    for (const item of next) {
      const h = upload(item.conn, item.bucket, item.key, item.file, item.overwrite, (loaded) =>
        patch([item.id], { loaded }),
      );
      handles.current.set(item.id, h);
      h.done
        .then(
          () => {
            patch([item.id], { status: 'done', loaded: item.file.size });
            onUploadedRef.current(item.conn, item.bucket, item.key);
          },
          (e: ApiError) => {
            if (e.code === 'Cancelled') patch([item.id], { status: 'cancelled' });
            else if (e.status === 409) patch([item.id], { status: 'conflict', error: 'Already exists' });
            else patch([item.id], { status: 'error', error: e.message });
          },
        )
        .finally(() => {
          handles.current.delete(item.id);
          pumpRef.current();
        });
    }
  }, [patch]);
  useEffect(() => {
    pumpRef.current = pump;
  }, [pump]);

  const add = useCallback(
    (conn: string, bucket: string, files: { file: File; key: string }[]) => {
      set([
        ...store.current,
        ...files.map(({ file, key }): UploadItem => {
          const err = keyError(key);
          return {
            id: nextId.current++,
            conn,
            bucket,
            key,
            file,
            loaded: 0,
            status: err ? 'error' : 'queued',
            error: err,
            overwrite: false,
          };
        }),
      ]);
      pump();
    },
    [set, pump],
  );

  const cancel = (id: number) => {
    const h = handles.current.get(id);
    if (h) h.abort();
    else patch([id], { status: 'cancelled' });
  };
  const replace = (ids: number[]) => {
    patch(ids, { status: 'queued', overwrite: true, error: null });
    pump();
  };
  const retry = (id: number) => {
    patch([id], { status: 'queued', error: null });
    pump();
  };
  const clearFinished = () =>
    set(store.current.filter((i) => i.status === 'queued' || i.status === 'uploading' || i.status === 'conflict'));

  return { items, add, cancel, replace, retry, clearFinished };
}

/** Files of a drop, folders included (recursively), with their relative paths. */
export async function droppedFiles(dt: DataTransfer): Promise<{ file: File; path: string }[]> {
  const entries = [...dt.items]
    .filter((i) => i.kind === 'file')
    .map((i) => i.webkitGetAsEntry())
    .filter((e): e is FileSystemEntry => e !== null);
  if (!entries.length) return [...dt.files].map((file) => ({ file, path: file.name }));
  const out: { file: File; path: string }[] = [];
  const walk = async (entry: FileSystemEntry, path: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
      out.push({ file, path: path + entry.name });
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      // readEntries returns at most 100 entries per call: read until it returns none.
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const e of batch) await walk(e, `${path}${entry.name}/`);
      }
    }
  };
  for (const e of entries) await walk(e, '');
  return out;
}
