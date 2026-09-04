import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Pressable,
  ScrollView,
  TextInput,
  View,
  type LayoutChangeEvent,
  type NativeSyntheticEvent,
  type ViewProps,
} from "react-native";

import { terminalBufferDelta } from "@t3tools/client-runtime/state/terminal";

import { AppText as Text } from "../../components/AppText";
import { MOBILE_TYPOGRAPHY } from "../../lib/typography";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import {
  getNativeTerminalHardwareKeyRevision,
  resolveNativeTerminalSurfaceView,
} from "./nativeTerminalModule";
import type { TerminalSurfaceContent } from "./terminalBufferReplay";
import {
  buildGhosttyThemeConfig,
  getMobileTerminalTheme,
  type TerminalTheme,
} from "./terminalTheme";
import { terminalDebugLog } from "./terminalDebugLog";

interface TerminalInputEvent {
  readonly data: string;
}

interface TerminalResizeEvent {
  readonly cols: number;
  readonly rows: number;
}

interface TerminalSurfaceProps extends ViewProps {
  readonly terminalKey: string;
  readonly content: TerminalSurfaceContent;
  readonly fontSize?: number;
  readonly isRunning: boolean;
  readonly autoFocus?: boolean;
  readonly keyboardFocusRequest?: number;
  readonly theme?: TerminalTheme;
  readonly onInput: (data: string) => void;
  readonly onResize: (size: { readonly cols: number; readonly rows: number }) => void;
}

function estimateGridSize(input: {
  readonly width: number;
  readonly height: number;
  readonly fontSize: number;
}): { readonly cols: number; readonly rows: number } {
  const cellWidth = input.fontSize * 0.62;
  const cellHeight = input.fontSize * 1.35;
  return {
    cols: Math.max(20, Math.min(400, Math.floor(input.width / cellWidth))),
    rows: Math.max(5, Math.min(200, Math.floor(input.height / cellHeight))),
  };
}

const FallbackTerminalSurface = memo(function FallbackTerminalSurface(props: TerminalSurfaceProps) {
  const fontSize = props.fontSize ?? MOBILE_TYPOGRAPHY.label.fontSize;
  const inputRef = useRef<TextInput>(null);
  const { themeAppearance, themeId } = useAppearancePreferences();
  const theme = props.theme ?? getMobileTerminalTheme(themeId, themeAppearance);
  const statusLabel = props.isRunning
    ? "Native terminal unavailable. Using text fallback."
    : "Open terminal to start a shell.";

  const handleLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    props.onResize(estimateGridSize({ width, height, fontSize }));
  };

  useEffect(() => {
    if ((props.keyboardFocusRequest ?? 0) > 0) {
      inputRef.current?.blur();
      const focusFrame = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(focusFrame);
    }

    return undefined;
  }, [props.keyboardFocusRequest]);

  return (
    <View
      className="flex-1"
      style={[
        {
          backgroundColor: theme.background,
          borderRadius: 8,
          overflow: "hidden",
        },
        props.style,
      ]}
      onLayout={handleLayout}
    >
      <View className="flex-1 px-2.5 py-2">
        <Text
          className="pb-2 text-2xs"
          style={{
            color: theme.mutedForeground,
          }}
        >
          {statusLabel}
        </Text>
        <ScrollView
          className="flex-1"
          contentContainerClassName="pb-3"
          showsVerticalScrollIndicator={false}
        >
          <Text
            selectable
            style={{
              color: theme.foreground,
              fontFamily: "Menlo",
              fontSize,
              lineHeight: Math.round(fontSize * 1.35),
            }}
          >
            {props.content.buffer || "$ "}
          </Text>
        </ScrollView>
      </View>
      <View
        className="flex-row items-center gap-2 border-t p-2"
        style={{
          borderTopColor: theme.border,
        }}
      >
        <TextInput
          ref={inputRef}
          autoCapitalize="none"
          autoCorrect={false}
          blurOnSubmit={false}
          editable={props.isRunning}
          placeholder="type and press return"
          placeholderTextColor={theme.mutedForeground}
          returnKeyType="send"
          className="text-sm"
          style={{
            color: theme.foreground,
            flex: 1,
            fontFamily: "Menlo",
            padding: 0,
          }}
          onSubmitEditing={(event) => {
            const text = event.nativeEvent.text;
            if (text.length > 0) {
              // Terminal Enter is CR. LF is Ctrl+J and raw-mode TUIs can treat it as J.
              props.onInput(`${text}\r`);
            }
          }}
        />
        <Pressable
          disabled={!props.isRunning}
          style={({ pressed }) => ({
            opacity: !props.isRunning ? 0.35 : pressed ? 0.65 : 1,
            paddingHorizontal: 10,
            paddingVertical: 6,
            borderRadius: 8,
            backgroundColor: theme.border,
          })}
          onPress={() => props.onInput("\u0003")}
        >
          <Text className="text-2xs font-t3-bold" style={{ color: theme.foreground }}>
            Ctrl-C
          </Text>
        </Pressable>
      </View>
    </View>
  );
});

