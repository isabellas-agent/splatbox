/**
 * Per-scan presentation.
 *
 * Every scan can carry two extra pieces of presentation data in its manifest:
 *
 * - `view`    the default camera pose (position / target / fov) the viewer
 *             opens the scan with. Saved with one button in the viewer, and
 *             also what "reset view" returns to.
 * - `gallery` how the scan animates in the gallery: `none` (static
 *             thumbnail), `orbit` (360° around the saved target) or
 *             `parallax` (a small side-step around the saved pose).
 *
 * The animation is rendered here in the viewer, where the real splat renderer
 * is available: one sprite sheet image (`<scan>.anim.webp`) with `frames`
 * tiles is uploaded next to the scan, and the gallery card plays it with a CSS
 * `steps()` transform, so no animated image encoder is needed and a card is a
 * single image request.
 */

import {
  camera,
  controls,
  renderer,
  composer,
  scene,
  currentMesh,
  forceRenderNow,
  requestRender,
  suspendRenderLoop,
  resumeRenderLoop,
  spark,
  THREE,
} from './viewer.js';
import { getSource } from './storage/index.js';
import { useStore } from './store.js';
import { resize } from './layout.js';
import { captureCurrentAssetPreview } from './assetManager.js';
import { applySavedView, captureSavedView, saveHomeView } from './cameraUtils.js';
import { savePreviewBlob } from './fileStorage.js';
import { getOrbitPivot, getSceneScale } from './navigation.js';

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Tile size matches the 4:3 gallery card thumbnail */
const TILE_WIDTH = 320;
const TILE_HEIGHT = 240;
const WEBP_QUALITY = 0.6;

/**
 * Playback presets per motion. `frames` is the sprite tile count; `duration`
 * is one full loop in milliseconds.
 */
export const GALLERY_MOTION_PRESETS = {
  none: { frames: 0, duration: 0 },
  orbit: { frames: 24, duration: 8000 },
  parallax: { frames: 16, duration: 6000 },
};

export const GALLERY_MOTIONS = [
  { id: 'none', label: 'No animation', hint: 'Static thumbnail rendered from the saved view.' },
  { id: 'orbit', label: 'Orbit 360°', hint: 'The camera circles once around the object.' },
  { id: 'parallax', label: 'Parallax', hint: 'The camera makes a small side-step and back.' },
];

/** Orbit rotation axis options (world axes, or the saved view's screen vertical) */
export const GALLERY_AXES = [
  { id: 'y', label: 'Y axis (up)' },
  { id: 'z', label: 'Z axis' },
  { id: 'x', label: 'X axis' },
  { id: 'view', label: 'Screen vertical' },
];

/** Orbit pivot options: where the rotation axis passes through */
export const GALLERY_PIVOTS = [
  { id: 'target', label: 'View pivot', hint: 'Where the camera looks (double-click a splat to set it).' },
  { id: 'center', label: 'Scan centre', hint: 'Centre of the scan’s bounding box.' },
];

/**
 * Resolve the orbit axis (unit vector, world space) and the point it passes
 * through, for the current camera.
 */
export const resolveOrbit = ({ axis = 'y', pivot = 'target' } = {}) => {
  const quat = camera.quaternion;
  let dir;
  if (axis === 'x') dir = new THREE.Vector3(1, 0, 0);
  else if (axis === 'z') dir = new THREE.Vector3(0, 0, 1);
  else if (axis === 'view') dir = new THREE.Vector3(0, 1, 0).applyQuaternion(quat);
  else dir = new THREE.Vector3(0, 1, 0);

  let point = null;
  if (pivot === 'center' && currentMesh) {
    try {
      const box = currentMesh.getBoundingBox().clone().applyMatrix4(currentMesh.matrixWorld);
      const c = box.getCenter(new THREE.Vector3());
      if ([c.x, c.y, c.z].every(Number.isFinite)) point = c;
    } catch {
      /* fall back to the view pivot */
    }
  }
  // Fly mode pins the controls target right in front of the camera; use a
  // pivot at scan depth instead so the turntable doesn't spin in place.
  if (!point) point = getOrbitPivot() || controls.target.clone();
  return { axis: dir.normalize(), point };
};

