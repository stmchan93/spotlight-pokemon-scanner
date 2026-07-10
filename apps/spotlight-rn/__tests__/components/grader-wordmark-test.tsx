import { render, screen } from '@testing-library/react-native';

import { CardListRow, GraderWordmark, InventoryCardTile } from '@spotlight/design-system';

// Grader-correctness guarantee: the mark + descriptor derive from the SAME
// entry's grader — a CGC card never shows the PSA mark or PSA's descriptors.
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

    // Known graders render Image marks (type has no children text).
    for (const id of ['mark-psa', 'mark-cgc', 'mark-bgs', 'mark-tag']) {
      expect(screen.getByTestId(id).type).toBe('Image');
    }
    // Unknown grader falls back to its OWN name as text.
    expect(screen.getByTestId('mark-ace').props.children).toBe('ACE');
  });
});

describe('CardListRow branded grade line', () => {
  const base = {
    imageUrl: null,
    name: 'Umbreon VMAX',
    cardNumber: '215/203',
    setName: 'Evolving Skies',
    marketPrice: 1000,
    quantity: 1,
  };

  it('PSA slab: PSA mark + grade with PSA descriptor + variant suffix', () => {
    render(
      <CardListRow {...base} grader="PSA" grade="10" gradeSuffix="Holofoil" testID="row" />,
    );
    expect(screen.getByTestId('row-grader-mark').type).toBe('Image');
    expect(screen.getByText('10 (GEM-MT) · Holofoil')).toBeTruthy();
  });

  it('CGC slab: CGC mark, bare grade — never the PSA descriptor', () => {
    render(<CardListRow {...base} grader="CGC" grade="10" testID="row" />);
    expect(screen.getByTestId('row-grader-mark').type).toBe('Image');
    expect(screen.getByText('10')).toBeTruthy();
    expect(screen.queryByText(/GEM-MT/)).toBeNull();
  });

  it('unknown grader: text fallback with its own name + bare grade', () => {
    render(<CardListRow {...base} grader="SGC" grade="9.5" testID="row" />);
    expect(screen.getByText('SGC')).toBeTruthy();
    expect(screen.getByText('9.5')).toBeTruthy();
    expect(screen.queryByText(/GEM-MT/)).toBeNull();
  });

  it('raw card keeps the plain gradeLabel text (no mark)', () => {
    render(<CardListRow {...base} gradeLabel="Holofoil · Near Mint" testID="row" />);
    expect(screen.getByText('Holofoil · Near Mint')).toBeTruthy();
    expect(screen.queryByTestId('row-grader-mark')).toBeNull();
  });
});

describe('InventoryCardTile branded quality line', () => {
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

  it('PSA slab tile renders the PSA mark + bare grade', () => {
    render(
      <InventoryCardTile
        {...base}
        kind="slab"
        graderLabel="PSA"
        gradeLabel="10"
        testID="tile"
      />,
    );
    expect(screen.getByTestId('tile-grader-mark').type).toBe('Image');
    expect(screen.getByText('10')).toBeTruthy();
  });

  it('unknown grader tile keeps the fused text line', () => {
    render(
      <InventoryCardTile
        {...base}
        kind="slab"
        graderLabel="SGC"
        gradeLabel="9"
        testID="tile"
      />,
    );
    expect(screen.queryByTestId('tile-grader-mark')).toBeNull();
    expect(screen.getByText('SGC 9')).toBeTruthy();
  });
});
