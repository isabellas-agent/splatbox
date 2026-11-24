/**
 * In-VR collection browser.
 *
 * A floating panel (canvas texture on a plane) that lists the scans of the
 * current collection as a thumbnail grid. Point at it with a controller ray and
 * pull the trigger to open a scan; the header arrows switch collection and the
 * footer arrows page through large collections.
 *
 * Controls (see vrMode.js): left trigger toggles the panel; while it is open,
 * either controller's trigger "clicks" and the right thumbstick pages.
 */
import { THREE } from "./viewer.js";
import { getAssetList, getCurrentAssetIndex } from "./assetManager.js";
import { useStore } from "./store.js";
import { getSource, getSourcesArray } from "./storage/index.js";

const CANVAS_W = 1280;
const CANVAS_H = 900;
const PANEL_W = 1.1; // metres
const PANEL_H = (PANEL_W * CANVAS_H) / CANVAS_W;
const COLS = 4;
const ROWS = 3;
const PAGE_SIZE = COLS * ROWS;
const HEADER_H = 110;
const FOOTER_H = 90;
const PAD = 28;
const GAP = 22;

const stripExt = (name) => String(name || "").replace(/\.[^.]+$/, "");
const titleOf = (asset) => asset?.title || stripExt(asset?.name);

/** Pure layout: rectangles (canvas px) of every clickable region for a page. */
export const computeLayout = (count, page) => {
  const gridTop = HEADER_H;
  const gridH = CANVAS_H - HEADER_H - FOOTER_H;
  const cellW = (CANVAS_W - PAD * 2 - GAP * (COLS - 1)) / COLS;
  const cellH = (gridH - GAP * (ROWS - 1) - PAD / 2) / ROWS;
  const cells = [];
  const start = page * PAGE_SIZE;
  for (let i = 0; i < PAGE_SIZE && start + i < count; i += 1) {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    cells.push({
      index: start + i,
      x: PAD + col * (cellW + GAP),
      y: gridTop + row * (cellH + GAP),
      w: cellW,
      h: cellH,
    });
  }
  const pages = Math.max(1, Math.ceil(count / PAGE_SIZE));
  return {
    cells,
    pages,
    prevCollection: { x: PAD, y: 22, w: 70, h: 66 },
    nextCollection: { x: CANVAS_W - PAD - 70 - 90, y: 22, w: 70, h: 66 },
    close: { x: CANVAS_W - PAD - 70, y: 22, w: 70, h: 66 },
    prevPage: { x: PAD, y: CANVAS_H - FOOTER_H + 14, w: 150, h: 62 },
    nextPage: { x: CANVAS_W - PAD - 150, y: CANVAS_H - FOOTER_H + 14, w: 150, h: 62 },
  };
};

const inside = (r, x, y) => r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

/** Map a canvas point to an action. */
export const hitTest = (layout, x, y) => {
  for (const c of layout.cells) if (inside(c, x, y)) return { type: "asset", index: c.index };
  if (inside(layout.close, x, y)) return { type: "close" };
  if (inside(layout.prevCollection, x, y)) return { type: "collection", dir: -1 };
  if (inside(layout.nextCollection, x, y)) return { type: "collection", dir: 1 };
  if (inside(layout.prevPage, x, y)) return { type: "page", dir: -1 };
  if (inside(layout.nextPage, x, y)) return { type: "page", dir: 1 };
  return null;
};

const roundRect = (ctx, x, y, w, h, r) => {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
};

const fitText = (ctx, text, maxW) => {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
  return `${t}…`;
};

const drawButton = (ctx, r, label, { hover = false, disabled = false } = {}) => {
  roundRect(ctx, r.x, r.y, r.w, r.h, 14);
  ctx.fillStyle = hover && !disabled ? "rgba(110,231,255,0.28)" : "rgba(255,255,255,0.07)";
  ctx.fill();
  ctx.strokeStyle = hover && !disabled ? "rgba(110,231,255,0.9)" : "rgba(255,255,255,0.18)";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = disabled ? "rgba(230,236,248,0.3)" : "#e6ecf8";
  ctx.font = "600 34px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, r.x + r.w / 2, r.y + r.h / 2 + 1);
};

/**
 * Draw the panel. `state` = { collectionName, assets, currentIndex, page,
 * hover, images: Map<url, HTMLImageElement> }
 */
