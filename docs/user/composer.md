# Messages and context

Give the agent a task in the composer. Add files, quote a previous response, or
include a skill when the task needs more context.

Messages can contain up to 120,000 characters. Longer drafts stay in the composer
so you can shorten them or split them into several messages.

## Attach files

Attach up to eight files per message. Images can be up to 10 MB; other files can
be up to 50 MB, subject to the environment's upload support and limit. The agent
receives them on the environment's machine.

Uploads begin when you add an attachment. All uploads must finish before the
message can send. Retry or remove a failed upload. On web and desktop, reloading
before an upload finishes requires you to attach that file again.

You can drag or paste images into the web or desktop composer. HEIC and HEIF
photos are converted to JPEG there and when selected from the iOS photo library;
the image limit applies after conversion. On mobile, you can also send files to
PseudoCode through another app's system share sheet.

See [images and videos](#images-and-videos-in-messages) for previewing and saving media.

## Queue messages offline on mobile

Mobile keeps local copies of draft attachments, so you can preview them and queue
messages while disconnected. Uploads resume when you reconnect. Drafts and queued
messages survive app restarts. Signing out of T3 Connect keeps that work on your
device until you sign back into the same account.

## Custom models

On web and desktop, use Settings → Providers → **Models** to add an unlisted model with a custom
name and options. Only options supported by the provider integration affect turns. Antigravity
uses its account catalog and does not support custom models.

## Model defaults

PseudoCode remembers your provider, model, and model options for new threads. A
project's configured model takes precedence; resetting that project setting
returns to the remembered selection.

Leaving reasoning level or service tier unset uses the provider's own configuration.

## Quote an assistant response

On web and desktop, select text within one assistant response and choose
**Cite in composer**. You can add a comment about the quote and write instructions
around it.

Select the quote in a draft or sent message to return to its source. If the source
is unavailable or has changed, the saved quote remains readable.

Mobile displays saved quotes and comments, but does not create citations or
navigate to their sources.

## Recall a sent prompt

Press `ArrowUp` in an empty composer to bring back the last prompt you sent in this thread. Press
`ArrowUp` again to go further back, and `ArrowDown` to come forward. Moving forward past the newest
prompt clears the composer. Recall walks the prompts loaded in the thread. Attachments, terminal
context, and other extras from the original message are not restored, only the text you typed. A
composer that holds an attachment or a picked element does not count as empty.

When the composer has text, the arrow keys move the caret as usual. Recall takes over only while
the text is an unedited recalled prompt, with the caret on the first visual line for `ArrowUp` or
the last visual line for `ArrowDown`, counting wrapped lines. Editing a recalled prompt turns it
into a normal draft.

## Prompt stash

On web and desktop, press `Cmd+S` on macOS or `Ctrl+S` on Windows and Linux to save
the current prompt and its attachments for later. Wait for uploads to finish first.
With an empty composer, the same shortcut restores a single stash or opens the
stash menu when there are several.

Stashes containing uploaded files must be restored in their original environment.
Those files are retained for 24 hours. After an upload expires, restore the prompt
and use **Attach again** or remove the missing file before sending.

## Voice input on iPhone

On supported iPhones with iOS 26 or later, use the composer's microphone to record,
then confirm to transcribe. Text is inserted where your selection was when
recording started, ready for you to review and edit before sending.

The first use may download Apple's speech model and needs a network connection.
Later transcription works offline for that language.

A recording can be up to 15 minutes long; if it reaches that limit, PseudoCode transcribes what it
captured and tells you it stopped. If the microphone is interrupted or the app moves to
the background, PseudoCode finishes transcribing the audio captured so far and tells you that
recording stopped. If transcription fails, tap the microphone to retry the saved recording.
Dismissing that error discards the saved audio. Canceling voice input or leaving the screen during
recording discards the new recording and keeps your existing draft and attachments. PseudoCode
deletes the local audio file after successful transcription and cleanup. It sends only the normal
message text when you submit the draft.

### Choosing a speech model

**Settings → Voice → Voice Input** lists the speech models your device can run. A small English
model is built into the app and needs no download. Larger and multilingual models download when you
pick them, and you can delete any of them later to free the space. A model your device does not have
the memory for is shown greyed out with the reason.

Downloads wait for Wi-Fi unless you turn on **Download over cellular**. Models are large, so this is
off to begin with.

Clearing the app cache never deletes voice models. The only way to remove one is to delete it in
voice settings.

### Ignoring other voices

Some speech models can tell voices apart. With one of those selected, turn on **Ignore other voices**
and PseudoCode keeps only the voice that did most of the talking, so a conversation nearby does not end
up in your message. This needs one extra small download.

It only drops a voice that is clearly farther from the phone than yours. When another voice is as
close as you are, or it cannot tell which voice is yours, it transcribes the whole recording and
tells you it did. Losing your own words would be worse than leaving a stray voice in. When it does
drop something, the composer says how many seconds went, so you can check that nothing of yours
is missing.

### Cleaning up transcripts

Turn on **Clean up transcripts** and a language model on your device rewrites what you said as
written text: punctuation, capitalization, and obvious mishearings fixed, filler words removed.
Long messages are cleaned up a few sentences at a time. If cleanup fails or stops before finishing,
PseudoCode keeps the original transcription for that part and tells you.

Three cleanup models are available, trading speed for quality. You can edit the instructions they
follow and reset them to the default at any time.

Two lists help with words that get misheard. **Preferred spellings** are kept exactly as you write
them, which is useful for project and tool names. **Corrections** are `wrong -> right` pairs, one
per line.

PseudoCode also learns from you. When you fix a word that voice input got wrong and then send the
message, that fix is remembered and applied to later transcripts. Everything it has learned is listed
under **Learned from your edits**, and you can delete any entry.

If cleanup fails or takes too long, you get the original transcript instead. You never lose what you
said.

## Context and cost

The composer shows a small ring beside the send button once the provider reports token usage,
which today means Claude and Codex threads. Next to the ring is the share of the context window in
use, and the running cost of the thread once one is known. Open it for the exact token counts and
the full window size; on mobile, tap it.

The cost is API-equivalent, the same figure the Usage page reports. It is what these tokens would
cost at list prices, not what you were charged: a subscription plan bills separately. Claude
reports its own per-turn cost, so those threads show the provider's own number. Codex threads are
priced from token counts, and a model with no published rate shows no cost rather than a guess.

## Commands and skills

Type `/` for commands or `$` to add a skill from the selected environment and
provider. On mobile, both are also available before starting a thread on
**New task**.

The slash menu also includes skills unless you turn off **Settings → General →
Show skills in slash menu**. Only skills enabled for the provider are listed.

Provider commands must start the message to run. PseudoCode commands such as
`/model` and `/plan`, and skill mentions, work on any line.

Send `/compact` in an existing conversation to reduce context usage when the
provider supports it. Web and desktop also offer compaction from the context meter.

## Images and videos in messages

Select an image or video attachment or link to preview it. Playback support depends
on your browser or device; save an unsupported video to open it in another app.

On web and desktop, right-click media to save it or copy its path or URL. On mobile,
touch and hold an image or video thumbnail and choose **Save or share**. On iOS,
return to the thumbnail to open this menu after watching a full-screen video.

File links refer to the environment's machine, including when you connect remotely.
Previews use the original file, even outside the workspace. Moving or deleting it
can break the preview, so save a copy if you need to keep it.

## Files outside the workspace

Follow an agent's file link to read a report or other file outside the workspace.
These files open read-only. An HTML file outside the workspace cannot load scripts,
styles, or images from neighboring files.

## HTML and PDF files in the file viewer

On web and desktop, HTML and PDF files open as rendered pages. Switch an HTML
file to source view to read its markup; a link to a specific line opens source
automatically. HTML previews cannot access your PseudoCode session.

On mobile, select a PDF attachment or link to open it. iOS uses the native viewer;
Android opens the system chooser.
