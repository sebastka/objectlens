// Integration tests against a real S3-compatible server: `npm run dev:s3` (RustFS, with the users
// of dev/s3-init.sh) and TEST_S3_ENDPOINT. Skipped without it. Each run works in buckets of its
// own and removes them afterwards.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../src/server/app.ts';
import { loadConfig } from '../src/server/config.ts';
import type {
  BucketDetails,
  BulkResult,
  Capabilities,
  ListResponse,
  ObjectDetails,
  SearchResponse,
  VersionEntry,
} from '../src/shared/types.ts';

const endpoint = process.env.TEST_S3_ENDPOINT;
const run = Math.random().toString(36).slice(2, 8);
const bucket = `ol-test-${run}`;
const plain = `ol-test-${run}-plain`;

const app = endpoint
  ? createApp(
      loadConfig({
        S3_1_ENDPOINT: endpoint,
        S3_1_ACCESS_KEY_ID: process.env.TEST_S3_ACCESS_KEY ?? 'objectlens',
        S3_1_SECRET_ACCESS_KEY: process.env.TEST_S3_SECRET_KEY ?? 'objectlens-secret',
        S3_2_ENDPOINT: endpoint,
        S3_2_ACCESS_KEY_ID: process.env.TEST_S3_READER_KEY ?? 'reader',
        S3_2_SECRET_ACCESS_KEY: process.env.TEST_S3_READER_SECRET ?? 'reader-secret',
        S3_3_ENDPOINT: endpoint,
        S3_3_ACCESS_KEY_ID: process.env.TEST_S3_ACCESS_KEY ?? 'objectlens',
        S3_3_SECRET_ACCESS_KEY: process.env.TEST_S3_SECRET_KEY ?? 'objectlens-secret',
        S3_3_READ_ONLY: 'true',
        CAPABILITY_TTL_MINUTES: '0',
      }),
    )
  : null;

const H = { host: 'localhost', 'x-objectlens': '1', 'sec-fetch-site': 'same-origin' };

