import { describe, expect, it } from "vite-plus/test";

import wasmDataUrl from "./vendor/ghostty-vt.wasm?inline";
import writePtyWasmDataUrl from "./vendor/ghostty-write-pty.wasm?inline";
import pinnedVersion from "../../../../../native/libghostty-vt/VERSION?raw";

type WasmFunction = (...args: number[]) => number;

function decodeWasmDataUrl(dataUrl: string): Uint8Array {
  const encoded = dataUrl.split(",", 2)[1];
  if (!encoded) throw new Error("The vendored Ghostty WASM data URL is invalid");
  return Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
}

describe("vendored libghostty-vt WebAssembly", () => {
  it("stays pinned to the canonical revision and size budget", async () => {
    const wasm = decodeWasmDataUrl(wasmDataUrl);
    expect(wasm.byteLength).toBeLessThan(750_000);

    const result = await WebAssembly.instantiate(wasm.buffer as ArrayBuffer, {
      env: { log: () => {} },
    });
    const instance = result instanceof WebAssembly.Instance ? result : result.instance;
    const memory = instance.exports.memory as WebAssembly.Memory;
    const call = (name: string, ...args: number[]) =>
      (instance.exports[name] as WasmFunction)(...args);
    const out = call("ghostty_wasm_alloc_u8_array", 8);
    expect(call("ghostty_build_info", 10, out)).toBe(0);
    const view = new DataView(memory.buffer, out, 8);
    const embeddedRevision = new TextDecoder().decode(
      new Uint8Array(memory.buffer, view.getUint32(0, true), view.getUint32(4, true)),
    );
    call("ghostty_wasm_free_u8_array", out, 8);
    expect(embeddedRevision).toBe(pinnedVersion.trim());
  });

  it("routes terminal-generated replies through the shared callback table", async () => {
    const mainResult = await WebAssembly.instantiate(
      decodeWasmDataUrl(wasmDataUrl).buffer as ArrayBuffer,
      { env: { log: () => {} } },
    );
    const main = mainResult instanceof WebAssembly.Instance ? mainResult : mainResult.instance;
    const memory = main.exports.memory as WebAssembly.Memory;
    let reply = "";
    const trampolineResult = await WebAssembly.instantiate(
      decodeWasmDataUrl(writePtyWasmDataUrl).buffer as ArrayBuffer,
      {
        env: {
          t3_write_pty: (_terminal: number, _userdata: number, pointer: number, length: number) => {
            reply += new TextDecoder().decode(new Uint8Array(memory.buffer, pointer, length));
          },
        },
      },
    );
    const trampoline =
      trampolineResult instanceof WebAssembly.Instance
        ? trampolineResult
        : trampolineResult.instance;
    const table = main.exports.__indirect_function_table as WebAssembly.Table;
    const callbackIndex = table.length;
    table.grow(1, trampoline.exports.ghostty_write_pty as CallableFunction);
    const call = (name: string, ...args: number[]) => (main.exports[name] as WasmFunction)(...args);
    const options = call("ghostty_wasm_alloc_u8_array", 8);
    const optionsView = new DataView(memory.buffer, options, 8);
    optionsView.setUint16(0, 80, true);
    optionsView.setUint16(2, 24, true);
    const terminalSlot = call("ghostty_wasm_alloc_opaque");
    expect(call("ghostty_terminal_new", 0, terminalSlot, options)).toBe(0);
    const terminal = new DataView(memory.buffer).getUint32(terminalSlot, true);
    call("ghostty_terminal_set", terminal, 0, 1);
    call("ghostty_terminal_set", terminal, 1, callbackIndex);
    const query = new TextEncoder().encode("\u001b[5n");
    const queryPointer = call("ghostty_wasm_alloc_u8_array", query.length);
    new Uint8Array(memory.buffer, queryPointer, query.length).set(query);
    call("ghostty_terminal_vt_write", terminal, queryPointer, query.length);

    expect(reply).toBe("\u001b[0n");
    reply = "";
    call("ghostty_terminal_set", terminal, 1, 0);
    call("ghostty_terminal_set", terminal, 0, 0);
    call("ghostty_terminal_vt_write", terminal, queryPointer, query.length);
    expect(reply).toBe("");
    call("ghostty_terminal_set", terminal, 0, 1);
    call("ghostty_terminal_set", terminal, 1, callbackIndex);
    call("ghostty_terminal_vt_write", terminal, queryPointer, query.length);
    expect(reply).toBe("\u001b[0n");
    call("ghostty_wasm_free_u8_array", queryPointer, query.length);
    call("ghostty_terminal_free", terminal);
    call("ghostty_wasm_free_opaque", terminalSlot);
    call("ghostty_wasm_free_u8_array", options, 8);
  });
  it("applies a default 256-color palette and resolves SGR colors through it", async () => {
    const result = await WebAssembly.instantiate(
      decodeWasmDataUrl(wasmDataUrl).buffer as ArrayBuffer,
      { env: { log: () => {} } },
    );
    const instance = result instanceof WebAssembly.Instance ? result : result.instance;
    const memory = instance.exports.memory as WebAssembly.Memory;
    const call = (name: string, ...args: number[]) =>
      (instance.exports[name] as WasmFunction)(...args);
    const alloc = (size: number) => call("ghostty_wasm_alloc_u8_array", size);
    const free = (pointer: number, size: number) =>
      call("ghostty_wasm_free_u8_array", pointer, size);

    const options = alloc(8);
    const optionsView = new DataView(memory.buffer, options, 8);
    optionsView.setUint16(0, 80, true);
    optionsView.setUint16(2, 24, true);
    const terminalSlot = call("ghostty_wasm_alloc_opaque");
    expect(call("ghostty_terminal_new", 0, terminalSlot, options)).toBe(0);
    const terminal = new DataView(memory.buffer).getUint32(terminalSlot, true);

    // A recognizable ramp: entry N is rgb(N, 255 - N, 128).
    const paletteSize = 256 * 3;
    const palette = alloc(paletteSize);
    const paletteBytes = new Uint8Array(memory.buffer, palette, paletteSize);
    for (let index = 0; index < 256; index += 1) {
      paletteBytes.set([index, 255 - index, 128], index * 3);
    }
    expect(call("ghostty_terminal_set", terminal, 14, palette)).toBe(0);

    const readback = alloc(paletteSize);
    expect(call("ghostty_terminal_get", terminal, 21, readback)).toBe(0);
    expect([...new Uint8Array(memory.buffer, readback, 9)]).toEqual([
      0, 255, 128, 1, 254, 128, 2, 253, 128,
    ]);

    // NULL restores the built-in palette, which is how a theme reset would work.
    expect(call("ghostty_terminal_set", terminal, 14, 0)).toBe(0);
    expect(call("ghostty_terminal_get", terminal, 21, readback)).toBe(0);
    expect([...new Uint8Array(memory.buffer, readback, 3)]).not.toEqual([0, 255, 128]);

    free(readback, paletteSize);
    free(palette, paletteSize);
    call("ghostty_terminal_free", terminal);
    call("ghostty_wasm_free_opaque", terminalSlot);
    free(options, 8);
  });
  it("records OSC 133 prompt boundaries per row", async () => {
    const result = await WebAssembly.instantiate(
      decodeWasmDataUrl(wasmDataUrl).buffer as ArrayBuffer,
      { env: { log: () => {} } },
    );
    const instance = result instanceof WebAssembly.Instance ? result : result.instance;
    const memory = instance.exports.memory as WebAssembly.Memory;
    const call = (name: string, ...args: number[]) =>
      (instance.exports[name] as WasmFunction)(...args);
    const alloc = (size: number) => call("ghostty_wasm_alloc_u8_array", size);
    const free = (pointer: number, size: number) =>
      call("ghostty_wasm_free_u8_array", pointer, size);

    const options = alloc(8);
    const optionsView = new DataView(memory.buffer, options, 8);
    optionsView.setUint16(0, 80, true);
    optionsView.setUint16(2, 24, true);
    const terminalSlot = call("ghostty_wasm_alloc_opaque");
    expect(call("ghostty_terminal_new", 0, terminalSlot, options)).toBe(0);
    const terminal = new DataView(memory.buffer).getUint32(terminalSlot, true);

    // What the shell integration emits: prompt, then input, then output.
    const script = "\u001b]133;A\u0007$ \u001b]133;B\u0007echo hi\r\n\u001b]133;C\u0007hi\r\n";
    const bytes = new TextEncoder().encode(script);
    const input = alloc(bytes.length);
    new Uint8Array(memory.buffer, input, bytes.length).set(bytes);
    call("ghostty_terminal_vt_write", terminal, input, bytes.length);
    free(input, bytes.length);

    const renderStateSlot = call("ghostty_wasm_alloc_opaque");
    expect(call("ghostty_render_state_new", 0, renderStateSlot)).toBe(0);
    const renderState = new DataView(memory.buffer).getUint32(renderStateSlot, true);
    expect(call("ghostty_render_state_update", renderState, terminal)).toBe(0);

    const iteratorSlot = call("ghostty_wasm_alloc_opaque");
    expect(call("ghostty_render_state_row_iterator_new", 0, iteratorSlot)).toBe(0);
    // 4 is RENDER_DATA.rowIterator: the render state hands back a bound iterator.
    expect(call("ghostty_render_state_get", renderState, 4, iteratorSlot)).toBe(0);
    const iterator = new DataView(memory.buffer).getUint32(iteratorSlot, true);

    const scratch = alloc(16);
    const semanticOf = () => {
      expect(call("ghostty_render_state_row_get", iterator, 2, scratch)).toBe(0);
      const rawRow = new DataView(memory.buffer, scratch, 8).getBigUint64(0, true);
      new Uint8Array(memory.buffer, scratch + 8, 1)[0] = 255;
      // The row handle is a u64, so it stays a BigInt across the boundary.
      const rowGet = instance.exports.ghostty_row_get as (
        ...args: Array<number | bigint>
      ) => number;
      // 6 is GHOSTTY_ROW_DATA_SEMANTIC_PROMPT.
      expect(rowGet(rawRow, 6, scratch + 8)).toBe(0);
      return new Uint8Array(memory.buffer, scratch + 8, 1)[0];
    };

    const semantics: number[] = [];
    // `_next` returns non-zero while rows remain.
    while (call("ghostty_render_state_row_iterator_next", iterator) !== 0) {
      semantics.push(semanticOf()!);
      if (semantics.length === 3) break;
    }

    // Row 0 carries the prompt and the typed command; row 1 is command output.
    expect(semantics[0]).toBe(1);
    expect(semantics[1]).toBe(0);

    free(scratch, 16);
    call("ghostty_wasm_free_opaque", iteratorSlot);
    call("ghostty_wasm_free_opaque", renderStateSlot);
    call("ghostty_terminal_free", terminal);
    call("ghostty_wasm_free_opaque", terminalSlot);
    free(options, 8);
  });
});
