require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'SpotlightSlabScanner'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = package['description']
  s.license        = 'UNLICENSED'
  s.author         = 'Spotlight'
  s.homepage       = 'https://github.com/spotlight/spotlight'
  # GoogleMLKit 7.x requires iOS 15.5+, so we bump from 15.1 to 15.5 here.
  s.platforms      = { :ios => '15.5' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # ML Kit text recognition + barcode scanning. Versions are pinned to
  # known-good GoogleMLKit 7.0.0 releases. Could not verify "latest stable"
  # from this environment; if a newer 7.x is available the team can bump.
  s.dependency 'GoogleMLKit/TextRecognition', '7.0.0'
  s.dependency 'GoogleMLKit/BarcodeScanning', '7.0.0'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = '**/*.{h,m,mm,swift}'
end
