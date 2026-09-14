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
  {
    // Jest files drive module mocking, which is a load-order problem, not a
    // style one: `jest.mock` is hoisted above `import`, so a mock factory (and
    // anything that must be read AFTER the mock is installed) has to use
    // `require()` to be evaluated at the right moment. Static imports cannot
    // express that. The rule stays on for `src/**`, where it is real advice.
    files: ['__tests__/**/*.{ts,tsx}', 'jest.setup.ts', 'test-support/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    // Flake guard: `expect(element).toBeNull()` makes Jest pretty-print the
    // whole ReactTestInstance — including its `_fiber` graph — when it fails.
    // That costs ~700ms PER ATTEMPT, and `waitFor` retries on a 1s budget, so a
    // polled negative assertion gets one or two tries instead of twenty and the
    // test becomes a coin flip on how fast the async state settles. RNTL's
    // `not.toBeOnTheScreen()` asserts the same thing and formats the element
    // compactly (~1ms), so retries stay cheap.
    files: ['__tests__/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.name='waitFor'] CallExpression[callee.property.name=/^(toBeNull|toBeFalsy)$/]",
          message:
            'Inside waitFor(), use `expect(...).not.toBeOnTheScreen()` instead of `.toBeNull()`/`.toBeFalsy()`. A failing toBeNull on a host element serializes the entire React fiber (~700ms), which burns waitFor\'s whole retry budget and makes the test flaky.',
        },
      ],
    },
  },
];
