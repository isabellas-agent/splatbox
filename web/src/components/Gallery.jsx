/**
 * Gallery start screen.
 *
 * Shows every collection hosted by the splatbox server as a grid of scans.
 * Clicking a card opens that scan in the viewer (and VR); collections can be
 * created, renamed, deleted and uploaded to from here.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faCube,
  faFolderOpen,
  faFolderPlus,
  faPen,
  faPlug,
  faRotate,
  faTrash,
  faUpload,
  faXmark,
  faMagnifyingGlass,
} from '@fortawesome/free-solid-svg-icons';
import {
  getSourcesArray,
  onSourceChange,
  registerSource,
  unregisterSource,
  syncServerSources,
  createServerCollection,
  deleteServerCollection,
  renameServerCollection,
} from '../storage/index.js';
import { getFormatAccept } from '../formats/index.js';

const formatBytes = (bytes) => {
  if (!bytes && bytes !== 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let value = bytes;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[i]}`;
};

const extOf = (name) => (name.match(/\.([^.]+)$/)?.[1] || '').toUpperCase();
const stripExt = (name) => name.replace(/\.[^.]+$/, '');

const isServerSource = (s) => s?.type === 'server-collection';

function AssetCard({ asset, onOpen }) {
  const [imgFailed, setImgFailed] = useState(false);
  const showImage = asset.preview && !imgFailed;
  return (
    <button class="gallery-card" onClick={onOpen} title={`Open ${asset.name}`}>
      <div class="gallery-card__thumb">
        {showImage ? (
          <img src={asset.preview} alt="" loading="lazy" onError={() => setImgFailed(true)} />
        ) : (
          <FontAwesomeIcon icon={faCube} className="gallery-card__placeholder" />
        )}
        <span class="gallery-card__badge">{extOf(asset.name)}</span>
      </div>
      <div class="gallery-card__meta">
        <span class="gallery-card__name">{stripExt(asset.name)}</span>
        {asset.size ? <span class="gallery-card__size">{formatBytes(asset.size)}</span> : null}
      </div>
    </button>
  );
}

function CollectionSection({ source, assets, query, onOpenAsset, onChanged }) {
  const uploadRef = useRef(null);
  const [busy, setBusy] = useState(null);
  const accept = useMemo(() => getFormatAccept(), []);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return assets
      .map((asset, index) => ({ asset, index }))
      .filter(({ asset }) => !q || asset.name.toLowerCase().includes(q));
  }, [assets, query]);

  const handleUpload = useCallback(async (event) => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (!files.length) return;
    setBusy(`Uploading ${files.length} file${files.length === 1 ? '' : 's'}…`);
    try {
      const result = await source.uploadAssets(files);
      if (result?.failed?.length) {
        alert(`Upload failed for:\n${result.failed.map((f) => `${f.name}: ${f.error}`).join('\n')}`);
      }
    } finally {
      setBusy(null);
      onChanged();
    }
  }, [source, onChanged]);

  const handleRename = useCallback(async () => {
    const name = prompt('Rename collection', source.name);
    if (!name || name === source.name) return;
    try {
      await renameServerCollection(source.collectionId, name);
      source.name = name;
      source.config.name = name;
      onChanged();
    } catch (err) {
      alert(`Rename failed: ${err.message}`);
    }
  }, [source, onChanged]);

  const handleDelete = useCallback(async () => {
    if (!confirm(`Delete collection "${source.name}" and all ${assets.length} file(s) in it? This cannot be undone.`)) return;
    try {
      await deleteServerCollection(source.collectionId);
      unregisterSource(source.id);
      onChanged();
    } catch (err) {
      alert(`Delete failed: ${err.message}`);
    }
  }, [source, assets.length, onChanged]);

  if (query && visible.length === 0) return null;

  return (
    <section class="gallery-section">
      <header class="gallery-section__header">
        <h2>
          {source.name}
          <span class="gallery-section__count">{assets.length}</span>
        </h2>
        <div class="gallery-section__actions">
          {busy && <span class="gallery-busy">{busy}</span>}
          <button class="gallery-btn" onClick={() => uploadRef.current?.click()} title="Upload scans to this collection">
            <FontAwesomeIcon icon={faUpload} />
            <span>Upload</span>
          </button>
          <button class="gallery-icon-btn" onClick={handleRename} title="Rename collection">
            <FontAwesomeIcon icon={faPen} />
          </button>
          <button class="gallery-icon-btn danger" onClick={handleDelete} title="Delete collection">
            <FontAwesomeIcon icon={faTrash} />
          </button>
          <input ref={uploadRef} type="file" multiple hidden accept={`${accept},.jpg,.jpeg,.png,.webp,.json`} onChange={handleUpload} />
        </div>
      </header>
      {assets.length === 0 ? (
        <div class="gallery-empty-section">
          No scans yet. Use <b>Upload</b> to add <code>.ply</code>, <code>.sog</code>, <code>.spz</code> or <code>.splat</code> files.
        </div>
      ) : (
        <div class="gallery-grid">
          {visible.map(({ asset, index }) => (
            <AssetCard key={asset.id} asset={asset} onOpen={() => onOpenAsset(source, index)} />
          ))}
        </div>
      )}
    </section>
  );
}

function Gallery({ show, canReturn, onReturn, onOpenAsset, onOpenSource, onPickFiles, onOpenStorage }) {
  const [sources, setSources] = useState(() => getSourcesArray());
  const [assetsBySource, setAssetsBySource] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');

  useEffect(() => onSourceChange(() => setSources(getSourcesArray())), []);

  const serverSources = useMemo(
    () => sources.filter(isServerSource).sort((a, b) => a.name.localeCompare(b.name)),
    [sources],
  );
  const otherSources = useMemo(() => sources.filter((s) => !isServerSource(s)), [sources]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await syncServerSources(registerSource, unregisterSource, getSourcesArray);
    } catch (err) {
      setError(`Could not reach the splatbox server: ${err.message}`);
    }
    const next = {};
    for (const source of getSourcesArray().filter(isServerSource)) {
      try {
        if (!source.isConnected()) await source.connect();
        next[source.id] = await source.listAssets();
      } catch (err) {
        console.warn('[Gallery] Failed to list', source.id, err);
        next[source.id] = [];
      }
    }
    setSources(getSourcesArray());
    setAssetsBySource(next);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (show) refresh();
  }, [show, refresh]);

  const handleNewCollection = useCallback(async () => {
    const name = prompt('Name of the new collection');
    if (!name) return;
    try {
      const created = await createServerCollection(name);
      await refresh();
      setFilter(`server-collection-${created.id}`);
    } catch (err) {
      alert(`Could not create collection: ${err.message}`);
    }
  }, [refresh]);

  const totalScans = Object.values(assetsBySource).reduce((n, list) => n + list.length, 0);
  const shownSources = filter === 'all' ? serverSources : serverSources.filter((s) => s.id === filter);

  if (!show) return null;

  return (
    <div class="gallery-overlay">
      <div class="gallery">
        <header class="gallery-header">
          <div class="gallery-brand">
            <h1 class="gallery-logo">splatbox</h1>
            <span class="gallery-subtitle">
              {serverSources.length} collection{serverSources.length === 1 ? '' : 's'} · {totalScans} scan{totalScans === 1 ? '' : 's'}
            </span>
          </div>
          <div class="gallery-header__actions">
            <label class="gallery-search">
              <FontAwesomeIcon icon={faMagnifyingGlass} />
              <input
                type="search"
                placeholder="Search scans"
                value={query}
                onInput={(e) => setQuery(e.currentTarget.value)}
              />
            </label>
            <button class="gallery-btn primary" onClick={handleNewCollection}>
              <FontAwesomeIcon icon={faFolderPlus} />
              <span>New collection</span>
            </button>
            <button class="gallery-icon-btn" onClick={refresh} title="Refresh">
              <FontAwesomeIcon icon={faRotate} spin={loading} />
            </button>
            {canReturn && (
              <button class="gallery-icon-btn" onClick={onReturn} title="Back to viewer">
                <FontAwesomeIcon icon={faXmark} />
              </button>
            )}
          </div>
        </header>

        {serverSources.length > 0 && (
          <nav class="gallery-filters" aria-label="Collections">
            <button class={`gallery-chip ${filter === 'all' ? 'active' : ''}`} onClick={() => setFilter('all')}>
              All
            </button>
            {serverSources.map((s) => (
              <button
                key={s.id}
                class={`gallery-chip ${filter === s.id ? 'active' : ''}`}
                onClick={() => setFilter(s.id)}
              >
                {s.name}
                <span class="gallery-chip__count">{assetsBySource[s.id]?.length ?? 0}</span>
              </button>
            ))}
          </nav>
        )}

        <main class="gallery-body">
          {error && <div class="gallery-error">{error}</div>}

          {!loading && serverSources.length === 0 && !error && (
            <div class="gallery-empty">
              <FontAwesomeIcon icon={faCube} className="gallery-empty__icon" />
              <p>No collections yet.</p>
              <button class="gallery-btn primary" onClick={handleNewCollection}>
                <FontAwesomeIcon icon={faFolderPlus} />
                <span>Create your first collection</span>
              </button>
            </div>
          )}

          {shownSources.map((source) => (
            <CollectionSection
              key={source.id}
              source={source}
              assets={assetsBySource[source.id] || []}
              query={query}
              onOpenAsset={onOpenAsset}
              onChanged={refresh}
            />
          ))}

          <section class="gallery-section gallery-section--other">
            <header class="gallery-section__header">
              <h2>Other sources</h2>
            </header>
            <div class="gallery-other">
              {otherSources.map((s) => (
                <button key={s.id} class="gallery-btn" onClick={() => onOpenSource(s)} title={`Open ${s.name}`}>
                  <FontAwesomeIcon icon={faFolderOpen} />
                  <span>{s.name}</span>
                </button>
              ))}
              <button class="gallery-btn" onClick={onPickFiles} title="View files from this device without uploading">
                <FontAwesomeIcon icon={faFolderOpen} />
                <span>Open local files</span>
              </button>
              <button class="gallery-btn" onClick={onOpenStorage} title="Connect a local folder or URL list">
                <FontAwesomeIcon icon={faPlug} />
                <span>Connect folder / URL</span>
              </button>
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}

export default Gallery;
