// Velero backup locations. Unit tests need nothing; the integration tests need the development S3
// (TEST_S3_ENDPOINT) and a kopia binary (as test/kopia.test.ts). They build a small Velero
// location by hand: a backup folder with its metadata and tarball, and a namespace's kopia
// repository created with Velero's default password by the real kopia CLI.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { after, before, describe, test } from 'node:test';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { createApp } from '../src/server/app.ts';
import { loadConfig } from '../src/server/config.ts';
import { VELERO_DEFAULT_PASSWORD } from '../src/server/kopia.ts';
import { createClient } from '../src/server/s3.ts';
import { paxRecords, readTar } from '../src/server/tar.ts';
import { fromDataUpload, fromPodVolumeBackup, fromVolumeInfo, toBackup } from '../src/server/velero.ts';
import type { KopiaBrowse, KopiaStatus, VeleroBackup, VeleroBackupDetails } from '../src/shared/types.ts';

const run = promisify(execFile);

// --- A tar writer for the tests (ustar, with PAX headers for long names, as Go writes them) ---

function header(name: string, size: number, type: string): Buffer {
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 100), 0, 'utf8');
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148);
  h.write(type, 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return h;
}

const pad = (b: Buffer) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);

function makeTar(files: { name: string; data: string | Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  for (const f of files) {
    const data = Buffer.from(f.data);
    if (Buffer.byteLength(f.name) > 100) {
      const rec = (k: string, v: string) => {
        const body = ` ${k}=${v}\n`;
        let len = body.length + 2;
        while (`${len}${body}`.length !== len) len++;
        return `${len}${body}`;
      };
      const pax = Buffer.from(rec('path', f.name));
      parts.push(header('PaxHeaders/x', pax.length, 'x'), pad(pax));
    }
    parts.push(header(f.name, data.length, '0'), pad(data));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

test('tar: ustar entries and PAX long names', () => {
  const long = `resources/datauploads.velero.io/namespaces/velero/${'x'.repeat(120)}.json`;
  const entries = readTar(
    gzipSync(
      makeTar([
        { name: 'metadata/version', data: '1' },
        { name: long, data: '{"a":1}' },
      ]),
    ),
  );
  assert.deepEqual(
    entries.map((e) => [e.name, e.data.toString()]),
    [
      ['metadata/version', '1'],
      [long, '{"a":1}'],
    ],
  );
  assert.deepEqual(paxRecords(Buffer.from('30 mtime=1432668921.098285006\n8 a=b=c\n')), {
    mtime: '1432668921.098285006',
    a: 'b=c',
  });
});

test('velero: backups, DataUploads, file-system backups and volumeinfo are mapped', () => {
  const b = toBackup('nightly-1', {
    metadata: { labels: { 'velero.io/schedule-name': 'nightly' } },
    spec: {
      includedNamespaces: ['*'],
      labelSelector: { matchLabels: { backup: 'on' } },
      snapshotMoveData: true,
      ttl: '720h0m0s',
    },
    status: { phase: 'PartiallyFailed', errors: 2, warnings: 1, progress: { totalItems: 8, itemsBackedUp: 7 } },
  });
  assert.deepEqual(
    [b.schedule, b.phase, b.errors, b.warnings, b.labelSelector, b.snapshotMoveData, b.itemsBackedUp],
    ['nightly', 'PartiallyFailed', 2, 1, 'backup=on', true, 7],
  );

  const du = fromDataUpload(
    {
      spec: { sourceNamespace: 'app', sourcePVC: 'data' },
      status: { snapshotID: 'abc123', phase: 'Completed', progress: { totalBytes: 10 }, incrementalBytes: -5 },
    },
    'velero/',
  );
  assert.deepEqual(
    [du.method, du.repository, du.snapshotId, du.bytes, du.incrementalBytes],
    ['data-mover', 'velero/kopia/app/', 'abc123', 10, null],
  );

  const restic = fromPodVolumeBackup(
    {
      spec: { pod: { namespace: 'app', name: 'p' }, volume: 'v', uploaderType: 'restic' },
      status: { snapshotID: 's' },
    },
    '',
  );
  assert.equal(restic.repository, null);
  assert.match(restic.note!, /restic/);
  const fsKopia = fromPodVolumeBackup(
    { spec: { pod: { namespace: 'app', name: 'p' }, volume: 'v', uploaderType: 'kopia' }, status: { snapshotID: 's' } },
    '',
  );
  assert.equal(fsKopia.repository, 'kopia/app/');

  const csi = fromVolumeInfo(
    { pvcName: 'd', pvcNamespace: 'app', backupMethod: 'CSISnapshot', snapshotDataMoved: false },
    '',
  );
  assert.deepEqual([csi.method, csi.repository], ['csi-snapshot', null]);
  const moved = fromVolumeInfo(
    {
      pvcName: 'd',
      pvcNamespace: 'app',
      backupMethod: 'CSISnapshot',
      snapshotDataMoved: true,
      snapshotDataMovementInfo: { dataMover: 'velero', uploaderType: 'kopia', snapshotHandle: 'h1', size: 3 },
    },
    '',
  );
  assert.deepEqual([moved.method, moved.repository, moved.snapshotId], ['data-mover', 'kopia/app/', 'h1']);
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

describe('Velero backup location in S3', { skip }, () => {
  const id = Math.random().toString(36).slice(2, 8);
  const bucket = `ol-test-${id}-velero`;
  const access = process.env.TEST_S3_ACCESS_KEY ?? 'objectlens';
  const secret = process.env.TEST_S3_SECRET_KEY ?? 'objectlens-secret';
  const backupName = 'nightly-20261026030012';
  let work: string;
  let snapshotId: string;

  const H = {
    host: 'localhost',
    'x-objectlens': '1',
    'sec-fetch-site': 'same-origin',
    'content-type': 'application/json',
  };
  const appWith = (env: Record<string, string> = {}) =>
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
    return (text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text) as T;
  };
  const put = (a: ReturnType<typeof createApp>, key: string, data: Buffer | string) =>
    a.request(`http://localhost/api/c/1/b/${bucket}/upload?key=${encodeURIComponent(key)}&overwrite=1`, {
      method: 'PUT',
      headers: { ...H, 'content-type': 'application/octet-stream' },
      body: data,
    });

  before(async () => {
    work = await mkdtemp(join(tmpdir(), 'objectlens-velero-'));
    const app = appWith();
    await call(app, 'POST', '/api/c/1/buckets', { name: bucket }, 201);
    const s3 = createClient(
      loadConfig({ S3_1_ENDPOINT: endpoint!, S3_1_ACCESS_KEY_ID: access, S3_1_SECRET_ACCESS_KEY: secret })
        .connections[0]!,
    );

    // The namespace's kopia repository, as Velero's data mover writes it.
    const src = join(work, 'volume');
    await mkdir(join(src, 'config'), { recursive: true });
    await writeFile(join(src, 'config', 'app.conf'), 'key = value\n');
    const url = new URL(endpoint!);
    const kopia = (args: string[]) =>
      run(kopiaBin, [...args, '--config-file', join(work, 'cli.config'), '--log-dir', join(work, 'cli-logs')], {
        env: {
          PATH: process.env.PATH,
          HOME: work,
          KOPIA_PASSWORD: VELERO_DEFAULT_PASSWORD,
          KOPIA_CHECK_FOR_UPDATES: 'false',
          AWS_ACCESS_KEY_ID: access,
          AWS_SECRET_ACCESS_KEY: secret,
        },
      });
    await kopia([
      'repository',
      'create',
      's3',
      '--bucket',
      bucket,
      '--prefix',
      'velero/kopia/app/',
      '--endpoint',
      url.host,
      ...(url.protocol === 'http:' ? ['--disable-tls'] : []),
      '--cache-directory',
      join(work, 'cli-cache'),
      '--override-hostname',
      'default',
      '--override-username',
      'default',
    ]);
    await kopia(['snapshot', 'create', src, '--json']).then(({ stdout }) => {
      snapshotId = (JSON.parse(stdout) as { id: string }).id;
    });
    await kopia(['repository', 'disconnect']);

    // The backup's metadata, as Velero writes it.
    const dir = `velero/backups/${backupName}/`;
    const backup = {
      metadata: { name: backupName, labels: { 'velero.io/schedule-name': 'nightly' } },
      spec: { includedNamespaces: ['*'], includedResources: ['persistentvolumeclaims'], snapshotMoveData: true },
      status: {
        phase: 'Completed',
        startTimestamp: '2026-10-26T03:00:12Z',
        completionTimestamp: '2026-10-26T03:07:09Z',
        expiration: '2026-11-25T03:00:12Z',
        progress: { totalItems: 1, itemsBackedUp: 1 },
      },
    };
    const dataUpload = {
      metadata: { name: `${backupName}-abcde`, namespace: 'velero' },
      spec: { sourceNamespace: 'app', sourcePVC: 'app-data', snapshotType: 'CSI' },
      status: { phase: 'Completed', snapshotID: snapshotId, progress: { totalBytes: 12 }, incrementalBytes: 12 },
    };
    const pvc = { apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: 'app-data', namespace: 'app' } };
    const tarball = gzipSync(
      makeTar([
        { name: 'metadata/version', data: '1' },
        { name: 'resources/persistentvolumeclaims/namespaces/app/app-data.json', data: JSON.stringify(pvc) },
        {
          name: `resources/datauploads.velero.io/namespaces/velero/${backupName}-abcde.json`,
          data: JSON.stringify(dataUpload),
        },
        {
          name: `resources/datauploads.velero.io/v2alpha1-preferredversion/namespaces/velero/${backupName}-abcde.json`,
          data: JSON.stringify(dataUpload),
        },
      ]),
    );
    for (const [k, v] of [
      [`${dir}velero-backup.json`, JSON.stringify(backup)],
      [
        `${dir}${backupName}-resource-list.json.gz`,
        gzipSync(JSON.stringify({ 'v1/PersistentVolumeClaim': ['app/app-data'] })),
      ],
      [`${dir}${backupName}-results.gz`, gzipSync('{"errors":{},"warnings":{}}')],
      [`${dir}${backupName}-volumeinfo.json.gz`, gzipSync('[]')],
      [`${dir}${backupName}-podvolumebackups.json.gz`, gzipSync('null')],
      [`${dir}${backupName}-logs.gz`, gzipSync('time="2026-10-26T03:00:12Z" level=info msg="Setting up backup"\n')],
      [`${dir}${backupName}.tar.gz`, tarball],
    ] as const) {
      // Straight to S3: ObjectLens itself refuses writes into a Velero location.
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: k, Body: v }));
    }
  });

  after(async () => {
    if (work) {
      const app = appWith();
      await call(app, 'POST', `/api/c/1/b/${bucket}/delete`, { items: [{ prefix: '' }] }).catch(() => {});
      await call(app, 'DELETE', `/api/c/1/buckets/${bucket}`).catch(() => {});
      await rm(work, { recursive: true, force: true });
    }
  });

  test('the location is detected, and its folders are protected', async () => {
    const app = appWith();
    assert.deepEqual(await call(app, 'GET', `/api/c/1/b/${bucket}/velero/detect?prefix=velero/`), { location: true });
    assert.deepEqual(await call(app, 'GET', `/api/c/1/b/${bucket}/velero/detect?prefix=`), { location: false });
    for (const folder of ['velero/backups/', `velero/backups/${backupName}/`]) {
      const r = await put(app, `${folder}x.txt`, 'x');
      assert.equal(r.status, 403, folder);
    }
    const r = await put(app, 'velero/kopia/app/x', 'x');
    assert.equal(r.status, 403);
  });

  test('backups, their volumes, manifests and log are read', async () => {
    const app = appWith();
    const list = await call<VeleroBackup[]>(app, 'GET', `/api/c/1/b/${bucket}/velero/backups?prefix=velero/`);
    assert.deepEqual(
      list.map((b) => [b.name, b.schedule, b.phase]),
      [[backupName, 'nightly', 'Completed']],
    );
    const d = await call<VeleroBackupDetails>(
      app,
      'GET',
      `/api/c/1/b/${bucket}/velero/backup?prefix=velero/&name=${backupName}`,
    );
    assert.deepEqual(d.resources, { 'v1/PersistentVolumeClaim': ['app/app-data'] });
    assert.equal(d.volumes.length, 1, 'the preferred-version copy of a DataUpload is not counted twice');
    const v = d.volumes[0]!;
    assert.deepEqual(
      [v.namespace, v.pvc, v.method, v.snapshotId, v.repository],
      ['app', 'app-data', 'data-mover', snapshotId, 'velero/kopia/app/'],
    );
    assert.ok(d.manifests.includes('resources/persistentvolumeclaims/namespaces/app/app-data.json'));
    assert.ok(!d.manifests.some((m) => m.includes('preferredversion')));

    const manifest = await app.request(
      `http://localhost/api/c/1/b/${bucket}/velero/manifest?prefix=velero/&name=${backupName}&path=resources/persistentvolumeclaims/namespaces/app/app-data.json`,
      { headers: H },
    );
    assert.equal(manifest.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.match(manifest.headers.get('content-security-policy')!, /^sandbox/);
    assert.equal(JSON.parse(await manifest.text()).metadata.name, 'app-data');
    const log = await call<string>(app, 'GET', `/api/c/1/b/${bucket}/velero/logs?prefix=velero/&name=${backupName}`);
    assert.match(log, /Setting up backup/);
    await call(app, 'GET', `/api/c/1/b/${bucket}/velero/backup?prefix=velero/&name=..%2Fx`, undefined, 404);
    await call(
      app,
      'GET',
      `/api/c/1/b/${bucket}/velero/manifest?prefix=velero/&name=${backupName}&path=../x`,
      undefined,
      404,
    );
  });

  test("Velero's default password opens the repository, with a warning", async () => {
    // Nothing configured: the default is tried.
    const plain = appWith();
    const st = await call<KopiaStatus>(plain, 'GET', `/api/c/1/b/${bucket}/kopia/status?prefix=velero/kopia/app/`);
    assert.deepEqual([st.locked, st.velero, st.passwordSource], [false, true, 'velero-default']);
    assert.match(st.warning!, /default password/);
    assert.doesNotMatch(st.warning!, /VELERO_PASSWORD was tried/);

    // A wrong configured password: the default is tried next, and the warning says so.
    const wrong = appWith({ S3_1_VELERO_PASSWORD: 'not-it' });
    const st2 = await call<KopiaStatus>(wrong, 'GET', `/api/c/1/b/${bucket}/kopia/status?prefix=velero/kopia/app/`);
    assert.equal(st2.passwordSource, 'velero-default');
    assert.match(st2.warning!, /S3_1_VELERO_PASSWORD was tried first/);

    // The right configured password: no warning.
    const right = appWith({ S3_1_VELERO_PASSWORD: VELERO_DEFAULT_PASSWORD });
    const st3 = await call<KopiaStatus>(right, 'GET', `/api/c/1/b/${bucket}/kopia/status?prefix=velero/kopia/app/`);
    assert.deepEqual([st3.passwordSource, st3.warning], ['velero-env', null]);

    // A typed password takes precedence.
    await call(plain, 'POST', `/api/c/1/b/${bucket}/kopia/unlock`, {
      prefix: 'velero/kopia/app/',
      password: VELERO_DEFAULT_PASSWORD,
    });
    const st4 = await call<KopiaStatus>(plain, 'GET', `/api/c/1/b/${bucket}/kopia/status?prefix=velero/kopia/app/`);
    assert.deepEqual([st4.passwordSource, st4.warning], ['ui', null]);
  });

  test("a volume's files are read through its kopia snapshot", async () => {
    const app = appWith();
    const root = await call<KopiaBrowse>(
      app,
      'GET',
      `/api/c/1/b/${bucket}/kopia/browse?prefix=velero/kopia/app/&snapshot=${snapshotId}&path=config`,
    );
    assert.deepEqual(
      root.entries.map((e) => e.name),
      ['app.conf'],
    );
    const f = await app.request(
      `http://localhost/api/c/1/b/${bucket}/kopia/file?prefix=velero/kopia/app/&snapshot=${snapshotId}&path=config/app.conf`,
      { headers: H },
    );
    assert.equal(await f.text(), 'key = value\n');
  });
});
