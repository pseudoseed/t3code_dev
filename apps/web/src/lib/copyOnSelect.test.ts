import { describe, expect, it } from "vite-plus/test";

import { resolveCopyOnSelectText } from "./copyOnSelect";

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

interface FakeElement {
  nodeType: number;
  parentElement: FakeElement | null;
  editable: boolean;
  closest(selector: string): FakeElement | null;
  contains(node: unknown): boolean;
}

/**
 * Minimal stand-ins for the two node shapes the rules care about: an element
 * that may sit inside an editable region, and a text node that reaches its
 * element through `parentElement`. `contains` answers by walking parents, so
 * scoping is exercised the way the browser resolves it.
 */
function makeElement(input: { editable?: boolean; parent?: FakeElement | null } = {}): FakeElement {
  const element: FakeElement = {
    nodeType: ELEMENT_NODE,
    parentElement: input.parent ?? null,
    editable: input.editable ?? false,
    closest(_selector: string) {
      let current: FakeElement | null = element;
      while (current !== null) {
        if (current.editable) return current;
        current = current.parentElement;
      }
      return null;
    },
    contains(node: unknown) {
      let current = node as FakeElement | null;
      while (current !== null && current !== undefined) {
        if (current === element) return true;
        current = current.parentElement;
      }
      return false;
    },
  };
  return element;
}

function makeTextNode(parent: FakeElement) {
  return { nodeType: TEXT_NODE, parentElement: parent } as unknown as Node;
}

const asScope = (element: FakeElement) => element as unknown as Element;

describe("resolveCopyOnSelectText", () => {
  it("copies text selected entirely inside the scope", () => {
    const scope = makeElement();
    const message = makeElement({ parent: scope });
    const node = makeTextNode(message);

    expect(
      resolveCopyOnSelectText(
        { text: "  indented line", isCollapsed: false, anchorNode: node, focusNode: node },
        asScope(scope),
      ),
    ).toBe("  indented line");
  });

  it("copies nothing for a click that leaves the selection collapsed", () => {
    const scope = makeElement();
    const node = makeTextNode(makeElement({ parent: scope }));

    expect(
      resolveCopyOnSelectText(
        { text: "", isCollapsed: true, anchorNode: node, focusNode: node },
        asScope(scope),
      ),
    ).toBeNull();
  });

  it("copies nothing when the selection is only whitespace", () => {
    const scope = makeElement();
    const node = makeTextNode(makeElement({ parent: scope }));

    expect(
      resolveCopyOnSelectText(
        { text: "  \n ", isCollapsed: false, anchorNode: node, focusNode: node },
        asScope(scope),
      ),
    ).toBeNull();
  });

  it("copies nothing when the selection runs outside the scope", () => {
    const scope = makeElement();
    const inside = makeTextNode(makeElement({ parent: scope }));
    const outside = makeTextNode(makeElement());

    expect(
      resolveCopyOnSelectText(
        { text: "half in, half out", isCollapsed: false, anchorNode: inside, focusNode: outside },
        asScope(scope),
      ),
    ).toBeNull();
  });

  it("copies nothing when either end sits in an editable region", () => {
    const scope = makeElement();
    const composer = makeElement({ parent: scope, editable: true });
    const draft = makeTextNode(composer);
    const message = makeTextNode(makeElement({ parent: scope }));

    expect(
      resolveCopyOnSelectText(
        { text: "my own draft", isCollapsed: false, anchorNode: draft, focusNode: draft },
        asScope(scope),
      ),
    ).toBeNull();
    expect(
      resolveCopyOnSelectText(
        { text: "spans into the draft", isCollapsed: false, anchorNode: message, focusNode: draft },
        asScope(scope),
      ),
    ).toBeNull();
  });

  it("copies nothing before the scope element mounts", () => {
    const scope = makeElement();
    const node = makeTextNode(makeElement({ parent: scope }));

    expect(
      resolveCopyOnSelectText(
        { text: "orphaned", isCollapsed: false, anchorNode: node, focusNode: node },
        null,
      ),
    ).toBeNull();
    expect(resolveCopyOnSelectText(null, asScope(scope))).toBeNull();
  });
});
