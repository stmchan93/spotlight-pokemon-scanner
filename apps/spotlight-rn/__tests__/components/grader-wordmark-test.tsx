import { render, screen } from '@testing-library/react-native';

import { CardListRow, GraderWordmark, InventoryCardTile } from '@spotlight/design-system';

describe('GraderWordmark', () => {
  it('renders an image mark for known graders and text fallback for unknown', () => {
    render(
      <>
        <GraderWordmark grader="PSA" testID="mark-psa" />
        <GraderWordmark grader="cgc" testID="mark-cgc" />
        <GraderWordmark grader="BGS" testID="mark-bgs" />
        <GraderWordmark grader="TAG" testID="mark-tag" />
        <GraderWordmark grader="ACE" testID="mark-ace" />
      </>,
    );

    for (const id of ['mark-psa', 'mark-cgc', 'mark-bgs', 'mark-tag']) {
      expect(screen.getByTestId(id).type).toBe('Image');
    }
    expect(screen.getByTestId('mark-ace').props.children).toBe('ACE');
  });
});

// Slab treatment: the THUMBNAIL gets the slab-case frame keyed by the entry's
// own grader; the grade TEXT line stays the plain fused label ("PSA 10").
describe('CardListRow slab frame', () => {
  const base = {
    imageUrl: null,
    name: 'Umbreon VMAX',
    cardNumber: '215/203',
    setName: 'Evolving Skies',
    marketPrice: 1000,
    quantity: 1,
  };

  it('PSA slab: frame with PSA-descriptor label + plain "PSA 10" text line', () => {
    render(
      <CardListRow
        {...base}
        grader="PSA"
        grade="10"
        gradeLabel="Holofoil · PSA 10"
        testID="row"
      />,
    );
    // Frame present, label carries the grade.
    expect(screen.getByTestId('row-slab-frame')).toBeTruthy();
    expect(screen.getByTestId('row-slab-frame-grade').props.children).toBe('10');
    // The meta line is the untouched plain text — no wordmark image.
    expect(screen.getByText('Holofoil · PSA 10')).toBeTruthy();
    expect(screen.queryByTestId('row-grader-mark')).toBeNull();
  });

  it('grader-correct: CGC slab frame shows CGC\'s descriptor, not PSA\'s', () => {
    render(<CardListRow {...base} grader="CGC" grade="10" gradeLabel="CGC 10" testID="row" />);
    expect(screen.getByTestId('row-slab-frame')).toBeTruthy();
    // CGC 10's own descriptor is "GEM MINT"; PSA 10's is "GEM MT". The frame
    // reads from the grader-specific map, so it shows CGC's, never PSA's.
    expect(screen.getByText('GEM MINT')).toBeTruthy();
    expect(screen.queryByText('GEM MT')).toBeNull();
    expect(screen.getByText('CGC 10')).toBeTruthy();
  });

  it('raw card: no frame, plain condition text', () => {
    render(<CardListRow {...base} gradeLabel="Holofoil · Near Mint" testID="row" />);
    expect(screen.queryByTestId('row-slab-frame')).toBeNull();
    expect(screen.getByText('Holofoil · Near Mint')).toBeTruthy();
  });
});

describe('InventoryCardTile slab frame', () => {
  const base = {
    imageUrl: null,
    name: 'Umbreon VMAX',
    setName: 'Evolving Skies',
    cardNumber: '215/203',
    priceLabel: '$1,000.00',
    isFavorite: false,
    onPress: () => {},
    onToggleFavorite: () => {},
  };

  it('slab tile frames the art and keeps the fused quality text', () => {
    render(
      <InventoryCardTile
        {...base}
        kind="slab"
        graderLabel="PSA"
        gradeLabel="10"
        testID="tile"
      />,
    );
    expect(screen.getByTestId('tile-slab-frame')).toBeTruthy();
    expect(screen.getByText('PSA 10')).toBeTruthy();
    expect(screen.queryByTestId('tile-grader-mark')).toBeNull();
  });

  it('raw tile renders without the frame', () => {
    render(
      <InventoryCardTile
        {...base}
        kind="raw"
        conditionLabel="Near Mint"
        testID="tile"
      />,
    );
    expect(screen.queryByTestId('tile-slab-frame')).toBeNull();
    expect(screen.getByText('Near Mint')).toBeTruthy();
  });
});
