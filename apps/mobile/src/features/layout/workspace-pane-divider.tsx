import { useCallback, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, View, type AccessibilityActionEvent } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { runOnJS } from "react-native-reanimated";
import { cn } from "../../lib/cn";

const ACCESSIBILITY_RESIZE_STEP = 24;

interface WorkspacePaneDividerProps {
  readonly accessibilityLabel: string;
  /** "x" resizes a side column's width, "y" a docked pane's height. */
  readonly axis?: "x" | "y";
  readonly currentWidth: number;
  /** 1 when dragging right/down grows the pane, -1 when the opposite does. */
  readonly resizeDirection: 1 | -1;
  readonly onResizeStart?: () => void;
  readonly onResizeBy: (delta: number) => void;
  readonly onResizeEnd?: () => void;
}

/** A forgiving divider target for touch, pointer, and VoiceOver users. */
export function WorkspacePaneDivider(props: WorkspacePaneDividerProps) {
  const latestProps = useRef(props);
  latestProps.current = props;
  const [hovered, setHovered] = useState(false);
  const [dragging, setDragging] = useState(false);
  const handleResizeStart = useCallback(() => {
    setDragging(true);
    latestProps.current.onResizeStart?.();
  }, []);
  const handleResize = useCallback((translation: number) => {
    latestProps.current.onResizeBy(translation * latestProps.current.resizeDirection);
  }, []);
  const handleResizeEnd = useCallback(() => {
    setDragging(false);
    latestProps.current.onResizeEnd?.();
  }, []);
  const axis = props.axis ?? "x";
  const resizeGesture = useMemo(() => {
    const pan = Gesture.Pan()
      .onStart(() => {
        runOnJS(handleResizeStart)();
      })
      .onUpdate((event) => {
        runOnJS(handleResize)(axis === "x" ? event.translationX : event.translationY);
      })
      .onFinalize(() => {
        runOnJS(handleResizeEnd)();
      });

    return axis === "x"
      ? pan.activeOffsetX([-4, 4]).failOffsetY([-24, 24])
      : pan.activeOffsetY([-4, 4]).failOffsetX([-24, 24]);
  }, [axis, handleResize, handleResizeEnd, handleResizeStart]);

  const handleAccessibilityAction = (event: AccessibilityActionEvent) => {
    props.onResizeStart?.();
    if (event.nativeEvent.actionName === "increment") {
      props.onResizeBy(ACCESSIBILITY_RESIZE_STEP);
    } else if (event.nativeEvent.actionName === "decrement") {
      props.onResizeBy(-ACCESSIBILITY_RESIZE_STEP);
    }
    props.onResizeEnd?.();
  };

  return (
    <GestureDetector gesture={resizeGesture}>
      <Pressable
        className={cn(
          "relative z-[100] cursor-pointer",
          axis === "x"
            ? "-mx-[22px] w-11 self-stretch justify-center"
            : "-my-[22px] h-11 self-stretch items-center justify-center",
        )}
        accessibilityActions={[
          {
            name: "increment",
            label: axis === "x" ? "Make pane wider" : "Make pane taller",
          },
          {
            name: "decrement",
            label: axis === "x" ? "Make pane narrower" : "Make pane shorter",
          },
        ]}
        accessibilityLabel={props.accessibilityLabel}
        accessibilityRole="adjustable"
        accessibilityValue={{
          now: Math.round(props.currentWidth),
          text: `${Math.round(props.currentWidth)} points ${axis === "x" ? "wide" : "tall"}`,
        }}
        onAccessibilityAction={handleAccessibilityAction}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
      >
        <View
          className={cn(
            "self-center bg-border opacity-70",
            axis === "x" ? "h-full" : "w-full",
            hovered || dragging ? "bg-primary opacity-100" : "",
          )}
          style={[
            axis === "x" ? styles.line : styles.horizontalLine,
            (hovered || dragging) &&
              (axis === "x" ? styles.activeLine : styles.activeHorizontalLine),
          ]}
        />
      </Pressable>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  line: {
    alignSelf: "center",
    height: "100%",
    width: StyleSheet.hairlineWidth,
  },
  activeLine: {
    width: 2,
  },
  horizontalLine: {
    alignSelf: "center",
    height: StyleSheet.hairlineWidth,
    width: "100%",
  },
  activeHorizontalLine: {
    height: 2,
  },
});
