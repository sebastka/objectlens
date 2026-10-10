import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  baseName,
  breadcrumbs,
  bucketNameError,
  keyError,
  nameError,
  parentPrefix,
  rebase,
} from '../src/shared/keys.ts';

test('baseName and parentPrefix treat "/" as the folder separator', () => {
  assert.equal(baseName('a/b/c.txt'), 'c.txt');
  assert.equal(baseName('a/b/'), 'b');
  assert.equal(baseName('c.txt'), 'c.txt');
  assert.equal(parentPrefix('a/b/c.txt'), 'a/b/');
  assert.equal(parentPrefix('a/b/'), 'a/');
  assert.equal(parentPrefix('a/'), '');
  assert.equal(parentPrefix('c.txt'), '');
});

test('breadcrumbs list every folder down to the prefix', () => {
  assert.deepEqual(breadcrumbs(''), []);
  assert.deepEqual(breadcrumbs('a/b/'), [
    { name: 'a', prefix: 'a/' },
    { name: 'b', prefix: 'a/b/' },
  ]);
  // Empty segments ("a//b/") are real, distinct S3 folders.
  assert.deepEqual(
    breadcrumbs('a//').map((c) => c.prefix),
    ['a/', 'a//'],
  );
});

test('nameError refuses slashes, dot names and control characters', () => {
  assert.equal(nameError('report.pdf'), null);
  assert.equal(nameError('with space & ünicode'), null);
  assert.match(nameError('')!, /empty/);
  assert.match(nameError('a/b')!, /\//);
  assert.match(nameError('..')!, /\.\./);
  assert.match(nameError('a\nb')!, /control/);
});

test('keyError counts UTF-8 bytes, as S3 does', () => {
  assert.equal(keyError('a'.repeat(1024)), null);
  assert.match(keyError('a'.repeat(1025))!, /1024 bytes/);
  // 512 two-byte characters are 1024 bytes; one more is too long.
  assert.equal(keyError('ø'.repeat(512)), null);
  assert.match(keyError('ø'.repeat(513))!, /1024 bytes/);
});

test('rebase moves a key from one prefix to another', () => {
  assert.equal(rebase('a/b/c.txt', 'a/', 'x/'), 'x/b/c.txt');
  assert.equal(rebase('a/b/c.txt', 'a/b/', ''), 'c.txt');
  assert.throws(() => rebase('z/c.txt', 'a/', 'x/'));
});

test('bucketNameError follows the S3 naming rules', () => {
  assert.equal(bucketNameError('my-bucket.data'), null);
  assert.ok(bucketNameError('ab'));
  assert.ok(bucketNameError('Upper'));
  assert.ok(bucketNameError('-start'));
  assert.ok(bucketNameError('a..b'));
  assert.ok(bucketNameError('192.168.1.1'));
  assert.ok(bucketNameError('xn--bucket'));
});

test('inline previews get a type chosen by ObjectLens', async () => {
  const { inlineType } = await import('../src/server/details.ts');
  assert.deepEqual(inlineType('doc.pdf', 'application/octet-stream'), { kind: 'pdf', type: 'application/pdf' });
  assert.deepEqual(inlineType('page.html', 'text/html'), { kind: 'text', type: 'text/plain; charset=utf-8' });
  assert.deepEqual(inlineType('pic.jpg', ''), { kind: 'image', type: 'image/jpeg' });
  assert.deepEqual(inlineType('clip.mp4', 'video/mp4'), { kind: 'video', type: 'video/mp4' });
  assert.equal(inlineType('app.exe', 'application/x-msdownload'), null);
  assert.equal(inlineType('noext', ''), null);
});
