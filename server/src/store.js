import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { randomBytes } from 'node:crypto';

export const SPLAT_EXTS = ['.ply', '.sog', '.spz', '.splat', '.ksplat'];
export const PREVIEW_EXTS = ['.jpg', '.jpeg', '.png', '.webp'];
const META_SUFFIXES = ['.meta.json', '.metadata.json'];
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MANIFEST_VERSION = 1;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const ext = (name) => path.extname(name).toLowerCase();
const baseName = (name) => {
  const lower = name.toLowerCase();
  for (const s of META_SUFFIXES) if (lower.endsWith(s)) return lower.slice(0, -s.length);
  const e = path.extname(name);
  return (e ? name.slice(0, -e.length) : name).toLowerCase();
};
const isMeta = (name) => META_SUFFIXES.some((s) => name.toLowerCase().endsWith(s));

export const slugify = (s) =>
  s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);

export function sanitizeFilename(raw) {
  const name = path.basename(String(raw)).replace(/[\u0000-\u001f<>:"|?*\\/]/g, '_').trim();
  if (!name || name.startsWith('.') || name.length > 200) throw new HttpError(400, 'Invalid filename');
  if (!SPLAT_EXTS.includes(ext(name)) && !PREVIEW_EXTS.includes(ext(name)) && !isMeta(name)) {
    throw new HttpError(415, `Unsupported file type: ${ext(name) || name}`);
  }
  return name;
}

export class Store {
  constructor(dataDir, maxUploadBytes) {
    this.root = path.join(dataDir, 'collections');
    this.maxUploadBytes = maxUploadBytes;
    this.locks = new Map();
  }

  async init() {
    await fs.mkdir(this.root, { recursive: true });
  }

  dir(id) {
    if (!ID_RE.test(id)) throw new HttpError(400, 'Invalid collection id');
    return path.join(this.root, id);
  }

  /** Serialize writes per collection. */
  async withLock(id, fn) {
    const prev = this.locks.get(id) || Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    this.locks.set(id, run);
    try {
      return await run;
    } finally {
      if (this.locks.get(id) === run) this.locks.delete(id);
    }
  }

  async readManifest(id) {
    try {
      return JSON.parse(await fs.readFile(path.join(this.dir(id), 'manifest.json'), 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT') throw new HttpError(404, 'Collection not found');
      throw e;
    }
  }

  async writeManifest(id, manifest) {
    const file = path.join(this.dir(id), 'manifest.json');
    const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(manifest, null, 2));
    await fs.rename(tmp, file);
  }

  async list() {
    const out = [];
    for (const e of await fs.readdir(this.root, { withFileTypes: true })) {
      if (!e.isDirectory() || !ID_RE.test(e.name)) continue;
      try {
        const m = await this.readManifest(e.name);
        out.push({ id: e.name, name: m.name || e.name, assetCount: (m.assets || []).length });
      } catch {
        /* skip broken dirs */
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async create(name) {
    name = String(name || '').trim();
    if (!name || name.length > 120) throw new HttpError(400, 'Collection name required (max 120 chars)');
    const base = slugify(name) || 'collection';
    let id = base;
    for (let n = 2; ; n++) {
      try {
        await fs.mkdir(this.dir(id));
        break;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        id = `${base}-${n}`.slice(0, 64);
      }
    }
    await fs.mkdir(path.join(this.dir(id), 'assets'));
    await this.writeManifest(id, { version: MANIFEST_VERSION, name, assets: [] });
    return { id, name, assetCount: 0 };
  }

  async rename(id, name) {
    name = String(name || '').trim();
    if (!name || name.length > 120) throw new HttpError(400, 'Collection name required (max 120 chars)');
    return this.withLock(id, async () => {
      const m = await this.readManifest(id);
      m.name = name;
      await this.writeManifest(id, m);
      return { id, name, assetCount: m.assets.length };
    });
  }

  async remove(id) {
    await this.readManifest(id);
    await this.withLock(id, () => fs.rm(this.dir(id), { recursive: true, force: true }));
  }

  /** Attach previews/metadata files to the asset with the same base name. */
  _attach(manifest) {
    const files = manifest._files || [];
    for (const a of manifest.assets) {
      const b = baseName(path.basename(a.path));
      const prev = files.find((f) => PREVIEW_EXTS.includes(ext(f)) && baseName(f) === b);
      const meta = files.find((f) => isMeta(f) && baseName(f) === b);
      if (prev) a.preview = `assets/${prev}`;
      if (meta) a.metadata = `assets/${meta}`;
    }
  }

  async _reconcile(id, manifest) {
    const files = await fs.readdir(path.join(this.dir(id), 'assets'));
    manifest._files = files;
    this._attach(manifest);
    delete manifest._files;
  }

  async putAsset(id, filename, stream) {
    const name = sanitizeFilename(filename);
    await this.readManifest(id);
    const assetsDir = path.join(this.dir(id), 'assets');
    const tmp = path.join(assetsDir, `.upload-${randomBytes(6).toString('hex')}.tmp`);
    let size = 0;
    const max = this.maxUploadBytes;
    let tooLarge = false;
    // On overflow, keep draining (discarding) the body so the client can
    // still receive the 413 instead of a dropped connection.
    const limiter = new Transform({
      transform(chunk, _enc, cb) {
        size += chunk.length;
        if (size > max) tooLarge = true;
        cb(null, tooLarge ? undefined : chunk);
      },
    });
    try {
      await pipeline(stream, limiter, createWriteStream(tmp));
      if (tooLarge) throw new HttpError(413, 'File too large');
      if (size === 0) throw new HttpError(400, 'Empty upload');
      return await this.withLock(id, async () => {
        const manifest = await this.readManifest(id);
        await fs.rename(tmp, path.join(assetsDir, name));
        const rel = `assets/${name}`;
        if (SPLAT_EXTS.includes(ext(name))) {
          const entry = manifest.assets.find((a) => a.path === rel);
          if (entry) entry.size = size;
          else manifest.assets.push({ path: rel, name, size });
        }
        await this._reconcile(id, manifest);
        await this.writeManifest(id, manifest);
        return { path: rel, size };
      });
    } catch (e) {
      await fs.rm(tmp, { force: true });
      throw e;
    }
  }

  async deleteAssets(id, paths) {
    if (!Array.isArray(paths) || !paths.length) throw new HttpError(400, 'paths required');
    return this.withLock(id, async () => {
      const manifest = await this.readManifest(id);
      const removed = [];
      for (const p of paths) {
        const entry = manifest.assets.find((a) => a.path === p);
        if (!entry) continue;
        for (const rel of [entry.path, entry.preview, typeof entry.metadata === 'string' ? entry.metadata : null]) {
          if (!rel) continue;
          const abs = path.join(this.dir(id), rel);
          if (!abs.startsWith(path.join(this.dir(id), 'assets') + path.sep)) continue;
          await fs.rm(abs, { force: true });
        }
        manifest.assets = manifest.assets.filter((a) => a !== entry);
        removed.push(p);
      }
      await this.writeManifest(id, manifest);
      return { removed };
    });
  }

  async rescan(id, apply) {
    return this.withLock(id, async () => {
      const manifest = await this.readManifest(id);
      const files = (await fs.readdir(path.join(this.dir(id), 'assets'))).filter((f) => !f.startsWith('.'));
      const known = new Set(manifest.assets.map((a) => a.path));
      const added = [];
      for (const f of files) {
        if (!SPLAT_EXTS.includes(ext(f)) || known.has(`assets/${f}`)) continue;
        const st = await fs.stat(path.join(this.dir(id), 'assets', f));
        added.push({ path: `assets/${f}`, name: f, size: st.size });
      }
      const missing = manifest.assets.map((a) => a.path).filter((p) => !files.includes(path.basename(p)));
      if (apply) {
        manifest.assets.push(...added);
        await this._reconcile(id, manifest);
        await this.writeManifest(id, manifest);
      }
      return { added, missing, totalFiles: files.filter((f) => SPLAT_EXTS.includes(ext(f))).length };
    });
  }
}
