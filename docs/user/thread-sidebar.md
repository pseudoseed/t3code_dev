# Organizing threads

Pin a thread from its context menu to keep it in the pinned section above your active work.
`mod+shift+p` pins or unpins the thread you have open. Pinned threads are shown independently of
their project, including when you connect to more than one environment.

To require confirmation before unpinning, enable **Settings → General → Unpin confirmation**. The
confirmation applies to the sidebar controls, thread menus, and the `mod+shift+p` shortcut.

Pinned threads still move to **Settled** when they become inactive. They also move when their pull
request merges if **Auto-settle merged threads** is enabled.

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

## Environment artwork

Dev and Nightly environments can identify themselves with artwork at the top of the sidebar and in
the send button. Choose **Artwork**, **Version pill**, or **None** in Settings under environment
identification. Artwork is recolored to match each built-in theme. Custom themes use the **Version
pill** fallback because their colors are not controlled by T3 Code.

To generate a fresh title from the conversation, open a thread's context menu and choose
**Regenerate title**. While T3 Code is generating it, the action reads **Regenerating…** and cannot
be selected again. The option is hidden when the connected environment needs a server update.