export const TerminalSurface = memo(function TerminalSurface(props: TerminalSurfaceProps) {
  const fontSize = props.fontSize ?? MOBILE_TYPOGRAPHY.label.fontSize;
  const { themeAppearance, themeId } = useAppearancePreferences();
  const theme = props.theme ?? getMobileTerminalTheme(themeId, themeAppearance);
  const { onInput, onResize } = props;
  const NativeTerminalSurfaceView = resolveNativeTerminalSurfaceView();
  const hasNativeSurface = Boolean(NativeTerminalSurfaceView);
  const content = props.content;

  // What the native surface has already been handed. A native surface is
  // recreated on font, theme and identity changes, and announces each new one
  // through onSurfaceReady; parking the cursor at null replays into it.
  const deliveredRef = useRef<{ readonly cursor: number; readonly epoch: number } | null>(null);
  const [replayRequest, setReplayRequest] = useState(0);
  const handleSurfaceReady = useCallback(() => {
    deliveredRef.current = null;
    setReplayRequest((request) => request + 1);
  }, []);
  const append = useMemo(
    () => terminalBufferDelta(content, deliveredRef.current),
    // deliveredRef advances after commit, so replayRequest is what re-runs this
    // when the surface asked for a replay but the content itself did not change.
    [content, replayRequest],
  );
  useEffect(() => {
    deliveredRef.current = { cursor: append.cursor, epoch: append.epoch };
  });

  useEffect(() => {
    terminalDebugLog("native:surface", {
      terminalKey: props.terminalKey,
      native: hasNativeSurface,
      // null = installed binary predates native hardware-key handling (rebuild needed).
      hardwareKeyRevision: getNativeTerminalHardwareKeyRevision(),
      bufferLen: content.buffer.length,
      isRunning: props.isRunning,
    });
  }, [content.buffer.length, hasNativeSurface, props.isRunning, props.terminalKey]);
  const handleNativeInput = useCallback(
    (event: NativeSyntheticEvent<TerminalInputEvent>) => {
      if (!props.isRunning) {
        return;
      }
      terminalDebugLog("native:onInput", {
        codes: Array.from(event.nativeEvent.data, (char) => char.codePointAt(0)),
      });
      onInput(event.nativeEvent.data);
    },
    [onInput, props.isRunning],
  );
  const handleNativeResize = useCallback(
    (event: NativeSyntheticEvent<TerminalResizeEvent>) => {
      onResize({
        cols: event.nativeEvent.cols,
        rows: event.nativeEvent.rows,
      });
    },
    [onResize],
  );

  if (NativeTerminalSurfaceView) {
    return (
      <View style={props.style}>
        <NativeTerminalSurfaceView
          appearanceScheme={themeAppearance}
          autoFocus={props.autoFocus ?? true}
          backgroundColor={theme.background}
          focusRequest={props.isRunning ? (props.keyboardFocusRequest ?? 0) : 0}
          foregroundColor={theme.foreground}
          mutedForegroundColor={theme.mutedForeground}
          terminalKey={props.terminalKey}
          append={append}
          fontSize={fontSize}
          style={{ flex: 1 }}
          themeConfig={buildGhosttyThemeConfig(theme)}
          onInput={handleNativeInput}
          onResize={handleNativeResize}
          onSurfaceReady={handleSurfaceReady}
        />
      </View>
    );
  }

  return <FallbackTerminalSurface {...props} fontSize={fontSize} theme={theme} />;
});
