/** Keeps suppression of controlled echoes inside the controlled commit itself. */
export function applyControlledComposerUpdate(
  applying: { current: boolean },
  update: () => void,
): void {
  applying.current = true;
  try {
    // Tiptap dispatches synchronously. Suppression must end before another edit.
    update();
  } finally {
    applying.current = false;
  }
}
