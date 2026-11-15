require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'SentinelSpike'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = package['description']
  s.license        = 'PolyForm-Noncommercial-1.0.0'
  s.author         = 'Varanda'
  s.homepage       = 'https://github.com/Varanda-org/varanda'
  s.platforms      = {
    :ios => '18.0'
  }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/Varanda-org/varanda.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  # The Objective-C API over the static ONNX Runtime xcframework
  # (onnxruntime-c comes with it). Expo's autolinking turns on modular
  # headers for an Expo module's dependencies, so Swift imports it directly.
  # Same version as the account service's onnxruntime-node (apps/cli,
  # through @huggingface/transformers 3.8.1). MIT.
  s.dependency 'onnxruntime-objc', '1.21.0'

  s.source_files = "**/*.{h,m,swift}"
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
