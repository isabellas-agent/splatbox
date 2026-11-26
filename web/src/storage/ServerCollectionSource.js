/**
 * Server Collection Source
 *
 * A collection stored on the splatbox server that served this page.
 * Layout on the server mirrors the manifest-first format:
 *   /files/collections/{id}/manifest.json
 *   /files/collections/{id}/assets/*
 * Writes go through the REST API under /api/collections/{id}.
 */

import { AssetSource } from './AssetSource.js';
import { SUPPORTED_MANIFEST_VERSIONS } from './types.js';
import { getSupportedExtensions } from '../formats/index.js';

const PREVIEW_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];

const getExtension = (filename) => {
  const parts = filename.split('.');
  return parts.length > 1 ? `.${parts.pop().toLowerCase()}` : '';
};

const getFilename = (path) => {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
};

const enc = (p) => p.split('/').map(encodeURIComponent).join('/');

export class ServerCollectionSource extends AssetSource {
  constructor(config) {
    super(config);
    this._manifest = null;
  }

  get collectionId() {
    return this.config.config.collectionId;
  }

  _fileUrl(relative) {
    return `/files/collections/${encodeURIComponent(this.collectionId)}/${enc(relative.replace(/^\/+/, ''))}`;
  }

  _api(path = '') {
    return `/api/collections/${encodeURIComponent(this.collectionId)}${path}`;
  }

  getCapabilities() {
    return {
      canList: true,
      canStream: true,
      canReadMetadata: true,
      canReadPreviews: true,
      persistent: false,
      writable: true,
    };
  }

  async connect() {
    try {
      await this._loadManifest();
      this._connected = true;
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async _loadManifest() {
    const res = await fetch(`${this._fileUrl('manifest.json')}?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Manifest fetch failed: ${res.status}`);
    const manifest = await res.json();
    if (!SUPPORTED_MANIFEST_VERSIONS.includes(manifest.version)) {
      throw new Error(`Unsupported manifest version: ${manifest.version}`);
    }
    this._manifest = manifest;
    if (manifest.name) {
      this.name = manifest.name;
      this.config.name = manifest.name;
    }
    return manifest;
  }

  async listAssets() {
    if (!this._connected) throw new Error('Not connected');
    await this._loadManifest();
    const supported = getSupportedExtensions();
    const assets = [];
    for (const item of this._manifest.assets || []) {
      if (!supported.includes(getExtension(item.path))) continue;
      assets.push({
        id: `${this.id}/${item.path}`,
        name: item.name || getFilename(item.path),
        path: item.path,
        sourceId: this.id,
        sourceType: this.type,
        size: item.size,
        title: item.title || null,
        description: item.description || null,
        tags: Array.isArray(item.tags) ? item.tags : [],
        preview: item.preview ? this._fileUrl(item.preview) : null,
        previewSource: item.preview ? 'remote' : null,
        // Default camera pose and gallery animation, set from the viewer
        view: item.view && typeof item.view === 'object' ? item.view : null,
        gallery: item.gallery && typeof item.gallery === 'object' ? item.gallery : null,
        animation: item.animation ? this._fileUrl(item.animation) : null,
        _metadataPath: typeof item.metadata === 'string' ? item.metadata : null,
        _inlineMetadata: item.metadata && typeof item.metadata === 'object' ? item.metadata : null,
        loaded: false,
      });
    }
    this._assets = assets;
    return assets;
  }

  /** Absolute URL of the scan file (used by Spark to stream large files). */
  getAssetUrl(asset) {
    return new URL(this._fileUrl(asset.path), window.location.href).href;
  }

  async fetchAssetData(asset) {
    const response = await fetch(this._fileUrl(asset.path));
    if (!response.ok) throw new Error(`Failed to fetch asset: ${response.status} ${response.statusText}`);
    return response.arrayBuffer();
  }

  /** Blob straight from the response (no intermediate ArrayBuffer copy). */
  async fetchAssetBlob(asset) {
    const response = await fetch(this._fileUrl(asset.path));
    if (!response.ok) throw new Error(`Failed to fetch asset: ${response.status} ${response.statusText}`);
    return response.blob();
  }

  async fetchAssetStream(asset) {
    const response = await fetch(this._fileUrl(asset.path));
    if (!response.ok) throw new Error(`Failed to fetch asset: ${response.status} ${response.statusText}`);
    return response.body;
  }

  async fetchPreview(asset) {
    return asset.preview || null;
  }

  async fetchMetadata(asset) {
    if (asset._inlineMetadata) return asset._inlineMetadata;
    if (asset._metadataPath) {
      const response = await fetch(this._fileUrl(asset._metadataPath));
      if (response.ok) return response.json();
    }
    return null;
  }

  async rescan({ applyChanges = false } = {}) {
    const res = await fetch(this._api(`/rescan?apply=${applyChanges ? 1 : 0}`), { method: 'POST' });
    if (!res.ok) return { success: false, error: `Rescan failed: ${res.status}` };
    const out = await res.json();
    if (applyChanges) await this.listAssets();
    return { success: true, hasManifest: true, applied: !!applyChanges, ...out };
  }

  async uploadAssets(files) {
    const supported = getSupportedExtensions();
    const results = { uploaded: [], failed: [] };
    for (const file of files) {
      const ext = getExtension(file.name);
      const lower = file.name.toLowerCase();
      if (!supported.includes(ext) && !PREVIEW_EXTENSIONS.includes(ext) && !lower.endsWith('.meta.json') && !lower.endsWith('.metadata.json')) {
        results.failed.push({ name: file.name, error: 'Unsupported file type' });
        continue;
      }
      try {
        const res = await fetch(this._api(`/assets/${encodeURIComponent(file.name)}`), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: file,
        });
        if (!res.ok) {
          const msg = await res.text().catch(() => '');
          results.failed.push({ name: file.name, error: msg || `HTTP ${res.status}` });
          continue;
        }
        const out = await res.json();
        results.uploaded.push({ name: file.name, path: out.path });
      } catch (err) {
        results.failed.push({ name: file.name, error: err.message });
      }
    }
    await this.listAssets();
    return { success: results.failed.length === 0, ...results };
  }

  /**
   * Upload a thumbnail for the asset at `assetPath`. Stored next to it with the
   * same base name so the server attaches it as the asset's preview.
   */
  async uploadPreview(assetPath, blob, ext = 'webp') {
    const base = getFilename(assetPath).replace(/\.[^.]+$/, '');
    const res = await fetch(this._api(`/assets/${encodeURIComponent(`${base}.${ext}`)}`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Splatbox-Background': '1' },
      body: blob,
    });
    if (!res.ok) {
      console.warn(`[ServerCollection] Preview upload failed: ${res.status}`);
      return false;
    }
    return true;
  }

  /**
   * Upload the gallery animation sprite sheet (`<name>.anim.webp`). The server
   * attaches it to the scan with the same base name, like a thumbnail.
   */
  async uploadAnimation(assetPath, blob) {
    const base = getFilename(assetPath).replace(/\.[^.]+$/, '');
    const res = await fetch(this._api(`/assets/${encodeURIComponent(`${base}.anim.webp`)}`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: blob,
    });
    if (!res.ok) {
      console.warn(`[ServerCollection] Animation upload failed: ${res.status}`);
      return false;
    }
    await this.listAssets();
    return true;
  }

  /** Update title/description/tags of one or more scans (see server PATCH /assets). */
  async updateAssetsMeta(paths, patch) {
    const res = await fetch(this._api('/assets'), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths, ...patch }),
    });
    if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
    const out = await res.json();
    await this.listAssets();
    return out;
  }

  /** Move or copy scans to another server collection. */
  async transferAssets(paths, targetCollectionId, mode = 'move') {
    const res = await fetch(this._api('/assets/transfer'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths, target: targetCollectionId, mode }),
    });
    if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
    const out = await res.json();
    await this.listAssets();
    return out;
  }

  async deleteAssets(items) {
    const list = Array.isArray(items) ? items : [items];
    const paths = list
      .map((i) => (typeof i === 'string' ? i : i?.path || i?._remoteAsset?.path))
      .filter(Boolean);
    if (!paths.length) return { success: false, error: 'No valid paths to delete', failed: [] };
    const res = await fetch(this._api('/assets'), {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths }),
    });
    if (!res.ok) return { success: false, error: `Delete failed: ${res.status}`, failed: [] };
    await this.listAssets();
    return { success: true, removed: paths, failed: [] };
  }
}

