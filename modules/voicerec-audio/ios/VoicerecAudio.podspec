Pod::Spec.new do |s|
  s.name           = 'VoicerecAudio'
  s.version        = '1.0.0'
  s.summary        = 'Audio clipping and on-device transcription for voicerec'
  s.description    = 'Reads a still-recording audio file, cuts a time range, and transcribes it on device.'
  s.author         = ''
  s.homepage       = 'https://github.com/daishir0/voicerec'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