/** Rigidly rotate the start pose by `angle` around the orbit axis. */
const applyOrbitPose = (orbit, startPos, startQuat, angle) => {
  const q = new THREE.Quaternion().setFromAxisAngle(orbit.axis, angle);
  camera.position.copy(startPos).sub(orbit.point).applyQuaternion(q).add(orbit.point);
  camera.quaternion.copy(q).multiply(startQuat);
};

let guide = null;

/** Show the orbit axis (line through the pivot) and the pivot in the viewer. */
export const showOrbitGuide = (options) => {
  hideOrbitGuide();
  if (!camera || !controls || !currentMesh) return;
  const { axis, point } = resolveOrbit(options);
  const len = Math.max(getSceneScale() * 0.6, 1e-3);
  const material = new THREE.LineBasicMaterial({ color: 0x6ee7ff, depthTest: false, transparent: true, opacity: 0.9 });
  const geometry = new THREE.BufferGeometry().setFromPoints([
    point.clone().addScaledVector(axis, -len),
    point.clone().addScaledVector(axis, len),
  ]);
  const line = new THREE.Line(geometry, material);
  const dot = new THREE.Mesh(
    new THREE.SphereGeometry(len * 0.02, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0xffcc33, depthTest: false, transparent: true }),
  );
  dot.position.copy(point);
  guide = new THREE.Group();
  guide.add(line, dot);
  guide.renderOrder = 999;
  line.renderOrder = 999;
  dot.renderOrder = 1000;
  scene.add(guide);
  requestRender();
};

export const hideOrbitGuide = () => {
  if (!guide) return;
  scene.remove(guide);
  guide.traverse((o) => {
    o.geometry?.dispose?.();
    o.material?.dispose?.();
  });
  guide = null;
  requestRender();
};

let previewing = null;

/** Play the orbit once in the live viewer so the axis/pivot can be checked. */
export const playOrbitPreview = (options, durationMs = 4000) => {
  if (!camera || !controls) return Promise.resolve();
  if (previewing) return previewing;
  const orbit = resolveOrbit(options);
  const startPos = camera.position.clone();
  const startQuat = camera.quaternion.clone();
  const controlsWereEnabled = controls.enabled;
  controls.enabled = false;
  previewing = new Promise((resolve) => {
    const t0 = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - t0) / durationMs);
      applyOrbitPose(orbit, startPos, startQuat, t * Math.PI * 2);
      camera.updateMatrixWorld(true);
      requestRender();
      if (t < 1) {
        requestAnimationFrame(step);
        return;
      }
      camera.position.copy(startPos);
      camera.quaternion.copy(startQuat);
      camera.updateMatrixWorld(true);
      controls.enabled = controlsWereEnabled;
      requestRender();
      previewing = null;
      resolve();
    };
    requestAnimationFrame(step);
  });
  return previewing;
};

export const isGalleryMotion = (motion) => Object.prototype.hasOwnProperty.call(GALLERY_MOTION_PRESETS, motion);

const round = (n) => Math.round(n * 1e4) / 1e4;

const canvasToBlob = (canvas, type, quality) =>
  new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob || null), type, quality);
  });

/** The saved view + gallery settings of a scan, if it is hosted on the server. */
export const getScanPresentation = (asset) => {
  const remote = asset?._remoteAsset || asset;
  return {
    view: remote?.view && typeof remote.view === 'object' ? remote.view : null,
    gallery: remote?.gallery && typeof remote.gallery === 'object' ? remote.gallery : null,
    animation: remote?.animation || null,
  };
};

const getServerSource = (asset) => {
  const source = asset?.sourceId ? getSource(asset.sourceId) : null;
  return source?.type === 'server-collection' ? source : null;
};

export const canSaveScanPresentation = (asset) => !!(asset && getServerSource(asset));

/**
 * Render `frames` tiles of the current scan around the current pose into one
 * horizontal sprite sheet. Everything (renderer size, pixel ratio, camera,
 * clear colour) is restored afterwards, so the live viewer is untouched.
 *
 * @param {Object} options
 * @param {'orbit'|'parallax'} options.motion
 * @param {number} options.frames - number of tiles (2..48)
 * @param {number} [options.amount] - parallax strength as a fraction of the distance
 * @param {'y'|'z'|'x'|'view'} [options.axis] - orbit rotation axis
 * @param {'target'|'center'} [options.pivot] - point the orbit axis passes through
 * @returns {Promise<{blob: Blob, frames: number, width: number, height: number}|null>}
 */
