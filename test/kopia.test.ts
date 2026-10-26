// kopia support. The unit tests need nothing; the integration tests need the development S3
// (TEST_S3_ENDPOINT, `npm run dev:s3`) and a kopia binary: TEST_KOPIA_BIN, else build/kopia/kopia
// (`npm run kopia:bin`), else "kopia" on the PATH. They create a repository with the real kopia
// CLI, snapshot a folder of test files, and read it back through ObjectLens' API.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../src/server/app.ts';
import { loadConfig } from '../src/server/config.ts';
import { classify, OBJECT_ID, repositoryInfo, toEntry, toSnapshot } from '../src/server/kopia.ts';
import type { Capabilities, KopiaBrowse, KopiaSnapshot, KopiaStatus } from '../src/shared/types.ts';

const run = promisify(execFile);

test('kopia errors are classified', () => {
  assert.equal(classify('ERROR invalid repository password\n').code, 'bad-password');
  assert.equal(classify('kopia: error: repository not initialized in the provided storage').code, 'not-found');
  const f = classify('connecting\nkopia: error: unable to open repository: Access Denied, try --help\n');
  assert.equal(f.code, 'failed');
  assert.match(f.message, /^unable to open repository: Access Denied/);
});

test('repository details never include keys or secrets', () => {
  const rows = repositoryInfo({
    uniqueIDHex: 'abcd',
    storage: { type: 's3', config: { accessKeyID: 'leak-access-key', secretAccessKey: 'leak-secret-key' } },
    contentFormat: {
      hash: 'BLAKE2B-256-128',
      encryption: 'AES256-GCM-HMAC-SHA256',
      version: 3,
      maxPackSize: 20971520,
      indexVersion: 2,
      hmacSecret: 'leak-hmac-secret',
      masterKey: 'leak-master-key',
      epochParameters: { Enabled: true },
    },
    objectFormat: { splitter: 'DYNAMIC-4M-BUZHASH' },
    blobRetention: { retentionMode: 'COMPLIANCE', retentionPeriod: 2592000000000000 },
  });
  const text = JSON.stringify(rows);
  for (const secret of ['leak-access-key', 'leak-secret-key', 'leak-hmac-secret', 'leak-master-key'])
    assert.ok(!text.includes(secret), secret);
  assert.deepEqual(Object.fromEntries(rows.map((r) => [r.label, r.value])), {
    'Repository ID': 'abcd',
    'Format version': '3',
    Hash: 'BLAKE2B-256-128',
    Encryption: 'AES256-GCM-HMAC-SHA256',
    Splitter: 'DYNAMIC-4M-BUZHASH',
    'Index version': '2',
    'Epoch-based indexes': 'yes',
    'Maximum pack size': '20 MiB',
    'Object Lock': 'COMPLIANCE, 30 days',
  });
});

test('snapshots and entries are mapped from kopia JSON', () => {
  const s = toSnapshot({
    id: '04322b5b6ef92f7e13ccfb0294a9db93',
    source: { host: 'file', userName: 'root', path: '/data' },
    startTime: '2026-10-26T09:15:02Z',
    endTime: '2026-10-26T10:00:30Z',
    incomplete: 'checkpoint',
    retentionReason: ['incomplete'],
    stats: { errorCount: 2 },
    rootEntry: { type: 'd', obj: 'kf7c1edc9ffda29bbb05d12ff6e072076', summ: { size: 10, files: 3, dirs: 1 } },
  });
  assert.equal(s.incomplete, 'checkpoint');
  assert.deepEqual(s.source, { host: 'file', user: 'root', path: '/data' });
  assert.equal(s.summary?.files, 3);
  assert.equal(s.errors, 2);
  // The root object ID stays on the server.
  assert.ok(!JSON.stringify(s).includes('kf7c1edc'));
  const dir = toEntry({ name: 'd', type: 'd', obj: 'k1', summ: { size: 42 } });
  assert.equal(dir.size, 42);
  const file = toEntry({ name: 'f', type: 'f', obj: 'a1', size: 7, mode: '0644' });
  assert.deepEqual([file.size, file.mode], [7, '0644']);
});

test('object IDs are validated before reaching the kopia command line', () => {
  for (const ok of [
    '74dd3c78c0962c2b68f3da8afd94e31c',
    'k3f8d98b4b7e7aa2252a61cace4475ea9',
    'Ixd4f8d98b4b7e7aa2252a61cace4475ea9',
    'IZk3f8d98b4b7e7aa2252a61cace4475ea9',
  ]) {
    assert.ok(OBJECT_ID.test(ok), ok);
  }
  for (const bad of ['--help', 'k3f8 --config-file=/etc/x', '', 'ABCDEF0123456789', '../../etc/passwd']) {
    assert.ok(!OBJECT_ID.test(bad), bad);
  }
});

// --- Integration ------------------------------------------------------------------------------

