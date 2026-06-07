import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { SpotlightThemeProvider } from '@spotlight/design-system';

import { TransactionPhotoCapture } from '@/features/sales/components/transaction-photo-capture';

const safeAreaMetrics = {
  frame: { height: 852, width: 393, x: 0, y: 0 },
  insets: { top: 59, right: 0, bottom: 34, left: 0 },
};

function ControlledCapture() {
  const [photoUri, setPhotoUri] = useState<string | null>(null);

  return (
    <TransactionPhotoCapture
      onCapture={setPhotoUri}
      onClear={() => setPhotoUri(null)}
      photoUri={photoUri}
      testIDPrefix="capture"
    />
  );
}

function renderCapture(node: React.ReactNode) {
  return render(
    <SafeAreaProvider initialMetrics={safeAreaMetrics}>
      <SpotlightThemeProvider>{node}</SpotlightThemeProvider>
    </SafeAreaProvider>,
  );
}

describe('TransactionPhotoCapture', () => {
  it('opens the camera, captures a photo, and lifts the captured uri to the parent', async () => {
    renderCapture(<ControlledCapture />);

    fireEvent.press(screen.getByTestId('capture-photo-trigger'));
    expect(screen.getByTestId('capture-camera-modal')).toBeTruthy();

    fireEvent.press(screen.getByTestId('capture-capture-photo'));

    await waitFor(() => {
      expect(screen.getByTestId('capture-photo-thumbnail')).toBeTruthy();
    });
    expect(screen.getByTestId('capture-retake-photo')).toBeTruthy();
  });

  it('clears the captured photo when Remove is pressed', async () => {
    renderCapture(<ControlledCapture />);

    fireEvent.press(screen.getByTestId('capture-photo-trigger'));
    fireEvent.press(screen.getByTestId('capture-capture-photo'));

    await waitFor(() => {
      expect(screen.getByTestId('capture-photo-thumbnail')).toBeTruthy();
    });

    fireEvent.press(screen.getByTestId('capture-clear-photo'));

    await waitFor(() => {
      expect(screen.queryByTestId('capture-photo-thumbnail')).toBeNull();
    });
    expect(screen.getByTestId('capture-photo-trigger')).toBeTruthy();
  });

  it('renders the provided photo uri as a controlled thumbnail', () => {
    renderCapture(
      <TransactionPhotoCapture
        onCapture={jest.fn()}
        photoUri="file:///existing.jpg"
        testIDPrefix="capture"
      />,
    );

    expect(screen.getByTestId('capture-photo-thumbnail')).toBeTruthy();
    expect(screen.queryByTestId('capture-photo-trigger')).toBeNull();
  });

  it('shows the card image as the default preview when no photo is captured', () => {
    renderCapture(
      <TransactionPhotoCapture
        fallbackImageUrl="https://cdn.spotlight.test/card.png"
        onCapture={jest.fn()}
        photoUri={null}
        testIDPrefix="capture"
      />,
    );

    // The card image fills the slot (not the empty gray camera trigger) and an
    // "Add photo" action is offered instead.
    expect(screen.getByTestId('capture-card-image')).toBeTruthy();
    expect(screen.getByTestId('capture-add-photo')).toBeTruthy();
    expect(screen.queryByTestId('capture-photo-trigger')).toBeNull();
  });

  it('prefers a captured photo over the card image fallback', () => {
    renderCapture(
      <TransactionPhotoCapture
        fallbackImageUrl="https://cdn.spotlight.test/card.png"
        onCapture={jest.fn()}
        photoUri="file:///existing.jpg"
        testIDPrefix="capture"
      />,
    );

    expect(screen.getByTestId('capture-photo-thumbnail')).toBeTruthy();
    expect(screen.queryByTestId('capture-card-image')).toBeNull();
  });
});
