import {
  isPushNativeModuleAvailable,
  loadNotificationsModule,
  resetNotificationsModuleCache,
} from '@/features/notifications/notifications-module';

/**
 * The case the rest of the suite CANNOT reach: `expo-notifications` is mocked
 * everywhere else, so nothing exercises a binary that lacks the native module.
 *
 * This matters because `requireNativeModule` THROWS at module evaluation when
 * the native half is missing, which is precisely the state of every binary
 * built before push was added. A static import would take the root layout down
 * on launch — a white screen for everyone on the old build after a JS-only OTA.
 */
describe('notifications native-module guard', () => {
  afterEach(() => {
    jest.resetModules();
    resetNotificationsModuleCache();
  });

  it('returns the module when the native half is present', () => {
    resetNotificationsModuleCache();
    expect(loadNotificationsModule()).not.toBeNull();
    expect(isPushNativeModuleAvailable()).toBe(true);
  });

  it('returns null instead of throwing when the native module is absent', () => {
    jest.isolateModules(() => {
      jest.doMock('expo-notifications', () => {
        throw new Error("Cannot find native module 'ExpoNotifications'");
      });
      const mod = require('@/features/notifications/notifications-module');
      mod.resetNotificationsModuleCache();

      expect(() => mod.loadNotificationsModule()).not.toThrow();
      expect(mod.loadNotificationsModule()).toBeNull();
      expect(mod.isPushNativeModuleAvailable()).toBe(false);
    });
  });

  it('reports unavailable without loading the package when the native probe is missing', () => {
    // The staging crash: the package itself required fine (lazy re-exports),
    // and the missing native module only threw on first member access.
    jest.isolateModules(() => {
      jest.doMock('expo-modules-core', () => ({
        ...jest.requireActual('expo-modules-core'),
        requireOptionalNativeModule: jest.fn(() => null),
      }));
      const factory = jest.fn(() => ({}));
      jest.doMock('expo-notifications', factory);
      const mod = require('@/features/notifications/notifications-module');
      mod.resetNotificationsModuleCache();

      expect(mod.loadNotificationsModule()).toBeNull();
      expect(mod.isPushNativeModuleAvailable()).toBe(false);
      expect(factory).not.toHaveBeenCalled();
    });
    // doMock outlives resetModules; don't let the missing probe leak onward.
    jest.dontMock('expo-modules-core');
  });

  it('only attempts the load once, so a missing module is not retried per call', () => {
    jest.isolateModules(() => {
      const factory = jest.fn(() => {
        throw new Error("Cannot find native module 'ExpoNotifications'");
      });
      jest.doMock('expo-notifications', factory);
      const mod = require('@/features/notifications/notifications-module');
      mod.resetNotificationsModuleCache();

      mod.loadNotificationsModule();
      mod.loadNotificationsModule();
      mod.loadNotificationsModule();

      expect(factory).toHaveBeenCalledTimes(1);
    });
  });
});
