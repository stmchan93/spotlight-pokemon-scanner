describe('observability context', () => {
  afterEach(() => {
    jest.resetModules();
  });

  it('falls back cleanly when Expo native modules are unavailable', () => {
    jest.resetModules();
    jest.doMock('expo-application', () => {
      throw new Error("Cannot find native module 'ExpoApplication'");
    });
    jest.doMock('expo-device', () => {
      throw new Error("Cannot find native module 'ExpoDevice'");
    });
    jest.doMock('expo-localization', () => {
      throw new Error("Cannot find native module 'ExpoLocalization'");
    });

    let properties: Record<string, unknown> | undefined;

    expect(() => {
      jest.isolateModules(() => {
        const {
          getPostHogCustomAppProperties,
        } = require('@/lib/observability/context') as typeof import('@/lib/observability/context');
        properties = getPostHogCustomAppProperties();
      });
    }).not.toThrow();

    expect(properties).toEqual(expect.objectContaining({
      $app_namespace: null,
      $device_manufacturer: null,
      $device_model: null,
      $device_type: 'Mobile',
      $is_emulator: null,
      $locale: null,
    }));
  });
});
