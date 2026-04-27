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
    'node_modules/(?!(?:.pnpm/)?((jest-)?react-native|@react-native|expo(nent)?|@expo(nent)?/.*|expo-router|@react-navigation/.*|react-native-svg))',
  ],
};
