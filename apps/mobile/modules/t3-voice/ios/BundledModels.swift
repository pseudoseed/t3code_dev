import Foundation

/// Locates speech models that ship inside the app.
///
/// One model is bundled so dictation works offline on the first launch, on
/// every supported device, without waiting on a download. Everything else is
/// fetched later into Application Support.
enum BundledModels {
  static let bundledSpeechModelId = "whisper-tiny-en"

  /// Directory names inside the resource bundle, keyed by catalog model id.
  private static let bundledFolderNames: [String: String] = [
    bundledSpeechModelId: "openai_whisper-tiny.en",
  ]

  static func folder(forModelId modelId: String) -> URL? {
    guard let folderName = bundledFolderNames[modelId] else { return nil }

    // The podspec ships these through a resource bundle, so they resolve
    // relative to that bundle rather than the app's main bundle.
    let candidates = [resourceBundle, Bundle.main].compactMap { $0 }
    for bundle in candidates {
      if let url = bundle.url(forResource: folderName, withExtension: nil) {
        return url
      }
    }

    return nil
  }

  private static var resourceBundle: Bundle? {
    guard
      let url = Bundle(for: BundleToken.self).url(
        forResource: "T3VoiceModels",
        withExtension: "bundle"
      )
    else {
      return nil
    }

    return Bundle(url: url)
  }
}

private final class BundleToken {}
