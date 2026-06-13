// Expo's default preset is applied implicitly when there's no babel config, but
// adding Reanimated requires an explicit config so we can register the worklets
// babel plugin. `react-native-worklets/plugin` (Reanimated 4's plugin) MUST be
// listed last.
module.exports = function babelConfig(api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: ['react-native-worklets/plugin'],
  };
};
