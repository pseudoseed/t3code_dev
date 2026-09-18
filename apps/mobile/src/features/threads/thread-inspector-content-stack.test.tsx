import { act, useEffect, useState } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({ View: "view" }));

import { ThreadInspectorContentStack } from "./thread-inspector-content-stack";

it("keeps a terminal mounted and its local state when chat changes its render callback", async () => {
  let mounts = 0;
  let unmounts = 0;
  let type: (value: string) => void = () => {};
  function Terminal({ turn }: { turn: number }) {
    const [input, setInput] = useState("");
    type = setInput;
    useEffect(() => {
      mounts += 1;
      return () => {
        unmounts += 1;
      };
    }, []);
    return <span>{`${turn}:${input}`}</span>;
  }
  const empty = () => null;
  function Chat({ turn }: { turn: number }) {
    return (
      <ThreadInspectorContentStack
        mode="terminal"
        Files={empty}
        Git={empty}
        Terminal={() => <Terminal turn={turn} />}
      />
    );
  }
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<Chat turn={0} />);
  });
  try {
    await act(async () => {
      type("echo still here");
    });
    await act(async () => {
      renderer.update(<Chat turn={1} />);
    });
    expect(renderer.root.findByType("span").children).toEqual(["1:echo still here"]);
    expect(mounts).toBe(1);
    expect(unmounts).toBe(0);
  } finally {
    await act(async () => renderer.unmount());
  }
});
