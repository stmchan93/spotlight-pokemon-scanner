module.exports = {
  preset: 'jest-expo',
  roots: [
    '<rootDir>',
    '<rootDir>/../../packages/api-client/src',
    '<rootDir>/../../packages/design-system/src',
  ],
  testMatch: ['<rootDir>/__tests__/**/*-test.ts?(x)'],
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^@spotlight/design-system$': '<rootDir>/../../packages/design-system/src/index.ts',
    '^@spotlight/design-system/(.*)$': '<rootDir>/../../packages/design-system/src/$1',
    '^@spotlight/api-client$': '<rootDir>/test-support/api-client.ts',
    '^@spotlight/api-client/(.*)$': '<rootDir>/../../packages/api-client/src/$1',
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
  transformIgnorePatterns: [
    'node_modules/(?!(?:.pnpm/)?((jest-)?react-native|@react-native|expo(nent)?|@expo(nent)?/.*|expo-router|@react-navigation/.*|react-native-svg|react-native-reanimated|react-native-worklets))',
  ],
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/**/*.d.ts',
    '!src/**/__mocks__/**',
    '!src/**/types.ts',
    '!src/**/index.ts',
  ],
  // File-scoped thresholds: enforce 70% only on the seed modules we have
  // dedicated tests for. Global thresholds stay disabled until coverage of
  // the rest of the app catches up.
  coverageThreshold: {
    'src/features/scanner/recent-capture-swipe.ts': {
      branches: 70,
      functions: 70,
      lines: 70,
      statements: 70,
    },
    'src/features/portfolio/components/portfolio-formatting.ts': {
      branches: 70,
      functions: 70,
      lines: 70,
      statements: 70,
    },
  },
};