export const createServerCollectionSource = ({ collectionId, name }) => {
  return new ServerCollectionSource({
    id: `server-collection-${collectionId}`,
    type: 'server-collection',
    name: name || collectionId,
    createdAt: Date.now(),
    lastAccessed: Date.now(),
    isDefault: false,
    config: { collectionId },
  });
};

export const restoreServerCollectionSource = (config) => new ServerCollectionSource(config);

/** Server-side API helpers for collections */
export const listServerCollections = async () => {
  const res = await fetch('/api/collections');
  if (!res.ok) throw new Error(`Failed to list collections: ${res.status}`);
  return res.json();
};

export const createServerCollection = async (name) => {
  const res = await fetch('/api/collections', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
  return res.json();
};

export const deleteServerCollection = async (id) => {
  const res = await fetch(`/api/collections/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
};

export const renameServerCollection = async (id, name) => {
  const res = await fetch(`/api/collections/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
  return res.json();
};

/**
 * Sync registered sources with the server's collections.
 * Server collections are authoritative: they are (re)registered on every start.
 */
export const syncServerSources = async (registerSource, unregisterSource, getSourcesArray) => {
  const collections = await listServerCollections();
  const wanted = new Set(collections.map((c) => `server-collection-${c.id}`));
  for (const s of getSourcesArray()) {
    if (s.type === 'server-collection' && !wanted.has(s.id)) unregisterSource(s.id);
  }
  const existing = new Set(getSourcesArray().map((s) => s.id));
  const added = [];
  for (const c of collections) {
    const id = `server-collection-${c.id}`;
    if (existing.has(id)) continue;
    const src = createServerCollectionSource({ collectionId: c.id, name: c.name });
    const r = await src.connect();
    if (r.success) {
      registerSource(src);
      added.push(src);
    }
  }
  return added;
};

export default ServerCollectionSource;
