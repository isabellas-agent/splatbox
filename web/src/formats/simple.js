import { SplatMesh, SplatFileType } from "@sparkjsdev/spark";

/** Formats Spark can load directly that carry no camera metadata. */
const makeFormat = (id, label, fileType) => ({
  id,
  label,
  extensions: [id],
  async loadData({ file, bytes, url }) {
    const mesh = new SplatMesh({ ...(url ? { url } : { fileBytes: bytes }), fileType, fileName: file?.name });
    await mesh.initialized;
    return mesh;
  },
  async loadMetadata() {
    return null;
  },
});

export const spzFormat = makeFormat("spz", "SPZ", SplatFileType.SPZ);
export const splatFormat = makeFormat("splat", "SPLAT", SplatFileType.SPLAT);
export const ksplatFormat = makeFormat("ksplat", "KSPLAT", SplatFileType.KSPLAT);
