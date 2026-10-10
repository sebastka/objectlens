import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigError, loadConfig } from '../src/server/config.ts';

const problems = (env: Record<string, string>) => {
  try {
    loadConfig(env);
    return [];
  } catch (e) {
    assert.ok(e instanceof ConfigError);
    return e.problems;
  }
};

test('defaults: localhost only, no connections', () => {
  const cfg = loadConfig({});
  assert.equal(cfg.http.host, '127.0.0.1');
  assert.equal(cfg.http.port, 3000);
  assert.deepEqual(cfg.connections, []);
});

test('numbered S3 blocks, in order, with defaults', () => {
  const cfg = loadConfig({
    S3_2_ENDPOINT: 'http://127.0.0.1:9000/',
    S3_2_ACCESS_KEY_ID: 'k',
    S3_2_SECRET_ACCESS_KEY: 's',
    S3_1_NAME: 'AWS prod',
    S3_1_REGION: 'eu-north-1',
    S3_1_BUCKETS: 'a, b',
    S3_1_READ_ONLY: 'true',
  });
  assert.deepEqual(
    cfg.connections.map((c) => c.id),
    ['1', '2'],
  );
  const [aws, local] = cfg.connections;
  assert.equal(aws!.endpoint, null);
  assert.equal(aws!.forcePathStyle, false);
  assert.equal(aws!.credentials, null);
  assert.deepEqual(aws!.buckets, ['a', 'b']);
  assert.equal(aws!.readOnly, true);
  assert.equal(local!.name, '127.0.0.1:9000');
  assert.equal(local!.endpoint, 'http://127.0.0.1:9000');
  assert.equal(local!.forcePathStyle, true);
  assert.deepEqual(local!.credentials, { accessKeyId: 'k', secretAccessKey: 's' });
  assert.equal(local!.probe, true);
});

test('every problem is reported at once', () => {
  const p = problems({
    PORT: 'abc',
    S3_1_ENDPOINT: 'ftp://x',
    S3_1_ACCESS_KEY_ID: 'only-the-key',
    S3_1_READ_ONLY: 'maybe',
    S3_2_ID: '1',
    S3_2_LIST_BUCKETS: 'false',
  });
  assert.equal(p.length, 6, p.join('\n'));
  assert.ok(p.some((x) => x.startsWith('PORT')));
  assert.ok(p.some((x) => x.includes('S3_1_ENDPOINT')));
  assert.ok(p.some((x) => x.includes('set together')));
  assert.ok(p.some((x) => x.includes('S3_1_READ_ONLY')));
  assert.ok(p.some((x) => x.includes('used by two connections')));
  assert.ok(p.some((x) => x.includes('needs S3_2_BUCKETS')));
});

test('a profile excludes static keys', () => {
  assert.equal(problems({ S3_1_PROFILE: 'dev', S3_1_ACCESS_KEY_ID: 'k', S3_1_SECRET_ACCESS_KEY: 's' }).length, 1);
  assert.equal(loadConfig({ S3_1_PROFILE: 'dev' }).connections[0]!.profile, 'dev');
});

test('share links never outlive SigV4 (7 days)', () => {
  assert.equal(loadConfig({ SHARE_MAX_HOURS: '1000' }).limits.shareMaxHours, 168);
});
