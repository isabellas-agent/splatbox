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


const MAX_TAGS = 50;

function cleanText(v, max, field) {
  if (v === null) return '';
  if (typeof v !== 'string') throw new HttpError(400, `${field} must be a string`);
  const t = v.trim();
  if (t.length > max) throw new HttpError(400, `${field} too long (max ${max})`);
  return t;
}

function cleanTags(v) {
  if (!Array.isArray(v)) throw new HttpError(400, 'tags must be an array of strings');
  const out = [];
  for (const raw of v) {
    if (typeof raw !== 'string') throw new HttpError(400, 'tags must be an array of strings');
    const t = raw.trim().replace(/\s+/g, ' ').toLowerCase();
    if (!t) continue;
    if (t.length > 40) throw new HttpError(400, 'tag too long (max 40)');
    if (!out.includes(t)) out.push(t);
  }
  if (out.length > MAX_TAGS) throw new HttpError(400, `too many tags (max ${MAX_TAGS})`);
  return out;
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

  /**
   * Update per-scan metadata. `title`/`description` replace the values (empty
   * string clears them); `tags` replaces the tag list; `addTags`/`removeTags`
   * edit it (bulk tagging).
   */
  async updateAssets(id, body = {}) {
    const { paths } = body;
    if (!Array.isArray(paths) || !paths.length) throw new HttpError(400, 'paths required');
    const patch = {};
    if (body.title !== undefined) patch.title = cleanText(body.title, 200, 'title');
    if (body.description !== undefined) patch.description = cleanText(body.description, 5000, 'description');
    const tags = body.tags !== undefined ? cleanTags(body.tags) : null;
    const addTags = body.addTags !== undefined ? cleanTags(body.addTags) : [];
    const removeTags = new Set(body.removeTags !== undefined ? cleanTags(body.removeTags) : []);
    return this.withLock(id, async () => {
      const manifest = await this.readManifest(id);
      const updated = [];
      for (const p of paths) {
        const entry = manifest.assets.find((a) => a.path === p);
        if (!entry) continue;
        for (const [k, v] of Object.entries(patch)) {
          if (v) entry[k] = v;
          else delete entry[k];
        }
        let next = tags ?? entry.tags ?? [];
        next = [...next, ...addTags].filter((t) => !removeTags.has(t));
        next = [...new Set(next)].slice(0, MAX_TAGS);
        if (next.length) entry.tags = next;
        else delete entry.tags;
        updated.push(entry);
      }
      if (!updated.length) throw new HttpError(404, 'No matching assets');
      await this.writeManifest(id, manifest);
      return { updated };
    });
  }

  /** Move or copy scans (with their preview/metadata files) to another collection. */
  async transferAssets(id, body = {}) {
    const { paths, target } = body;
    const mode = body.mode || 'move';
    if (!Array.isArray(paths) || !paths.length) throw new HttpError(400, 'paths required');
    if (!['move', 'copy'].includes(mode)) throw new HttpError(400, 'mode must be move or copy');
    if (typeof target !== 'string' || target === id) throw new HttpError(400, 'target must be another collection');
    this.dir(target); // validates id
    // Lock both collections in a stable order to avoid deadlocks.
    const [first, second] = [id, target].sort();
    return this.withLock(first, () => this.withLock(second, async () => {
      const src = await this.readManifest(id);
      const dst = await this.readManifest(target);
      const srcAssets = path.join(this.dir(id), 'assets');
      const dstAssets = path.join(this.dir(target), 'assets');
      const taken = new Set((await fs.readdir(dstAssets)).map((f) => f.toLowerCase()));
      const transferred = [];
      for (const p of paths) {
        const entry = src.assets.find((a) => a.path === p);
        if (!entry) continue;
        const fileName = path.basename(entry.path);
        const extension = path.extname(fileName);
        const stem = fileName.slice(0, -extension.length);
        // Pick a base name that is free for the scan and its companion files
        let newStem = stem;
        const companions = [entry.preview, typeof entry.metadata === 'string' ? entry.metadata : null]
          .filter(Boolean)
          .map((rel) => path.basename(rel));
        const renameCompanion = (f, s) => s + f.slice(baseName(f).length);
        for (let n = 2; ; n++) {
          const names = [newStem + extension, ...companions.map((f) => renameCompanion(f, newStem))];
          if (names.every((f) => !taken.has(f.toLowerCase()))) break;
          newStem = `${stem}-${n}`;
        }
        const moves = [[fileName, newStem + extension], ...companions.map((f) => [f, renameCompanion(f, newStem)])];
        for (const [from, to] of moves) {
          const a = path.join(srcAssets, from);
          const b = path.join(dstAssets, to);
          if (mode === 'copy') await fs.copyFile(a, b, fs.constants.COPYFILE_EXCL);
          else await fs.rename(a, b);
          taken.add(to.toLowerCase());
        }
        const copy = { ...entry, path: `assets/${newStem}${extension}`, name: `${newStem}${extension}` };
        delete copy.preview;
        delete copy.metadata;
        dst.assets.push(copy);
        if (mode === 'move') src.assets = src.assets.filter((a) => a !== entry);
        transferred.push({ from: p, to: copy.path });
      }
      if (!transferred.length) throw new HttpError(404, 'No matching assets');
      await this._reconcile(target, dst);
      await this.writeManifest(target, dst);
      if (mode === 'move') await this.writeManifest(id, src);
      return { mode, target, transferred };
    }));
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
