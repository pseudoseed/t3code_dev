# Copy on select

Turn on **Settings → General → Copy on select** to have T3 Code copy highlighted text the moment
you let go of the mouse button, the way a terminal emulator does. There is no confirmation and no
keyboard shortcut to press: release the drag and the text is on your clipboard.

The setting is off by default, because copying on release replaces whatever you were already
holding on the clipboard.

## Where it applies

Copy on select works in two places:

- Thread messages, including agent output, code blocks, and your own sent messages.
- Terminal output.

It deliberately does nothing anywhere else. Selecting text in the composer, in a settings field, or
in any other box you can type into never copies, because selecting there is part of editing rather
than a request to copy.

A selection that starts in a message and ends outside it copies nothing, rather than copying part
of what you highlighted.

## Web and desktop only

Copy on select responds to a mouse drag, so it applies to the web and desktop apps. The mobile app
is unaffected and keeps its usual selection behavior.

## Still available without it

The manual ways to copy are unchanged whether or not this setting is on: the copy button on a
message, the copy entry in the terminal's right-click menu, and the normal copy keyboard shortcut.
