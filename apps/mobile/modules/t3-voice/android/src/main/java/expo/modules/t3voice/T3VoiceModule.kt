package expo.modules.t3voice

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Android stub. On-device dictation ships for iOS and iPadOS only, so this
 * exists to keep Android builds linking. The JS side gates on platform before
 * calling anything here; see `apps/mobile/src/native/t3Voice.ts`.
 */
class T3VoiceModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("T3Voice")

    Constants(
      "nativeRevision" to 0,
    )
  }
}
