// iOS Notification Service Extension: attaches the push's card image
// (Expo `richContent.image`) before the banner is shown. Android renders the
// image natively. No entitlements: downloading an image needs no App Group.
/** @type {import('@bacons/apple-targets/app.plugin').Config} */
module.exports = {
  type: 'notification-service',
  // Bundle id defaults to `<ios.bundleIdentifier>.notification-service`, so it
  // follows the per-env app id (dev / staging / prod).
  // Match the main app (expo-build-properties); the plugin default is 18.0,
  // which would leave iOS 15.5-17 users without images.
  deploymentTarget: '15.5',
};
