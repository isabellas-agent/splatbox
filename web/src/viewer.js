/**
 * Viewer module - Three.js scene, renderer, camera, controls, render loop
 */

import * as THREE from "three";
import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";

// Scene
export const scene = new THREE.Scene();
scene.background = null;

// Renderer (initialized lazily)
export let renderer;
export let composer;
export let renderPass;
export let outputPass;
export let camera;
export let controls;
export let spark;
export let raycaster;

// Default settings (captured after initialization)
export let defaultCamera;
export let defaultControls;

// State
export let currentMesh = null;
export let activeCamera = null;
export let needsRender = true;
export let originalImageAspect = null;
let renderSuspended = false;

// Dolly zoom state
export let dollyZoomEnabled = true;
export let dollyZoomBaseDistance = null;
export let dollyZoomBaseFov = null;

// Background capture state
export let bgImageUrl = null;
export let bgImageContainer = null;
export let bgImageAspect = null;
let bgActivateRaf = null;
let pendingBg = null;
// FPS overlay element
export let fpsContainer = null;

export const setCurrentMesh = (mesh) => { currentMesh = mesh; };
export const setActiveCamera = (cam) => { activeCamera = cam; };
export const setOriginalImageAspect = (aspect) => { originalImageAspect = aspect; };
export const setDollyZoomEnabled = (enabled) => { dollyZoomEnabled = enabled; };
export const setBgImageUrl = (url) => { bgImageUrl = url; };

/**
 * Gets the current focus distance (camera to orbit target distance).
 * @returns {number|null} Distance in scene units, or null if not available
 */
export const getFocusDistance = () => {
  if (!camera || !controls) return null;
  return camera.position.distanceTo(controls.target);
};


export const requestRender = () => {
  needsRender = true;
};

/**
 * Force an immediate render, bypassing frame rate limiting.
 * Useful for batch operations where timing is critical.
 */
export const forceRenderNow = () => {
  if (!renderer || !composer || !camera) return;
  composer.render();
  needsRender = false;
};

export const suspendRenderLoop = () => {
  renderSuspended = true;
};

export const resumeRenderLoop = () => {
  renderSuspended = false;
  needsRender = true;
};

export const updateDollyZoomBaselineFromCamera = () => {
  if (!dollyZoomEnabled) return;
  dollyZoomBaseDistance = camera.position.distanceTo(controls.target);
  dollyZoomBaseFov = camera.fov;
};

export const initViewer = (viewerEl) => {
  // Renderer
  renderer = new THREE.WebGLRenderer({
    antialias: false,
    alpha: true,
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setClearColor(0x000000, 0); // Transparent clear color
  viewerEl.appendChild(renderer.domElement);

  // Camera
  camera = new THREE.PerspectiveCamera(60, 1, 0.01, 500);
  camera.position.set(0.5, 0.5, 2.5);
  defaultCamera = {
    fov: camera.fov,
    near: camera.near,
    far: camera.far,
  };

  // Post-processing
  composer = new EffectComposer(renderer);
  renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);
  outputPass = new OutputPass();

  // Controls
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.rotateSpeed = 0.75;
  controls.zoomSpeed = 0.6;
  controls.panSpeed = 0.6;
  controls.target.set(0, 0, 0);
  defaultControls = {
    dampingFactor: controls.dampingFactor,
    rotateSpeed: controls.rotateSpeed,
    zoomSpeed: controls.zoomSpeed,
    panSpeed: controls.panSpeed,
    minDistance: controls.minDistance,
    maxDistance: controls.maxDistance,
    minPolarAngle: controls.minPolarAngle,
    maxPolarAngle: controls.maxPolarAngle,
    minAzimuthAngle: controls.minAzimuthAngle,
    maxAzimuthAngle: controls.maxAzimuthAngle,
    enablePan: controls.enablePan,
  };

  // Spark renderer
  // Re-render when Spark finishes an async sort/LoD update (render loop is on-demand)
  spark = new SparkRenderer({ renderer, onDirty: () => requestRender() });
  scene.add(spark);

  // Raycaster for double-click
  raycaster = new THREE.Raycaster();

  // Solid background color (CSS on the viewer element; the canvas stays transparent)
  import('./store.js').then(({ useStore, BACKGROUND_COLORS }) => {
    const applyBgColor = (id) => {
      const color = BACKGROUND_COLORS.find((c) => c.id === id) ?? BACKGROUND_COLORS[0];
      viewerEl.style.setProperty('--viewer-bg', color.value);
      requestRender();
    };
    applyBgColor(useStore.getState().bgColor);
    useStore.subscribe((s) => s.bgColor, applyBgColor);
  }).catch(() => {});

  // FPS overlay
  fpsContainer = document.createElement('div');
  fpsContainer.id = 'fps-counter';
  fpsContainer.textContent = '';
  fpsContainer.style.display = 'none';
  viewerEl.appendChild(fpsContainer);

  // Subscribe to store for showFps flag (lazy import to avoid circular deps)
  import('./store.js').then(({ useStore }) => {
    // Initialize visibility
    const initial = useStore.getState().showFps;
    fpsContainer.style.display = initial ? 'block' : 'none';
    // Subscribe to changes
    useStore.subscribe((s) => s.showFps, (show) => {
      if (fpsContainer) fpsContainer.style.display = show ? 'block' : 'none';
    });
  }).catch(() => {});

  // Initialize dolly zoom baseline
  updateDollyZoomBaselineFromCamera();


  // On-demand rendering
  controls.addEventListener("change", requestRender);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) requestRender();
  });

  return { renderer, camera, controls, composer, spark };
};

