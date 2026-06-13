import { Fragment } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useSpotlightTheme } from '@spotlight/design-system';
import type { CardText, CardTextTypeValue } from '@spotlight/api-client';

type CardProductDetailsProps = {
  cardText: CardText;
  testID?: string;
};

type DetailLine = {
  key: string;
  label: string;
  value: string;
};

function joinTypeValues(entries: CardTextTypeValue[]): string {
  return entries.map((entry) => `${entry.type} ${entry.value}`.trim()).join(', ');
}

/** Builds the ordered label/value lines, omitting any section with no content. */
function buildLines(cardText: CardText): DetailLine[] {
  const lines: DetailLine[] = [];

  const number = cardText.number?.trim();
  const rarity = cardText.rarity?.trim();
  if (number || rarity) {
    lines.push({
      key: 'number-rarity',
      label: 'Card Number / Rarity',
      value: [number, rarity].filter(Boolean).join(' / '),
    });
  }

  const types = cardText.types.filter(Boolean);
  const hp = cardText.hp?.trim();
  const stage = cardText.stage?.trim();
  if (types.length > 0 || hp || stage) {
    lines.push({
      key: 'type-hp-stage',
      label: 'Card Type / HP / Stage',
      value: [types.join('/'), hp, stage].filter(Boolean).join(' / '),
    });
  }

  cardText.abilities.forEach((ability, index) => {
    const name = ability.name?.trim();
    const text = ability.text?.trim();
    if (!name && !text) {
      return;
    }
    lines.push({
      key: `ability-${index}`,
      label: 'Card Text / Ability',
      value: [name, text].filter(Boolean).join(': '),
    });
  });

  cardText.attacks.forEach((attack, index) => {
    const cost = attack.cost.filter(Boolean).join('');
    const name = attack.name?.trim();
    const damage = attack.damage?.trim();
    const text = attack.text?.trim();
    if (!cost && !name && !damage && !text) {
      return;
    }
    const head = [cost ? `[${cost}]` : null, name].filter(Boolean).join(' ');
    const withDamage = damage ? `${head} (${damage})` : head;
    lines.push({
      key: `attack-${index}`,
      label: `Attack ${index + 1}`,
      value: [withDamage, text].filter(Boolean).join(' '),
    });
  });

  const weakness = joinTypeValues(cardText.weaknesses);
  const resistance = joinTypeValues(cardText.resistances);
  const retreat = cardText.retreatCost.filter(Boolean).join('');
  if (weakness || resistance || retreat) {
    lines.push({
      key: 'weakness-resistance-retreat',
      label: 'Weakness / Resistance / Retreat Cost',
      value: [weakness || '—', resistance || '—', retreat || '—'].join(' / '),
    });
  }

  return lines;
}

export function CardProductDetails({ cardText, testID }: CardProductDetailsProps) {
  const theme = useSpotlightTheme();
  const lines = buildLines(cardText);

  if (lines.length === 0) {
    return null;
  }

  return (
    <View style={[styles.root, { gap: theme.spacing.xs }]} testID={testID}>
      <Text style={theme.typography.titleMedium}>Product Details</Text>
      <View style={[styles.lines, { gap: theme.spacing.xxs }]}>
        {lines.map((line) => (
          <Fragment key={line.key}>
            <Text
              style={[theme.typography.body, { color: theme.colors.textSecondary }]}
              testID={testID ? `${testID}-${line.key}` : undefined}
            >
              <Text style={[theme.typography.bodyStrong, { color: theme.colors.textPrimary }]}>
                {line.label}:{' '}
              </Text>
              {line.value}
            </Text>
          </Fragment>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  lines: {
    width: '100%',
  },
  root: {
    width: '100%',
  },
});

export default CardProductDetails;
