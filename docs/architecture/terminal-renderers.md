# Terminal renderers

Terminal sessions remain server-owned PTYs. Clients receive the existing raw byte stream and send
input and resize events over the existing terminal contracts; renderer choices never cross the
wire.

## Delivering output

`packages/client-runtime` accumulates the stream into one buffer per session, capped in bytes, and
tags it with a cursor (units appended) and a trim count (units dropped off the front). A renderer
records the cursor it last wrote and asks `terminalBufferDelta` for the rest, so catching up costs
the size of the new output rather than the size of the session. Trimming drops well under the cap
so it happens once per many chunks, and it does not force a replay: only a cleared or restarted
session bumps the epoch, and only a renderer that fell behind the trim point has to start over.

Renderers hold no second copy of the scrollback. The native mobile surfaces are recreated on font,
theme and identity changes, and each new one emits `onSurfaceReady`, which is what makes the client
resend history into it.

## Ghostty alignment

Android and web use the official `libghostty-vt` C ABI for parsing, terminal state, grapheme
boundaries, keyboard encoding, selection, and scrollback:

- Android links the native shared library and converts render state into a compact JNI snapshot.
- Web loads a separately cached WebAssembly build and reads render state into a Canvas 2D surface.
- Both artifacts are built from the revision in
  `native/libghostty-vt/VERSION`.

The platform adapters deliberately own only platform behavior. Android owns its Kotlin Canvas and
touch integration. Web owns browser font shaping, the hidden IME textarea, clipboard and DOM input,
and its Canvas renderer. The web adapter also delegates application mouse encoding, word and line
selection, and OSC 8 hyperlink metadata to the official ABI. Browser conventions remain available:
holding Shift bypasses application mouse capture, and the platform link modifier opens hyperlinks.
React does not participate in terminal frames.

The web runtime is singleton-scoped per browser tab so split terminals share one compiled module
and memory. Each visible terminal owns and frees its own terminal, render state, row iterator, cell
iterator, key and mouse encoder, and input event handles. Restoring captured scrollback temporarily
detaches the PTY callback so historical device queries cannot emit replies into the current shell.

## Updating Ghostty

Update and rebuild Android first, because mobile's `VERSION` file is the single source of truth for
the upstream pin (the upstream `LICENSE` lives beside it). Then run:

```sh
pnpm --dir apps/web build:ghostty-wasm
```

Commit the regenerated web `wasm` artifacts. The build embeds the pinned revision into the binary as
semver build metadata, and the focused web ABI test reads it back through `ghostty_build_info` and
compares it against mobile's `VERSION` — so the web vendor directory holds only the artifacts, drift
cannot hide, and there is no second pin to keep in sync. The same test enforces the artifact budget
and exercises repeated create/write/free cycles with multi-codepoint graphemes.
