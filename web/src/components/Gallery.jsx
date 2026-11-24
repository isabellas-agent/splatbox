/**
 * Gallery start screen.
 *
 * Shows every collection hosted by the splatbox server as a grid of scans.
 * Clicking a card opens that scan in the viewer (and VR). Collections can be
 * created, renamed, deleted and uploaded to; scans can be edited (title,
 * description, tags), and selected in bulk to move, copy, tag or delete.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faCube,
  faFolderOpen,
  faFolderPlus,
  faPen,
  faRotate,
  faTrash,
  faUpload,
  faXmark,
  faMagnifyingGlass,
  faCheck,
  faCopy,
  faArrowRightArrowLeft,
  faTags,
  faListCheck,
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
const parseTags = (text) =>
  [...new Set(String(text || '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean))];

export const displayTitle = (asset) => asset?.title || stripExt(asset?.name || '');

const isServerSource = (s) => s?.type === 'server-collection';
const selKey = (sourceId, path) => `${sourceId}|${path}`;

const matchesQuery = (asset, q) => {
  if (!q) return true;
  const hay = [asset.name, asset.title, asset.description, ...(asset.tags || [])].filter(Boolean).join(' ').toLowerCase();
  return hay.includes(q);
};

/** Minimal modal used by the gallery dialogs */
function Dialog({ title, onClose, children, actions }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div class="gallery-dialog-overlay" onClick={onClose}>
      <div class="gallery-dialog" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <header class="gallery-dialog__header">
          <h3>{title}</h3>
          <button class="gallery-icon-btn" onClick={onClose} title="Close">
            <FontAwesomeIcon icon={faXmark} />
          </button>
        </header>
        <div class="gallery-dialog__body">{children}</div>
        <footer class="gallery-dialog__actions">{actions}</footer>
      </div>
    </div>
  );
}

function EditScanDialog({ source, asset, onClose, onSaved }) {
  const [title, setTitle] = useState(asset.title || '');
  const [description, setDescription] = useState(asset.description || '');
  const [tags, setTags] = useState((asset.tags || []).join(', '));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await source.updateAssetsMeta([asset.path], { title, description, tags: parseTags(tags) });
      onSaved();
      onClose();
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };

  return (
    <Dialog
      title={`Edit ${asset.name}`}
      onClose={onClose}
      actions={(
        <>
          <button class="gallery-btn" onClick={onClose}>Cancel</button>
          <button class="gallery-btn primary" onClick={save} disabled={saving}>
            <FontAwesomeIcon icon={faCheck} />
            <span>{saving ? 'Saving…' : 'Save'}</span>
          </button>
        </>
      )}
    >
      <label class="gallery-field">
        <span>Title</span>
        <input type="text" maxLength={200} value={title} placeholder={stripExt(asset.name)} onInput={(e) => setTitle(e.currentTarget.value)} />
      </label>
      <label class="gallery-field">
        <span>Description</span>
        <textarea rows={4} maxLength={5000} value={description} onInput={(e) => setDescription(e.currentTarget.value)} />
      </label>
      <label class="gallery-field">
        <span>Tags <small>(comma separated)</small></span>
        <input type="text" value={tags} placeholder="indoor, 2026, family" onInput={(e) => setTags(e.currentTarget.value)} />
      </label>
      {error && <div class="gallery-error">{error}</div>}
    </Dialog>
  );
}

function TransferDialog({ mode, count, collections, onClose, onConfirm }) {
  const [target, setTarget] = useState(collections[0]?.collectionId || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const verb = mode === 'copy' ? 'Copy' : 'Move';
  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm(target);
      onClose();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={`${verb} ${count} scan${count === 1 ? '' : 's'}`}
      onClose={onClose}
      actions={(
        <>
          <button class="gallery-btn" onClick={onClose}>Cancel</button>
          <button class="gallery-btn primary" onClick={confirm} disabled={busy || !target}>
            <FontAwesomeIcon icon={mode === 'copy' ? faCopy : faArrowRightArrowLeft} />
            <span>{busy ? `${verb === 'Copy' ? 'Copying' : 'Moving'}…` : verb}</span>
          </button>
        </>
      )}
    >
      {collections.length === 0 ? (
        <p>There is no other collection to {mode} to. Create one first.</p>
      ) : (
        <label class="gallery-field">
          <span>Target collection</span>
          <select value={target} onChange={(e) => setTarget(e.currentTarget.value)}>
            {collections.map((s) => (
              <option key={s.id} value={s.collectionId}>{s.name}</option>
            ))}
          </select>
        </label>
      )}
      <p class="gallery-hint">Scans already in the target collection are left alone. Thumbnails, title, description and tags come along; name clashes get a numbered suffix.</p>
      {error && <div class="gallery-error">{error}</div>}
    </Dialog>
  );
}

