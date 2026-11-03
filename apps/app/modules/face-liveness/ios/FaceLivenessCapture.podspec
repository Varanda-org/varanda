require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'FaceLivenessCapture'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = package['description']
  s.license        = 'PolyForm-Noncommercial-1.0.0'
  s.author         = 'Varanda'
  s.homepage       = 'https://github.com/Varanda-org/varanda'
  s.platforms      = {
    :ios => '15.1'
  }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/Varanda-org/varanda.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # The pod is not called FaceLiveness: autolinking names the Swift module
  # after the podspec file, and a module named FaceLiveness could not import
  # the SDK's own FaceLiveness module.
  #
  # The official AWS Face Liveness UI ships only as a Swift package. React
  # Native's spm_dependency is a private top-level method of the Podfile's
  # context, so respond_to? never sees it: defined? is the only working guard.
  # The exact version is pinned on purpose (test/podsLock.test.js checks it).
  if defined?(spm_dependency)
    spm_dependency(s,
      url: 'https://github.com/aws-amplify/amplify-ui-swift-liveness',
      requirement: { kind: 'exactVersion', version: '1.5.3' },
      products: ['FaceLiveness']
    )
  end

  s.source_files = "**/*.{h,m,swift}"
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
