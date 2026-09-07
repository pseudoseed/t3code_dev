# Agent attention notifications

Web and desktop observe each environment's existing shell stream. The observer in
`apps/web/src/components/AgentAttentionCoordinator.tsx` tracks new `hasPendingApprovals` and
`hasPendingUserInput` transitions, including threads outside the visible sidebar. It subscribes
directly to the shell atom, without fetching transcripts or rerendering the application for each
status update. The first live snapshot after hydration or reconnection establishes a silent
baseline. Approval and input flags are tracked independently so resolving an overlapping approval
does not replay an existing input request.

The client settings `agentAttentionSound` and `agentAttentionNotifications` are off by default.
They persist through the existing local client settings API, including desktop IPC persistence.
Settings search exposes both controls. No provider-specific adapter change or new server RPC is
required: all adapters use the same shell request flags.

Sound uses a short Web Audio chime. Browsers unlock audio through a user gesture; Electron creates
or resumes the audio context on delivery, so a restarted desktop client can sound before its first
click. Electron's default autoplay policy allows this. System alerts use the Notifications API,
which Electron supports in its renderer and delivers through the operating system. Permission
is requested only from the settings control. Enabling notifications also sends a confirmation alert:
Electron's renderer permission can already be granted before macOS has prompted for native permission.
Notification tags and click targets contain both the
environment and thread IDs. Local alerts depend on a running client and a live connection; they
are not background push for a closed app or suspended mobile client.

## Mobile push and APNs

The ordinary iOS widget registers its layout with `createWidget` in
`apps/mobile/src/widgets/AgentWidget.tsx`. Its configuration name is `AgentActivity`,
matching the generated widget extension. Expo stores this layout separately from
the identically named ActivityKit layout; registering a Live Activity does not
register a Home Screen widget.

`AgentWidgetSync` projects existing mobile shell state into a persisted widget
snapshot. It supports direct connections, uses environment-scoped project keys,
prioritizes attention requests, and skips timestamp-only reloads. Initial shell
synchronization preserves the previous snapshot. Background app notifications are
handled by `widgetBackgroundTask.ts`, which merges each environment's snapshot into
the persisted WidgetKit timeline. Updates from unknown/removed environments and
older snapshots are ignored. This does not use a WidgetKit push handler or an
extension-side server fetch. Builds using the
free Personal Team flag exclude the widget extension and this synchronization.

Direct Live Activities use a separate factory name, `DirectAgentActivity:<environmentId>`,
so relay cleanup cannot end them and two environments cannot overwrite one card.
The ordinary widget does not start or update Live Activities.

The T3 Connect native iOS implementation registers device tokens through
`apps/mobile/src/features/agent-awareness/remoteRegistration.ts`. The T3 Connect relay owns the
APNs sender in `infra/relay/src/agentActivity/ApnsClient.ts`, its signing credentials, and delivery
queue. That relay is part of the current implementation, not a requirement imposed by Apple.

Apple requires a notification provider to send authenticated requests to APNs. An existing T3
environment can perform that role directly: environment → APNs → device. A separate hosted relay
is unnecessary for a personal deployment if the environment owns the APNs credentials and device
registrations. `apps/server/src/push` implements this mode: authenticated HTTP
registration, persistent device records bound to client sessions, and a drainable
event worker. The sender uses Node HTTP/2 and cached ES256 provider tokens, retries
transport/429/5xx failures twice, and removes invalid device/activity tokens. Initial
hydration and re-registration reconcile cards without replaying historical alerts.
The mobile client reads the provisioning profile's APNs environment through Expo
Application. If that lookup returns null, the native App Store release type
selects production: Apple-distributed installs can omit the embedded profile.
Other unknown environments remain errors; app branding does not select routing.
The sender loads `apns.json` from `ServerConfig.secretsDir` at startup, so each
desktop host can retain private configuration across Finder launches and restarts.
The file contains `keyFile`, `keyId`, `teamId`, and `bundleId`; a relative key path
resolves beside the configuration file. A complete set of `T3CODE_APNS_*`
environment variables overrides the file. Partial overrides fail configuration
instead of mixing identities. Invalid configuration leaves the sender disabled
without preventing server startup or logging key contents.
Shipping the app publisher's APNs private key with distributed clients or
arbitrary user servers is not an appropriate substitute for a relay in the public product.
See the [direct APNs runbook](../operations/direct-apns.md) for private configuration
and native-build requirements. Remote ActivityKit push-to-start is intentionally
not enabled; foreground creation provides the activity update token immediately.

A paid individual Apple Developer Program membership supports push; an organization membership
is not required. A free Xcode Personal Team is different. Browser background delivery uses Web
Push subscriptions and a service worker; Safari's Web Push transport uses Apple's servers, but
native APNs device tokens are not a cross-browser or Android transport.

References: [Electron notifications](https://www.electronjs.org/docs/latest/tutorial/notifications),
[Apple notification providers](https://developer.apple.com/documentation/usernotifications/setting-up-a-remote-notification-server),
[iOS capabilities](https://developer.apple.com/help/account/reference/supported-capabilities-ios/),
[WebKit Web Push](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/).

## PseudoCode glanceable surfaces

The mobile header and the widget extension use the PseudoCode artwork. The widget
asset plugin bundles an original-color `AppMark` image set, sourced from the same
app icon. Serialized WidgetKit layouts keep their helpers inside the layout
function; app-module imports cannot supply runtime branding inside the extension.

The shared `selectWidgetActivities` projection prioritizes requests and active
work, retains terminal results from the past hour at refresh time, and limits error
context to the first 140 characters of the first line. The optional aggregate row
`detail` field carries this context through direct APNs to widgets and Live
Activities; payload compaction still enforces Apple's byte limit. A detail change
invalidates the widget content key, while timestamp-only changes do not.

Product labels use PseudoCode and the optional hosted connection UI uses Cloud
Connect. Existing URL schemes, server protocol names, stored theme IDs, and legacy
data-directory migration names remain compatible with installed clients.

The Live Activity uses a dark surface with explicit contrast colors because its
WidgetKit environment can report light mode on a dark Lock Screen. Home Screen
widgets follow the system color scheme. `icons:export` derives web and ICO assets
from the checked-in PseudoCode PNG; it does not overwrite that source from the
upstream Icon Composer projects.
