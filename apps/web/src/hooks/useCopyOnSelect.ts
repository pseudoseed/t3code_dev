import { useEffect } from "react";

import { resolveCopyOnSelectText } from "~/lib/copyOnSelect";

import { writeTextToClipboard } from "./useCopyToClipboard";

/**
 * Copies a pointer-made text selection when the drag that made it ends.
 *
 * Scoped to `scope`: the gesture must start inside it and both ends of the
 * resulting selection must land inside it, which is what keeps the behavior in
 * the thread transcript instead of loose across the app. Passing
 * `enabled: false` detaches the listeners, so the setting toggles without
 * remounting the view.
 */
export function useCopyOnSelect(input: {
  enabled: boolean;
  scope: HTMLElement | null;
  target?: string;
}): void {
  const { enabled, scope } = input;
  const target = input.target ?? "selection";

  useEffect(() => {
    if (!enabled || scope === null) return;

    let gestureActive = false;
    let frame: number | null = null;

    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      gestureActive = event.button === 0 && target !== null && scope.contains(target);
    };

    const onMouseUp = () => {
      if (!gestureActive) return;
      gestureActive = false;
      // Reading synchronously here can return the pre-drag range: the
      // selection is not guaranteed to have settled by the time mouseup
      // dispatches. One frame later it has.
      frame = window.requestAnimationFrame(() => {
        frame = null;
        const selection = window.getSelection();
        const text = resolveCopyOnSelectText(
          selection === null
            ? null
            : {
                text: selection.toString(),
                isCollapsed: selection.isCollapsed,
                anchorNode: selection.anchorNode,
                focusNode: selection.focusNode,
              },
          scope,
        );
        if (text === null) return;
        // Copy-on-select is silent by design, so a denied clipboard permission
        // has nowhere to report to and must not surface as an unhandled
        // rejection on a gesture the user makes constantly.
        void writeTextToClipboard(text, target).catch(() => {});
      });
    };

    // mouseup binds to the window because a drag routinely ends outside the
    // element it started in; the scope checks above still decide what copies.
    scope.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      scope.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [enabled, scope, target]);
}
