/**
 * Background manager.
 *
 * The viewer uses a solid background color (chosen in the camera settings and
 * applied as CSS on the viewer element), so the canvas is always cleared to
 * transparent. The blurred preview-image background of the old monocular
 * viewer is gone; these functions keep the loader API stable.
 */
import { requestRender, renderer, scene } from './viewer.js';

/** Keep the Three.js canvas transparent so the solid CSS color shows. */
export const applyBackground = () => {
  if (scene && renderer) {
    scene.background = null;
    renderer.setClearColor(0x000000, 0);
  }
  requestRender();
  return null;
};

export const clearBackground = () => applyBackground();

export const applyPreviewBackground = () => applyBackground();

/** No-op: preview-derived backgrounds are disabled. */
export const captureAndApplyBackground = () => null;
