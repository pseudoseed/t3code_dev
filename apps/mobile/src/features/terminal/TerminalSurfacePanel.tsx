import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";
import {
  KeyboardController,
  KeyboardEvents,
  KeyboardStickyView,
  useKeyboardState,
} from "react-native-keyboard-controller";

import { SymbolView } from "../../components/AppSymbol";
import {
  ComposerToolbarButton,
  ComposerToolbarRow,
  ComposerToolbarScroller,
} from "../../components/ComposerToolbar";
import { GlassSurface } from "../../components/GlassSurface";
import { TerminalSurface } from "./NativeTerminalSurface";
import type { TerminalSurfaceContent } from "./terminalBufferReplay";
import type { TerminalTheme } from "./terminalTheme";
import type { TerminalPendingModifier } from "./useThreadTerminalSession";

const TERMINAL_ACCESSORY_HEIGHT = 52;
const SHOWCASE_ENABLED = process.env.EXPO_PUBLIC_SHOWCASE === "1";

type HostPlatform = "mac" | "linux" | "windows" | "unknown";

type TerminalToolbarAction =
  | { readonly kind: "send"; readonly key: string; readonly label: string; readonly data: string }
  | { readonly kind: "clear"; readonly key: string; readonly label: string }
  | {
      readonly kind: "modifier";
      readonly key: string;
      readonly label: string;
      readonly modifier: TerminalPendingModifier;
    };

export function inferTerminalHostPlatform(environmentLabel: string | null): HostPlatform {
  const value = environmentLabel?.toLowerCase() ?? "";
  if (
    value.includes("mac") ||
    value.includes("macbook") ||
    value.includes("mac mini") ||
    value.includes("imac") ||
    value.includes("darwin")
  ) {
    return "mac";
  }
  if (value.includes("windows") || value.includes("win")) {
    return "windows";
  }
  if (value.includes("linux") || value.includes("ubuntu") || value.includes("debian")) {
    return "linux";
  }

  return "unknown";
}

/** Pinned to the keyboard on a full screen; in normal flow inside a dock. */
function AccessoryContainer(props: { readonly children: ReactNode; readonly hosted: boolean }) {
  if (props.hosted) {
    return <>{props.children}</>;
  }

  return (
    <KeyboardStickyView
      style={{ position: "absolute", bottom: 0, left: 0, right: 0 }}
      offset={{ closed: 0, opened: 0 }}
    >
      {props.children}
    </KeyboardStickyView>
  );
}

/**
 * The pty surface plus its soft-keyboard chrome, with no opinion about the
 * container: the full-screen terminal route and the workspace terminal pane
 * both render this and supply their own header and navigation.
 */
