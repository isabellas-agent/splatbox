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
import { resize } from './layout.js';
import { captureCurrentAssetPreview } from './assetManager.js';
import { applySavedView, captureSavedView, saveHomeView } from './cameraUtils.js';
import { savePreviewBlob } from './fileStorage.js';
import { getOrbitPivot } from './navigation.js';

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
 * @returns {Promise<{blob: Blob, frames: number, width: number, height: number}|null>}
 */
export const renderGallerySheet = async ({ motion = 'orbit', frames = 24, amount = 0.12 } = {}) => {
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

  // Fly mode pins the controls target right in front of the camera; orbit
  // around the scan instead of spinning in place.
  const target = getOrbitPivot() || savedTarget.clone();
  const offset = savedPosition.clone().sub(target);
  const radius = Math.max(offset.length(), 1e-3);
  const up = new THREE.Vector3(0, 1, 0);
  const forward = new THREE.Vector3().subVectors(target, savedPosition).normalize();
  const right = new THREE.Vector3().crossVectors(forward, up).normalize();

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
        camera.lookAt(target.clone().addScaledVector(right, shift));
      } else {
        const rotated = offset.clone().applyAxisAngle(up, t * Math.PI * 2);
        camera.position.copy(target).add(rotated);
        camera.lookAt(target);
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
 * @param {(stage: string) => void} [options.onStage]
 * @returns {Promise<{animation: boolean, view: Object, gallery: Object}>}
 */
export const saveScanPresentation = async (asset, { motion = 'orbit', duration, amount = 0.12, onStage } = {}) => {
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
  };
  const view = captureSavedView();
  if (!view) throw new Error('Viewer is not ready.');

  onStage?.('Saving default view…');
  applySavedView(view);
  saveHomeView();
  await source.updateAssetsMeta([path], { view, gallery });

  if (motion !== 'none') {
    onStage?.(`Rendering ${frames} preview frames…`);
    const sheet = await renderGallerySheet({ motion, frames, amount: gallery.amount });
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
      asset.view = remote.view;
      asset.gallery = remote.gallery;
      asset.animation = remote.animation;
      asset.preview = remote.preview || asset.preview;
      asset._remoteAsset = remote;
    }
  } catch (err) {
    console.warn('[ScanPresentation] Refreshing the scan failed', err);
  }

  return { animation: motion !== 'none', view, gallery };
};

/** Forget the saved view and turn the gallery animation off. */
export const clearScanPresentation = async (asset) => {
  const source = getServerSource(asset);
  if (!source) throw new Error('This scan is not hosted on the splatbox server.');
  const path = asset._remoteAsset?.path || asset.path;
  await source.updateAssetsMeta([path], {
    view: null,
    gallery: { motion: 'none', frames: 0, duration: 0, amount: 0.12 },
  });
  asset.view = null;
  asset.gallery = { motion: 'none', frames: 0, duration: 0, amount: 0.12 };
  if (asset._remoteAsset) {
    asset._remoteAsset.view = null;
    asset._remoteAsset.gallery = asset.gallery;
  }
};
