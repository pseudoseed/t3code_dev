# T3 Code Mobile

> [!WARNING]
> T3 Code Mobile is currently in development and is not distributed yet. If you want to try it out, you can build it from source.

## Quickstart

> [!NOTE]
> Uses native modules so using Expo Go is not supported. You need to use the Expo Dev Client.

This app has three variants:

- `development`: Expo dev client, installable side-by-side as `T3 Code Dev`
- `preview`: persistent internal preview build, installable side-by-side as `T3 Code Preview`
- `production`: store/release build as `T3 Code`

Run commands from `apps/mobile`.

T3 Connect is optional and disabled in a fresh clone. Public configuration belongs in the
repository-root `.env` or `.env.local`, not an `apps/mobile/.env` file. See
[`../../.env.example`](../../.env.example).

## Development

Start Metro for the dev client:

```bash
vp run dev:client
```

Metro keeps its transform cache between ordinary starts. If the cache itself is causing stale or
invalid output, clear it for one development-client start:

```bash
vp run dev:client:reset
```

Run that reset once after installing or changing the Uniwind dependency patch. Cached transforms
can otherwise reference its previous pnpm package path. Ordinary Metro starts still keep the cache.

Component edits use Fast Refresh. Connection-runtime edits replace the active Effect layer through
a stable atom runtime, preserving navigation and existing atom subscribers. Replaced registries
and managed runtimes dispose their resources; the app does not force a JavaScript reload. The Uniwind patch
skips global style invalidation when generated styles and themes are unchanged, while real style
changes still refresh. See [mobile development lifecycle](../../docs/internals/mobile-development.md)
for the lifetime boundaries.

Build and run the local iOS dev client:

```bash
vp run ios:dev
```

If your Xcode account only has a Personal Team, use a bundle identifier you control and opt into the
reduced-capability local build. Personal Team builds omit the widget and share extensions, push
entitlement, and native Sign in with Apple entitlement; builds without this opt-in are unchanged.

```bash
T3CODE_IOS_PERSONAL_TEAM=1 \
T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID=com.example.t3code.dev \
vp run ios:dev
```

Build and install a self-contained Release app that does not need Metro:

```bash
vp run ios:release
```

The Personal Team equivalent also needs a unique bundle identifier:

```bash
T3CODE_IOS_PERSONAL_TEAM=1 \
T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID=com.example.t3code \
vp run ios:release
```

### Building on your own paid team

A paid Apple Developer Program membership signs every capability, so leave
`T3CODE_IOS_PERSONAL_TEAM` unset and supply the two identifiers instead. Signing lasts as long as
the certificate rather than 7 days, and push, associated domains, widgets, and the share extension
all stay in the build.

```bash
T3CODE_IOS_BUNDLE_ID=com.example.t3code \
T3CODE_IOS_TEAM_ID=YOURTEAMID \
vp run ios:release --device <hardware-udid>
```

Your team id is on developer.apple.com under Account, Membership details. The first build on a new
bundle identifier still needs the one-time xcodebuild step below to create the profile.

### Installing a Personal Team build on your own iPad

`expo run:ios` targets a simulator by default. Pass `--device` with the device's hardware UDID from
`xcrun xctrace list devices` (not the CoreDevice identifier `devicectl` prints). The iPad must be
unlocked, trusted, and in Developer Mode (**Settings → Privacy & Security → Developer Mode**).

The first build on a new bundle identifier needs a provisioning profile that does not exist yet.
`expo run:ios` cannot pass `-allowProvisioningUpdates`, so create the profile once with xcodebuild
after prebuilding:

```bash
T3CODE_IOS_PERSONAL_TEAM=1 \
T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID=com.example.t3code \
APP_VARIANT=production EXPO_NO_GIT_STATUS=1 \
vp exec expo prebuild --clean --platform ios

xcodebuild -workspace ios/T3Code.xcworkspace -scheme T3Code \
  -configuration Release -destination "id=<hardware-udid>" \
  -allowProvisioningUpdates build
```

Set `T3CODE_IOS_PERSONAL_TEAM_ID` to your team id (`security find-identity -v -p codesigning`
prints it) when Xcode holds more than one team. With a single team, leave it unset and automatic
signing picks it.

Later builds reuse that profile, so the short command works:

```bash
T3CODE_IOS_PERSONAL_TEAM=1 \
T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID=com.example.t3code \
vp run ios:release --device <hardware-udid>
```

The first install of a given certificate will not launch until you trust it on the device:
**Settings → General → VPN & Device Management → Developer App → trust your name**. Until you do,
iOS reports "invalid code signature, inadequate entitlements or its profile has not been explicitly
trusted by the user".

Personal Team constraints that decide how often you repeat that command:

