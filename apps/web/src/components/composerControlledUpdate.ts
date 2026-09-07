import type { EditorUpdateOptions, LexicalEditor } from "lexical";

/** Keeps suppression of controlled echoes inside the controlled commit itself. */
export function applyControlledComposerUpdate(
  editor: LexicalEditor,
  applying: { current: boolean },
  update: () => void,
  options?: EditorUpdateOptions,
): void {
  applying.current = true;
  try {
    // A deferred commit can absorb a user edit into the suppressed update.
    editor.update(update, { ...options, discrete: true });
  } finally {
    applying.current = false;
  }
}
