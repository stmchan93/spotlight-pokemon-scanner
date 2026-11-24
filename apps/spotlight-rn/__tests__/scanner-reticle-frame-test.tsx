import { render, screen } from '@testing-library/react-native';
import { createRef } from 'react';
import { StyleSheet } from 'react-native';

import { colors } from '@spotlight/design-system';

import type { RawScannerCameraHandle } from '@/features/scanner/raw-scanner-capture-surface';
import {
  makeRawScannerCaptureLayout,
  RawScannerCaptureSurface,
  scannerReticleOutlineStrokeWidth,
} from '@/features/scanner/raw-scanner-capture-surface';

/*
  The scanner frame and the pocket grid it contains.

  This frame drifts — it has been purple, then white, then purple again, and
  four detached corner brackets before it became one closed outline — and every
  past flip went unnoticed until someone looked at a phone. The grid's
  relationship to it drifted too: it was a SIBLING positioned in the preview
  canvas's own coordinates, which left the outer cells a pixel narrower than the
  middle one and let the frame contract away from the grid during the capture
  pulse. Nesting is the fix, so nesting is what these assert.
*/

const layout = makeRawScannerCaptureLayout({
  containerHeight: 844,
  containerWidth: 390,
  mode: 'page',
  safeAreaTop: 59,
});

function renderSurface(pageGrid: { columns: number; rows: number } | null) {
  return render(
    <RawScannerCaptureSurface
      cameraRef={createRef<RawScannerCameraHandle>()}
      canCapture
      captureResolution="page"
      hasCameraPermission
      layout={layout}
      onCameraReady={() => {}}
      onCapture={() => {}}
      pageGrid={pageGrid}
      prompt=""
      shouldMountCamera
      testIDPrefix="frame"
    />,
  );
}

describe('the scanner frame', () => {
  it('is one closed rounded outline, per Figma 5559:7112', () => {
    renderSurface(null);

    const outline = StyleSheet.flatten(screen.getByTestId('frame-reticle-outline').props.style);
    expect(outline).toMatchObject({
      borderColor: colors.purple500,
      borderRadius: 12,
      borderWidth: scannerReticleOutlineStrokeWidth,
    });
    // No translucent fill: Figma composites one over flat artwork, but over a
    // live viewfinder it scrims the very card being scanned.
    expect(outline.backgroundColor).toBeUndefined();
  });

  it('draws no pocket grid in single-card mode', () => {
    renderSurface(null);

    expect(screen.queryByTestId('frame-binder-grid')).toBeNull();
  });
});

describe('the pocket grid', () => {
  it('divides the frame INTERIOR, so all three cells are the same width', () => {
    /*
      The 1px border is drawn inside the frame's box. Dividing that outer box
      into thirds is what left each outer cell a pixel short; the grid is inset
      by exactly the stroke width so the thirds are thirds of what the border
      leaves behind, and each line runs flush into the frame.
    */
    renderSurface({ columns: 3, rows: 3 });

    expect(StyleSheet.flatten(screen.getByTestId('frame-binder-grid').props.style))
      .toMatchObject({ margin: scannerReticleOutlineStrokeWidth });
  });

  it('positions its lines in PERCENTAGES of that interior, not screen coordinates', () => {
    // Percentages are what make the split survive both the inset above and the
    // capture pulse's transform — a pixel offset computed once would not.
    renderSurface({ columns: 3, rows: 3 });

    const lines = screen.getByTestId('frame-binder-grid').props.children.flat()
      .map((line: { props: { style: unknown } }) => StyleSheet.flatten(line.props.style));
    const verticals = lines.filter((line: { width?: number }) => line.width != null);
    const horizontals = lines.filter((line: { height?: number }) => line.height != null);

    expect(verticals.map((line: { left: string }) => line.left)).toEqual([
      `${100 / 3}%`,
      `${(100 / 3) * 2}%`,
    ]);
    expect(horizontals.map((line: { top: string }) => line.top)).toEqual([
      `${100 / 3}%`,
      `${(100 / 3) * 2}%`,
    ]);
  });

  it('stays pale lilac under the purple 500 frame, so the 3x3 reads as a hint', () => {
    /*
      Figma draws these lines in the near-white `purple50` (5085:15377 /
      5085:15380) and we deliberately don't — over a live viewfinder that
      vanishes into a glossy card's highlights, and it left the frame dominant
      with the 3x3 reading as a faint hint. Pinned so the departure is a
      decision somebody has to argue with, not a value that quietly drifts back.
    */
    renderSurface({ columns: 3, rows: 3 });

    const [line] = screen.getByTestId('frame-binder-grid').props.children.flat();
    const style = StyleSheet.flatten(line.props.style);
    expect(style.backgroundColor).toBe(colors.purple200);
    expect(style.backgroundColor).not.toBe(colors.purple50);
  });
});

