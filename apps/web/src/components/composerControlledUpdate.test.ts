import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { describe, expect, it } from "vite-plus/test";

import { applyControlledComposerUpdate } from "./composerControlledUpdate";

describe("controlled composer commits", () => {
  it.each(["Keep this sentence.", "", "Keep this sentence. Add the next sentence."])(
    "publishes the user's edit %j immediately after a controlled update",
    (edited) => {
      const documentFor = (text: string) => ({
        type: "doc",
        content: [{ type: "paragraph", content: text ? [{ type: "text", text }] : [] }],
      });
      const editor = new Editor({
        element: null,
        extensions: [StarterKit],
        content: documentFor(""),
      });
      const applying = { current: false };
      const published: string[] = [];
      editor.on("update", () => {
        if (!applying.current) {
          published.push(editor.getText());
        }
      });

      applyControlledComposerUpdate(applying, () => {
        editor.commands.setContent(documentFor("Keep this sentence. Delete this section."));
      });
      expect(published).toEqual([]);

      editor.commands.setContent(documentFor(edited));

      expect(published).toEqual([edited]);
      expect(editor.getText()).toBe(edited);
      editor.destroy();
    },
  );
});