export const drawPanel = (ctx, state) => {
  const { assets, page, hover, images } = state;
  const layout = computeLayout(assets.length, page);
  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

  roundRect(ctx, 0, 0, CANVAS_W, CANVAS_H, 36);
  ctx.fillStyle = "rgba(11,13,18,0.92)";
  ctx.fill();
  ctx.strokeStyle = "rgba(110,231,255,0.45)";
  ctx.lineWidth = 4;
  ctx.stroke();

  // Header
  const isHover = (type, dir) => hover && hover.type === type && (dir === undefined || hover.dir === dir);
  drawButton(ctx, layout.prevCollection, "◀", { hover: isHover("collection", -1), disabled: !state.canSwitchCollection });
  drawButton(ctx, layout.nextCollection, "▶", { hover: isHover("collection", 1), disabled: !state.canSwitchCollection });
  drawButton(ctx, layout.close, "✕", { hover: isHover("close") });
  ctx.fillStyle = "#e6ecf8";
  ctx.font = "700 44px system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  const titleX = layout.prevCollection.x + layout.prevCollection.w + 24;
  const titleMax = layout.nextCollection.x - titleX - 24;
  ctx.fillText(fitText(ctx, state.collectionName || "Scans", titleMax - 150), titleX, 56);
  ctx.font = "400 28px system-ui, sans-serif";
  ctx.fillStyle = "rgba(230,236,248,0.6)";
  ctx.textAlign = "right";
  ctx.fillText(`${assets.length} scan${assets.length === 1 ? "" : "s"}`, layout.nextCollection.x - 20, 58);

  // Grid
  for (const cell of layout.cells) {
    const asset = assets[cell.index];
    const isCurrent = cell.index === state.currentIndex;
    const isHovered = hover?.type === "asset" && hover.index === cell.index;
    roundRect(ctx, cell.x, cell.y, cell.w, cell.h, 18);
    ctx.fillStyle = isHovered ? "rgba(110,231,255,0.16)" : "rgba(255,255,255,0.05)";
    ctx.fill();
    ctx.lineWidth = isCurrent || isHovered ? 5 : 2;
    ctx.strokeStyle = isCurrent ? "#3dd6c6" : isHovered ? "rgba(110,231,255,0.9)" : "rgba(255,255,255,0.12)";
    ctx.stroke();

    const thumbH = cell.h - 56;
    const img = asset?.preview ? images.get(asset.preview) : null;
    ctx.save();
    roundRect(ctx, cell.x + 6, cell.y + 6, cell.w - 12, thumbH - 6, 14);
    ctx.clip();
    if (img && img.complete && img.naturalWidth > 0) {
      const scale = Math.max((cell.w - 12) / img.naturalWidth, (thumbH - 6) / img.naturalHeight);
      const w = img.naturalWidth * scale;
      const h = img.naturalHeight * scale;
      ctx.drawImage(img, cell.x + 6 + (cell.w - 12 - w) / 2, cell.y + 6 + (thumbH - 6 - h) / 2, w, h);
    } else {
      ctx.fillStyle = "rgba(84,113,255,0.18)";
      ctx.fillRect(cell.x, cell.y, cell.w, thumbH);
      ctx.fillStyle = "rgba(230,236,248,0.35)";
      ctx.font = "600 56px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("◆", cell.x + cell.w / 2, cell.y + thumbH / 2);
    }
    ctx.restore();

    ctx.fillStyle = "#e6ecf8";
    ctx.font = "600 28px system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(fitText(ctx, titleOf(asset), cell.w - 28), cell.x + 14, cell.y + cell.h - 28);
  }

  if (!assets.length) {
    ctx.fillStyle = "rgba(230,236,248,0.6)";
    ctx.font = "400 34px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("No scans in this collection", CANVAS_W / 2, CANVAS_H / 2);
  }

  // Footer
  if (layout.pages > 1) {
    drawButton(ctx, layout.prevPage, "◀ Prev", { hover: isHover("page", -1), disabled: page <= 0 });
    drawButton(ctx, layout.nextPage, "Next ▶", { hover: isHover("page", 1), disabled: page >= layout.pages - 1 });
  }
  ctx.fillStyle = "rgba(230,236,248,0.6)";
  ctx.font = "400 26px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const footerY = CANVAS_H - FOOTER_H / 2;
  const pageText = layout.pages > 1 ? `Page ${page + 1} / ${layout.pages} · ` : "";
  ctx.fillText(`${pageText}Trigger: open · Left trigger: close`, CANVAS_W / 2, footerY);
  return layout;
};

/**
 * Three.js wrapper around the drawing code.
 */
