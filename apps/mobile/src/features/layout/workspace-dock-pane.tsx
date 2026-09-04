import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useKeyboardState } from "react-native-keyboard-controller";

import { constrainDockPaneHeight, type WorkspaceDockPaneLayout } from "../../lib/layout";
import { WORKSPACE_PANE_TIMING } from "./workspace-pane-animation";
import { WorkspacePaneDivider } from "./workspace-pane-divider";

/**
 * The bottom dock: resize divider + animated reveal, rendered BELOW the
 * navigator inside the content column so the docked surface spans the chat
 * pane only (the sidebar and the trailing inspector keep their full height).
 *
 * Height changes reflow the chat feed's scroll viewport but never re-wrap its
 * text, so — unlike the trailing column — the pane animates its real height
 * instead of clipping a frozen layout.
 */
export function WorkspaceDockPane(props: {
  /**
   * When false the pane animates closed but keeps its content mounted for the
   * exit transition. `onClosed` fires once that settles.
   */
  readonly active?: boolean;
  readonly dock: WorkspaceDockPaneLayout;
  readonly onClosed?: () => void;
  readonly renderDock?: () => ReactNode;
  readonly setDockPaneHeight: (height: number) => void;
  readonly viewportHeight: number;
}) {
  const { dock, setDockPaneHeight, viewportHeight } = props;
  const dockHeight = dock.height;
  const dockSupported = props.renderDock !== undefined && dockHeight !== null;
  const dockVisible = dockSupported && (props.active ?? true);
  const resizeStartHeight = useRef(0);
  const [resizing, setResizing] = useState(false);
  // A docked terminal sits where the software keyboard appears. Growing the
  // pane by the keyboard height (and padding it back out) keeps the visible
  // surface the same size, shifted above the keyboard.
  const keyboardHeight = useKeyboardState((state) => (state.isVisible ? state.height : 0));
  const targetHeight = dockVisible ? (dockHeight ?? 0) + keyboardHeight : 0;

  const renderedHeight = useSharedValue(targetHeight);
  const onClosed = props.onClosed;
  useEffect(() => {
    if (resizing) {
      renderedHeight.value = targetHeight;
      return;
    }
    renderedHeight.value = withTiming(targetHeight, WORKSPACE_PANE_TIMING, (finished) => {
      if (finished === true && !dockVisible && onClosed !== undefined) {
        runOnJS(onClosed)();
      }
    });
  }, [dockVisible, onClosed, renderedHeight, resizing, targetHeight]);

  const dockStyle = useAnimatedStyle(() => ({ height: renderedHeight.value }), []);

  const beginResize = useCallback(() => {
    resizeStartHeight.current = dockHeight ?? 0;
    setResizing(true);
  }, [dockHeight]);
  const resizeBy = useCallback(
    (delta: number) => {
      setDockPaneHeight(
        constrainDockPaneHeight({
          // Dragging the divider UP grows the dock, so the gesture delta is
          // inverted by the divider's resizeDirection before it lands here.
          preferredHeight: resizeStartHeight.current + delta,
          availableHeight: viewportHeight,
        }),
      );
    },
    [setDockPaneHeight, viewportHeight],
  );
  const endResize = useCallback(() => {
    setResizing(false);
  }, []);

  if (!dockSupported) {
    return null;
  }

  return (
    <>
      {dockVisible ? (
        <WorkspacePaneDivider
          accessibilityLabel="Resize terminal dock"
          axis="y"
          currentWidth={dockHeight ?? 0}
          resizeDirection={-1}
          onResizeStart={beginResize}
          onResizeBy={resizeBy}
          onResizeEnd={endResize}
        />
      ) : null}
      <Animated.View
        className="shrink-0 overflow-hidden"
        accessibilityElementsHidden={!dockVisible}
        collapsable={false}
        importantForAccessibility={dockVisible ? "auto" : "no-hide-descendants"}
        pointerEvents={dockVisible ? "auto" : "none"}
        style={dockStyle}
      >
        <Animated.View className="flex-1" style={{ paddingBottom: keyboardHeight }}>
          {props.renderDock?.()}
        </Animated.View>
      </Animated.View>
    </>
  );
}
