import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

async function setup(env = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'splatbox-'));
  const config = loadConfig({ DATA_DIR: dataDir, WEB_DIR: '/nonexistent', ...env });
  const app = await buildApp(config);
  return { app, dataDir };
}
const put = (app, url, body, headers = {}) =>
  app.inject({ method: 'PUT', url, payload: body, headers: { 'content-type': 'application/octet-stream', ...headers } });

test('collections + upload + manifest + range + delete', async () => {
  const { app } = await setup();
  const c = (await app.inject({ method: 'POST', url: '/api/collections', payload: { name: 'Travel Scans' } })).json();
  assert.equal(c.id, 'travel-scans');
  const dup = (await app.inject({ method: 'POST', url: '/api/collections', payload: { name: 'Travel Scans' } })).json();
  assert.equal(dup.id, 'travel-scans-2');

  // preview uploaded before the asset still gets attached
  assert.equal((await put(app, '/api/collections/travel-scans/assets/room.preview.webp', 'img')).statusCode, 200);
  const up = await put(app, '/api/collections/travel-scans/assets/room.ply', 'ply data here');
  assert.equal(up.statusCode, 200);
  const man = (await app.inject('/files/collections/travel-scans/manifest.json')).json();
  assert.equal(man.version, 1);
  assert.equal(man.assets.length, 1);
  assert.equal(man.assets[0].path, 'assets/room.ply');
  assert.equal(man.assets[0].size, 13);

  const rng = await app.inject({ url: '/files/collections/travel-scans/assets/room.ply', headers: { range: 'bytes=0-2' } });
  assert.equal(rng.statusCode, 206);
  assert.equal(rng.body, 'ply');

  const list = (await app.inject('/api/collections')).json();
  assert.equal(list.find((x) => x.id === 'travel-scans').assetCount, 1);

  const del = await app.inject({ method: 'DELETE', url: '/api/collections/travel-scans/assets', payload: { paths: ['assets/room.ply'] } });
  assert.deepEqual(del.json().removed, ['assets/room.ply']);
  assert.equal((await app.inject('/files/collections/travel-scans/assets/room.ply')).statusCode, 404);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/collections/travel-scans' })).statusCode, 204);
  assert.equal((await app.inject('/api/collections/travel-scans')).statusCode, 404);
});

test('rejects bad filenames, types, traversal and oversize', async () => {
  const { app } = await setup({ MAX_UPLOAD_GB: '0.000001' });
  await app.inject({ method: 'POST', url: '/api/collections', payload: { name: 'a' } });
  assert.equal((await put(app, '/api/collections/a/assets/x.exe', 'x')).statusCode, 415);
  assert.equal((await put(app, '/api/collections/a/assets/.hidden.ply', 'x')).statusCode, 400);
  assert.equal((await put(app, '/api/collections/..%2Fetc/assets/x.ply', 'x')).statusCode, 400);
  assert.equal((await put(app, '/api/collections/a/assets/big.ply', Buffer.alloc(5000))).statusCode, 413);
  assert.equal((await app.inject('/files/collections/a/..%2f..%2fetc/passwd')).statusCode >= 400, true);
});

test('rescan picks up files placed on disk', async () => {
  const { app, dataDir } = await setup();
  await app.inject({ method: 'POST', url: '/api/collections', payload: { name: 'r' } });
  await fs.writeFile(path.join(dataDir, 'collections/r/assets/found.sog'), 'abc');
  const dry = (await app.inject({ method: 'POST', url: '/api/collections/r/rescan?apply=0' })).json();
  assert.equal(dry.added.length, 1);
  await app.inject({ method: 'POST', url: '/api/collections/r/rescan?apply=1' });
  const man = (await app.inject('/files/collections/r/manifest.json')).json();
  assert.equal(man.assets[0].name, 'found.sog');
});

test('basic auth: off by default, enforced when configured, readonly mode', async () => {
  const open = await setup();
  assert.equal((await open.app.inject('/api/collections')).statusCode, 200);

  const { app } = await setup({ BASIC_AUTH_USER: 'u', BASIC_AUTH_PASSWORD: 'p' });
  assert.equal((await app.inject('/api/health')).statusCode, 200);
  const no = await app.inject('/api/collections');
  assert.equal(no.statusCode, 401);
  assert.match(no.headers['www-authenticate'], /Basic/);
  const bad = { authorization: 'Basic ' + Buffer.from('u:x').toString('base64') };
  assert.equal((await app.inject({ url: '/api/collections', headers: bad })).statusCode, 401);
  const good = { authorization: 'Basic ' + Buffer.from('u:p').toString('base64') };
  assert.equal((await app.inject({ url: '/api/collections', headers: good })).statusCode, 200);

  const ro = await setup({ BASIC_AUTH_USER: 'u', BASIC_AUTH_PASSWORD: 'p', BASIC_AUTH_READONLY: 'true' });
  assert.equal((await ro.app.inject('/api/collections')).statusCode, 200);
  assert.equal((await ro.app.inject({ method: 'POST', url: '/api/collections', payload: { name: 'x' } })).statusCode, 401);
  assert.equal((await ro.app.inject({ method: 'POST', url: '/api/collections', payload: { name: 'x' }, headers: good })).statusCode, 201);
});

test('background requests get 401 without a login prompt', async () => {
  const { app } = await setup({ BASIC_AUTH_USER: 'u', BASIC_AUTH_PASSWORD: 'p', BASIC_AUTH_READONLY: 'true' });
  const res = await put(app, '/api/collections/x/assets/a.webp', Buffer.from('img'), { 'x-splatbox-background': '1' });
  assert.equal(res.statusCode, 401);
  assert.equal(res.headers['www-authenticate'], undefined);
});

test('uploaded thumbnail is attached as the preview of the scan with the same base name', async () => {
  const { app } = await setup();
  const c = (await app.inject({ method: 'POST', url: '/api/collections', payload: { name: 'Thumbs' } })).json();
  assert.equal((await put(app, `/api/collections/${c.id}/assets/room.ply`, Buffer.from('ply-data'))).statusCode, 200);
  assert.equal((await put(app, `/api/collections/${c.id}/assets/room.webp`, Buffer.from('webp-data'))).statusCode, 200);
  const manifest = (await app.inject(`/files/collections/${c.id}/manifest.json`)).json();
  assert.equal(manifest.assets.length, 1);
  assert.equal(manifest.assets[0].preview, 'assets/room.webp');
});
