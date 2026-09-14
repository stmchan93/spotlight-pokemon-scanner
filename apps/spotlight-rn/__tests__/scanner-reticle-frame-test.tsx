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
  it('is one closed rounded outline, per Figma 5085:15171', () => {
    renderSurface(null);

    const outline = StyleSheet.flatten(screen.getByTestId('frame-reticle-outline').props.style);
    expect(outline).toMatchObject({
      borderColor: colors.purple200,
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

  it('is the same ink as the frame, so the two read as one object', () => {
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
