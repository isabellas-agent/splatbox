/**
 * "Default view & gallery preview" dialog.
 *
 * Opened from the viewer toolbar. Saves the current camera pose as the view
 * the scan opens with, renders the gallery thumbnail from that pose and,
 * when a motion is selected, rebuilds the animated gallery preview.
 */

import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCamera, faCheck, faPlay, faTrash, faXmark } from '@fortawesome/free-solid-svg-icons';
import { useStore } from '../store.js';
import {
  GALLERY_AXES,
  GALLERY_MOTIONS,
  GALLERY_MOTION_PRESETS,
  GALLERY_PIVOTS,
  hideOrbitGuide,
  playOrbitPreview,
  showOrbitGuide,
  canSaveScanPresentation,
  clearScanPresentation,
  getScanPresentation,
  saveScanPresentation,
} from '../scanPresentation.js';

const DURATIONS = [
  { value: 4000, label: 'Fast (4 s per loop)' },
  { value: 6000, label: 'Medium (6 s per loop)' },
  { value: 8000, label: 'Slow (8 s per loop)' },
  { value: 12000, label: 'Very slow (12 s per loop)' },
];

const formatSavedAt = (value) => {
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
};

function ScanViewDialog({ onClose }) {
  const assets = useStore((state) => state.assets);
  const currentAssetIndex = useStore((state) => state.currentAssetIndex);
  const addLog = useStore((state) => state.addLog);
  const asset = assets[currentAssetIndex] || null;
  const presentation = useMemo(() => getScanPresentation(asset), [asset]);
  const canSave = canSaveScanPresentation(asset);

  const savedMotion = presentation.gallery?.motion;
  const [motion, setMotion] = useState(savedMotion && savedMotion !== 'none' ? savedMotion : 'orbit');
  const [duration, setDuration] = useState(
    () => presentation.gallery?.duration || GALLERY_MOTION_PRESETS.orbit.duration,
  );
  const [axis, setAxis] = useState(() => presentation.gallery?.axis || 'y');
  const [pivot, setPivot] = useState(() => presentation.gallery?.pivot || 'target');
  const [previewing, setPreviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  // Draw the orbit axis through the pivot in the viewer while choosing it
  useEffect(() => {
    if (motion === 'orbit' && !busy && asset) showOrbitGuide({ axis, pivot });
    else hideOrbitGuide();
  }, [motion, axis, pivot, busy, asset]);
  useEffect(() => () => hideOrbitGuide(), []);

  const preview = useCallback(async () => {
    if (previewing || busy) return;
    setPreviewing(true);
    try {
      await playOrbitPreview({ axis, pivot });
    } finally {
      setPreviewing(false);
    }
  }, [axis, pivot, previewing, busy]);

  const save = useCallback(async () => {
    if (!asset || busy || !canSave) return;
    setBusy(true);
    setError(null);
    try {
      const result = await saveScanPresentation(asset, { motion, duration, axis, pivot, onStage: setStatus });
      setStatus(null);
      addLog(
        result.animation
          ? `Saved default view and ${result.gallery.frames}-frame ${result.gallery.motion} gallery preview for ${asset.name}`
          : `Saved default view for ${asset.name}`,
      );
      onClose();
    } catch (err) {
      setStatus(null);
      setError(err.message || String(err));
      setBusy(false);
    }
  }, [asset, busy, canSave, motion, duration, axis, pivot, addLog, onClose]);

  const clear = useCallback(async () => {
    if (!asset || busy || !canSave) return;
    if (!confirm('Forget the saved default view and turn the gallery animation off?')) return;
    setBusy(true);
    setError(null);
    try {
      await clearScanPresentation(asset);
      addLog(`Cleared default view for ${asset.name}`);
      onClose();
    } catch (err) {
      setError(err.message || String(err));
      setBusy(false);
    }
  }, [asset, busy, canSave, addLog, onClose]);

  const frames = GALLERY_MOTION_PRESETS[motion]?.frames || 0;

  return (
    <div class="gallery-dialog-overlay scan-view-overlay" onClick={() => !busy && onClose()}>
      <div
        class="gallery-dialog scan-view-dialog"
        role="dialog"
        aria-label="Default view and gallery preview"
        onClick={(event) => event.stopPropagation()}
      >
        <header class="gallery-dialog__header">
          <h3>Default view &amp; gallery preview</h3>
          <button class="gallery-icon-btn" onClick={onClose} disabled={busy} title="Close">
            <FontAwesomeIcon icon={faXmark} />
          </button>
        </header>

        <div class="gallery-dialog__body">
          {!asset ? (
            <p>Open a scan first.</p>
          ) : (
            <>
              <p class="scan-view-scan">
                <b>{asset.title || asset.name}</b>
                <span>{presentation.view ? `Saved ${formatSavedAt(presentation.view.savedAt)}` : 'No saved view yet'}</span>
              </p>

              {!canSave && (
                <div class="gallery-error">Only scans hosted on this server can store a default view.</div>
              )}

              <fieldset class="scan-view-fieldset" disabled={busy || !canSave}>
                <legend>Gallery animation</legend>
                <div class="scan-view-options">
                  {GALLERY_MOTIONS.map((option) => (
                    <label class={`scan-view-option ${motion === option.id ? 'is-active' : ''}`} key={option.id}>
                      <input
                        type="radio"
                        name="gallery-motion"
                        value={option.id}
                        checked={motion === option.id}
                        onChange={() => setMotion(option.id)}
                      />
                      <span>
                        <b>{option.label}</b>
                        <small>{option.hint}</small>
                      </span>
                    </label>
                  ))}
                </div>

                {motion === 'orbit' && (
                  <div class="scan-view-orbit">
                    <label class="gallery-field">
                      <span>Rotate around</span>
                      <select value={pivot} onChange={(event) => setPivot(event.currentTarget.value)}>
                        {GALLERY_PIVOTS.map((option) => (
                          <option value={option.id} key={option.id}>{option.label}</option>
                        ))}
                      </select>
                    </label>
                    <label class="gallery-field">
                      <span>Axis</span>
                      <select value={axis} onChange={(event) => setAxis(event.currentTarget.value)}>
                        {GALLERY_AXES.map((option) => (
                          <option value={option.id} key={option.id}>{option.label}</option>
                        ))}
                      </select>
                    </label>
                    <button type="button" class="gallery-btn" onClick={preview} disabled={previewing}>
                      <FontAwesomeIcon icon={faPlay} />
                      <span>{previewing ? 'Previewing…' : 'Preview orbit'}</span>
                    </button>
                    <small class="scan-view-orbit__hint">
                      {GALLERY_PIVOTS.find((p) => p.id === pivot)?.hint} The cyan line in the viewer is the
                      rotation axis, the yellow dot the pivot. Scans exported Z-up need the Z axis.
                    </small>
                  </div>
                )}

                {motion !== 'none' && (
                  <label class="gallery-field">
                    <span>Loop duration</span>
                    <select value={duration} onChange={(event) => setDuration(Number(event.currentTarget.value))}>
                      {DURATIONS.map((option) => (
                        <option value={option.value} key={option.value}>{option.label}</option>
                      ))}
                    </select>
                  </label>
                )}
              </fieldset>

              <p class="gallery-hint">
                The current camera position and orientation become the view this scan opens with (and what
                “reset view” returns to). The thumbnail is rendered from it
                {frames ? `, plus ${frames} frames for the gallery animation` : ''}.
              </p>

              {status && <div class="gallery-busy">{status}</div>}
              {error && <div class="gallery-error">{error}</div>}
            </>
          )}
        </div>

        <footer class="gallery-dialog__actions">
          {canSave && presentation.view && (
            <button class="gallery-btn danger" onClick={clear} disabled={busy}>
              <FontAwesomeIcon icon={faTrash} />
              <span>Clear saved view</span>
            </button>
          )}
          <button class="gallery-btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button class="gallery-btn primary" onClick={save} disabled={busy || !canSave}>
            {busy ? <span class="gallery-btn__spinner" /> : <FontAwesomeIcon icon={motion === 'none' ? faCheck : faCamera} />}
            <span>{busy ? 'Working…' : 'Save view & preview'}</span>
          </button>
        </footer>
      </div>
    </div>
  );
}

export default ScanViewDialog;
