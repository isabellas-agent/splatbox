/**
 * Connect to Storage Dialog
 *
 * Modal dialog for adding new collections backed by Local Folder or server storage.
 */

import { useState, useCallback, useEffect, useMemo } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faFolder,
  faCloud,
  faTimes,
  faCheck,
  faSpinner,
  faExclamationTriangle,
  faChevronRight,
  faChevronDown,
  faPlus,
  faLink,
  faQuestion,
  faFolderOpen,
} from '@fortawesome/free-solid-svg-icons';
import {
  SOURCE_TIERS,
  isFileSystemAccessSupported,
  createLocalFolderSource,
  createPublicUrlSource,
  createServerCollectionSource,
  createServerCollection,
  registerSource,
  saveSource,
} from '../storage/index.js';
import { getAssetList } from '../assetManager.js';
import { getSupportedExtensions } from '../formats/index.js';

const ICONS = {
  folder: faFolder,
  cloud: faCloud,
  link: faLink,
};

function TierCard({ type, selected, onSelect, disabled }) {
  const info = SOURCE_TIERS[type];
  if (!info) return null;

  return (
    <button
      class={`storage-tier-card ${selected ? 'selected' : ''} ${disabled ? 'disabled' : ''}`}
      onClick={() => !disabled && onSelect(type)}
      disabled={disabled}
    >
      <div class="tier-icon">
        <FontAwesomeIcon icon={ICONS[info.icon] || faFolder} />
      </div>
      <div class="tier-content">
        <div class="tier-header">
          <h4>{info.label}</h4>
          {/* {info.tier === 3 && <span class="tier-badge">Recommended</span>} */}
        </div>
        <p class="tier-description">{info.description}</p>
        {disabled && (
          <p class="tier-disabled-reason">
            <FontAwesomeIcon icon={faExclamationTriangle} />
            {' '}Not supported in this browser
          </p>
        )}
      </div>
      <FontAwesomeIcon icon={faChevronRight} class="tier-arrow" />
    </button>
  );
}

function LocalFolderForm({ onConnect, onBack }) {
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState(null);
  const [collectionName, setCollectionName] = useState('');

  const handleSelect = useCallback(async () => {
    setStatus('connecting');
    setError(null);

    try {
      const source = createLocalFolderSource();
      const result = await source.connect(true);

      if (result.success) {
        if (collectionName.trim()) {
          source.name = collectionName.trim();
          source.config.name = collectionName.trim();
        }
        registerSource(source);
        setStatus('success');
        setTimeout(() => onConnect(source), 500);
      } else {
        setError(result.error || 'Failed to connect');
        setStatus('error');
      }
    } catch (err) {
      setError(err.message);
      setStatus('error');
    }
  }, [onConnect, collectionName]);

  return (
    <div class="storage-form">
      <button class="back-button" onClick={onBack}>
        {'Back'}
      </button>

      <h3>Create local collection</h3>

      <div class="form-field">
        <label>Collection name</label>
        <input
          type="text"
          placeholder="My local splats"
          value={collectionName}
          onInput={(e) => setCollectionName(e.target.value)}
        />
      </div>

      <div class="form-info">
        <p>Select a folder containing splat files (.ply, .sog).</p>
        <ul class="feature-list">
          <li><FontAwesomeIcon icon={faCheck} /> Works offline after selection</li>
          <li><FontAwesomeIcon icon={faCheck} /> Fast loading from local disk</li>
          <li><FontAwesomeIcon icon={faCheck} /> Folder access persists across sessions</li>
          <li><FontAwesomeIcon icon={faCheck} /> Preview images matched automatically</li>
        </ul>
      </div>

      {error && (
        <div class="form-error">
          <FontAwesomeIcon icon={faExclamationTriangle} />
          {' '}{error}
        </div>
      )}

      <button
        class="primary-button"
        onClick={handleSelect}
        disabled={status === 'connecting'}
      >
        {status === 'connecting' ? (
          <>
            <FontAwesomeIcon icon={faSpinner} spin />
            {' '}Selecting...
          </>
        ) : status === 'success' ? (
          <>
            <FontAwesomeIcon icon={faCheck} />
            {' '}Connected!
          </>
        ) : (
          <>
            <FontAwesomeIcon icon={faFolder} />
            {' '}Select Folder
          </>
        )}
      </button>

      <p class="form-note">
        Your browser will ask for permission to access the folder.
        The app only reads files and never uploads data.
      </p>
    </div>
  );
}

