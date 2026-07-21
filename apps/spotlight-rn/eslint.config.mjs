import expoConfig from 'eslint-config-expo/flat.js';

export default [
  ...expoConfig,
  {
    ignores: ['dist/*', '.expo/*', 'coverage/*'],
  },
  {
    // Dynamic Type guard: raw `Text`/`TextInput` from react-native ignore the
    // app-wide font-scaling cap (React 19 killed the old Text.defaultProps
    // approach), so iOS "Larger Text" blows up fixed-width layouts. Import the
    // capped `Text` (or `AppText`) from '@spotlight/design-system' instead.
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'react-native',
              importNames: ['Text'],
              message:
                "Import the font-scale-capped `Text` (or `AppText`) from '@spotlight/design-system' instead of react-native's Text — raw Text ignores the Dynamic Type cap under React 19.",
            },
          ],
        },
      ],
    },
  },
];
