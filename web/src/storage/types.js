/**
 * Storage Source Types & Interfaces
 * 
 * Defines the asset source abstraction used by server collections.
 * Each adapter must implement the AssetSource interface to work with the render pipeline.
 */

/**
 * @typedef {'server-collection'} SourceType
 */

/**
 * @typedef {Object} SourceCapabilities
 * @property {boolean} canList - Can enumerate available assets
 * @property {boolean} canStream - Supports streaming/range requests
 * @property {boolean} canReadMetadata - Can read colocated metadata files
 * @property {boolean} canReadPreviews - Can read colocated preview images
 * @property {boolean} persistent - Connection persists across sessions
 * @property {boolean} writable - Can write metadata back to source (future)
 */

/**
 * @typedef {Object} SourceConfig
 * @property {string} id - Unique identifier for this source
 * @property {SourceType} type - Type of storage source
 * @property {string} name - User-friendly display name
 * @property {number} createdAt - Timestamp when connection was created
 * @property {number} lastAccessed - Timestamp of last access
 * @property {boolean} [isDefault] - Marks the default collection to auto-load
 * @property {Object} config - Type-specific configuration
 */

/**
 * @typedef {Object} RemoteAssetDescriptor
 * @property {string} id - Unique identifier
 * @property {string} name - Display name (filename)
 * @property {string} path - Path relative to source root
 * @property {string} sourceId - ID of the parent source
 * @property {SourceType} sourceType - Type of the parent source
 * @property {number} [size] - File size in bytes (if known)
 * @property {string} [preview] - Preview image URL or data URL
 * @property {string} [previewSource] - 'remote' | 'indexeddb' | 'generated'
 * @property {Object} [metadata] - Colocated metadata (camera data, etc.)
 * @property {boolean} loaded - Whether asset has been loaded
 */

/**
 * @typedef {Object} AssetManifest
 * @property {number} version - Manifest schema version
 * @property {string} [name] - Collection name
 * @property {ManifestAsset[]} assets - List of assets
 */

/**
 * @typedef {Object} ManifestAsset
 * @property {string} path - Asset path relative to manifest
 * @property {string} [name] - Display name (defaults to filename)
 * @property {number} [size] - File size in bytes
 * @property {string} [preview] - Preview image path relative to manifest
 * @property {Object} [metadata] - Inline metadata or path to metadata file
 */

/**
 * Server collection layout (manifest-first):
 * $DATA_DIR/
 * └── collections/{collectionId}/
 *     ├── manifest.json          // source of truth
 *     └── assets/
 *         ├── scene1.ply
 *         ├── scene1.preview.jpg // optional
 *         ├── scene1.meta.json   // optional
 *         └── ...
 *
 * manifest.json schema:
 * {
 *   "version": 1,
 *   "name": "My Collection",
 *   "assets": [
 *     {
 *       "path": "assets/scene1.ply",
 *       "name": "Scene 1",
 *       "size": 15000000,
 *       "preview": "assets/scene1.preview.jpg",
 *       "metadata": { ... } // or "metadata": "assets/scene1.meta.json"
 *     }
 *   ]
 * }
 */

// Validation constants
export const MANIFEST_VERSION = 1;
export const SUPPORTED_MANIFEST_VERSIONS = [1];
