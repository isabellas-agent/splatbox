/**
 * Storage Module Index
 *
 * Re-exports the storage functionality: the server collection source,
 * the in-memory source registry and the asset adapter.
 */

// Types and constants
export { MANIFEST_VERSION, SUPPORTED_MANIFEST_VERSIONS } from './types.js';

// Base class
export { AssetSource } from './AssetSource.js';

// Server collections (the only source type)
export {
  ServerCollectionSource,
  createServerCollectionSource,
  listServerCollections,
  createServerCollection,
  deleteServerCollection,
  renameServerCollection,
  syncServerSources,
} from './ServerCollectionSource.js';

// Source registry
export {
  deleteSource,
  registerSource,
  unregisterSource,
  getSource,
  getAllSources,
  getSourcesArray,
  onSourceChange,
  touchSource,
} from './sourceManager.js';

// Source asset adapter
export {
  adaptRemoteAsset,
  loadAssetFile,
  loadAssetPreview,
  loadAssetMetadata,
  isSourceAsset,
  loadSourceAssets,
  loadAllSourceAssets,
} from './sourceAssetAdapter.js';