function UrlCollectionForm({ onConnect, onBack, initialSource, editMode = false, onSaveEdit }) {
  const initialUrls = useMemo(() => {
    if (editMode && initialSource?.config?.config?.assetPaths?.length) {
      return [...initialSource.config.config.assetPaths];
    }
    return [''];
  }, [editMode, initialSource]);
  const [urls, setUrls] = useState(initialUrls);
  const [collectionName, setCollectionName] = useState(
    editMode ? (initialSource?.name || initialSource?.config?.name || '') : ''
  );
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState(null);

  useEffect(() => {
    if (editMode && initialSource) {
      setUrls(initialSource?.config?.config?.assetPaths?.length ? [...initialSource.config.config.assetPaths] : ['']);
      setCollectionName(initialSource?.name || initialSource?.config?.name || '');
      setStatus('idle');
      setError(null);
    }
  }, [editMode, initialSource]);

  const updateUrl = useCallback((index, value) => {
    setUrls((prev) => prev.map((u, i) => (i === index ? value : u)));
  }, []);

  const addRow = useCallback(() => {
    setUrls((prev) => [...prev, '']);
  }, []);

  const removeRow = useCallback((index) => {
    setUrls((prev) => (prev.length === 1 ? [''] : prev.filter((_, i) => i !== index)));
  }, []);

  const isValidUrl = useCallback((url) => {
    if (!url.trim()) return false;
    try {
      const parsed = new URL(url.trim());
      return parsed.protocol === 'https:' || parsed.protocol === 'http:';
    } catch {
      return false;
    }
  }, []);

  const allUrlsValid = useMemo(() => {
    const nonEmpty = urls.filter(u => u.trim());
    return nonEmpty.length > 0 && nonEmpty.every(u => isValidUrl(u));
  }, [urls, isValidUrl]);

  const handleConnect = useCallback(async () => {
    const cleaned = urls.map((u) => u.trim()).filter(Boolean);
    if (cleaned.length === 0) {
      setError('Add at least one URL');
      return;
    }

    // Basic URL validation
    for (const u of cleaned) {
      try {
        const parsed = new URL(u);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
          throw new Error('URL must be http/https');
        }
      } catch (err) {
        setError(`Invalid URL: ${u}`);
        return;
      }
    }

    setStatus('connecting');
    setError(null);

    try {
      if (editMode && initialSource) {
        const updatedName = collectionName.trim() || initialSource.name;
        initialSource.name = updatedName;
        initialSource.config.name = updatedName;
        initialSource.config.config.assetPaths = cleaned;
        initialSource.config.config.customName = Boolean(collectionName.trim());

        await saveSource(initialSource.toJSON());
        registerSource(initialSource);
        await initialSource.listAssets();

        setStatus('success');
        const finish = onSaveEdit || onConnect;
        if (finish) {
          setTimeout(() => finish(initialSource), 300);
        }
        return;
      }

      const source = createPublicUrlSource({
        assetPaths: cleaned,
        name: collectionName.trim() || 'URL collection',
      });

      const result = await source.connect();

      if (result.success) {
        registerSource(source);
        await saveSource(source.toJSON());
        setStatus('success');
        setTimeout(() => onConnect(source), 500);
      } else {
        setError(result.error || 'Failed to connect');
        setStatus('error');
      }
    } catch (err) {
      setError(err.message);
      setStatus('error');
    }
  }, [urls, collectionName, onConnect, editMode, initialSource, onSaveEdit]);

  return (
    <div class="storage-form">
      {!editMode && (
        <button class="back-button" onClick={onBack}>
          {'Back'}
        </button>
      )}

      <h3>{editMode ? 'Edit URL collection' : 'Create URL collection'}</h3>

      <div class="form-info">
        <ul class="feature-list">
          <li><FontAwesomeIcon icon={faCheck} /> No setup or credentials required</li>
          <li><FontAwesomeIcon icon={faCheck} /> Direct HTTP/HTTPS links only, read-only</li>
          <li><FontAwesomeIcon icon={faCheck} /> Best for quick demos or hosted files</li>
        </ul>
      </div>

      <div class="form-field">
        <label>Collection name</label>
        <input
          type="text"
          placeholder="Public URLs"
          value={collectionName}
          onInput={(e) => setCollectionName(e.target.value)}
        />
      </div>

      <div class="form-field">
        <label>Asset URLs</label>
        <div class="url-list">
          {urls.map((url, index) => {
            const isValid = isValidUrl(url);
            const showInvalid = url.trim() && !isValid;
            return (
              <div class="url-row" key={`url-${index}`}>
                <div class="url-input-wrapper">
                  <input
                    type="url"
                    placeholder="https://example.com/scene.sog"
                    value={url}
                    onInput={(e) => updateUrl(index, e.target.value)}
                    class={showInvalid ? 'invalid' : ''}
                  />
                </div>
                <button
                  class="url-remove-btn"
                  onClick={() => removeRow(index)}
                  title="Remove URL"
                  type="button"
                >
                  <FontAwesomeIcon icon={faTimes} />
                </button>
              </div>
            );
          })}
        </div>
        <button class="add-url-btn" onClick={addRow} type="button">
          <FontAwesomeIcon icon={faPlus} />
          <span>Add another URL</span>
        </button>
        <span class="field-hint">Provide direct links to .sog/.ply files. Invalid URLs show a red outline.</span>
      </div>

      {error && (
        <div class="form-error">
          <FontAwesomeIcon icon={faExclamationTriangle} />
          {' '}{error}
        </div>
      )}

      <button
        class="primary-button save-collection-btn"
        onClick={handleConnect}
        disabled={status === 'connecting' || !allUrlsValid}
      >
        {status === 'connecting' ? (
          <>
            <FontAwesomeIcon icon={faSpinner} spin />
            <span>{editMode ? 'Saving changes...' : 'Saving collection...'}</span>
          </>
        ) : status === 'success' ? (
          <>
            <FontAwesomeIcon icon={faCheck} />
            <span>{editMode ? 'Updated!' : 'Connected!'}</span>
          </>
        ) : (
          <>
            <FontAwesomeIcon icon={faCheck} />
            <span>{editMode ? 'Save changes' : 'Save URL collection'}</span>
          </>
        )}
      </button>
    </div>
  );
}

