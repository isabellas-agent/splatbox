/**
 * Source registry
 *
 * Keeps the runtime instances of the server collections (one source per
 * collection). Collections are discovered from the server on every start, so
 * nothing is persisted in the browser.
 */

/** Active source instances (runtime only) */
const activeSources = new Map();

/** Event listeners for source changes */
const listeners = new Set();

const notifyListeners = (event, sourceId) => {
  listeners.forEach((listener) => {
    try {
      listener(event, sourceId);
    } catch (err) {
      console.warn('Source change listener error:', err);
    }
  });
};

/**
 * Subscribe to source changes.
 * @param {Function} listener - Callback receiving (event, sourceId)
 * @returns {Function} Unsubscribe function
 */
export const onSourceChange = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Register an active source instance. */
export const registerSource = (source) => {
  activeSources.set(source.id, source);
  notifyListeners('added', source.id);
};

/** Unregister an active source instance. */
export const unregisterSource = (sourceId) => {
  const source = activeSources.get(sourceId);
  if (source) {
    source.disconnect?.();
    activeSources.delete(sourceId);
    notifyListeners('removed', sourceId);
  }
};

/** Remove a source from the registry (kept for API compatibility). */
export const deleteSource = async (sourceId) => {
  unregisterSource(sourceId);
  return true;
};

/** Record access to a source (no-op; nothing is persisted). */
export const touchSource = async () => {};

export const getSource = (sourceId) => activeSources.get(sourceId);

export const getAllSources = () => new Map(activeSources);

export const getSourcesArray = () => Array.from(activeSources.values());