function TagDialog({ count, onClose, onConfirm }) {
  const [add, setAdd] = useState('');
  const [remove, setRemove] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm(parseTags(add), parseTags(remove));
      onClose();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={`Tag ${count} scan${count === 1 ? '' : 's'}`}
      onClose={onClose}
      actions={(
        <>
          <button class="gallery-btn" onClick={onClose}>Cancel</button>
          <button class="gallery-btn primary" onClick={confirm} disabled={busy || (!add.trim() && !remove.trim())}>
            <FontAwesomeIcon icon={faTags} />
            <span>{busy ? 'Saving…' : 'Apply'}</span>
          </button>
        </>
      )}
    >
      <label class="gallery-field">
        <span>Add tags <small>(comma separated)</small></span>
        <input type="text" value={add} placeholder="indoor, 2026" onInput={(e) => setAdd(e.currentTarget.value)} />
      </label>
      <label class="gallery-field">
        <span>Remove tags</span>
        <input type="text" value={remove} onInput={(e) => setRemove(e.currentTarget.value)} />
      </label>
      {error && <div class="gallery-error">{error}</div>}
    </Dialog>
  );
}

function AssetCard({ asset, selected, selecting, onOpen, onToggleSelect, onEdit }) {
  const [imgFailed, setImgFailed] = useState(false);
  const showImage = asset.preview && !imgFailed;
  const handleClick = (e) => {
    if (selecting || e.ctrlKey || e.metaKey || e.shiftKey) onToggleSelect();
    else onOpen();
  };
  return (
    <div class={`gallery-card ${selected ? 'is-selected' : ''}`}>
      <button class="gallery-card__main" onClick={handleClick} title={selecting ? 'Select' : `Open ${asset.name}`}>
        <div class="gallery-card__thumb">
          {showImage ? (
            <img src={asset.preview} alt="" loading="lazy" onError={() => setImgFailed(true)} />
          ) : (
            <FontAwesomeIcon icon={faCube} className="gallery-card__placeholder" />
          )}
          <span class="gallery-card__badge">{extOf(asset.name)}</span>
        </div>
        <div class="gallery-card__meta">
          <span class="gallery-card__name">{displayTitle(asset)}</span>
          {asset.size ? <span class="gallery-card__size">{formatBytes(asset.size)}</span> : null}
        </div>
        {asset.description && <div class="gallery-card__desc">{asset.description}</div>}
        {asset.tags?.length > 0 && (
          <div class="gallery-card__tags">
            {asset.tags.map((t) => <span key={t} class="gallery-tag">{t}</span>)}
          </div>
        )}
      </button>
      <button
        class={`gallery-card__check ${selected ? 'checked' : ''}`}
        onClick={onToggleSelect}
        title={selected ? 'Deselect' : 'Select'}
        aria-pressed={selected}
      >
        <FontAwesomeIcon icon={faCheck} />
      </button>
      <button class="gallery-card__edit" onClick={onEdit} title="Edit title, description and tags">
        <FontAwesomeIcon icon={faPen} />
      </button>
    </div>
  );
}