export const startRenderLoop = () => {
  // Simple FPS measurement
  let lastTime = performance.now();
  let frameCount = 0;
  let lastFpsUpdate = performance.now();
  const targetFrameMs = 1000 / 60; // cap at 60 FPS
  let lastRenderTime = performance.now();

  const animate = () => {
    requestAnimationFrame(animate);

    // Skip rendering if tab is hidden
    if (document.hidden) return;

    const now = performance.now();
    const elapsedSinceRender = now - lastRenderTime;
    if (elapsedSinceRender < targetFrameMs) {
      return;
    }
    // Align to the frame boundary to reduce drift on high-refresh monitors
    lastRenderTime = now - (elapsedSinceRender % targetFrameMs);

    if (renderSuspended || !renderer || !controls || !composer || !camera) {
      return;
    }

    // Always update controls for damping, but only render if needed
    const controlsNeedUpdate = controls.update();

    if (needsRender || controlsNeedUpdate) {
      composer.render();
      needsRender = false;
      frameCount++;
    }

    // Update FPS display once per 250ms if present
    if (fpsContainer && fpsContainer.style.display === 'block') {
      const now = performance.now();
      const dt = now - lastFpsUpdate;
      if (dt >= 250) {
        const fps = Math.round((frameCount * 1000) / dt);
        fpsContainer.textContent = `${fps} FPS`;
        frameCount = 0;
        lastFpsUpdate = now;
      }
    }
  };
  animate();
};

export const removeCurrentMesh = () => {
  if (currentMesh) {
    scene.remove(currentMesh);
    currentMesh = null;
  }
};

const cancelPendingBgActivation = () => {
  if (bgActivateRaf) {
    cancelAnimationFrame(bgActivateRaf);
    bgActivateRaf = null;
  }
  pendingBg = null;
};

export const updateBackgroundImage = (url) => {
  if (!bgImageContainer) return;
  cancelPendingBgActivation();

  if (url) {
    const viewerEl = bgImageContainer.parentElement;
    const isSlidingOut = viewerEl?.classList.contains("slide-out");
    const isSlidingIn = viewerEl?.classList.contains("slide-in");

    if (isSlidingOut) {
      // During slide-out, defer swap until slide-out completes (old bg stays visible)
      pendingBg = { url };
      bgActivateRaf = requestAnimationFrame(function waitUntilSlideOutEnds() {
        bgActivateRaf = null;
        if (viewerEl?.classList.contains("slide-out")) {
          bgActivateRaf = requestAnimationFrame(waitUntilSlideOutEnds);
          return;
        }
        // slide-out done, apply the new background (slide-in may now be active)
        if (pendingBg) {
          bgImageContainer.style.backgroundImage = `url(${pendingBg.url})`;
          bgImageUrl = pendingBg.url;
          pendingBg = null;
        }
        bgImageContainer.classList.add("active");
        requestRender();
      });
    } else if (isSlidingIn) {
      // During slide-in, apply immediately so it fades in with canvas
      bgImageContainer.style.backgroundImage = `url(${url})`;
      bgImageUrl = url;
      bgImageContainer.classList.add("active");
    } else {
      bgImageContainer.style.backgroundImage = `url(${url})`;
      bgImageUrl = url;
      bgImageContainer.classList.add("active");
    }
  } else {
    pendingBg = null;
    bgImageContainer.style.backgroundImage = "none";
    bgImageContainer.classList.remove("active");
  }

  requestRender();
};

// Export THREE and SplatMesh for use in other modules
export { THREE, SplatMesh };