describe('design review 2026-11-16', () => {
  const cardLayout = makeRawScannerCaptureLayout({
    containerHeight: 844,
    containerWidth: 390,
    controlsInsideFrame: true,
    safeAreaTop: 59,
  });

  function renderCardSurface(props: { blurOutsideFrameIntensity?: number; isTrayExpanded?: boolean }) {
    return render(
      <RawScannerCaptureSurface
        blurOutsideFrameIntensity={props.blurOutsideFrameIntensity}
        cameraRef={createRef<RawScannerCameraHandle>()}
        canCapture
        hasCameraPermission
        isTrayExpanded={props.isTrayExpanded}
        layout={cardLayout}
        onCameraReady={() => {}}
        onCapture={() => {}}
        prompt="Tap to scan"
        shouldMountCamera
        testIDPrefix="frame"
      />,
    );
  }

  it('blurs the camera all around the frame, leaving the frame itself clear', () => {
    renderCardSurface({ blurOutsideFrameIntensity: 10 });

    const strips = screen.getByTestId('frame-outside-blur').props.children as {
      props: { intensity: number; style: unknown };
    }[];
    expect(strips).toHaveLength(4);
    const frame = cardLayout.reticle;
    const rects = strips.map(
      (strip) =>
        StyleSheet.flatten(strip.props.style as never) as unknown as {
          height: number;
          left: number;
          top: number;
          width: number;
        },
    );
    strips.forEach((strip) => expect(strip.props.intensity).toBe(10));
    // Strips tile the screen minus the frame rect, and none enters the window.
    const area = rects.reduce((sum, r) => sum + r.width * r.height, 0);
    expect(area).toBeCloseTo(390 * 844 - frame.width * frame.height);
    rects.forEach((r) => {
      const overlapsX = r.left < frame.x + frame.width && r.left + r.width > frame.x;
      const overlapsY = r.top < frame.y + frame.height && r.top + r.height > frame.y;
      expect(overlapsX && overlapsY).toBe(false);
    });
  });

  it('draws no outside blur when not asked for, or with the tray expanded', () => {
    renderCardSurface({});
    expect(screen.queryByTestId('frame-outside-blur')).toBeNull();
    screen.unmount();
    renderCardSurface({ blurOutsideFrameIntensity: 10, isTrayExpanded: true });
    expect(screen.queryByTestId('frame-outside-blur')).toBeNull();
  });

  it('shows the hint in sentence case at Label size (Figma 6711:6012)', () => {
    renderCardSurface({});
    const prompt = screen.getByTestId('frame-prompt');
    expect(prompt).toHaveTextContent('Tap to scan');
    const style = StyleSheet.flatten(prompt.props.style);
    expect(style.fontSize).toBe(14);
    expect(style.textTransform).toBeUndefined();
  });

  it('puts the top bar directly under the safe area, like every other tab header', () => {
    expect(cardLayout.backButtonTop).toBe(59);
  });
});
