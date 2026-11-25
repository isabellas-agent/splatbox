/**
 * Main App component.
 * Root component that initializes the Three.js viewer and
 * orchestrates the main layout (viewer + side panel/mobile sheet).
 */

import { useEffect, useState, useCallback, useRef } from 'preact/hooks';
import { useStore } from '../store';
import Viewer from './Viewer';
import Gallery from './Gallery';
import SidePanel from './SidePanel';
import MobileSheet from './MobileSheet';
import AssetSidebar from './AssetSidebar';
import AssetNavigation from './AssetNavigation';
import ScanViewDialog from './ScanViewDialog';
import { initViewer, startRenderLoop, currentMesh, camera, controls, defaultCamera, defaultControls, dollyZoomBaseDistance, dollyZoomBaseFov, requestRender, THREE } from '../viewer';
import { resize, loadFromStorageSource, loadNextAsset, loadPrevAsset, handleMultipleFiles, loadAssetByIndex } from '../fileLoader';
import { resetViewWithImmersive } from '../cameraUtils';
import { enableImmersiveMode, disableImmersiveMode, setImmersiveSensitivityMultiplier, setTouchPanEnabled, syncImmersiveBaseline } from '../immersiveMode';
import { setupFullscreenHandler, moveElementsToFullscreen } from '../fullscreenHandler';
import useOutsideClick from '../utils/useOutsideClick';
import useSwipe from '../utils/useSwipe';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCamera, faRotateRight, faTableCellsLarge } from '@fortawesome/free-solid-svg-icons';
import { faExpand, faCompress } from '@fortawesome/free-solid-svg-icons';
import { initVrSupport } from '../vrMode';
import { getFormatAccept } from '../formats/index';


const updateControlSpeedsForFov = (fov) => {
  if (!controls) return;
  const fovScale = THREE.MathUtils.clamp(fov / defaultCamera.fov, 0.05, 2.0);
  controls.rotateSpeed = Math.max(0.02, defaultControls.rotateSpeed * fovScale * 0.45);
  controls.zoomSpeed = Math.max(0.05, defaultControls.zoomSpeed * fovScale * 0.8);
  controls.panSpeed = Math.max(0.05, defaultControls.panSpeed * fovScale * 0.8);
};