function CollectionSection({ source, assets, query, tagFilter, selection, selecting, onToggleSelect, onSelectAll, onEdit, onOpenAsset, onChanged }) {
  const uploadRef = useRef(null);
  const [busy, setBusy] = useState(null);
  const accept = useMemo(() => getFormatAccept(), []);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return assets
      .map((asset, index) => ({ asset, index }))
      .filter(({ asset }) => matchesQuery(asset, q) && (!tagFilter || asset.tags?.includes(tagFilter)));
  }, [assets, query, tagFilter]);

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

  if ((query || tagFilter) && visible.length === 0) return null;

  const allSelected = visible.length > 0 && visible.every(({ asset }) => selection.has(selKey(source.id, asset.path)));

  return (
    <section class="gallery-section">
      <header class="gallery-section__header">
        <h2>
          {source.name}
          <span class="gallery-section__count">{assets.length}</span>
        </h2>
        <div class="gallery-section__actions">
          {busy && <span class="gallery-busy">{busy}</span>}
          {selecting && visible.length > 0 && (
            <button class="gallery-btn" onClick={() => onSelectAll(source, visible.map(({ asset }) => asset), !allSelected)}>
              <FontAwesomeIcon icon={faListCheck} />
              <span>{allSelected ? 'Select none' : 'Select all'}</span>
            </button>
          )}
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
            <AssetCard
              key={asset.id}
              asset={asset}
              selected={selection.has(selKey(source.id, asset.path))}
              selecting={selecting}
              onOpen={() => onOpenAsset(source, index)}
              onToggleSelect={() => onToggleSelect(source, asset)}
              onEdit={() => onEdit(source, asset)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function Gallery({ show, canReturn, onReturn, onOpenAsset, onPickFiles }) {
  const [sources, setSources] = useState(() => getSourcesArray());
  const [assetsBySource, setAssetsBySource] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('all');
  const [tagFilter, setTagFilter] = useState(null);
  const [query, setQuery] = useState('');
  const [selectMode, setSelectMode] = useState(false);
  // key -> { sourceId, path }
  const [selection, setSelection] = useState(() => new Map());
  const [dialog, setDialog] = useState(null);

  useEffect(() => onSourceChange(() => setSources(getSourcesArray())), []);

  const serverSources = useMemo(
    () => sources.filter(isServerSource).sort((a, b) => a.name.localeCompare(b.name)),
    [sources],
  );

  const allTags = useMemo(() => {
    const counts = new Map();
    for (const list of Object.values(assetsBySource)) {
      for (const a of list) for (const t of a.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [assetsBySource]);

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
    // Drop selections that no longer exist
    setSelection((prev) => {
      const out = new Map();
      for (const [k, v] of prev) {
        if (next[v.sourceId]?.some((a) => a.path === v.path)) out.set(k, v);
      }
      return out;
    });
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

  const toggleSelect = useCallback((source, asset) => {
    setSelectMode(true);
    setSelection((prev) => {
      const next = new Map(prev);
      const k = selKey(source.id, asset.path);
      if (next.has(k)) next.delete(k);
      else next.set(k, { sourceId: source.id, path: asset.path });
      return next;
    });
  }, []);

  const selectAll = useCallback((source, assets, on) => {
    setSelection((prev) => {
      const next = new Map(prev);
      for (const a of assets) {
        const k = selKey(source.id, a.path);
        if (on) next.set(k, { sourceId: source.id, path: a.path });
        else next.delete(k);
      }
      return next;
    });
  }, []);

  const exitSelect = useCallback(() => {
    setSelectMode(false);
    setSelection(new Map());
  }, []);

  /** Group the selection by collection: [[source, paths[]], ...] */
  const selectionGroups = useCallback(() => {
    const groups = new Map();
    for (const { sourceId, path } of selection.values()) {
      if (!groups.has(sourceId)) groups.set(sourceId, []);
      groups.get(sourceId).push(path);
    }
    return [...groups.entries()]
      .map(([id, paths]) => [serverSources.find((s) => s.id === id), paths])
      .filter(([s]) => s);
  }, [selection, serverSources]);

  const runTransfer = useCallback(async (mode, targetCollectionId) => {
    const failures = [];
    for (const [source, paths] of selectionGroups()) {
      if (source.collectionId === targetCollectionId) continue;
      try {
        await source.transferAssets(paths, targetCollectionId, mode);
      } catch (err) {
        failures.push(`${source.name}: ${err.message}`);
      }
    }
    if (mode === 'move' || !failures.length) setSelection(new Map());
    await refresh();
    if (failures.length) throw new Error(failures.join('\n'));
  }, [selectionGroups, refresh]);

  const runTag = useCallback(async (addTags, removeTags) => {
    for (const [source, paths] of selectionGroups()) {
      await source.updateAssetsMeta(paths, { addTags, removeTags });
    }
    await refresh();
  }, [selectionGroups, refresh]);

  const runDelete = useCallback(async () => {
    const count = selection.size;
    if (!confirm(`Delete ${count} scan${count === 1 ? '' : 's'} (with thumbnails)? This cannot be undone.`)) return;
    const failures = [];
    for (const [source, paths] of selectionGroups()) {
      const r = await source.deleteAssets(paths);
      if (!r?.success) failures.push(`${source.name}: ${r?.error || 'failed'}`);
    }
    setSelection(new Map());
    await refresh();
    if (failures.length) alert(`Delete failed:\n${failures.join('\n')}`);
  }, [selection, selectionGroups, refresh]);

  const totalScans = Object.values(assetsBySource).reduce((n, list) => n + list.length, 0);
  const shownSources = filter === 'all' ? serverSources : serverSources.filter((s) => s.id === filter);
  const selectedSourceIds = new Set([...selection.values()].map((v) => v.sourceId));
  const transferTargets = serverSources.filter((s) => !(selectedSourceIds.size === 1 && selectedSourceIds.has(s.id)));

  if (!show) return null;

  return (
    <div class={`gallery-overlay ${selectMode ? 'is-selecting' : ''}`}>
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
            <button
              class={`gallery-btn ${selectMode ? 'active' : ''}`}
              onClick={() => (selectMode ? exitSelect() : setSelectMode(true))}
              title="Select several scans to move, copy, tag or delete"
            >
              <FontAwesomeIcon icon={faListCheck} />
              <span>{selectMode ? 'Done' : 'Select'}</span>
            </button>
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

        {allTags.length > 0 && (
          <nav class="gallery-filters gallery-filters--tags" aria-label="Tags">
            <FontAwesomeIcon icon={faTags} className="gallery-filters__icon" />
            {allTags.map(([t, n]) => (
              <button
                key={t}
                class={`gallery-chip gallery-chip--tag ${tagFilter === t ? 'active' : ''}`}
                onClick={() => setTagFilter(tagFilter === t ? null : t)}
              >
                {t}
                <span class="gallery-chip__count">{n}</span>
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
              tagFilter={tagFilter}
              selection={selection}
              selecting={selectMode}
              onToggleSelect={toggleSelect}
              onSelectAll={selectAll}
              onEdit={(src, asset) => setDialog({ type: 'edit', source: src, asset })}
              onOpenAsset={onOpenAsset}
              onChanged={refresh}
            />
          ))}

          <section class="gallery-section gallery-section--other">
            <div class="gallery-other">
              <button class="gallery-btn" onClick={onPickFiles} title="View files from this device without uploading them">
                <FontAwesomeIcon icon={faFolderOpen} />
                <span>Open local files</span>
              </button>
            </div>
          </section>
        </main>
      </div>

      {selectMode && (
        <div class="gallery-bulkbar" role="toolbar" aria-label="Selection actions">
          <span class="gallery-bulkbar__count">{selection.size} selected</span>
          <button class="gallery-btn" disabled={!selection.size} onClick={() => setDialog({ type: 'transfer', mode: 'move' })}>
            <FontAwesomeIcon icon={faArrowRightArrowLeft} />
            <span>Move to…</span>
          </button>
          <button class="gallery-btn" disabled={!selection.size} onClick={() => setDialog({ type: 'transfer', mode: 'copy' })}>
            <FontAwesomeIcon icon={faCopy} />
            <span>Copy to…</span>
          </button>
          <button class="gallery-btn" disabled={!selection.size} onClick={() => setDialog({ type: 'tag' })}>
            <FontAwesomeIcon icon={faTags} />
            <span>Tag…</span>
          </button>
          <button class="gallery-btn danger" disabled={!selection.size} onClick={runDelete}>
            <FontAwesomeIcon icon={faTrash} />
            <span>Delete</span>
          </button>
          <button class="gallery-icon-btn" onClick={exitSelect} title="Clear selection">
            <FontAwesomeIcon icon={faXmark} />
          </button>
        </div>
      )}

      {dialog?.type === 'edit' && (
        <EditScanDialog source={dialog.source} asset={dialog.asset} onClose={() => setDialog(null)} onSaved={refresh} />
      )}
      {dialog?.type === 'transfer' && (
        <TransferDialog
          mode={dialog.mode}
          count={selection.size}
          collections={transferTargets}
          onClose={() => setDialog(null)}
          onConfirm={(target) => runTransfer(dialog.mode, target)}
        />
      )}
      {dialog?.type === 'tag' && (
        <TagDialog count={selection.size} onClose={() => setDialog(null)} onConfirm={runTag} />
      )}
    </div>
  );
}

export default Gallery;
