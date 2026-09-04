Pod::Spec.new do |s|
  s.name           = 'T3Voice'
  s.version        = '1.0.0'
  s.summary        = 'On-device speech recognition and transcript cleanup for T3 Code mobile.'
  s.description    = 'Local speech-to-text and LLM cleanup. No audio or text leaves the device.'
  s.author         = 'T3 Tools'
  s.homepage       = 'https://t3tools.com'
  s.platforms      = {
    :ios => '18.0',
  }
  s.source         = { :path => '.' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  # Inference engines come in through SwiftPM rather than vendored binaries, so
  # SwiftPM resolves transitive dependencies and Metal resources for us. Every
  # pin is exact: a moving dependency cannot coexist with a single-shot release.
  #
  # Engines are added here as the phase that uses them lands, so a build never
  # pays for a package nothing calls yet. Pins for the not-yet-linked engines
  # live in the plan, not in comments that drift.
  if defined?(spm_dependency)
    spm_dependency(
      s,
      url: 'https://github.com/argmaxinc/WhisperKit.git',
      requirement: { :kind => 'exactVersion', :version => '0.18.0' },
      products: ['WhisperKit']
    )
    spm_dependency(
      s,
      url: 'https://github.com/FluidInference/FluidAudio.git',
      requirement: { :kind => 'exactVersion', :version => '0.15.6' },
      products: ['FluidAudio']
    )
  else
    raise 'T3Voice requires React Native 0.75 or newer for iOS Swift Package Manager dependencies.'
  end

  # llama.cpp, for transcript cleanup. Vendored rather than fetched through
  # SwiftPM: every Swift wrapper around it depends on SwiftSyntax, which does
  # not build inside a CocoaPods workspace, and llama.cpp's own published
  # xcframework carries no iOS simulator slice. `scripts/build-llama-xcframework.sh`
  # builds both slices from a pinned upstream tag; the output is not in git, so
  # a checkout that has not run it fails to link rather than building something
  # subtly different.
  s.vendored_frameworks = 'Vendor/llama.xcframework'

  s.source_files = '*.{h,m,mm,swift,hpp,cpp}'

  # The bundled speech model. `scripts/fetch-bundled-model.sh` downloads it from
  # pinned revisions; it is deliberately not in git. Missing here means the
  # script has not run, and BundledModels.swift reports the model as
  # not installed rather than crashing.
  # Reference the model directory, not a file glob. CocoaPods flattens a glob
  # into the bundle root, which makes the three `.mlmodelc` folders collide on
  # `coremldata.bin` and `weights`. A directory is copied with its shape intact.
  s.resource_bundles = {
    'T3VoiceModels' => ['BundledModels/openai_whisper-tiny.en']
  }
end
