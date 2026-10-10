import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp, contentDisposition } from '../src/server/app.ts';
import { loadConfig } from '../src/server/config.ts';
import { allowedHosts, hostName } from '../src/server/guard.ts';

const app = createApp(loadConfig({ S3_1_ENDPOINT: 'http://127.0.0.1:1', S3_1_READ_ONLY: 'true' }));

test('hostName strips the port, keeps IPv6 brackets', () => {
  assert.equal(hostName('LocalHost:3000'), 'localhost');
  assert.equal(hostName('[::1]:3000'), '[::1]');
  assert.equal(hostName('example.com'), 'example.com');
});

test('allowed hosts: loopback names, the listen address and ALLOWED_HOSTS', () => {
  const h = allowedHosts({ host: '169.254.1.2', port: 3000, allowedHosts: ['lens.home'] });
  assert.ok(h.has('localhost') && h.has('127.0.0.1') && h.has('[::1]'));
  assert.ok(h.has('169.254.1.2') && h.has('lens.home'));
  assert.ok(!allowedHosts({ host: '0.0.0.0', port: 3000, allowedHosts: [] }).has('0.0.0.0'));
});

test('a foreign Host header is refused (DNS rebinding)', async () => {
  const ok = await app.request('http://localhost:3000/api/health');
  assert.equal(ok.status, 200);
  const bad = await app.request('http://evil.example/api/health');
  assert.equal(bad.status, 403);
});

test('writes need same-origin and the X-ObjectLens header (CSRF)', async () => {
  const url = 'http://localhost:3000/api/c/1/b/x/folder';
  const body = JSON.stringify({ prefix: '', name: 'a' });
  const json = { 'content-type': 'application/json' };
  const crossSite = await app.request(url, {
    method: 'POST',
    body,
    headers: { ...json, 'sec-fetch-site': 'cross-site', 'x-objectlens': '1' },
  });
  assert.equal(crossSite.status, 403);
  const otherOrigin = await app.request(url, {
    method: 'POST',
    body,
    headers: { ...json, origin: 'http://evil.example', 'x-objectlens': '1' },
  });
  assert.equal(otherOrigin.status, 403);
  const noHeader = await app.request(url, {
    method: 'POST',
    body,
    headers: { ...json, 'sec-fetch-site': 'same-origin' },
  });
  assert.equal(noHeader.status, 403);
  // Passes the guards; refused because this connection is read-only, before S3 is asked.
  const readOnly = await app.request(url, {
    method: 'POST',
    body,
    headers: { ...json, 'sec-fetch-site': 'same-origin', 'x-objectlens': '1' },
  });
  assert.equal(readOnly.status, 403);
  assert.match(((await readOnly.json()) as { error: string }).error, /read-only/);
});

test('unknown connections and routes are 404', async () => {
  assert.equal((await app.request('http://localhost/api/c/9/buckets')).status, 404);
  assert.equal((await app.request('http://localhost/api/nope')).status, 404);
});

test('Content-Disposition carries an ASCII fallback and the UTF-8 name', () => {
  assert.equal(
    contentDisposition('attachment', 'rapport "år".pdf'),
    `attachment; filename="rapport __r_.pdf"; filename*=UTF-8''rapport%20%22%C3%A5r%22.pdf`,
  );
  assert.equal(contentDisposition('inline', "it's.txt"), `inline; filename="it's.txt"; filename*=UTF-8''it%27s.txt`);
});
