# PseudoCode widgets and Live Activities

Add the PseudoCode widget from the iOS widget gallery, then open the app and
connect to an environment to populate it. Small and rectangular Lock Screen
widgets show one thread; the medium Home Screen widget shows up to two.
Requests for input or approval appear first, followed by working threads and
recent results. Tap the widget to open its highest-priority thread.

The widget saves activity received by the app, including direct server
connections without a Cloud Connect account. It shows an empty-state message before
the first sync. The displayed update time belongs to the saved activity; opening
the app and reconnecting refreshes the saved snapshot. iOS controls when the
widget redraws. With **Apple notifications from my servers** enabled and server
setup complete, the widget also receives occasional background snapshot updates.
Input and approval alerts include a fresh snapshot. iOS may delay these updates;
open the app to refresh when needed.

Add **PseudoCode Overview** from the widget gallery for a separate medium or large
widget. The large version shows up to four threads with project icons, a short
update, and colored status text. Tap an individual row to open that thread.
Project icons are saved when you open the connected app; a folder appears until
an icon is available. The existing PseudoCode widget remains available.

Overview and Live Activities can include AI progress summaries when the host has
an enabled, signed-in Claude provider. Summaries use Haiku through that connection
and consume provider usage. They refresh as work changes, with a rate limit;
approval, input, and completion labels come directly from the thread status and
do not wait for a summary. If a summary is unavailable, a factual status appears.
Direct background updates require **Apple notifications from my servers**; Cloud
Connect supplies summaries to its Live Activities. iOS still controls delivery
and widget refresh timing.

Live Activities on the Lock Screen and Dynamic Island are a separate feature.
Enable them through Cloud Connect, or under **Apple notifications from my servers**
after configuring your server. The direct option requires no Cloud Connect account.
Open the app while work is active to create a card. It can then receive updates
while the app is in the background, and ends when work finishes. Open the app
again during subsequent work to create a new card.

Each card shows the PseudoCode icon, task title, project, and a short status. The
Lock Screen card highlights the task that needs attention, with a prompt to reply
or approve, and a concise progress update when available. Hold the Dynamic Island to see the
highlighted task; its compact view shows the app icon and active count or action.

Completed and failed tasks appear among recent results for up to an hour when
activity refreshes. Failures show **Needs review** and a short error explanation
when one is available; open the thread for the full context. Older results no
longer crowd out current work. The small widget shows one task, and the medium
widget uses its full width with a count for additional active tasks.
