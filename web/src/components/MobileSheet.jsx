/**
 * Mobile sheet component for portrait orientation.
 * Swipeable bottom sheet drawer with drag handle interaction.
 */

import { useRef, useCallback, useState } from 'preact/hooks';
import useSwipe from '../utils/useSwipe';
import { useStore } from '../store';
import CameraControls from './CameraControls';
import DebugSettings from './DebugSettings';
import AnimationSettings from './AnimationSettings';
import StorageSourceList from './StorageSourceList';
import { loadFromStorageSource } from '../fileLoader';

/** File input accept attribute value */

/** Minimum swipe distance to trigger open/close */
const SWIPE_THRESHOLD = 50;

function MobileSheet() {
  // Store state
  const panelOpen = useStore((state) => state.panelOpen);
  const togglePanel = useStore((state) => state.togglePanel);

  // Refs
  const dragHandleRef = useRef(null);

  const handleSelectSource = useCallback((source) => {
    // Load assets from selected source
    loadFromStorageSource(source);
  }, []);

  /**
   * Handle drag handle click to toggle
   */
  const handleDragHandleClick = useCallback(() => {
    togglePanel();
  }, [togglePanel]);

  // useSwipe on the drag handle to detect vertical swipes
  useSwipe(dragHandleRef, {
    direction: 'vertical',
    threshold: SWIPE_THRESHOLD,
    allowCross: 50,
    onSwipe: ({ dir }) => {
      if (dir === 'up' && !panelOpen) togglePanel();
      if (dir === 'down' && panelOpen) togglePanel();
    }
  });

  return (
    <div class={`mobile-sheet ${panelOpen ? 'open' : 'closed'}`}>
      {/* Drag handle with enlarged touch target - outside scroll container */}
      <div class="drag-handle" ref={dragHandleRef}>
        <div 
          class="drag-handle-touch-target"
          onClick={handleDragHandleClick}
        />
        <div class="drag-handle-bar" />
      </div>
      
      {/* Scrollable content container */}
      <div class="mobile-sheet-content">
        <CameraControls />
        <AnimationSettings />
        <StorageSourceList 
          onSelectSource={handleSelectSource}
        />
                <DebugSettings />

        {/* <AssetGallery /> */}
      </div>

    </div>
  );
}

export default MobileSheet;
