import { fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet, Text, View } from 'react-native';

import {
  GlassNavBubbleGroup,
  SpotlightThemeProvider,
  colors,
  glassNavBubbleGroupMetrics,
  glassNavBubbleGroupWidth,
  shadows,
} from '@spotlight/design-system';

// The jest.setup mock forces `isLiquidGlassAvailable()` to false, so these
// assert the NON-GLASS fallback — Android and every pre-iOS-26 target, i.e. the
// path most users see, and the one where "one capsule" is easiest to get wrong.
function renderGroup(node: React.ReactElement) {
  return render(<SpotlightThemeProvider>{node}</SpotlightThemeProvider>);
}

function flattenStyle(style: unknown) {
  if (typeof style === 'function') {
    return StyleSheet.flatten(style({ pressed: false })) as Record<string, unknown>;
  }

  return (StyleSheet.flatten(style as never) ?? {}) as Record<string, unknown>;
}

const pair = [
  { accessibilityLabel: 'Notifications', children: <Text>bell</Text>, onPress: () => {}, testID: 'group-bell' },
  { accessibilityLabel: 'New post', children: <Text>plus</Text>, onPress: () => {}, testID: 'group-add' },
];

describe('GlassNavBubbleGroup', () => {
  /*
    THE FIGMA NUMBER, AS A LITERAL. Home's toolbar (3523:15499 → 3567:22969)
    closes at `16 + 40 + 8 + 215 + 8 + 90 + 16 = 393`, so the trailing control
    has to measure exactly 90 or the flexed search pill does not land on its
    215. Two separate 40pt bubbles with the row's 8pt gap measure 88, which is
    the 2pt of drift this primitive exists to remove — pinned as a literal
    rather than recomputed from the same metrics that produce it.
  */
  it('measures the frame’s 90pt for a two-slot capsule', () => {
    expect(glassNavBubbleGroupWidth(2)).toBe(90);
    // 6 + 36 + 6 = 48 for one, and every extra slot adds 36 + 6.
    expect(glassNavBubbleGroupWidth(1)).toBe(48);
    expect(glassNavBubbleGroupWidth(3)).toBe(132);
    expect(glassNavBubbleGroupWidth(0)).toBe(0);
  });

  it('renders that width as one 40pt capsule, not two circles in a box', () => {
    renderGroup(<GlassNavBubbleGroup items={pair} testID="group" />);

    const group = flattenStyle(screen.getByTestId('group').props.style);
    expect(group.width).toBe(90);
    expect(group.height).toBe(40);
    expect(group.borderRadius).toBe(20);
    expect(group.paddingHorizontal).toBe(6);
    expect(group.gap).toBe(6);

    // THE FALLBACK IS ONE SURFACE. The lift and the fill belong to the capsule;
    // a slot carrying either would read as a chip inside a pill on Android and
    // on every pre-iOS-26 device — the exact look grouping exists to remove.
    expect(group.backgroundColor).toBe(colors.canvasElevated);
    expect(group.shadowRadius).toBe(shadows.card.shadowRadius);

    for (const testID of ['group-bell', 'group-add']) {
      const slot = flattenStyle(screen.getByTestId(testID).props.style);
      expect(slot.width).toBe(glassNavBubbleGroupMetrics.slotSize);
      expect(slot.height).toBe(glassNavBubbleGroupMetrics.slotSize);
      expect(slot.backgroundColor).toBeUndefined();
      expect(slot.borderRadius).toBeUndefined();
      expect(slot.shadowRadius).toBeUndefined();
    }
  });

  // A rounded container usually wants `overflow: 'hidden'` (`GlassButtonGroup`
  // does), and that would shave Home's unread badge, which hangs off the bell
  // at `top: -2, right: -2`. The material clips itself to `borderRadius`
  // without it, so nothing here may clip.
  it('never clips — a badge is allowed to overhang the capsule', () => {
    renderGroup(
      <GlassNavBubbleGroup
        items={[
          {
            accessibilityLabel: 'Notifications',
            children: (
              <>
                <Text>bell</Text>
                <View style={{ position: 'absolute', right: -2, top: -2 }} testID="group-badge">
                  <Text>3</Text>
                </View>
              </>
            ),
            onPress: () => {},
            testID: 'group-bell',
          },
          pair[1],
        ]}
        testID="group"
      />,
    );

    expect(flattenStyle(screen.getByTestId('group').props.style).overflow).toBe('visible');
    expect(flattenStyle(screen.getByTestId('group-bell').props.style).overflow).toBe('visible');
    expect(screen.getByTestId('group-badge')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
  });

  /*
    A 36pt slot is under the 44pt touch minimum on its own, so the slop has to
    carry it back over — and it cannot be uniform, because the OUTER edges have
    the capsule's 6pt padding to spend while the INNER ones have a 6pt gap to
    share with a neighbour.
  */
  it('gives every slot at least a 44pt touch target', () => {
    renderGroup(<GlassNavBubbleGroup items={pair} testID="group" />);

    const { slotSize } = glassNavBubbleGroupMetrics;
    for (const testID of ['group-bell', 'group-add']) {
      const hitSlop = screen.getByTestId(testID).props.hitSlop;
      expect(slotSize + hitSlop.left + hitSlop.right).toBeGreaterThanOrEqual(44);
      expect(slotSize + hitSlop.top + hitSlop.bottom).toBeGreaterThanOrEqual(44);
    }

    // Outside edges get the full 8 (matching a standalone `GlassNavBubble`);
    // inside edges take the 4 that still clears 44 across the 6pt seam.
    expect(screen.getByTestId('group-bell').props.hitSlop).toEqual({
      bottom: 8,
      left: 8,
      right: 4,
      top: 8,
    });
    expect(screen.getByTestId('group-add').props.hitSlop).toEqual({
      bottom: 8,
      left: 4,
      right: 8,
      top: 8,
    });
  });

  it('falls back to a transparent ring on a dark surface, with no white fill', () => {
    renderGroup(<GlassNavBubbleGroup items={pair} surface="onDark" testID="group" />);

    const group = flattenStyle(screen.getByTestId('group').props.style);
    // The camera feed must stay visible through the capsule.
    expect(group.backgroundColor).toBeUndefined();
    expect(group.borderWidth).toBe(1);
    expect(group.borderColor).toBe(colors.gray0);
    expect(group.shadowRadius).toBeUndefined();
  });

  it('routes each slot to its own handler and dims only the pressed slot', () => {
    const onBell = jest.fn();
    const onAdd = jest.fn();

    renderGroup(
      <GlassNavBubbleGroup
        items={[
          { ...pair[0], onPress: onBell },
          { ...pair[1], disabled: true, onPress: onAdd },
        ]}
        testID="group"
      />,
    );

    fireEvent.press(screen.getByTestId('group-bell'));
    expect(onBell).toHaveBeenCalledTimes(1);

    fireEvent.press(screen.getByTestId('group-add'));
    expect(onAdd).not.toHaveBeenCalled();
    expect(flattenStyle(screen.getByTestId('group-add').props.style).opacity).toBe(0.45);
    // The capsule itself never dims — the material must not fade out from
    // under the slot that is still live.
    expect(flattenStyle(screen.getByTestId('group').props.style).opacity).toBeUndefined();
    expect(flattenStyle(screen.getByTestId('group-bell').props.style).opacity).toBe(1);
  });
});