- Provisioning profiles last 7 days. After that the app refuses to launch until you rebuild and
  reinstall; nothing on the device is lost, and the app's data survives the reinstall. Renewing the
  profile needs the `-allowProvisioningUpdates` build above again.
- Apple allows 10 App IDs per 7 days and 3 apps installed per device at a time on a free account.
  Keep one bundle identifier rather than minting a new one per build.
- The stripped entitlements mean no push notifications, no Home Screen widget, no system share
  target, no native Sign in with Apple, and no Associated Domains (so no universal links and no
  shared web credentials). Everything else, including pairing to a T3 Code server over the local
  network or a tailnet, works normally.

A paid Apple Developer Program membership removes all of the above: profiles last a year, the
entitlements sign, and TestFlight can distribute the build instead of a cable.

Build and run the local iOS preview app:

```bash
vp run ios:preview
```

Force the review diff highlighter engine:

```bash
EXPO_PUBLIC_REVIEW_HIGHLIGHTER_ENGINE=javascript vp run ios:dev
```

`javascript` is the default and recommended setting for the review diff screen. Set `EXPO_PUBLIC_REVIEW_HIGHLIGHTER_ENGINE=native` only when you explicitly want to test the native Shiki engine.

Inspect the resolved Expo config for a variant:

```bash
vp run config:dev
vp run config:preview
```

Run static checks for mobile native code:

```bash
node ../../scripts/mobile-native-static-check.ts
```

The native lint task runs SwiftLint for Swift plus ktlint and detekt for Kotlin. Missing native tools are reported as warnings and skipped locally. CI installs the default toolset from `apps/mobile/Brewfile` before running the native checks.

## TestFlight from this machine

An alternative to EAS for a team that owns its own App Store Connect record: archive locally and
upload with an App Store Connect API key. Nothing here needs an Expo account.

One-time setup:

1. Register the bundle identifier as an App ID on developer.apple.com, or let a signed device build
   create it.
2. Create the app in App Store Connect with that bundle identifier.
3. Create an API key under Users and Access, Integrations, App Store Connect API with the App
   Manager role. Keep the issuer id, the key id, and the downloaded `.p8`, which is offered once.
   `xcrun altool` and `notarytool` read it from `~/.appstoreconnect/private_keys`.

Every upload needs a build number no earlier upload used. `ios.buildNumber` in `app.config.ts`
carries it.

```bash
T3CODE_IOS_BUNDLE_ID=com.example.t3code \
T3CODE_IOS_TEAM_ID=YOURTEAMID \
APP_VARIANT=production EXPO_NO_GIT_STATUS=1 \
vp exec expo prebuild --clean --platform ios

xcodebuild -workspace ios/T3Code.xcworkspace -scheme T3Code \
  -configuration Release -destination "generic/platform=iOS" \
  -archivePath build/T3Code.xcarchive \
  -allowProvisioningUpdates archive

xcodebuild -exportArchive -archivePath build/T3Code.xcarchive \
  -exportOptionsPlist ExportOptions.plist -exportPath build/export \
  -allowProvisioningUpdates

xcrun altool --upload-app -f build/export/T3Code.ipa -t ios \
  --apiKey YOURKEYID --apiIssuer YOURISSUERID
```

`ExportOptions.plist` selects the store distribution method:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>method</key><string>app-store-connect</string>
    <key>teamID</key><string>YOURTEAMID</string>
    <key>uploadSymbols</key><true/>
  </dict>
</plist>
```

Processing in App Store Connect takes a few minutes, after which the build appears in TestFlight and
installs on any device signed in with an invited tester's Apple Account.

## EAS Builds

Preview and production variants use Expo fingerprinting so OTA updates only reach binaries with matching native dependencies, config plugins, and patches. CI uses the `preview:dev` profile to reuse a compatible native build when possible.

The development variant uses `appVersion` to avoid recalculating the native fingerprint for each Metro launch manifest. `MOBILE_VERSION_POLICY` can override either default. If you distribute a custom Release build with the development identity and publish OTA updates to it, set `MOBILE_VERSION_POLICY=fingerprint` for both its build and updates. Changing the runtime policy requires a native rebuild for OTA matching; an existing dev client can still load local Metro bundles.

For preview or production EAS environments, set `T3CODE_CLERK_PUBLISHABLE_KEY`,
`T3CODE_CLERK_JWT_TEMPLATE`, and `T3CODE_RELAY_URL`
as EAS environment variables. Expo config maps the canonical values into the mobile build.

Create a PR preview dev-client build manually:

```bash
vp run eas:ios:preview:dev
```

Create a cloud dev-client build:

```bash
vp run eas:ios:dev
```

Create a persistent preview build:

```bash
vp run eas:ios:preview
```

Android equivalents:

```bash
vp run eas:android:dev
vp run eas:android:preview:dev
vp run eas:android:preview
```
