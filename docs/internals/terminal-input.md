# Terminal input and selection adapters

Terminal input belongs to the renderer adapter. The server owns the PTY and forwards bytes;
provider adapters are not involved. Full-screen and docked mobile terminals use the same native
surface. Web and desktop use the same Canvas surface, with desktop additionally exposing Electron
Edit and context-menu actions. Local, LAN, relay, and tunnel connections use the same input contract.

## iOS embedded Ghostty ABI

`ghostty_surface_key` expects Apple virtual keycodes on iOS, as defined by the pinned fork's
`src/input/keycodes.zig`. Its `keycode` field is not a `ghostty_input_key_e` value and is not a UIKit
HID usage. `TerminalHardwareKeyEncoder` owns this translation. Ghostty encodes navigation and
control-letter keys against the active terminal modes; Option/Command line editing uses the
same readline sequences as web.

UIKit's `UIKeyCommand.inputDelete` is backward Delete (U+0008). Register it only once. Adding a
literal U+0008 as a second dictionary key causes a process-ending Swift trap. Forward Delete is
U+007F at the UIKit boundary; the terminal's encoded backward-delete byte is also U+007F, so input
identities and output bytes must remain separate.

The hidden `TerminalInputField` is an input sink. Deletion emits one terminal event without asking
UIKit to mutate empty local storage. System Copy, Paste, and Select All target the terminal;
Cut and other document-editing actions are unavailable. Hardware command selectors must remain
enabled by `canPerformAction`.

`ghostty_surface_mouse_pos` accepts UIKit points. The embedded library applies content scale;
only surface sizing uses pixels. Touch long-press selects a word and extends while dragging.
Trackpad button-drag selects cells. Touch scrolling waits for long-press to fail, so it cannot
steal an active selection. Selection temporarily suspends application mouse reporting and restores
it on completion or cancellation. A contextual menu exposes Copy, Select All, and Paste without
forcing keyboard focus or silently replacing the clipboard on release.

The iOS surface reserves a native clipboard bar above the viewport for Paste, Select All,
and Copy. It remains visible independently of software keyboard state in both docked and
full-screen terminals. Selection stays inside Ghostty; only an explicit copy reads it out.
Copy availability updates during existing redraws, without polling or sending selection over
the React Native bridge. Tapping selected output clears the selection with application mouse
reporting temporarily suspended, then returns keyboard focus.

Native input regression tests live in the terminal pod's `InputTests` test specification. They
exercise UIKit constants, real command dispatch, repeated backward deletion, editing sequences,
and system edit actions. Simulator tests cover the software boundary; a physical Magic Keyboard
remains useful for keyboard-layout and pointer-behavior checks.

## Other adapters

Web and desktop use the official libghostty-vt key and paste encoders. Copy selection is staged in
the IME textarea for browser and Electron Edit-menu compatibility; asynchronous clipboard reads
are invalidated when a newer paste wins. Focused coverage is in the Ghostty surface/core tests and
terminal drawer tests.

Android uses libghostty-vt for rendering and selection, with native selection handles and an action
menu. Its current EditText adapter handles backward Delete and Ctrl-letter shortcuts explicitly,
but does not yet route the full hardware keyboard or paste through the libghostty-vt encoders.
Arrow/function-key modes, empty-field IME deletion, and bracketed paste need that adapter work;
iOS fixes cannot correct those Android paths. Avoid copying iOS embedded keycodes into Android:
libghostty-vt's key-event API takes its own enum, unlike the embedded iOS API.