/**
 * Expandable FAQ item
 */
function FaqItem({ question, children }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div class="faq-item">
      <button 
        class="faq-question" 
        onClick={() => setExpanded(!expanded)}
        type="button"
      >
        <FontAwesomeIcon icon={faQuestion} className="faq-icon" />
        <span>{question}</span>
        <FontAwesomeIcon icon={expanded ? faChevronDown : faChevronRight} className="faq-chevron" />
      </button>
      {expanded && (
        <div class="faq-answer">
          {children}
        </div>
      )}
    </div>
  );
}

/**
 * Existing collection list item
 */
function ExistingCollectionItem({ collection, onSelect, isLoading, selected }) {
  return (
    <button 
      class={`existing-collection-item ${selected ? 'selected' : ''}`}
      onClick={() => onSelect(collection)}
      disabled={isLoading}
    >
      <div class="collection-info">
        <FontAwesomeIcon icon={faFolderOpen} className="collection-icon" />
        <div class="collection-details">
          <span class="collection-name">{collection.name}</span>
          <span class="collection-meta">
            {collection.id} · {collection.assetCount} asset{collection.assetCount !== 1 ? 's' : ''}
            {collection.hasManifest && <span class="manifest-badge">manifest</span>}
          </span>
        </div>
      </div>
      <FontAwesomeIcon icon={faChevronRight} className="collection-arrow" />
    </button>
  );
}