export const renderGallerySheet = async ({ motion = 'orbit', frames = 24, amount = 0.12, axis = 'y', pivot = 'target' } = {}) => {
  if (!renderer || !composer || !camera || !controls || !currentMesh) return null;
  const total = Math.round(frames);
  if (!Number.isFinite(total) || total < 2) return null;

  const savedSize = renderer.getSize(new THREE.Vector2());
  const savedPixelRatio = renderer.getPixelRatio();
  const composerSize = {
    width: composer._width || savedSize.x,
    height: composer._height || savedSize.y,
  };
  const savedAspect = camera.aspect;
  const savedFov = camera.fov;
  const savedPosition = camera.position.clone();
  const savedQuaternion = camera.quaternion.clone();
  const savedTarget = controls.target.clone();
  const savedBackground = scene.background;
  const savedClearColor = new THREE.Color();
  renderer.getClearColor(savedClearColor);
  const savedClearAlpha = renderer.getClearAlpha();

  const orbit = resolveOrbit({ axis, pivot });
  const radius = Math.max(savedPosition.distanceTo(orbit.point), 1e-3);
  // Parallax side-steps along the camera's own right vector
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(savedQuaternion).normalize();
  hideOrbitGuide();

  const sheet = document.createElement('canvas');
  sheet.width = TILE_WIDTH * total;
  sheet.height = TILE_HEIGHT;
  const ctx = sheet.getContext('2d');

  try {
    suspendRenderLoop();
    scene.background = null;
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(1);
    renderer.setSize(TILE_WIDTH, TILE_HEIGHT, false);
    composer.setSize(TILE_WIDTH, TILE_HEIGHT);
    camera.aspect = TILE_WIDTH / TILE_HEIGHT;
    camera.fov = savedFov;
    camera.updateProjectionMatrix();

    for (let i = 0; i < total; i += 1) {
      const t = i / total;
      if (motion === 'parallax') {
        // Side-step with the camera, sliding the look-at point along, so the
        // scan shifts in frame like a stereo pair.
        const shift = Math.sin(t * Math.PI * 2) * radius * amount;
        camera.position.copy(savedPosition).addScaledVector(right, shift);
        camera.quaternion.copy(savedQuaternion);
      } else {
        applyOrbitPose(orbit, savedPosition, savedQuaternion, t * Math.PI * 2);
      }
      camera.updateMatrixWorld(true);
      // Spark sorts splats asynchronously for the new viewpoint: render once to
      // kick off the sort, give it a moment, then render again for the capture.
      spark?.update?.({ scene, camera });
      forceRenderNow();
      await nextFrame();
      await sleep(30);
      // Render and read back in the same task: the drawing buffer has no
      // preserveDrawingBuffer, so the copy must happen synchronously.
      forceRenderNow();
      ctx.drawImage(renderer.domElement, i * TILE_WIDTH, 0, TILE_WIDTH, TILE_HEIGHT);
    }
  } finally {
    scene.background = savedBackground;
    renderer.setClearColor(savedClearColor, savedClearAlpha);
    camera.position.copy(savedPosition);
    camera.quaternion.copy(savedQuaternion);
    camera.fov = savedFov;
    camera.aspect = savedAspect;
    camera.updateProjectionMatrix();
    controls.target.copy(savedTarget);
    controls.update();
    renderer.setPixelRatio(savedPixelRatio);
    renderer.setSize(savedSize.x, savedSize.y, false);
    composer.setSize(composerSize.width, composerSize.height);
    if (resize) resize();
    resumeRenderLoop();
    requestRender();
  }

  const blob = await canvasToBlob(sheet, 'image/webp', WEBP_QUALITY);
  if (!blob) return null;
  return { blob, frames: total, width: sheet.width, height: sheet.height };
};

/**
 * Save the current camera pose as the scan's default view and (re)build its
 * gallery animation.
 *
 * @param {Object} asset - the current asset (server collection)
 * @param {Object} options
 * @param {'none'|'orbit'|'parallax'} options.motion
 * @param {number} [options.duration] - one loop in ms
 * @param {number} [options.amount] - parallax strength
 * @param {'y'|'z'|'x'|'view'} [options.axis] - orbit axis
 * @param {'target'|'center'} [options.pivot] - orbit pivot
 * @param {(stage: string) => void} [options.onStage]
 * @returns {Promise<{animation: boolean, view: Object, gallery: Object}>}
 */
