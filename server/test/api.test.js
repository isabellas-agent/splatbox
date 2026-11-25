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

test('collection files are served with revalidation cache headers', async () => {
  const { app } = await setup();
  const c = (await app.inject({ method: 'POST', url: '/api/collections', payload: { name: 'Cache' } })).json();
  const res = await app.inject(`/files/collections/${c.id}/manifest.json`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['cache-control'], 'public, max-age=0, must-revalidate');
});

test('web app: hashed assets are immutable, index.html is revalidated', async () => {
  const webDir = await fs.mkdtemp(path.join(os.tmpdir(), 'splatbox-web-'));
  await fs.mkdir(path.join(webDir, 'assets'));
  await fs.writeFile(path.join(webDir, 'index.html'), '<!doctype html>');
  await fs.writeFile(path.join(webDir, 'assets', 'app-abc.js'), 'console.log(1)');
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'splatbox-'));
  const app = await buildApp(loadConfig({ DATA_DIR: dataDir, WEB_DIR: webDir }));
  const index = await app.inject('/');
  assert.equal(index.statusCode, 200);
  assert.equal(index.headers['cache-control'], 'no-cache');
  const asset = await app.inject('/assets/app-abc.js');
  assert.equal(asset.statusCode, 200);
  assert.equal(asset.headers['cache-control'], 'public, max-age=31536000, immutable');
});

test('per-scan title, description and tags (single and bulk)', async () => {
  const { app } = await setup();
  const c = (await app.inject({ method: 'POST', url: '/api/collections', payload: { name: 'Meta' } })).json();
  await put(app, `/api/collections/${c.id}/assets/a.ply`, Buffer.from('a'));
  await put(app, `/api/collections/${c.id}/assets/b.ply`, Buffer.from('b'));
  const patch = (payload) => app.inject({ method: 'PATCH', url: `/api/collections/${c.id}/assets`, payload });

  let r = await patch({ paths: ['assets/a.ply'], title: ' Kitchen ', description: 'Morning light', tags: ['Indoor', 'indoor ', 'Home'] });
  assert.equal(r.statusCode, 200);
  let m = (await app.inject(`/files/collections/${c.id}/manifest.json`)).json();
  assert.deepEqual(m.assets[0], { path: 'assets/a.ply', name: 'a.ply', size: 1, title: 'Kitchen', description: 'Morning light', tags: ['indoor', 'home'] });

  r = await patch({ paths: ['assets/a.ply', 'assets/b.ply'], addTags: ['2026'], removeTags: ['home'] });
  assert.equal(r.statusCode, 200);
  m = (await app.inject(`/files/collections/${c.id}/manifest.json`)).json();
  assert.deepEqual(m.assets[0].tags, ['indoor', '2026']);
  assert.deepEqual(m.assets[1].tags, ['2026']);

  r = await patch({ paths: ['assets/a.ply'], title: '', tags: [] });
  m = (await app.inject(`/files/collections/${c.id}/manifest.json`)).json();
  assert.equal(m.assets[0].title, undefined);
  assert.equal(m.assets[0].tags, undefined);
  assert.equal(m.assets[0].description, 'Morning light');

  assert.equal((await patch({ paths: ['assets/a.ply'], title: 'x'.repeat(201) })).statusCode, 400);
  assert.equal((await patch({ paths: ['assets/a.ply'], tags: 'nope' })).statusCode, 400);
  assert.equal((await patch({ paths: ['assets/missing.ply'], title: 'x' })).statusCode, 404);
});

test('move and copy scans between collections with previews and name clashes', async () => {
  const { app, dataDir } = await setup();
  const mk = async (name) => (await app.inject({ method: 'POST', url: '/api/collections', payload: { name } })).json();
  const a = await mk('Source');
  const b = await mk('Target');
  await put(app, `/api/collections/${a.id}/assets/room.ply`, Buffer.from('room-a'));
  await put(app, `/api/collections/${a.id}/assets/room.webp`, Buffer.from('thumb-a'));
  await put(app, `/api/collections/${a.id}/assets/hall.ply`, Buffer.from('hall'));
  await app.inject({ method: 'PATCH', url: `/api/collections/${a.id}/assets`, payload: { paths: ['assets/room.ply'], title: 'Room', tags: ['x'] } });
  await put(app, `/api/collections/${b.id}/assets/room.ply`, Buffer.from('room-b'));
  const transfer = (id, payload) => app.inject({ method: 'POST', url: `/api/collections/${id}/assets/transfer`, payload });

  // copy: source keeps the scan, target gets a renamed copy with its thumbnail
  let r = await transfer(a.id, { paths: ['assets/room.ply'], target: b.id, mode: 'copy' });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json().transferred, [{ from: 'assets/room.ply', to: 'assets/room-2.ply' }]);
  let ma = (await app.inject(`/files/collections/${a.id}/manifest.json`)).json();
  let mb = (await app.inject(`/files/collections/${b.id}/manifest.json`)).json();
  assert.equal(ma.assets.length, 2);
  const copied = mb.assets.find((x) => x.path === 'assets/room-2.ply');
  assert.equal(copied.title, 'Room');
  assert.deepEqual(copied.tags, ['x']);
  assert.equal(copied.preview, 'assets/room-2.webp');
  assert.equal(await fs.readFile(path.join(dataDir, 'collections', b.id, 'assets', 'room-2.webp'), 'utf8'), 'thumb-a');
  assert.equal(await fs.readFile(path.join(dataDir, 'collections', b.id, 'assets', 'room.ply'), 'utf8'), 'room-b');

  // move: removed from source with its files
  r = await transfer(a.id, { paths: ['assets/room.ply', 'assets/hall.ply'], target: b.id, mode: 'move' });
  assert.equal(r.statusCode, 200);
  ma = (await app.inject(`/files/collections/${a.id}/manifest.json`)).json();
  mb = (await app.inject(`/files/collections/${b.id}/manifest.json`)).json();
  assert.equal(ma.assets.length, 0);
  assert.deepEqual(mb.assets.map((x) => x.path).sort(), ['assets/hall.ply', 'assets/room-2.ply', 'assets/room-3.ply', 'assets/room.ply']);
  assert.deepEqual(await fs.readdir(path.join(dataDir, 'collections', a.id, 'assets')), []);

  assert.equal((await transfer(a.id, { paths: ['assets/x.ply'], target: a.id })).statusCode, 400);
  assert.equal((await transfer(a.id, { paths: ['assets/x.ply'], target: '../etc' })).statusCode, 400);
  assert.equal((await transfer(b.id, { paths: ['assets/hall.ply'], target: 'nope' })).statusCode, 404);
  assert.equal((await transfer(b.id, { paths: ['assets/hall.ply'], target: a.id, mode: 'link' })).statusCode, 400);
});