async function call<T>(method: string, path: string, body?: unknown, status = 200): Promise<T> {
  const res = await app!.request(`http://localhost${path}`, {
    method,
    headers: { ...H, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  assert.equal(res.status, status, `${method} ${path}: ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

async function put(c: string, b: string, key: string, data: string | Uint8Array, type = 'text/plain', q = '') {
  const res = await app!.request(`http://localhost/api/c/${c}/b/${b}/upload?key=${encodeURIComponent(key)}${q}`, {
    method: 'PUT',
    headers: { ...H, 'content-type': type },
    body: data,
  });
  return { status: res.status, body: (await res.json()) as { error?: string; versionId?: string | null } };
}

async function get(b: string, key: string, extra: Record<string, string> = {}, versionId?: string) {
  return app!.request(
    `http://localhost/api/c/1/b/${b}/download?key=${encodeURIComponent(key)}${versionId ? `&versionId=${versionId}` : ''}`,
    { headers: { ...H, ...extra } },
  );
}

const keys = async (b: string, prefix = '') =>
  (await call<ListResponse>('GET', `/api/c/1/b/${b}/list?prefix=${encodeURIComponent(prefix)}`)).objects.map(
    (o) => o.key,
  );

describe('against S3', { skip: endpoint ? false : 'TEST_S3_ENDPOINT is not set' }, () => {
  before(async () => {
    await call('POST', '/api/c/1/buckets', { name: bucket }, 201);
    await call('POST', '/api/c/1/buckets', { name: plain }, 201);
    await call('PUT', `/api/c/1/b/${bucket}/versioning`, { enabled: true });
  });

  after(async () => {
    for (const b of [bucket, plain]) {
      await call('POST', `/api/c/1/b/${b}/delete`, { items: [{ prefix: '' }], allVersions: true });
      await call('DELETE', `/api/c/1/buckets/${b}`);
    }
  });

  test('upload, list as folders, download with ranges', async () => {
    const data = randomBytes(256 * 1024);
    assert.equal((await put('1', bucket, 'dir/sub/blob.bin', data, 'application/octet-stream')).status, 200);
    assert.equal((await put('1', bucket, 'dir/a.txt', 'hello')).status, 200);
    const root = await call<ListResponse>('GET', `/api/c/1/b/${bucket}/list?prefix=`);
    assert.deepEqual(root.folders, ['dir/']);
    const dir = await call<ListResponse>('GET', `/api/c/1/b/${bucket}/list?prefix=dir/`);
    assert.deepEqual(dir.folders, ['dir/sub/']);
    assert.deepEqual(
      dir.objects.map((o) => [o.key, o.size]),
      [['dir/a.txt', 5]],
    );

    const full = await get(bucket, 'dir/sub/blob.bin');
    assert.equal(full.status, 200);
    assert.ok(Buffer.from(await full.arrayBuffer()).equals(data));
    assert.match(full.headers.get('content-disposition')!, /^attachment; filename="blob.bin"/);
    assert.equal(full.headers.get('x-content-type-options'), 'nosniff');

    const part = await get(bucket, 'dir/sub/blob.bin', { range: 'bytes=10-19' });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), `bytes 10-19/${data.length}`);
    assert.ok(Buffer.from(await part.arrayBuffer()).equals(data.subarray(10, 20)));
  });

  test('an upload does not overwrite unless asked', async () => {
    const again = await put('1', bucket, 'dir/a.txt', 'other');
    assert.equal(again.status, 409);
    assert.equal((await put('1', bucket, 'dir/a.txt', 'world', 'text/plain', '&overwrite=1')).status, 200);
    assert.equal(await (await get(bucket, 'dir/a.txt')).text(), 'world');
  });

  test('inline previews are sandboxed and typed by ObjectLens, not by the object', async () => {
    await put('1', bucket, 'evil.html', '<script>alert(1)</script>', 'text/html');
    const html = await app!.request(`http://localhost/api/c/1/b/${bucket}/download?key=evil.html&inline=1`, {
      headers: H,
    });
    assert.equal(html.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.match(html.headers.get('content-security-policy')!, /^sandbox/);
    await put('1', bucket, 'pic.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>', 'image/svg+xml');
    const svg = await app!.request(`http://localhost/api/c/1/b/${bucket}/download?key=pic.svg&inline=1`, {
      headers: H,
    });
    assert.equal(svg.headers.get('content-type'), 'image/svg+xml');
    assert.match(svg.headers.get('content-security-policy')!, /^sandbox/);
  });

  test('details, metadata and tags; metadata edits keep the content', async () => {
    await call('PUT', `/api/c/1/b/${bucket}/metadata`, {
      key: 'dir/a.txt',
      system: {
        contentType: 'text/markdown',
        cacheControl: 'max-age=60',
        contentDisposition: null,
        contentEncoding: null,
        contentLanguage: 'nb',
        expires: null,
        websiteRedirectLocation: null,
      },
      metadata: { Owner: 'tests' },
    });
    await call('PUT', `/api/c/1/b/${bucket}/object-tags`, { key: 'dir/a.txt', tags: [{ key: 'env', value: 'test' }] });
    const d = await call<ObjectDetails>('GET', `/api/c/1/b/${bucket}/object?key=dir/a.txt`);
    assert.equal(d.size, 5);
    assert.equal(d.system.contentType, 'text/markdown');
    assert.equal(d.system.cacheControl, 'max-age=60');
    assert.equal(d.system.contentLanguage, 'nb');
    assert.deepEqual(d.metadata, { owner: 'tests' });
    assert.deepEqual(d.tags, { ok: true, value: [{ key: 'env', value: 'test' }] });
    assert.equal(d.preview, 'text');
    assert.ok(d.s3.some((r) => r.label === 'Version ID'));
    assert.equal(await (await get(bucket, 'dir/a.txt')).text(), 'world');

    // Saving an edited file (keep=1) keeps metadata and tags.
    assert.equal((await put('1', bucket, 'dir/a.txt', 'edited', 'text/plain', '&overwrite=1&keep=1')).status, 200);
    const e = await call<ObjectDetails>('GET', `/api/c/1/b/${bucket}/object?key=dir/a.txt`);
    assert.equal(e.system.contentType, 'text/markdown');
    assert.deepEqual(e.metadata, { owner: 'tests' });
    assert.deepEqual(e.tags, { ok: true, value: [{ key: 'env', value: 'test' }] });
  });

  test('versions: list, read an old one, restore it', async () => {
    const versions = await call<VersionEntry[]>('GET', `/api/c/1/b/${bucket}/versions?key=dir/a.txt`);
    assert.ok(versions.length >= 3, `expected several versions, got ${versions.length}`);
    assert.ok(versions[0]!.isLatest);
    const first = versions[versions.length - 1]!;
    assert.equal(await (await get(bucket, 'dir/a.txt', {}, first.versionId)).text(), 'hello');
    await call('POST', `/api/c/1/b/${bucket}/restore-version`, { key: 'dir/a.txt', versionId: first.versionId });
    assert.equal(await (await get(bucket, 'dir/a.txt')).text(), 'hello');
  });

  test('folders: create, copy, rename, move across buckets, search, size', async () => {
    await call('POST', `/api/c/1/b/${bucket}/folder`, { prefix: 'dir/', name: 'empty' }, 201);
    assert.ok((await keys(bucket, 'dir/empty/')).length === 0);
    assert.deepEqual((await call<ListResponse>('GET', `/api/c/1/b/${bucket}/list?prefix=dir/`)).folders, [
      'dir/empty/',
      'dir/sub/',
    ]);

    const copied = await call<BulkResult>('POST', `/api/c/1/b/${bucket}/transfer`, {
      items: [{ prefix: 'dir/sub/' }],
      toPrefix: 'copy/',
    });
    assert.equal(copied.done, 1);
    assert.deepEqual(await keys(bucket, 'copy/sub/'), ['copy/sub/blob.bin']);

    // Copying again conflicts and changes nothing.
    const conflict = await call<{ conflicts: string[] }>(
      'POST',
      `/api/c/1/b/${bucket}/transfer`,
      { items: [{ prefix: 'dir/sub/' }], toPrefix: 'copy/' },
      409,
    );
    assert.deepEqual(conflict.conflicts, ['copy/sub/blob.bin']);

    await call('POST', `/api/c/1/b/${bucket}/transfer`, {
      items: [{ prefix: 'copy/sub/' }],
      newName: 'renamed',
      move: true,
    });
    assert.deepEqual(await keys(bucket, 'copy/'), []);
    assert.deepEqual(await keys(bucket, 'copy/renamed/'), ['copy/renamed/blob.bin']);

    await call('POST', `/api/c/1/b/${bucket}/transfer`, {
      items: [{ key: 'copy/renamed/blob.bin' }],
      toBucket: plain,
      toPrefix: 'in/',
      move: true,
    });
    assert.deepEqual(await keys(plain, 'in/'), ['in/blob.bin']);
    assert.deepEqual(await keys(bucket, 'copy/renamed/'), []);

    await call('POST', `/api/c/1/b/${bucket}/transfer`, { items: [{ prefix: 'dir/' }], toPrefix: 'dir/x/' }, 400);

    const found = await call<SearchResponse>('GET', `/api/c/1/b/${bucket}/search?prefix=&q=BLOB`);
    assert.deepEqual(
      found.objects.map((o) => o.key),
      ['dir/sub/blob.bin'],
    );
    const size = await call<{ objects: number; bytes: number }>('GET', `/api/c/1/b/${bucket}/size?prefix=dir/sub/`);
    assert.deepEqual(size, { prefix: 'dir/sub/', objects: 1, bytes: 256 * 1024, truncated: false });
  });

  test('delete: markers in a versioned bucket, everything with allVersions', async () => {
    await put('1', bucket, 'gone/x.txt', 'x');
    const r = await call<BulkResult>('POST', `/api/c/1/b/${bucket}/delete`, { items: [{ prefix: 'gone/' }] });
    assert.equal(r.done, 1);
    assert.deepEqual(await keys(bucket, 'gone/'), []);
    const v = await call<VersionEntry[]>('GET', `/api/c/1/b/${bucket}/versions?key=gone/x.txt`);
    assert.deepEqual(
      v.map((x) => x.isDeleteMarker),
      [true, false],
    );
    await call('POST', `/api/c/1/b/${bucket}/delete`, { items: [{ key: 'gone/x.txt' }], allVersions: true });
    assert.deepEqual(await call<VersionEntry[]>('GET', `/api/c/1/b/${bucket}/versions?key=gone/x.txt`), []);
  });

  test('share links download directly from S3', async () => {
    await put('1', plain, 'shared.txt', 'shared content', 'text/plain', '&overwrite=1');
    const link = await call<{ url: string }>('POST', `/api/c/1/b/${plain}/share`, { key: 'shared.txt', hours: 1 });
    assert.equal(await (await fetch(link.url)).text(), 'shared content');
  });

  test('bucket details: each setting on its own', async () => {
    const d = await call<BucketDetails>('GET', `/api/c/1/b/${bucket}/details`);
    assert.deepEqual(d.versioning, { ok: true, value: { status: 'Enabled', mfaDelete: null } });
    assert.deepEqual(d.policy, { ok: true, value: null });
    await call('PUT', `/api/c/1/b/${bucket}/tags`, { tags: [{ key: 'team', value: 'lens' }] });
    const t = await call<BucketDetails>('GET', `/api/c/1/b/${bucket}/details`);
    assert.deepEqual(t.tags, { ok: true, value: [{ key: 'team', value: 'lens' }] });
  });

  test('capabilities: the admin may do everything, probes leave nothing behind', async () => {
    const versioned = await call<Capabilities>('GET', `/api/c/1/b/${bucket}/capabilities?prefix=dir/`);
    assert.equal(versioned.list.allowed, true);
    assert.equal(versioned.read.allowed, true);
    assert.equal(versioned.write.allowed, true);
    assert.equal(versioned.tags.allowed, true);
    // No delete probe in a versioned bucket (it would leave a delete marker).
    assert.equal(versioned.delete.allowed, null);
    const unversioned = await call<Capabilities>('GET', `/api/c/1/b/${plain}/capabilities?prefix=`);
    assert.equal(unversioned.delete.allowed, true);
    const all = await call<VersionEntry[]>('GET', `/api/c/1/b/${bucket}/versions?key=dir/.objectlens-probe-`);
    assert.deepEqual(all, []);
    assert.ok(!(await keys(plain)).some((k) => k.includes('objectlens-probe')));
  });

  test('capabilities: a read-only user is recognised and learned', async () => {
    const c = await call<Capabilities>('GET', `/api/c/2/b/${bucket}/capabilities?prefix=dir/`);
    assert.equal(c.list.allowed, true);
    assert.equal(c.write.allowed, false);
    assert.equal(c.tags.allowed, false);
    const denied = await put('2', plain, 'nope.txt', 'x');
    assert.equal(denied.status, 403);
    const del = await call<{ error: string }>(
      'POST',
      `/api/c/2/b/${plain}/delete`,
      { items: [{ key: 'shared.txt' }] },
      403,
    );
    assert.match(del.error, /AccessDenied/);
    const after = await call<Capabilities>('GET', `/api/c/2/b/${plain}/capabilities?prefix=`);
    assert.equal(after.write.allowed, false);
    assert.equal(after.delete.allowed, false);
  });

  test('a READ_ONLY connection refuses writes before asking S3', async () => {
    const c = await call<Capabilities>('GET', `/api/c/3/b/${bucket}/capabilities?prefix=`);
    for (const k of ['write', 'delete', 'tags', 'bucketConfig'] as const) assert.equal(c[k].allowed, false);
    assert.equal((await put('3', bucket, 'x.txt', 'x')).status, 403);
    await call('POST', `/api/c/3/b/${bucket}/delete`, { items: [{ key: 'dir/a.txt' }] }, 403);
    assert.equal(await (await get(bucket, 'dir/a.txt')).text(), 'hello');
  });
});

describe('against S3, with a tiny BULK_LIMIT', { skip: endpoint ? false : 'TEST_S3_ENDPOINT is not set' }, () => {
  const small = endpoint
    ? createApp(
        loadConfig({
          S3_1_ENDPOINT: endpoint,
          S3_1_ACCESS_KEY_ID: process.env.TEST_S3_ACCESS_KEY ?? 'objectlens',
          S3_1_SECRET_ACCESS_KEY: process.env.TEST_S3_SECRET_KEY ?? 'objectlens-secret',
          BULK_LIMIT: '2',
        }),
      )
    : null;
  const b = `ol-test-${run}-small`;
  const req = async <T>(method: string, path: string, body?: unknown, status = 200) => {
    const res = await small!.request(`http://localhost${path}`, {
      method,
      headers: { ...H, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    assert.equal(res.status, status, text);
    return JSON.parse(text) as T;
  };

  before(async () => {
    await req('POST', '/api/c/1/buckets', { name: b }, 201);
    for (const k of ['src/1', 'src/2', 'src/3', 'src/4', 'src/5', 'other.txt']) {
      await small!.request(`http://localhost/api/c/1/b/${b}/upload?key=${k}`, {
        method: 'PUT',
        headers: { ...H, 'content-type': 'text/plain' },
        body: k,
      });
    }
  });
  after(async () => {
    for (let i = 0; i < 10; i++) {
      const r = await req<BulkResult>('POST', `/api/c/1/b/${b}/delete`, { items: [{ prefix: '' }] });
      if (!r.truncated) break;
    }
    await req('DELETE', `/api/c/1/buckets/${b}`);
  });

  test('a copy over the limit resumes where it stopped instead of starting over', async () => {
    const items = [{ prefix: 'src/' }, { key: 'other.txt' }];
    let resume: unknown = null;
    let done = 0;
    for (let round = 0; round < 10; round++) {
      const r = await req<BulkResult & { resume: unknown }>('POST', `/api/c/1/b/${b}/transfer`, {
        items,
        toPrefix: 'dst/',
        resume,
      });
      assert.ok(r.done <= 2);
      done += r.done;
      resume = r.resume;
      if (!resume) break;
    }
    assert.equal(done, 6);
    const list = await req<ListResponse>('GET', `/api/c/1/b/${b}/list?prefix=dst/src/`);
    assert.deepEqual(
      list.objects.map((o) => o.key),
      ['dst/src/1', 'dst/src/2', 'dst/src/3', 'dst/src/4', 'dst/src/5'],
    );
  });

  test('a delete over the limit is truncated, and running it again continues', async () => {
    const r1 = await req<BulkResult>('POST', `/api/c/1/b/${b}/delete`, { items: [{ prefix: 'dst/' }] });
    assert.deepEqual([r1.done, r1.truncated], [2, true]);
    let left = 4;
    while (left > 0) {
      const r = await req<BulkResult>('POST', `/api/c/1/b/${b}/delete`, { items: [{ prefix: 'dst/' }] });
      left -= r.done;
      if (!r.truncated) break;
    }
    assert.deepEqual((await req<ListResponse>('GET', `/api/c/1/b/${b}/list?prefix=dst/`)).folders, []);
  });
});
