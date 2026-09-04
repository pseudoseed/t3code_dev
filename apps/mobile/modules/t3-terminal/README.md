# T3 Mobile Terminal Native Module

This local Expo module owns the native terminal surface for the mobile app.

The JavaScript contract is intentionally small:

- input from the native surface is emitted as `{ data: string }`
- resize from the native surface is emitted as `{ cols: number, rows: number }`
- remote PTY output arrives through the `append` prop as `{ reset, chunk, cursor, epoch }`
- a newly created surface emits `onSurfaceReady`, which is how JS learns to resend history

The views deliberately hold no copy of the scrollback. They apply the slice an `append` carries
and ignore one whose cursor they already passed, so the buffer lives in exactly one place.

The iOS implementation uses the vendored `GhosttyKit.xcframework` built from VVTerm's Ghostty
custom-I/O and live-padding branch. `T3TerminalView` owns a `libghostty` surface and uses that
callback I/O model:

1. initialize libghostty once for the process
2. create one Ghostty app and surface per native view
3. feed remote output into the surface with `ghostty_surface_feed_data`
4. send user input back to JS with the write callback
5. emit Ghostty's measured terminal size through `onResize`

Hardware keys are captured with `UIKeyCommand` (the text-input system swallows presses before the
responder chain sees them) and encoded by `ghostty_surface_key`, so cursor keys follow the modes
the running program set. Chords that terminals encode as modified cursor keys — Option and Command
with the arrows or Backspace — are sent as the readline control codes the web client uses instead,
because stock zsh and readline do not bind the modified forms.

Android implements the same view contract with upstream `libghostty-vt` for terminal state, parsing,
reflow, and scrollback. An Android Canvas view renders compact snapshots produced by the JNI bridge,
so the React Native screen and RPC code stay platform-neutral.

Vendored Ghostty revision and license details are in `THIRD_PARTY_NOTICES.md`.

## Rebuilding GhosttyKit

The checked-in `GhosttyKit.xcframework` is built from Yash Singh's Ghostty fork at revision
`cf8edc23f3a6a87a96e41a90013e89e987d34980`. Set `GHOSTTY_SOURCE_DIR` to a clone of
https://github.com/Yash-Singh1/ghostty checked out at that revision (the
`t3code/custom-io-ordered-feed` branch when vendored, based on VVTerm's
`vvterm/custom-io-padding` branch).

```bash
apps/mobile/modules/t3-terminal/scripts/build-libghostty-ios16.sh
```

The script builds Ghostty with Zig 0.16.0, strips the iOS archives, and replaces only the
`ios-arm64` and `ios-arm64-simulator` slices. Xcode's Metal toolchain must be installed; if `metal`
fails, run `xcodebuild -downloadComponent MetalToolchain`.

## Rebuilding libghostty-vt for Android

The checked-in Android shared libraries and headers are pinned to the revision recorded in
`native/libghostty-vt/VERSION` at the repository root. Set `ANDROID_NDK_HOME` and run:

```bash
apps/mobile/modules/t3-terminal/scripts/build-libghostty-android.sh
```

The script downloads Zig 0.15.2 when needed, checks out the pinned upstream Ghostty revision, and
rebuilds all four Android ABIs with 16 KB page-size support.
