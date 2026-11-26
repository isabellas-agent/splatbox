/**
 * 6DoF navigation for the flat-screen viewer.
 *
 * Builds on OrbitControls (mouse/touch rotate, pan, zoom) and adds free
 * movement in all directions:
 *   W/S forward/back · A/D left/right · E/Q up/down · Shift faster · Alt slower
 *   F toggles between the two look modes:
 *     orbit – rotate around a pivot (double-click a splat to set it), zoom to cursor
 *     fly   – look around from where you stand, mouse wheel moves forward/back
 * Movement is scaled to the size of the loaded scene and the speed setting.
 */
import { camera, controls, renderer, requestRender, THREE, currentMesh } from './viewer.js';
import { useStore } from './store.js';

const MOVE_KEYS = {
  KeyW: 'forward',
  KeyS: 'back',
  KeyA: 'left',
  KeyD: 'right',
  KeyE: 'up',
  KeyQ: 'down',
};

/** Base speed: fraction of the scene size per second */
const BASE_SPEED = 0.35;
/** Distance of the look-around pivot in fly mode, as a fraction of scene size */
const FLY_PIVOT_FRACTION = 0.01;

const pressed = new Set();
let fast = false;
let slow = false;
let rafId = null;
let lastTime = 0;
let lastMesh = null;
let sceneScale = 1;
let initialized = false;
let repinning = false;

const tmpForward = new THREE.Vector3();
const tmpRight = new THREE.Vector3();
const tmpDelta = new THREE.Vector3();
const tmpBox = new THREE.Box3();
const tmpSize = new THREE.Vector3();
const tmpCenter = new THREE.Vector3();

const isTyping = (el) => {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
};

/** Navigation is inactive while the gallery or a dialog covers the viewer, or in VR. */
const isBlocked = () => {
  if (useStore.getState().vrSessionActive) return true;
  return !!document.querySelector('.gallery-overlay, .gallery-dialog-overlay, .modal-overlay');
};

/** Size of the loaded scene (bounding-box diagonal), cached per mesh. */
export const getSceneScale = () => {
  if (currentMesh !== lastMesh) {
    lastMesh = currentMesh;
    sceneScale = 1;
    try {
      if (currentMesh?.getBoundingBox) {
        tmpBox.copy(currentMesh.getBoundingBox());
        tmpBox.applyMatrix4(currentMesh.matrixWorld);
        const d = tmpBox.getSize(tmpSize).length();
        if (Number.isFinite(d) && d > 0) sceneScale = THREE.MathUtils.clamp(d, 0.05, 5000);
      }
    } catch {
      sceneScale = 1;
    }
  }
  return sceneScale;
};

const flyPivotDistance = () => Math.max(0.005, getSceneScale() * FLY_PIVOT_FRACTION);

/** Fly mode: keep the orbit pivot just in front of the camera so rotating looks around. */
const pinPivotInFront = () => {
  if (!camera || !controls) return;
  camera.getWorldDirection(tmpForward);
  const d = flyPivotDistance();
  repinning = true;
  controls.target.copy(camera.position).addScaledVector(tmpForward, d);
  repinning = false;
};

/**
 * A sensible orbit pivot along the current view direction: the depth of the
 * scan's centre, or a fraction of the scene size when that is behind us.
 */
const computeOrbitPivot = (out = new THREE.Vector3()) => {
  const forward = new THREE.Vector3();
  camera.getWorldDirection(forward);
  let dist = getSceneScale() * 0.35;
  if (currentMesh) {
    try {
      tmpBox.copy(currentMesh.getBoundingBox()).applyMatrix4(currentMesh.matrixWorld);
      tmpBox.getCenter(tmpCenter);
      const along = tmpCenter.sub(camera.position).dot(forward);
      if (Number.isFinite(along) && along > getSceneScale() * 0.02) dist = along;
    } catch {
      /* keep default */
    }
  }
  return out.copy(camera.position).addScaledVector(forward, dist);
};

/**
 * The point to orbit around for the current view. In orbit mode this is the
 * controls target; in fly mode the target is pinned right in front of the
 * camera, so a pivot at scan depth is computed instead (used for saved views
 * and gallery turntables).
 */
export const getOrbitPivot = () => {
  if (!camera || !controls) return null;
  if (useStore.getState().navMode === 'fly'
    || camera.position.distanceTo(controls.target) < flyPivotDistance() * 3) {
    return computeOrbitPivot();
  }
  return controls.target.clone();
};

