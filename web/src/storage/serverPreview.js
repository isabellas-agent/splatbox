/**
 * Persist browser-captured thumbnails to the splatbox server.
 *
 * The server attaches an image to the scan with the same base name
 * (scene.ply + scene.webp), so uploading the capture once makes the
 * thumbnail show up in the gallery on every device.
 */
import { getSource } from './sourceManager.js';

const EXT_BY_TYPE = {
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

const uploaded = new Set();

export const uploadPreviewToServer = async (asset, blob, format) => {
  try {
    if (!asset?.sourceId || !blob) return false;
    const source = getSource(asset.sourceId);
    if (source?.type !== 'server-collection' || typeof source.uploadPreview !== 'function') return false;
    const path = asset._remoteAsset?.path || asset.path;
    if (!path || uploaded.has(`${asset.sourceId}/${path}`)) return false;
    // Already has a server-side preview
    if (asset._remoteAsset?.preview) return false;
    uploaded.add(`${asset.sourceId}/${path}`);
    const ext = EXT_BY_TYPE[format || blob.type] || 'webp';
    return await source.uploadPreview(path, blob, ext);
  } catch (err) {
    console.warn('[Preview] Failed to upload preview to server:', err);
    return false;
  }
};
