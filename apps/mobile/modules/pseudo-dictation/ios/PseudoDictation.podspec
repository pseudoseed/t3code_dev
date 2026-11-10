Pod::Spec.new do |s|
  s.name           = 'PseudoDictation'
  s.version        = '1.0.0'
  s.summary        = 'On-device dictation models for PseudoCode.'
  s.description    = 'Local speech recognition, voice filtering and model storage built on FluidAudio.'
  s.author         = 'pseudoseed'
  s.homepage       = 'https://github.com/pseudoseed/t3code_dev'
  s.platforms      = {
    :ios => '18.0',
  }
  s.source         = { :path => '.' }
  s.static_framework = true
  s.swift_version  = '5.9'

  s.dependency 'ExpoModulesCore'
  s.dependency 'FluidAudio'
  s.frameworks = 'AVFoundation', 'CoreML'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }
  s.source_files = '**/*.{h,m,mm,swift}'
  s.resource_bundles = {
    'PseudoDictationResources' => ['Resources/*.wav'],
  }
end