export function TerminalSurfacePanel(props: {
  readonly autoFocus?: boolean;
  readonly content: TerminalSurfaceContent;
  /**
   * "inset" pads the surface above the software keyboard and pins the key
   * accessory to it — the full-screen route. "hosted" leaves both to the
   * container, for a docked pane that already moves above the keyboard.
   */
  readonly keyboardMode?: "inset" | "hosted";
  readonly environmentLabel: string | null;
  readonly fontSize: number;
  readonly isRunning: boolean;
  readonly onClear: () => void;
  readonly onInput: (data: string) => void;
  readonly onResize: (size: { readonly cols: number; readonly rows: number }) => void;
  readonly onToggleModifier: (modifier: TerminalPendingModifier) => void;
  readonly pendingModifier: TerminalPendingModifier | null;
  readonly terminalKey: string;
  readonly theme: TerminalTheme;
}) {
  const { onClear, onInput, onToggleModifier, theme } = props;
  const [keyboardFocusRequest, setKeyboardFocusRequest] = useState(0);
  const [isAccessoryDismissed, setIsAccessoryDismissed] = useState(false);
  const hostPlatform = useMemo(
    () => inferTerminalHostPlatform(props.environmentLabel),
    [props.environmentLabel],
  );
  const keyboardState = useKeyboardState((state) => ({
    height: state.height,
    isVisible: state.isVisible,
  }));
  const isHosted = props.keyboardMode === "hosted";
  const isAccessoryVisible = keyboardState.isVisible && !isAccessoryDismissed;
  const bottomInset = isHosted
    ? 0
    : (keyboardState.isVisible ? keyboardState.height : 0) +
      (isAccessoryVisible ? TERMINAL_ACCESSORY_HEIGHT : 0);

  useEffect(() => {
    const keyboardWillShow = KeyboardEvents.addListener("keyboardWillShow", () => {
      setIsAccessoryDismissed(false);
    });
    const keyboardWillHide = KeyboardEvents.addListener("keyboardWillHide", () => {
      setIsAccessoryDismissed(true);
    });

    return () => {
      keyboardWillShow.remove();
      keyboardWillHide.remove();
    };
  }, []);

  const toolbarActions = useMemo<ReadonlyArray<TerminalToolbarAction>>(() => {
    const modifierActions: ReadonlyArray<TerminalToolbarAction> =
      hostPlatform === "mac"
        ? [
            { kind: "modifier", key: "cmd", label: "cmd", modifier: "meta" },
            { kind: "modifier", key: "ctrl", label: "ctrl", modifier: "ctrl" },
          ]
        : [
            { kind: "modifier", key: "ctrl", label: "ctrl", modifier: "ctrl" },
            { kind: "modifier", key: "alt", label: "alt", modifier: "meta" },
          ];

    return [
      { kind: "send", key: "esc", label: "esc", data: "\u001b" },
      ...modifierActions,
      { kind: "send", key: "tab", label: "tab", data: "\t" },
      { kind: "clear", key: "clear", label: "clear" },
      { kind: "send", key: "up", label: "\u2191", data: "\u001b[A" },
      { kind: "send", key: "down", label: "\u2193", data: "\u001b[B" },
      { kind: "send", key: "left", label: "\u2190", data: "\u001b[D" },
      { kind: "send", key: "right", label: "\u2192", data: "\u001b[C" },
      { kind: "send", key: "tilde", label: "~", data: "~" },
      { kind: "send", key: "pipe", label: "|", data: "|" },
      { kind: "send", key: "slash", label: "/", data: "/" },
      { kind: "send", key: "dash", label: "-", data: "-" },
    ];
  }, [hostPlatform]);

  const handleToolbarActionPress = useCallback(
    (action: TerminalToolbarAction) => {
      if (action.kind === "modifier") {
        onToggleModifier(action.modifier);
        return;
      }
      if (action.kind === "clear") {
        onClear();
        return;
      }
      onInput(action.data);
    },
    [onClear, onInput, onToggleModifier],
  );

  const handleDismissKeyboard = useCallback(() => {
    setIsAccessoryDismissed(true);
    void KeyboardController.dismiss();
  }, []);

  const handleShowKeyboard = useCallback(() => {
    setKeyboardFocusRequest((current) => current + 1);
  }, []);

  return (
    <>
      <View className="flex-1" style={{ paddingBottom: bottomInset }}>
        <TerminalSurface
          autoFocus={(props.autoFocus ?? true) && !SHOWCASE_ENABLED}
          content={props.content}
          fontSize={props.fontSize}
          isRunning={props.isRunning}
          keyboardFocusRequest={keyboardFocusRequest}
          onInput={onInput}
          onResize={props.onResize}
          style={{ flex: 1 }}
          terminalKey={props.terminalKey}
          theme={theme}
        />
      </View>

      {isAccessoryVisible ? (
        <AccessoryContainer hosted={isHosted}>
          <View
            className="border-t"
            style={{
              backgroundColor: theme.background,
              borderTopColor: theme.border,
              minHeight: TERMINAL_ACCESSORY_HEIGHT,
            }}
          >
            <ComposerToolbarRow paddingBottom={4} paddingHorizontal={8} paddingTop={4}>
              <ComposerToolbarScroller
                contentPaddingRight={2}
                fadeOpaque={theme.background}
                fadeTransparent={`${theme.background}00`}
              >
                {toolbarActions.map((action) => {
                  const active =
                    action.kind === "modifier" && props.pendingModifier === action.modifier;

                  return (
                    <ComposerToolbarButton
                      key={action.key}
                      active={active}
                      label={action.label}
                      maxWidth={120}
                      minWidth={action.label.length > 1 ? 56 : 44}
                      onPress={() => handleToolbarActionPress(action)}
                      showChevron={false}
                      textTransform={
                        action.kind === "modifier" || action.kind === "clear" ? "uppercase" : "none"
                      }
                    />
                  );
                })}
              </ComposerToolbarScroller>
              <ComposerToolbarButton
                accessibilityLabel="Dismiss keyboard"
                icon={{ ios: "keyboard.chevron.compact.down", android: "keyboard_hide" }}
                onPress={handleDismissKeyboard}
                showChevron={false}
              />
            </ComposerToolbarRow>
          </View>
        </AccessoryContainer>
      ) : !keyboardState.isVisible ? (
        <Pressable
          accessibilityLabel="Show keyboard"
          accessibilityRole="button"
          onPress={handleShowKeyboard}
          style={({ pressed }) => ({
            bottom: 16,
            borderRadius: 28,
            opacity: pressed ? 0.72 : 1,
            position: "absolute",
            right: 16,
          })}
        >
          <GlassSurface
            chrome="none"
            glassEffectStyle="regular"
            tintColor="transparent"
            style={{
              alignItems: "center",
              borderRadius: 24,
              height: 48,
              justifyContent: "center",
              width: 48,
            }}
            pointerEvents="none"
          >
            <SymbolView
              name={{ ios: "keyboard", android: "keyboard" }}
              size={20}
              tintColor={theme.foreground}
              type="monochrome"
            />
          </GlassSurface>
        </Pressable>
      ) : null}
    </>
  );
}
