/**
 * Camera settings: VR entry, 6DoF navigation mode and speed, FOV,
 * background color, axis swaps and recenter.
 */

import { useEffect, useCallback } from 'preact/hooks';
import { useStore, BACKGROUND_COLORS } from '../store';
import { camera, controls, defaultCamera, defaultControls, requestRender, THREE, currentMesh } from '../viewer';
import { applyAxisSwaps, resetViewWithImmersive } from '../cameraUtils';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronDown, faEye, faEyeSlash } from '@fortawesome/free-solid-svg-icons';
import { enterVrSession } from '../vrMode';

/**
 * Updates orbit controls speed based on current FOV.
 * Slower controls at narrower FOV for precision, faster at wider FOV.
 * @param {number} fov - Current field of view in degrees
 */
export const updateControlSpeedsForFov = (fov) => {
  if (!controls || !defaultCamera || !defaultControls) return;
  const fovScale = THREE.MathUtils.clamp(fov / defaultCamera.fov, 0.05, 2.0);
  controls.rotateSpeed = Math.max(0.02, defaultControls.rotateSpeed * fovScale);
  controls.zoomSpeed = Math.max(0.05, defaultControls.zoomSpeed * fovScale);
  controls.panSpeed = Math.max(0.05, defaultControls.panSpeed * fovScale);
};

/** Set the camera FOV (no dolly compensation: the camera stays where it is). */
export const setCameraFov = (fov) => {
  if (!camera || !Number.isFinite(fov)) return;
  camera.fov = fov;
  camera.updateProjectionMatrix();
  updateControlSpeedsForFov(fov);
  controls?.update();
  requestRender();
};