function ServerCollectionForm({ onConnect, onBack }) {
  const [collectionName, setCollectionName] = useState('');
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState(null);

  const handleCreate = useCallback(async () => {
    const name = collectionName.trim();
    if (!name) {
      setError('Enter a collection name.');
      return;
    }
    setStatus('connecting');
    setError(null);
    try {
      const created = await createServerCollection(name);
      const source = createServerCollectionSource({ collectionId: created.id, name: created.name });
      const result = await source.connect();
      if (!result.success) throw new Error(result.error || 'Failed to connect');
      registerSource(source);
      setStatus('success');
      setTimeout(() => onConnect(source), 300);
    } catch (err) {
      setError(err.message);
      setStatus('error');
    }
  }, [collectionName, onConnect]);

  return (
    <div class="storage-form">
      <button class="back-button" onClick={onBack}>Back</button>
      <h3>New collection</h3>
      <p class="dialog-subtitle">Collections group your splats. Upload files to a collection after creating it.</p>
      <div class="form-group">
        <label>Collection name</label>
        <input
          type="text"
          placeholder="e.g. Travel scans"
          value={collectionName}
          onInput={(e) => setCollectionName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
        />
      </div>
      {error && (
        <div class="form-error">
          <FontAwesomeIcon icon={faExclamationTriangle} /> {error}
        </div>
      )}
      <button class="primary" onClick={handleCreate} disabled={status === 'connecting'}>
        {status === 'connecting' ? <><FontAwesomeIcon icon={faSpinner} spin /> Creating...</> : 'Create collection'}
      </button>
    </div>
  );
}


function ConnectStorageDialog({ isOpen, onClose, onConnect, editSource, onEditComplete }) {
  const [selectedTier, setSelectedTier] = useState(editSource?.type || null);
  const localSupported = isFileSystemAccessSupported();

  useEffect(() => {
    if (editSource) {
      setSelectedTier(editSource.type);
    }
  }, [editSource]);

  const handleConnect = useCallback((source) => {
    onConnect?.(source);
    onClose();
    setSelectedTier(editSource?.type || null);
  }, [onConnect, onClose, editSource?.type]);

  const handleBack = useCallback(() => {
    setSelectedTier(editSource?.type || null);
  }, [editSource?.type]);

  const handleClose = useCallback(() => {
    onClose();
    setSelectedTier(null);
  }, [onClose]);

  if (!isOpen) return null;

  const isEditMode = Boolean(editSource && editSource.type === 'public-url');

  const content = (
    <div class="modal-overlay storage-dialog-overlay" onClick={handleClose}>
      <div class="modal-content storage-dialog" onClick={(e) => e.stopPropagation()}>
        <button class="modal-close" onClick={handleClose}>
          <FontAwesomeIcon icon={faTimes} />
        </button>

        {selectedTier === null && !isEditMode ? (
          <>
            <h2>Create a collection</h2>
            <p class="dialog-subtitle">
              Pick where your collection lives. Files stay in your storage; manifests load fast in the viewer.
            </p>

            <div class="storage-tiers">
              <TierCard
                type="local-folder"
                selected={false}
                onSelect={setSelectedTier}
                disabled={!localSupported}
              />
              <TierCard
                type="server-collection"
                selected={false}
                onSelect={setSelectedTier}
              />
              <TierCard
                type="public-url"
                selected={false}
                onSelect={setSelectedTier}
              />
            </div>
          </>
        ) : selectedTier === 'local-folder' ? (
          <LocalFolderForm onConnect={handleConnect} onBack={handleBack} />
        ) : selectedTier === 'server-collection' ? (
          <ServerCollectionForm onConnect={handleConnect} onBack={handleBack} />
        ) : selectedTier === 'public-url' ? (
          <UrlCollectionForm 
            onConnect={handleConnect} 
            onBack={handleBack}
            initialSource={isEditMode ? editSource : null}
            editMode={isEditMode}
            onSaveEdit={onEditComplete || onConnect}
          />
        ) : null}
      </div>
    </div>
  );

  return createPortal(content, document.body);
}

export default ConnectStorageDialog;