const endpoint = process.env.TEST_S3_ENDPOINT;
const kopiaBin =
  process.env.TEST_KOPIA_BIN ?? (existsSync('build/kopia/kopia') ? join(process.cwd(), 'build/kopia/kopia') : 'kopia');
const kopiaWorks = await run(kopiaBin, ['--version']).then(
  () => true,
  () => false,
);
const skip = !endpoint ? 'TEST_S3_ENDPOINT is not set' : !kopiaWorks ? `no kopia binary (${kopiaBin})` : false;

describe('kopia repository in S3', { skip }, () => {
  const id = Math.random().toString(36).slice(2, 8);
  const bucket = `ol-test-${id}-kopia`;
  const password = `pw-${randomBytes(6).toString('hex')}`;
  const access = process.env.TEST_S3_ACCESS_KEY ?? 'objectlens';
  const secret = process.env.TEST_S3_SECRET_KEY ?? 'objectlens-secret';
  const binary = randomBytes(300 * 1024);
  let work: string;
  let app: ReturnType<typeof createApp>;

  const H = {
    host: 'localhost',
    'x-objectlens': '1',
    'sec-fetch-site': 'same-origin',
    'content-type': 'application/json',
  };
  const call = async <T>(
    a: ReturnType<typeof createApp>,
    method: string,
    path: string,
    body?: unknown,
    status = 200,
  ) => {
    const res = await a.request(`http://localhost${path}`, {
      method,
      headers: H,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    assert.equal(res.status, status, `${method} ${path}: ${text}`);
    return (text ? JSON.parse(text) : null) as T;
  };
  const appWith = (env: Record<string, string>) =>
    createApp(
      loadConfig({
        S3_1_ENDPOINT: endpoint!,
        S3_1_ACCESS_KEY_ID: access,
        S3_1_SECRET_ACCESS_KEY: secret,
        KOPIA_BIN: kopiaBin,
        KOPIA_DIR: join(work, `state-${Math.random().toString(36).slice(2)}`),
        CAPABILITY_TTL_MINUTES: '0',
        ...env,
      }),
    );
  const kopia = (args: string[]) =>
    run(kopiaBin, [...args, '--config-file', join(work, 'cli.config'), '--log-dir', join(work, 'cli-logs')], {
      env: {
        PATH: process.env.PATH,
        HOME: work,
        KOPIA_PASSWORD: password,
        KOPIA_CHECK_FOR_UPDATES: 'false',
        AWS_ACCESS_KEY_ID: access,
        AWS_SECRET_ACCESS_KEY: secret,
      },
    });

  before(async () => {
    work = await mkdtemp(join(tmpdir(), 'objectlens-kopia-'));
    const src = join(work, 'source');
    await mkdir(join(src, 'nested', 'deeper'), { recursive: true });
    await writeFile(join(src, 'hello.txt'), 'hello from kopia\n');
    await writeFile(join(src, 'ø å.md'), '# unicode\n');
    await writeFile(join(src, 'page.html'), '<script>alert(1)</script>');
    await writeFile(join(src, 'nested', 'data.bin'), binary);
    await writeFile(join(src, 'nested', 'deeper', 'leaf.txt'), 'leaf');
    await symlink('hello.txt', join(src, 'link'));

    // The repository lives under a prefix, next to ordinary objects.
    app = appWith({});
    await call(app, 'POST', '/api/c/1/buckets', { name: bucket }, 201);
    const url = new URL(endpoint!);
    await kopia([
      'repository',
      'create',
      's3',
      '--bucket',
      bucket,
      '--prefix',
      'backups/',
      '--endpoint',
      url.host,
      ...(url.protocol === 'http:' ? ['--disable-tls'] : []),
      '--cache-directory',
      join(work, 'cli-cache'),
      '--override-hostname',
      'testhost',
      '--override-username',
      'tester',
    ]);
    await kopia(['snapshot', 'create', src]);
    await kopia(['repository', 'disconnect']);
  });

  after(async () => {
    if (app) {
      await call(app, 'POST', `/api/c/1/b/${bucket}/delete`, { items: [{ prefix: '' }], allVersions: false }).catch(
        () => {},
      );
      await call(app, 'DELETE', `/api/c/1/buckets/${bucket}`).catch(() => {});
    }
    if (work) await rm(work, { recursive: true, force: true });
  });

  test('the repository folder is detected and protected', async () => {
    assert.deepEqual(await call(app, 'GET', `/api/c/1/b/${bucket}/kopia/detect?prefix=backups/`), { repository: true });
    assert.deepEqual(await call(app, 'GET', `/api/c/1/b/${bucket}/kopia/detect?prefix=`), { repository: false });
    const caps = await call<Capabilities>(app, 'GET', `/api/c/1/b/${bucket}/capabilities?prefix=backups/`);
    assert.equal(caps.write.allowed, false);
    assert.equal(caps.delete.allowed, false);
    // The server refuses too, not just the UI.
    const put = await app.request(`http://localhost/api/c/1/b/${bucket}/upload?key=backups/x.txt`, {
      method: 'PUT',
      headers: H,
      body: 'x',
    });
    assert.equal(put.status, 403);
    await call(app, 'POST', `/api/c/1/b/${bucket}/delete`, { items: [{ key: 'backups/kopia.repository' }] }, 403);
    await call(app, 'GET', `/api/c/1/b/${bucket}/kopia/status?prefix=`, undefined, 404);
  });

  test('without a password the repository is locked; a typed one unlocks it', async () => {
    const st = await call<KopiaStatus>(app, 'GET', `/api/c/1/b/${bucket}/kopia/status?prefix=backups/`);
    assert.deepEqual([st.installed, st.locked, st.passwordSource], [true, true, null]);
    await call(app, 'GET', `/api/c/1/b/${bucket}/kopia/snapshots?prefix=backups/`, undefined, 423);
    const wrong = await call<{ code: string }>(
      app,
      'POST',
      `/api/c/1/b/${bucket}/kopia/unlock`,
      { prefix: 'backups/', password: 'wrong' },
      400,
    );
    assert.equal(wrong.code, 'kopia-bad-password');
    await call(app, 'POST', `/api/c/1/b/${bucket}/kopia/unlock`, { prefix: 'backups/', password });
    const open = await call<KopiaStatus>(app, 'GET', `/api/c/1/b/${bucket}/kopia/status?prefix=backups/`);
    assert.deepEqual([open.locked, open.passwordSource, open.error], [false, 'ui', null]);
    assert.ok(open.repository?.some((r) => r.label === 'Encryption'));
    await call(app, 'POST', `/api/c/1/b/${bucket}/kopia/lock`, { prefix: 'backups/' });
    const locked = await call<KopiaStatus>(app, 'GET', `/api/c/1/b/${bucket}/kopia/status?prefix=backups/`);
    assert.equal(locked.locked, true);
  });

  test('snapshots, folders and files are read back', async () => {
    const a = appWith({ S3_1_KOPIA_PASSWORD: password });
    const st = await call<KopiaStatus>(a, 'GET', `/api/c/1/b/${bucket}/kopia/status?prefix=backups/`);
    assert.deepEqual([st.locked, st.passwordSource], [false, 'env']);

    const snaps = await call<KopiaSnapshot[]>(a, 'GET', `/api/c/1/b/${bucket}/kopia/snapshots?prefix=backups/`);
    assert.equal(snaps.length, 1);
    const s = snaps[0]!;
    assert.equal(s.incomplete, null);
    assert.deepEqual([s.source.host, s.source.user], ['testhost', 'tester']);
    assert.equal(s.summary?.files, 5);

    const root = await call<KopiaBrowse>(
      a,
      'GET',
      `/api/c/1/b/${bucket}/kopia/browse?prefix=backups/&snapshot=${s.id}`,
    );
    assert.deepEqual(root.entries.map((e) => `${e.type}:${e.name}`).sort(), [
      'd:nested',
      'f:hello.txt',
      'f:page.html',
      'f:ø å.md',
      's:link',
    ]);
    const deeper = await call<KopiaBrowse>(
      a,
      'GET',
      `/api/c/1/b/${bucket}/kopia/browse?prefix=backups/&snapshot=${s.id}&path=${encodeURIComponent('nested/deeper')}`,
    );
    assert.deepEqual(
      deeper.entries.map((e) => [e.name, e.size]),
      [['leaf.txt', 4]],
    );

    const file = (path: string, inline = false) =>
      a.request(
        `http://localhost/api/c/1/b/${bucket}/kopia/file?prefix=backups/&snapshot=${s.id}&path=${encodeURIComponent(path)}${inline ? '&inline=1' : ''}`,
        { headers: H },
      );
    const bin = await file('nested/data.bin');
    assert.equal(bin.status, 200);
    assert.ok(Buffer.from(await bin.arrayBuffer()).equals(binary));
    assert.match(bin.headers.get('content-disposition')!, /^attachment; filename="data.bin"/);
    assert.equal(await (await file('ø å.md')).text(), '# unicode\n');

    // HTML from a backup is shown as text, sandboxed.
    const html = await file('page.html', true);
    assert.equal(html.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.match(html.headers.get('content-security-policy')!, /^sandbox/);
    await html.arrayBuffer();

    // Only files of listed folders: no folders, links or made-up names.
    for (const p of ['nested', 'link', 'nope.txt', '../x']) {
      const r = await file(p);
      assert.equal(r.status, 404, p);
      await r.arrayBuffer();
    }
    await call(
      a,
      'GET',
      `/api/c/1/b/${bucket}/kopia/browse?prefix=backups/&snapshot=${s.id}&path=nope`,
      undefined,
      404,
    );
    await call(a, 'GET', `/api/c/1/b/${bucket}/kopia/browse?prefix=backups/&snapshot=--help`, undefined, 404);
  });
});
