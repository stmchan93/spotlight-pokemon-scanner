import { act, render, screen, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';

import {
  CircularTabAvatarProvider,
  useCircularTabAvatar,
} from '@/components/circular-tab-avatar';

/**
 * `toDataURL` is a native method on a mounted `Svg`, and the `href` is a real
 * network fetch — neither exists under jest. The mock keeps the two things this
 * component actually coordinates: a ref that hands back base64, and an `onLoad`
 * that says when there is something to capture.
 */
// Photo-sized: the provider rejects captures too small to hold a photo.
const PHOTO_BASE64 = 'P'.repeat(8000);
const mockToDataURL = jest.fn((callback: (base64: string) => void) => callback(PHOTO_BASE64));

jest.mock('react-native-svg', () => {
   
  const React = require('react');
   
  const { View } = require('react-native');

  const Svg = React.forwardRef(
    (props: { children?: unknown }, ref: React.Ref<{ toDataURL: unknown }>) => {
      React.useImperativeHandle(ref, () => ({ toDataURL: mockToDataURL }));
      return React.createElement(View, { testID: 'raster-svg' }, props.children);
    },
  );
  Svg.displayName = 'Svg';

  // Stands in for the remote image having decoded inside the SVG.
  const SvgImage = ({ onLoad }: { onLoad?: () => void }) => {
    React.useEffect(() => {
      onLoad?.();
    }, [onLoad]);
    return null;
  };

  const passthrough = ({ children }: { children?: unknown }) =>
    React.createElement(View, null, children);

  return {
    __esModule: true,
    default: Svg,
    Circle: passthrough,
    ClipPath: passthrough,
    Defs: passthrough,
    Image: SvgImage,
  };
});

let mockAvatarURL: string | null = null;
jest.mock('@/providers/auth-provider', () => ({
  useAuth: () => ({ currentUser: { id: 'u1', avatarURL: mockAvatarURL } }),
}));

function Consumer() {
  const icon = useCircularTabAvatar();
  return <Text testID="icon">{JSON.stringify(icon)}</Text>;
}

function renderProvider() {
  return render(
    <CircularTabAvatarProvider>
      <Consumer />
    </CircularTabAvatarProvider>,
  );
}

describe('CircularTabAvatarProvider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockToDataURL.mockReset();
    mockToDataURL.mockImplementation((callback) => callback(PHOTO_BASE64));
    mockAvatarURL = null;
  });

  it('publishes nothing when the account has no photo, and mounts no rasteriser', () => {
    renderProvider();

    expect(screen.getByTestId('icon').props.children).toBe('null');
    // Nothing to draw means nothing off-screen to draw it with.
    expect(screen.queryByTestId('raster-svg')).toBeNull();
    expect(mockToDataURL).not.toHaveBeenCalled();
  });

  it('rasterises the photo into a tab-sized @3x data URI', async () => {
    mockAvatarURL = 'https://cdn.example/avatar.jpg';
    renderProvider();

    await waitFor(() => {
      expect(screen.getByTestId('icon').props.children).not.toBe('null');
    });

    expect(JSON.parse(screen.getByTestId('icon').props.children)).toEqual({
      uri: `data:image/png;base64,${PHOTO_BASE64}`,
      // 28pt at scale 3. Tagging the scale is what stops an 84px bitmap being
      // drawn as an 84pt icon that swamps the tab bar.
      width: 28,
      height: 28,
      scale: 3,
    });

    // The off-screen SVG is torn down once its output has been captured.
    await waitFor(() => {
      expect(screen.queryByTestId('raster-svg')).not.toBeOnTheScreen();
    });
  });

  it('drops the old face immediately when the photo changes', async () => {
    mockAvatarURL = 'https://cdn.example/old.jpg';
    const view = renderProvider();
    await waitFor(() => {
      expect(screen.getByTestId('icon').props.children).not.toBe('null');
    });

    // A raster is keyed by the URL it came from, so switching photos must not
    // keep serving the previous one while the new one is still being drawn.
    mockToDataURL.mockImplementationOnce(() => {});
    mockAvatarURL = 'https://cdn.example/new.jpg';
    view.rerender(
      <CircularTabAvatarProvider>
        <Consumer />
      </CircularTabAvatarProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('icon').props.children).toBe('null');
    });
  });

  it('retries a blank capture and ships only the real photo', async () => {
    // react-native-svg can fire onLoad before the bitmap is attached, so the
    // first capture comes back as an empty canvas.
    mockToDataURL.mockImplementationOnce((callback) => callback('EMPTY'));
    mockAvatarURL = 'https://cdn.example/avatar.jpg';
    renderProvider();

    await waitFor(() => {
      expect(screen.getByTestId('icon').props.children).not.toBe('null');
    }, { timeout: 3000 });
    expect(mockToDataURL).toHaveBeenCalledTimes(2);
    expect(JSON.parse(screen.getByTestId('icon').props.children).uri).toBe(
      `data:image/png;base64,${PHOTO_BASE64}`,
    );
  });

  it('keeps the glyph when every capture is blank', async () => {
    jest.useFakeTimers();
    mockToDataURL.mockImplementation((callback) => callback('EMPTY'));
    mockAvatarURL = 'https://cdn.example/avatar.jpg';
    renderProvider();

    await act(async () => {
      jest.advanceTimersByTime(10_000);
    });
    expect(mockToDataURL).toHaveBeenCalledTimes(5);
    expect(screen.getByTestId('icon').props.children).toBe('null');
    jest.useRealTimers();
  });
});
