Pod::Spec.new do |s|
  s.name             = 'moneymaker_flutter'
  s.version          = '1.0.0'
  s.summary          = 'MoneyMaker subscriptions SDK for Flutter (StoreKit 2).'
  s.description      = 'Flutter plugin wrapping the MoneyMaker iOS SDK (vendored from sdk/ios).'
  s.homepage         = 'https://github.com/amineprimesmr/moneymaker'
  s.license          = { :type => 'MIT', :file => '../LICENSE' }
  s.author           = { 'MoneyMaker' => 'contact@moneymakerr.com' }
  s.source           = { :path => '.' }
  # Classes/MoneyMakerCore is a copy of sdk/ios/Sources/MoneyMaker (tool/sync_native_sources.sh).
  s.source_files     = 'Classes/**/*.swift'
  s.dependency 'Flutter'
  s.platform         = :ios, '16.0'
  s.frameworks       = 'StoreKit', 'CryptoKit'
  s.swift_version    = '5.9'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES', 'EXCLUDED_ARCHS[sdk=iphonesimulator*]' => 'i386' }
end