export class VrCollectionPanel {
  constructor({ onOpenAsset, onSwitchCollection }) {
    this.onOpenAsset = onOpenAsset;
    this.onSwitchCollection = onSwitchCollection;
    this.canvas = document.createElement("canvas");
    this.canvas.width = CANVAS_W;
    this.canvas.height = CANVAS_H;
    this.ctx = this.canvas.getContext("2d");
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    const material = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(PANEL_W, PANEL_H), material);
    this.mesh.renderOrder = 10000;
    this.mesh.visible = false;
    this.mesh.name = "vr-collection-panel";
    this.page = 0;
    this.hover = null;
    this.images = new Map();
    this.layout = null;
    this.raycaster = new THREE.Raycaster();
    this._dirty = true;
  }

  get visible() {
    return this.mesh.visible;
  }

  _state() {
    const assets = getAssetList();
    const activeId = useStore.getState().activeSourceId;
    const source = activeId ? getSource(activeId) : null;
    return {
      assets,
      currentIndex: getCurrentAssetIndex(),
      collectionName: source?.name || "Scans",
      canSwitchCollection: getSourcesArray().filter((s) => s.type === "server-collection").length > 1,
      page: this.page,
      hover: this.hover,
      images: this.images,
    };
  }

  _loadImages(assets) {
    for (const a of assets) {
      if (!a?.preview || this.images.has(a.preview)) continue;
      const img = new Image();
      img.onload = () => this.redraw();
      img.src = a.preview;
      this.images.set(a.preview, img);
    }
  }

  redraw() {
    const state = this._state();
    const pages = Math.max(1, Math.ceil(state.assets.length / PAGE_SIZE));
    if (this.page > pages - 1) this.page = pages - 1;
    state.page = this.page;
    this._loadImages(state.assets.slice(this.page * PAGE_SIZE, (this.page + 1) * PAGE_SIZE));
    this.layout = drawPanel(this.ctx, state);
    this.texture.needsUpdate = true;
  }

  /** Show the panel in front of the viewer (XR camera), on the current page. */
  open(xrCamera) {
    const cur = getCurrentAssetIndex();
    if (cur >= 0) this.page = Math.floor(cur / PAGE_SIZE);
    if (xrCamera) {
      const pos = new THREE.Vector3();
      const dir = new THREE.Vector3();
      xrCamera.getWorldPosition(pos);
      xrCamera.getWorldDirection(dir);
      dir.y = 0;
      if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1);
      dir.normalize();
      this.mesh.position.copy(pos).addScaledVector(dir, 1.0);
      this.mesh.position.y = pos.y - 0.15;
      this.mesh.lookAt(pos.x, this.mesh.position.y, pos.z);
    }
    this.hover = null;
    this.mesh.visible = true;
    this.redraw();
  }

  close() {
    this.mesh.visible = false;
    this.hover = null;
  }

  toggle(xrCamera) {
    if (this.visible) this.close();
    else this.open(xrCamera);
  }

  changePage(dir) {
    const pages = Math.max(1, Math.ceil(getAssetList().length / PAGE_SIZE));
    const next = Math.min(pages - 1, Math.max(0, this.page + dir));
    if (next !== this.page) {
      this.page = next;
      this.redraw();
    }
  }

  /** Ray from a controller object (-Z forward). Returns canvas hit or null. */
  _intersect(controller) {
    if (!this.visible || !controller) return null;
    const m = controller.matrixWorld;
    this.raycaster.ray.origin.setFromMatrixPosition(m);
    this.raycaster.ray.direction.set(0, 0, -1).transformDirection(m);
    const hit = this.raycaster.intersectObject(this.mesh, false)[0];
    if (!hit?.uv) return null;
    return { x: hit.uv.x * CANVAS_W, y: (1 - hit.uv.y) * CANVAS_H, distance: hit.distance, point: hit.point };
  }

  /** Update hover from the given controllers; returns the active hit (for cursor/ray length). */
  updatePointer(controllers) {
    if (!this.visible) return null;
    let best = null;
    for (const c of controllers) {
      const hit = this._intersect(c);
      if (hit && (!best || hit.distance < best.distance)) best = { ...hit, controller: c };
    }
    const action = best && this.layout ? hitTest(this.layout, best.x, best.y) : null;
    const same = JSON.stringify(action) === JSON.stringify(this.hover);
    if (!same) {
      this.hover = action;
      this.redraw();
    }
    return best;
  }

  /** Trigger pressed on `controller`: perform the action under its ray. */
  select(controller) {
    const hit = this._intersect(controller);
    if (!hit || !this.layout) return false;
    const action = hitTest(this.layout, hit.x, hit.y);
    if (!action) return true; // consumed: pointed at the panel background
    if (action.type === "close") this.close();
    else if (action.type === "page") this.changePage(action.dir);
    else if (action.type === "asset") {
      Promise.resolve(this.onOpenAsset?.(action.index)).finally(() => this.redraw());
    } else if (action.type === "collection") {
      this.page = 0;
      Promise.resolve(this.onSwitchCollection?.(action.dir)).finally(() => this.redraw());
    }
    return true;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.texture.dispose();
    this.images.clear();
  }
}