/** Orbit mode: put the pivot at a sensible distance along the view direction. */
const placeOrbitPivot = () => {
  if (!camera || !controls) return;
  computeOrbitPivot(controls.target);
};

export const applyNavMode = (mode) => {
  if (!controls) return;
  if (mode === 'fly') {
    controls.enableZoom = false;
    pinPivotInFront();
  } else {
    controls.enableZoom = true;
    controls.zoomToCursor = true;
    placeOrbitPivot();
  }
  controls.update();
  requestRender();
};

const step = (time) => {
  rafId = null;
  if (!camera || !controls) return;
  if (pressed.size === 0 || isBlocked()) {
    pressed.clear();
    return;
  }
  const dt = Math.min(0.1, Math.max(0.001, (time - lastTime) / 1000));
  lastTime = time;

  const { moveSpeed } = useStore.getState();
  const speed = getSceneScale() * BASE_SPEED * (moveSpeed || 1) * (fast ? 4 : 1) * (slow ? 0.25 : 1);

  camera.getWorldDirection(tmpForward);
  tmpRight.crossVectors(tmpForward, camera.up).normalize();
  tmpDelta.set(0, 0, 0);
  if (pressed.has('forward')) tmpDelta.add(tmpForward);
  if (pressed.has('back')) tmpDelta.sub(tmpForward);
  if (pressed.has('right')) tmpDelta.add(tmpRight);
  if (pressed.has('left')) tmpDelta.sub(tmpRight);
  if (pressed.has('up')) tmpDelta.add(camera.up);
  if (pressed.has('down')) tmpDelta.sub(camera.up);

  if (tmpDelta.lengthSq() > 0) {
    tmpDelta.normalize().multiplyScalar(speed * dt);
    camera.position.add(tmpDelta);
    controls.target.add(tmpDelta);
    controls.update();
    requestRender();
  }
  rafId = requestAnimationFrame(step);
};

const ensureLoop = () => {
  if (rafId == null) {
    lastTime = performance.now();
    rafId = requestAnimationFrame(step);
  }
};

const onKeyDown = (event) => {
  if (isTyping(event.target) || event.ctrlKey || event.metaKey || isBlocked()) return;
  fast = event.shiftKey;
  slow = event.altKey;
  if (event.code === 'KeyF' && !event.repeat) {
    const { navMode, setNavMode } = useStore.getState();
    setNavMode(navMode === 'fly' ? 'orbit' : 'fly');
    event.preventDefault();
    return;
  }
  const dir = MOVE_KEYS[event.code];
  if (!dir) return;
  event.preventDefault();
  pressed.add(dir);
  ensureLoop();
};

const onKeyUp = (event) => {
  fast = event.shiftKey;
  slow = event.altKey;
  const dir = MOVE_KEYS[event.code];
  if (dir) pressed.delete(dir);
};

const onBlur = () => {
  pressed.clear();
  fast = false;
  slow = false;
};

/** Fly mode: mouse wheel moves forward/back instead of zooming. */
const onWheel = (event) => {
  if (useStore.getState().navMode !== 'fly' || isBlocked() || !camera || !controls) return;
  event.preventDefault();
  const { moveSpeed } = useStore.getState();
  const amount = -Math.sign(event.deltaY) * Math.min(1, Math.abs(event.deltaY) / 100)
    * getSceneScale() * 0.05 * (moveSpeed || 1) * (event.shiftKey ? 4 : 1);
  camera.getWorldDirection(tmpForward);
  camera.position.addScaledVector(tmpForward, amount);
  controls.target.addScaledVector(tmpForward, amount);
  controls.update();
  requestRender();
};

/** In fly mode, re-pin the pivot whenever something moved it away (reset, animations). */
const onControlsChange = () => {
  if (repinning || useStore.getState().navMode !== 'fly' || !camera || !controls) return;
  if (camera.position.distanceTo(controls.target) > flyPivotDistance() * 3) pinPivotInFront();
};

export const initNavigation = () => {
  if (initialized || !renderer || !controls) return;
  initialized = true;
  controls.zoomToCursor = true;
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  renderer.domElement.addEventListener('wheel', onWheel, { passive: false, capture: true });
  controls.addEventListener('change', onControlsChange);
  useStore.subscribe((s) => s.navMode, applyNavMode);
  if (useStore.getState().navMode === 'fly') applyNavMode('fly');
};