test('saved default view and gallery animation per scan', async () => {
  const { app, dataDir } = await setup();
  const c = (await app.inject({ method: 'POST', url: '/api/collections', payload: { name: 'Views' } })).json();
  const patch = (payload) => app.inject({ method: 'PATCH', url: `/api/collections/${c.id}/assets`, payload });
  await put(app, `/api/collections/${c.id}/assets/room.ply`, Buffer.from('ply'));

  const view = { position: [1.5, 0.5, -2], target: [0, 0.25, 0], fov: 72 };
  let r = await patch({ paths: ['assets/room.ply'], view, gallery: { motion: 'orbit', frames: 24, duration: 8000 } });
  assert.equal(r.statusCode, 200);
  let m = (await app.inject(`/files/collections/${c.id}/manifest.json`)).json();
  assert.deepEqual(m.assets[0].view.position, [1.5, 0.5, -2]);
  assert.equal(m.assets[0].view.fov, 72);
  assert.match(m.assets[0].view.savedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(
    { motion: m.assets[0].gallery.motion, frames: m.assets[0].gallery.frames, duration: m.assets[0].gallery.duration },
    { motion: 'orbit', frames: 24, duration: 8000 },
  );
  assert.equal(m.assets[0].animation, undefined);

  // The sprite sheet companions the scan like a thumbnail does
  assert.equal((await put(app, `/api/collections/${c.id}/assets/room.anim.webp`, Buffer.from('sheet'))).statusCode, 200);
  m = (await app.inject(`/files/collections/${c.id}/manifest.json`)).json();
  assert.equal(m.assets[0].animation, 'assets/room.anim.webp');
  assert.equal(m.assets[0].preview, undefined);
  assert.equal((await app.inject(`/files/collections/${c.id}/assets/room.anim.webp`)).body, 'sheet');

  // Validation
  assert.equal((await patch({ paths: ['assets/room.ply'], view: { position: [1, 2], target: [0, 0, 0] } })).statusCode, 400);
  assert.equal((await patch({ paths: ['assets/room.ply'], view: { position: [1, 2, 3], target: [0, 0, 0], fov: 'wide' } })).statusCode, 400);
  assert.equal((await patch({ paths: ['assets/room.ply'], gallery: { motion: 'spin' } })).statusCode, 400);
  assert.equal((await patch({ paths: ['assets/room.ply'], gallery: { motion: 'orbit', frames: 1 } })).statusCode, 400);

  // Clearing the view but keeping the animation setting
  r = await patch({ paths: ['assets/room.ply'], view: null });
  m = (await app.inject(`/files/collections/${c.id}/manifest.json`)).json();
  assert.equal(m.assets[0].view, undefined);
  assert.equal(m.assets[0].gallery.motion, 'orbit');

  // Move keeps the sprite sheet, renamed with the scan
  const t = (await app.inject({ method: 'POST', url: '/api/collections', payload: { name: 'Target' } })).json();
  r = await app.inject({ method: 'POST', url: `/api/collections/${c.id}/assets/transfer`, payload: { paths: ['assets/room.ply'], target: t.id, mode: 'move' } });
  assert.equal(r.statusCode, 200);
  const mt = (await app.inject(`/files/collections/${t.id}/manifest.json`)).json();
  assert.equal(mt.assets[0].animation, 'assets/room.anim.webp');
  assert.equal(await fs.readFile(path.join(dataDir, 'collections', t.id, 'assets', 'room.anim.webp'), 'utf8'), 'sheet');

  // Deleting the scan removes its sprite sheet too
  await app.inject({ method: 'DELETE', url: `/api/collections/${t.id}/assets`, payload: { paths: ['assets/room.ply'] } });
  assert.deepEqual(await fs.readdir(path.join(dataDir, 'collections', t.id, 'assets')), []);
});