function App() {
  // Store state
  const panelOpen = useStore((state) => state.panelOpen);
  const isMobile = useStore((state) => state.isMobile);
  const isPortrait = useStore((state) => state.isPortrait);
  const setMobileState = useStore((state) => state.setMobileState);
  const togglePanel = useStore((state) => state.togglePanel);
  const assets = useStore((state) => state.assets);
  const currentAssetIndex = useStore((state) => state.currentAssetIndex);
  const setCurrentAssetIndex = useStore((state) => state.setCurrentAssetIndex);
  const setAssets = useStore((state) => state.setAssets);
  const toggleAssetSidebar = useStore((state) => state.toggleAssetSidebar);
  const addLog = useStore((state) => state.addLog);
  const focusSettingActive = useStore((state) => state.focusSettingActive);
  const fov = useStore((state) => state.fov);
  const setFov = useStore((state) => state.setFov);
  const viewerFovSlider = useStore((state) => state.viewerFovSlider);
  const immersiveMode = useStore((state) => state.immersiveMode);
  const setImmersiveMode = useStore((state) => state.setImmersiveMode);
  const immersiveSensitivity = useStore((state) => state.immersiveSensitivity);
  
  // Local state for viewer initialization
  const [viewerReady, setViewerReady] = useState(false);
  // Gallery (start screen) visibility
  const [galleryOpen, setGalleryOpen] = useState(true);
  // "Default view & gallery preview" dialog
  const [scanViewOpen, setScanViewOpen] = useState(false);
  const activeSourceId = useStore((state) => state.activeSourceId);
  
  // Track mesh state
  const [hasMesh, setHasMesh] = useState(false);
  const hasMeshRef = useRef(false);

  // File input for "Open local files"
  const fileInputRef = useRef(null);

  // Fullscreen state
  const [isFullscreen, setIsFullscreen] = useState(false);
  const controlsRef = useRef(null);
  const bottomControlsRef = useRef(null);
  const swipeTargetRef = useRef(null);

  // Outside click handler to close side panel
  useOutsideClick(
    togglePanel,
    ['.side', '.mobile-sheet', '.panel-toggle', '.bottom-page-btn', '.bottom-controls'],
    panelOpen && !focusSettingActive
  );

  // Setup fullscreen handler - re-run when controls mount
  useEffect(() => {
    const viewerEl = document.getElementById('viewer');
    if (!viewerEl) return;

    return setupFullscreenHandler(viewerEl, controlsRef.current, setIsFullscreen);
  }, [hasMesh]); // Re-run when hasMesh changes (when controls appear/disappear)

  // Ensure fullscreen UI elements are re-parented after orientation changes
  // Use requestAnimationFrame to wait for React to render the new SidePanel/MobileSheet
  useEffect(() => {
    const viewerEl = document.getElementById('viewer');
    if (!viewerEl) return;
    if (document.fullscreenElement !== viewerEl) return;

    const frameId = requestAnimationFrame(() => {
      moveElementsToFullscreen(viewerEl, controlsRef.current);
    });
    return () => cancelAnimationFrame(frameId);
  }, [isMobile, isPortrait, isFullscreen]);

  /**
   * Track mesh loading state with stability to prevent flickering.
   * When mesh disappears, wait before updating state to avoid flicker during asset transitions.
   * When mesh appears, update immediately for responsive UI.
   */
  useEffect(() => {
    let timeout = null;
    
    const checkMesh = () => {
      const meshPresent = !!currentMesh;
      
      // Clear any pending timeout
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      
      if (meshPresent !== hasMeshRef.current) {
        if (meshPresent) {
          // Mesh appeared - update immediately
          hasMeshRef.current = true;
          setHasMesh(true);
        } else {
          // Mesh disappeared - wait before updating to avoid flicker during transitions
          timeout = setTimeout(() => {
            hasMeshRef.current = false;
            setHasMesh(false);
          }, 300);
        }
      }
    };
    
    // Check immediately and set up interval to poll
    checkMesh();
    const interval = setInterval(checkMesh, 100);
    
    return () => {
      clearInterval(interval);
      if (timeout) clearTimeout(timeout);
    };
  }, []);

  /**
   * Handles reset view - uses shared function that handles immersive mode.
   */
  const handleResetView = useCallback(() => {
    resetViewWithImmersive();
  }, []);

  /**
   * Handles swipe gestures on bottom controls for asset navigation.
   */
  const handleSwipe = useCallback(({ dir }) => {
    if (assets.length <= 1) return;
    
    if (dir === 'left') {
      loadNextAsset();
    } else if (dir === 'right') {
      loadPrevAsset();
    }
  }, [assets.length]);

  // Setup swipe detection on bottom controls
  useSwipe(swipeTargetRef, {
    direction: 'horizontal',
    threshold: 40,
    onSwipe: handleSwipe,
  });

  const handleToggleFullscreen = useCallback(async () => {
    // Use the viewer element itself for fullscreen so the canvas expands
    const viewerEl = document.getElementById('viewer');
    if (!viewerEl) return;

    try {
      if (document.fullscreenElement === viewerEl) {
        await document.exitFullscreen();
      } else {
        await viewerEl.requestFullscreen();
      }
    } catch (err) {
      console.warn('Fullscreen toggle failed:', err);
    }
  }, []);

  const handleOverlayFovChange = useCallback((event) => {
    const newFov = Number(event.target.value);
    if (!Number.isFinite(newFov) || !camera || !controls) return;

    setFov(newFov);

    if (dollyZoomBaseDistance && dollyZoomBaseFov) {
      const baseTan = Math.tan(THREE.MathUtils.degToRad(dollyZoomBaseFov / 2));
      const newTan = Math.tan(THREE.MathUtils.degToRad(newFov / 2));
      const newDistance = dollyZoomBaseDistance * (baseTan / newTan);

      const direction = new THREE.Vector3()
        .subVectors(camera.position, controls.target)
        .normalize();
      camera.position.copy(controls.target).addScaledVector(direction, newDistance);
    }

    camera.fov = newFov;
    camera.updateProjectionMatrix();
    updateControlSpeedsForFov(newFov);
    controls.update();
    if (immersiveMode) {
      syncImmersiveBaseline();
    }
    requestRender();
  }, [setFov, immersiveMode]);

  const handleImmersiveToggle = useCallback(async () => {
    if (immersiveMode) {
      disableImmersiveMode();
      setImmersiveMode(false);
      addLog('Immersive mode disabled');
      return;
    }

    setTouchPanEnabled(true);
    setImmersiveSensitivityMultiplier(immersiveSensitivity);
    const success = await enableImmersiveMode();
    if (success) {
      setImmersiveMode(true);
      addLog('Immersive mode enabled - tilt device to orbit');
    } else {
      setImmersiveMode(false);
      addLog('Could not enable immersive mode');
    }
  }, [immersiveMode, setImmersiveMode, addLog, immersiveSensitivity]);

  /**
   * Title card actions: file picker
   */
  const formatAccept = getFormatAccept();

  const handlePickFile = useCallback(() => {
    (async () => {
      fileInputRef.current?.click();
    })();
  }, []);

  const handleFileChange = useCallback(async (event) => {
    const files = event.target.files;
    if (files && files.length > 0) {
      setGalleryOpen(false);
      await handleMultipleFiles(Array.from(files));
      event.target.value = '';
    }
  }, []);

  /**
   * Gallery actions: open a scan from a collection in the viewer.
   * Reuses the loaded asset list when the collection is already active.
   */
  const handleOpenAsset = useCallback(async (source, index) => {
    setGalleryOpen(false);
    try {
      if (source.id === activeSourceId && assets.length > 0) {
        await loadAssetByIndex(index);
      } else {
        await loadFromStorageSource(source, { startIndex: index });
      }
    } catch (err) {
      addLog('Failed to open scan: ' + (err?.message || err));
    }
  }, [activeSourceId, assets.length, addLog]);

  /**
   * Detects mobile device and orientation.
   * Uses orientationchange event and matchMedia for reliable mobile detection.
   */
  useEffect(() => {
    const updateMobileState = () => {
      const mobile = Math.min(window.innerWidth, window.innerHeight) <= 768;
      // Prefer matchMedia for orientation as it's more reliable on mobile
      const portraitQuery = window.matchMedia?.('(orientation: portrait)');
      const portrait = portraitQuery ? portraitQuery.matches : window.innerHeight > window.innerWidth;
      setMobileState(mobile, portrait);
    };
    
    updateMobileState();

    // Listen to resize as fallback
    window.addEventListener('resize', updateMobileState);

    // Dedicated orientation change event for mobile devices
    window.addEventListener('orientationchange', updateMobileState);

    // matchMedia change listener for orientation (most reliable)
    const portraitQuery = window.matchMedia?.('(orientation: portrait)');
    portraitQuery?.addEventListener?.('change', updateMobileState);

    return () => {
      window.removeEventListener('resize', updateMobileState);
      window.removeEventListener('orientationchange', updateMobileState);
      portraitQuery?.removeEventListener?.('change', updateMobileState);
    };
  }, [setMobileState]);

  /**
   * Initialize Three.js viewer on mount.
   * Sets up renderer, camera, controls, and render loop.
   */
  useEffect(() => {
    const viewerEl = document.getElementById('viewer');
    if (!viewerEl) return;
    
    initViewer(viewerEl);
    startRenderLoop();
    void initVrSupport(viewerEl);
    setViewerReady(true);
    
    // Handle window resize
    window.addEventListener('resize', resize);
    resize();
    
    return () => {
      window.removeEventListener('resize', resize);
    };
  }, []);


  // Nothing loaded (e.g. last scan removed): go back to the gallery
  useEffect(() => {
    if (assets.length === 0) {
      setGalleryOpen(true);
    }
  }, [assets.length]);

  return (
    <div class={`page ${panelOpen ? 'panel-open' : ''}`}>
      <AssetSidebar />
      <input 
        ref={fileInputRef}
        type="file" 
        accept={formatAccept} 
        multiple 
        hidden 
        onChange={handleFileChange}
      />
      <Gallery
        show={galleryOpen}
        canReturn={assets.length > 0}
        onReturn={() => setGalleryOpen(false)}
        onOpenAsset={handleOpenAsset}
        onPickFiles={handlePickFile}
      />
        <Viewer viewerReady={viewerReady} />
      {/* Separate swipe target near bottom controls (debug green) */}
      <div class="bottom-swipe-target" ref={swipeTargetRef} />
      {isMobile && isPortrait ? <MobileSheet /> : <SidePanel />}
      {/* Bottom controls container: sidebar index (left), nav (center), fullscreen+reset (right) */}
      <div class="bottom-controls" ref={bottomControlsRef}>
        {/* Left: Asset index button */}
        <div class="bottom-controls-left">
          <button
            class="bottom-page-btn"
            onClick={() => setGalleryOpen(true)}
            title="Back to gallery"
            aria-label="Back to gallery"
          >
            <FontAwesomeIcon icon={faTableCellsLarge} />
          </button>
          {assets.length > 0 && (
            <button
              class="bottom-page-btn"
              onClick={toggleAssetSidebar}
              title="Open asset browser"
            >
              {currentAssetIndex + 1} / {assets.length}
            </button>
          )}
        </div>
{hasMesh && assets.length > 0 && (
  <>
        {/* Center: Navigation buttons */}
        <div class="bottom-controls-center">
          <div class="bottom-controls-center-inner">
            <AssetNavigation />
            {viewerFovSlider && (
              <div class="fov-overlay" role="group" aria-label="Viewer FOV">
                <input
                  class="fov-overlay-slider"
                  type="range"
                  min="20"
                  max="120"
                  step="1"
                  value={fov}
                  onInput={handleOverlayFovChange}
                />
              </div>
            )}
          </div>
        </div>

        {/* Right: Fullscreen and reset buttons */}
        <div class="bottom-controls-right">
            <>
            
              <button 
                class="bottom-page-btn" 
                onClick={handleResetView}
                aria-label="Reset camera view"
                title="Reset view (R)"
              >
                <FontAwesomeIcon icon={faRotateRight} />
              </button>

              <button
                class="bottom-page-btn"
                onClick={() => setScanViewOpen(true)}
                aria-label="Save default view and gallery preview"
                title="Save default view & gallery preview"
              >
                <FontAwesomeIcon icon={faCamera} />
              </button>
             
              <button
                class="bottom-page-btn"
                onClick={handleToggleFullscreen}
                aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
                title={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
              >
                <FontAwesomeIcon icon={isFullscreen ? faCompress : faExpand} />
              </button>
{isMobile && <button
                class={`bottom-page-btn immersive-toggle ${immersiveMode ? 'is-active' : 'is-inactive'}`}
                onClick={handleImmersiveToggle}
                aria-pressed={immersiveMode}
                aria-label={immersiveMode ? 'Disable immersive mode' : 'Enable immersive mode'}
                title={immersiveMode ? 'Disable immersive mode' : 'Enable immersive mode'}
              >
                Imm
              </button>}
            </>
        </div>
        </>
)}
      </div>

      {scanViewOpen && <ScanViewDialog onClose={() => setScanViewOpen(false)} />}
    </div>
  );
}

export default App;
