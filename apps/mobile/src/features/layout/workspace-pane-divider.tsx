import { useEffectEvent, useMemo, useState } from "react";
import { Platform, Pressable, StyleSheet, View, type AccessibilityActionEvent } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { runOnJS } from "react-native-reanimated";
import { cn } from "../../lib/cn";

const ACCESSIBILITY_RESIZE_STEP = 24;

interface WorkspacePaneDividerProps {
  readonly accessibilityLabel: string;
  /** "x" resizes a side column's width, "y" a docked pane's height. */
  readonly axis?: "x" | "y";
  readonly currentWidth: number;
  readonly resizeDirection: 1 | -1;
  readonly onResizeStart?: () => void;
  readonly onResizeBy: (delta: number) => void;
  readonly onResizeEnd?: () => void;
}

export function WorkspacePaneDivider(props: WorkspacePaneDividerProps) {
  const axis = props.axis ?? "x";
  const [hovered, setHovered] = useState(false);
  const [dragging, setDragging] = useState(false);
  // The pan callbacks fire after render, so effect events read the latest props
  // while the gesture object stays stable across renders.
  const handleResizeStart = useEffectEvent(() => {
    setDragging(true);
    props.onResizeStart?.();
  });
  const handleResize = useEffectEvent((translationX: number) => {
    props.onResizeBy(translationX * props.resizeDirection);
  });
  const handleResizeEnd = useEffectEvent(() => {
    setDragging(false);
    props.onResizeEnd?.();
  });
  const resizeGesture = useMemo(
    () =>
      (axis === "x"
        ? Gesture.Pan().activeOffsetX([-4, 4]).failOffsetY([-24, 24])
        : Gesture.Pan().activeOffsetY([-4, 4]).failOffsetX([-24, 24])
      )
        .onStart(() => {
          runOnJS(handleResizeStart)();
        })
        .onUpdate((event) => {
          runOnJS(handleResize)(axis === "x" ? event.translationX : event.translationY);
        })
        .onFinalize(() => {
          runOnJS(handleResizeEnd)();
        }),
    [axis],
  );

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
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        onAccessibilityAction={handleAccessibilityAction}
      >
        <View
          className={cn(
            "self-center bg-border opacity-70",
            axis === "x" ? "h-full" : "w-full",
            hovered || dragging ? "bg-primary opacity-100" : "",
            Platform.OS === "android" && !dragging && "opacity-0",
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
