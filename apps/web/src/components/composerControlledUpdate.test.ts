import { $createParagraphNode, $createTextNode, $getRoot, createEditor } from "lexical";
import { describe, expect, it } from "vite-plus/test";

import { applyControlledComposerUpdate } from "./composerControlledUpdate";

describe("controlled composer commits", () => {
  it.each(["Keep this sentence.", "", "Keep this sentence. Add the next sentence."])(
    "publishes the user's edit %j immediately after a controlled update",
    (edited) => {
      const editor = createEditor({
        onError: (error) => {
          throw error;
        },
      });
      const applying = { current: false };
      const published: string[] = [];
      editor.registerUpdateListener(({ editorState }) => {
        if (!applying.current) {
          published.push(editorState.read(() => $getRoot().getTextContent()));
        }
      });

      applyControlledComposerUpdate(editor, applying, () => {
        $getRoot().append(
          $createParagraphNode().append(
            $createTextNode("Keep this sentence. Delete this section."),
          ),
        );
      });
      expect(published).toEqual([]);

      editor.update(
        () => {
          $getRoot()
            .clear()
            .append($createParagraphNode().append($createTextNode(edited)));
        },
        { discrete: true },
      );

      expect(published).toEqual([edited]);
      expect(editor.getEditorState().read(() => $getRoot().getTextContent())).toBe(edited);
    },
  );
});
