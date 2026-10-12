require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'MoneyMakerReactNative'
  s.version        = package['version']
  s.summary        = package['description']
  s.homepage       = package['homepage']
  s.license        = package['license']
  s.author         = 'MoneyMaker'
  s.source         = { git: 'https://github.com/moneymaker/moneymaker.git', tag: s.version.to_s }
  s.platforms      = { ios: '16.0' }
  s.swift_version  = '5.9'
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'StoreKit'

  # ios/MoneyMakerCore contains the native iOS SDK sources (copied by scripts/sync-native.js).
  s.source_files = 'ios/**/*.swift'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