export const saveScanPresentation = async (asset, { motion = 'orbit', duration, amount = 0.12, axis = 'y', pivot = 'target', onStage } = {}) => {
  const source = getServerSource(asset);
  if (!source) throw new Error('This scan is not hosted on the splatbox server, so its view cannot be saved.');
  const path = asset._remoteAsset?.path || asset.path;
  if (!path) throw new Error('Scan path unknown.');

  const preset = GALLERY_MOTION_PRESETS[motion] || GALLERY_MOTION_PRESETS.orbit;
  const frames = preset.frames;
  const gallery = {
    motion,
    frames,
    duration: Math.round(duration || preset.duration || 8000),
    amount: round(Math.min(1, Math.max(0.01, amount))),
    ...(motion === 'orbit' ? { axis, pivot } : {}),
  };
  const view = captureSavedView();
  if (!view) throw new Error('Viewer is not ready.');

  onStage?.('Saving default view…');
  applySavedView(view);
  saveHomeView();
  await source.updateAssetsMeta([path], { view, gallery });

  if (motion !== 'none') {
    onStage?.(`Rendering ${frames} preview frames…`);
    const sheet = await renderGallerySheet({ motion, frames, amount: gallery.amount, axis, pivot });
    if (!sheet?.blob) throw new Error('Could not render the gallery animation.');
    onStage?.('Uploading animation…');
    const ok = await source.uploadAnimation(path, sheet.blob);
    if (!ok) throw new Error('Uploading the gallery animation failed.');
  }

  onStage?.('Rendering thumbnail…');
  const capture = await captureCurrentAssetPreview();
  if (capture?.blob) {
    const ext = capture.format === 'image/jpeg' ? 'jpg' : 'webp';
    try {
      await source.uploadPreview(path, capture.blob, ext);
    } catch (err) {
      console.warn('[ScanPresentation] Thumbnail upload failed', err);
    }
    try {
      await savePreviewBlob(asset.name, capture.blob, {
        width: capture.width,
        height: capture.height,
        format: capture.format,
      });
    } catch (err) {
      console.warn('[ScanPresentation] Thumbnail cache write failed', err);
    }
  }

  // Pick up the freshly attached files (animation / preview URLs)
  try {
    const remote = (await source.listAssets()).find((a) => a.path === path);
    if (remote) {
      syncAssetPresentation(asset, {
        view: remote.view,
        gallery: remote.gallery,
        animation: remote.animation,
        preview: remote.preview || asset.preview,
      });
    }
  } catch (err) {
    console.warn('[ScanPresentation] Refreshing the scan failed', err);
  }

  return { animation: motion !== 'none', view, gallery };
};

/**
 * Write presentation fields onto the asset, its shared `_remoteAsset`, and
 * every copy of it in the store. The store copies assets on some updates
 * (e.g. preview changes), so mutating only the object we were handed would
 * leave the dialog and gallery showing stale values.
 */
const syncAssetPresentation = (asset, fields) => {
  const apply = (obj) => {
    if (!obj) return;
    Object.assign(obj, fields);
    if (obj._remoteAsset) Object.assign(obj._remoteAsset, fields);
  };
  apply(asset);
  const store = useStore.getState();
  const assets = store.assets || [];
  let touched = false;
  const next = assets.map((a) => {
    if (a === asset || a.id !== asset.id) return a;
    touched = true;
    const copy = { ...a, ...fields };
    if (copy._remoteAsset) Object.assign(copy._remoteAsset, fields);
    return copy;
  });
  useStore.setState({ assets: touched ? next : [...assets] });
};

/** Forget the saved view and turn the gallery animation off. */
export const clearScanPresentation = async (asset) => {
  const source = getServerSource(asset);
  if (!source) throw new Error('This scan is not hosted on the splatbox server.');
  const path = asset._remoteAsset?.path || asset.path;
  await source.updateAssetsMeta([path], {
    view: null,
    gallery: { motion: 'none' },
  });
  syncAssetPresentation(asset, {
    view: null,
    gallery: { motion: 'none', frames: 0, duration: 0, amount: 0.12 },
    animation: null,
  });
};
