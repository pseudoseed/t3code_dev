# Mobile text selection

iOS text selection belongs to a single UIKit text document. Separate selectable views cannot
share a selection, even when they look like one message. The native Markdown renderer groups
adjacent prose inside blockquotes through the same chunking helper used for top-level content.
The quote border remains a surrounding view; nested code, tables, and media retain their rich
renderers and separate selection boundaries.

Source files opt into a read-only UITextView inside the native review module using the
`setSourceText` view function. Review diffs continue using the virtualized canvas. The source
view owns selection, scrolling, and hardware edit actions. Its TextKit layout manager draws
line numbers outside text storage, so copying preserves source whitespace without gutter text.
Highlight token ranges use UTF-16 offsets and are applied only when their text matches the
current line. Highlight and appearance updates preserve the current selection and scroll offset.
Large source strings use the existing native view-function delivery path rather than Fabric props.

Both source and Markdown previews reserve bottom scrolling space for selection handles and
the safe area. Chat and file preview use the same Markdown renderer. These changes are iOS
client behavior; no provider or WebSocket contract changes are involved. Android retains its
existing renderer; the Markdown preview's extra bottom spacing applies there too.