function CameraControls() {
  const fov = useStore((state) => state.fov);
  const setFov = useStore((state) => state.setFov);
  const viewerFovSlider = useStore((state) => state.viewerFovSlider);
  const toggleViewerFovSlider = useStore((state) => state.toggleViewerFovSlider);
  const cameraSettingsExpanded = useStore((state) => state.cameraSettingsExpanded);
  const toggleCameraSettingsExpanded = useStore((state) => state.toggleCameraSettingsExpanded);
  const vrSupported = useStore((state) => state.vrSupported);
  const vrSessionActive = useStore((state) => state.vrSessionActive);
  const hasAssetLoaded = useStore((state) => state.fileInfo?.name && state.fileInfo.name !== '-');
  const navMode = useStore((state) => state.navMode);
  const setNavMode = useStore((state) => state.setNavMode);
  const moveSpeed = useStore((state) => state.moveSpeed);
  const setMoveSpeed = useStore((state) => state.setMoveSpeed);
  const bgColor = useStore((state) => state.bgColor);
  const setBgColor = useStore((state) => state.setBgColor);
  const swapX = useStore((state) => state.swapX);
  const swapY = useStore((state) => state.swapY);
  const swapZ = useStore((state) => state.swapZ);
  const setSwapX = useStore((state) => state.setSwapX);
  const setSwapY = useStore((state) => state.setSwapY);
  const setSwapZ = useStore((state) => state.setSwapZ);

  const handleFovChange = (e) => {
    const newFov = Number(e.target.value);
    if (!Number.isFinite(newFov)) return;
    setFov(newFov);
    setCameraFov(newFov);
  };

  // Apply axis swaps when toggles change or mesh changes
  useEffect(() => {
    if (currentMesh) {
      applyAxisSwaps(currentMesh);
      requestRender();
    }
  }, [swapX, swapY, swapZ, currentMesh]);

  const handleRecenter = useCallback(() => {
    resetViewWithImmersive();
  }, []);

  return (
    <div class="settings-group">
      <button
        class="group-toggle"
        aria-expanded={cameraSettingsExpanded}
        onClick={toggleCameraSettingsExpanded}
      >
        <span class="settings-eyebrow">Camera Settings</span>
        <FontAwesomeIcon icon={faChevronDown} className="chevron" />
      </button>

      <div
        class="group-content"
        style={{ display: cameraSettingsExpanded ? 'flex' : 'none' }}
      >
        {vrSupported && hasAssetLoaded && (
          <div class="control-row">
            <button
              class={`secondary enter-vr-btn ${vrSessionActive ? 'vr-active' : ''}`}
              onClick={() => enterVrSession()}
            >
              {vrSessionActive ? 'Exit VR' : 'Enter VR'}
            </button>
          </div>
        )}

        {/* Navigation mode */}
        <div class="control-row">
          <span class="control-label">Navigation</span>
          <div class="segmented" role="radiogroup" aria-label="Navigation mode">
            <button
              class={navMode === 'orbit' ? 'is-active' : ''}
              role="radio"
              aria-checked={navMode === 'orbit'}
              onClick={() => setNavMode('orbit')}
              title="Drag rotates around a pivot (double-click a splat to set it); wheel zooms to the cursor"
            >
              Orbit
            </button>
            <button
              class={navMode === 'fly' ? 'is-active' : ''}
              role="radio"
              aria-checked={navMode === 'fly'}
              onClick={() => setNavMode('fly')}
              title="Drag looks around from where you are; wheel moves forward/back"
            >
              Fly
            </button>
          </div>
        </div>

        <div class="control-row">
          <span class="control-label">Move speed</span>
          <div class="control-track">
            <input
              type="range"
              min="-2"
              max="2"
              step="0.1"
              value={Math.log2(moveSpeed)}
              onInput={(e) => setMoveSpeed(Math.round(2 ** Number(e.target.value) * 100) / 100)}
            />
            <span class="control-value">{moveSpeed.toFixed(2)}×</span>
          </div>
        </div>

        <div class="nav-help">
          <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> move · <kbd>E</kbd>/<kbd>Q</kbd> up/down ·
          {' '}<kbd>Shift</kbd> fast · <kbd>F</kbd> orbit/fly · right-drag pan · double-click sets the pivot
        </div>

        {/* FOV control */}
        <div class="control-row">
          <span class="control-label fov-label">
            FOV
            <button
              type="button"
              class={`fov-toggle-btn ${viewerFovSlider ? 'is-on' : 'is-off'}`}
              onClick={toggleViewerFovSlider}
              title={viewerFovSlider ? 'Hide viewer FOV slider' : 'Show viewer FOV slider'}
              aria-pressed={viewerFovSlider}
            >
              <FontAwesomeIcon icon={viewerFovSlider ? faEye : faEyeSlash} />
            </button>
          </span>
          <div class="control-track">
            <input type="range" min="20" max="120" step="1" value={fov} onInput={handleFovChange} />
            <span class="control-value">{Math.round(fov)}°</span>
          </div>
        </div>

        {/* Background color */}
        <div class="control-row">
          <span class="control-label">Background</span>
          <div class="bg-swatches" role="radiogroup" aria-label="Background color">
            {BACKGROUND_COLORS.map((c) => (
              <button
                key={c.id}
                class={`bg-swatch ${bgColor === c.id ? 'is-active' : ''}`}
                style={{ background: c.value }}
                role="radio"
                aria-checked={bgColor === c.id}
                aria-label={c.label}
                title={c.label}
                onClick={() => setBgColor(c.id)}
              />
            ))}
          </div>
        </div>

        {hasAssetLoaded && (
          <div class="control-row">
            <span class="control-label">Swap axes</span>
            <div class="control-switches">
              <label class="axis-swap-label">
                <input type="checkbox" checked={swapX} onChange={(e) => setSwapX(e.target.checked)} />
                <span class="axis-swap-text">X</span>
              </label>
              <label class="axis-swap-label">
                <input type="checkbox" checked={swapY} onChange={(e) => setSwapY(e.target.checked)} />
                <span class="axis-swap-text">Y</span>
              </label>
              <label class="axis-swap-label">
                <input type="checkbox" checked={swapZ} onChange={(e) => setSwapZ(e.target.checked)} />
                <span class="axis-swap-text">Z</span>
              </label>
            </div>
          </div>
        )}

        <div class="settings-footer">
          <button class="secondary" onClick={handleRecenter} title="Back to the start (or saved default) view">
            Recenter view
          </button>
        </div>
      </div>
    </div>
  );
}

export default CameraControls;
