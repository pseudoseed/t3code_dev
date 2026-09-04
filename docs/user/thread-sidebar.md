# Organizing threads

Pin a thread from its context menu to keep it in the pinned section above your active work.
`mod+shift+p` pins or unpins the thread you have open. Pinned threads are shown independently of
their project, including when you connect to more than one environment.

To require confirmation before unpinning, enable **Settings → General → Unpin confirmation**. The
confirmation applies to the sidebar controls, thread menus, and the `mod+shift+p` shortcut.

Pinned threads still move to **Settled** when they become inactive. They also move when their pull
request merges if **Auto-settle merged threads** is enabled.

Each server stores its own copy of the automatic settlement settings and checks them even when no
web, desktop, or mobile client is connected. By default, it settles threads after three days without
activity and when their pull request merges. An eligible idle thread also settles when its pull
request closes. An open pull request blocks inactivity settlement. Active work, pending input, and
live background work keep the thread active. T3 Code settles from a closed or merged pull request
only when its timestamp is not older than the user's latest activity. If that timestamp is not
available, the inactivity rule still applies. A manual un-settle also keeps the thread active.

**Settled** lists threads by when their work finished, newest first. A thread you settle yourself
sorts by the moment you settled it. A thread that settled on its own sorts by its last message or
turn, not by when the server noticed it was inactive.

Change these rules in **Settings > General**. The change is written to every connected environment
whose server supports shared settings. An environment that is offline or needs a server update
keeps its old value and does not appear in mismatch warnings. When a connected environment whose
server supports shared settings holds a different value, **Settings > General** shows a warning
that names it. Choose **Apply to all** to write your current values to the environments named in
the warning. The same applies to the new-thread workspace mode and the source control writing
style.

A settings change affects future settlement and does not reopen a settled thread. Settings saved
by older clients on one device no longer control this behavior.

When you un-settle a thread, it returns to the top of the active list so you can find it right
away. Its timestamps do not change. Other threads keep their positions.

Right-click a pull request link in a thread and choose **Link to thread** to show that pull request
in the sidebar. The thread settles when the linked pull request merges if **Auto-settle merged
threads** is enabled. Right-click the same link and choose **Unlink from thread** to remove it.

On web and desktop, drag a pinned thread to change its position. On mobile, open the thread's menu
and choose **Move up** or **Move down**. The order is stored by the server and appears on your
other connected devices.

If reordering is unavailable for one environment, update the T3 Code server running in that
environment. Older servers can still pin and unpin threads, but do not understand synced ordering;
their pinned threads keep the default newest-first order below the ones you have arranged.

## Unread threads

A thread that finished work while you were somewhere else is marked **Done** in place of its
timestamp. Opening the thread clears the mark.

T3 Code keeps track of this on the server, so reading a thread on your desktop clears it on your
phone and iPad too. A thread you have never opened is not marked, so turning on a machine after a
long break does not light up your whole history.

On web and desktop you can put the mark back: open the thread's context menu and choose **Mark
unread**. That applies everywhere too. Mobile shows the mark but does not set it by hand.

If one environment does not show the mark, update the T3 Code server running there. Older servers
fall back to per-device tracking on web and desktop, and show nothing on mobile.

## Project sections

**Settings → General → Group sidebar by project** gives every project its own container in the
sidebar. The project name sits at the top in a larger size and in a color of its own, with the
number of threads beside it and a **+** button to start a new thread there. Threads keep their
usual order inside the container: active work first, then Snoozed, then Settled.

The color comes from the project itself, so a project keeps the same color every time you open T3
Code and on every device. There is nothing to choose and nothing to configure.

Tap or click the project name to fold the container. A folded project takes one row no matter how
much work is in it, and the count stays visible so you can still see what is waiting. The thread
you have open is never hidden by a fold, a shelf, or a **Show more**.

Each project has its own Snoozed and Settled shelves and its own **Show more**, so looking further
back in one project leaves the others alone.

Turn the setting off to go back to one flat list. On iPad and Android the same switch is
**Settings → General → Group Sidebar by Project**; folded projects are remembered per device.

## Filtering by project

The menu above the thread list controls which projects the sidebar shows. Open it and tick the
projects you want. Ticking several shows all of them at once, so you can watch two or three
projects without the rest in the way.

**All projects** at the top of the menu is a bulk control. It ticks everything when some projects
are hidden, and clears everything when they are all showing. Type in the menu's search box to find
a project by name when the list is long.

The button always says what the filter is doing: **All projects** when nothing is hidden, the
project's name when you have narrowed to exactly one, and a count such as **2 of 7 projects**
otherwise. A project you hide is still there; it is only filtered out of the list.

Your choice is remembered and comes back the next time you open T3 Code. A project you add later
shows up by default, so a filter you set months ago never hides new work from you. Hiding every
project is allowed: the list then offers a **Show all projects** button to undo it. You can also
clear the filter from **Settings → General → Restore default settings**.

Projects on an environment that is offline keep their filter state while it is disconnected, so
reconnecting does not un-hide them.

The filter is a web and desktop feature. The mobile app is unaffected.

## Panel motion

The main sidebar, right panel, and terminal drawer open and close immediately by default. Under
**Settings → Appearance → Motion**, move the **Panel animations** slider above 0 ms to add motion.
The duration can be set up to 400 ms. Clicking the preview replays all three panel transitions; at
0 ms, it snaps between the same open and closed states.

## Environment icons

When you are connected to more than one environment, every thread that lives somewhere other than
the machine you are on wears a small icon for that machine at the end of its row: a server, a cloud
VM, a desktop, a laptop, a Mac mini, or a Mac Studio. In the hosted web app and the mobile app,
where every environment is remote, each row wears its machine so you can tell them apart at a
glance. The same icon appears wherever an environment is named: the thread tooltip, the command
palette, the "Run on" picker, the pull request server filter, the provider settings device tabs,
and the environment lists under **Settings → Connections**. On mobile it appears in the thread
lists, the archive, the new-task environment picker, and the Environments and storage settings.

Servers pick the icon themselves from the hardware they run on. A Mac reports its model, a Linux
machine reports its chassis type and whether it is a virtual machine, and anything without a usable
signal shows a generic server. To override it, open **Settings → Connections** and choose an icon
for that environment; **Automatic** goes back to what the server detected. The choice is stored on
that server, so every device that connects to it sees the same icon.

## Environment artwork

Dev and Nightly environments can identify themselves with artwork at the top of the sidebar and in
the send button. Choose **Artwork**, **Version pill**, or **None** in Settings under environment
identification. Artwork is recolored to match each built-in theme. Custom themes use the **Version
pill** fallback because their colors are not controlled by T3 Code.

To generate a fresh title from the conversation, open a thread's context menu and choose
**Regenerate title**. While T3 Code is generating it, the action reads **Regenerating…** and cannot
be selected again. The option is hidden when the connected environment needs a server update.
