import type { AssistantCardRef, AssistantConditionCode, AssistantPrintingChoice } from '@spotlight/api-client';

const CONDITION_NAMES: Record<AssistantConditionCode, string> = {
  NM: 'Near Mint',
  LP: 'Lightly Played',
  MP: 'Moderately Played',
  HP: 'Heavily Played',
  DMG: 'Damaged',
};

function printingLabel(card: AssistantCardRef): string {
  const where = [card.setName, card.number].filter(Boolean).join(' ');
  return where ? `${card.name} (${where})` : card.name;
}

/**
 * The follow-up sent when the user taps a candidate printing. It names one exact
 * printing (and rides with that card_id as context), so the server proposes the
 * add/update for it. Only details the user stated are repeated: unstated ones
 * stay the proposal's defaults (×1, Near Mint), editable before Confirm.
 */
export function assistantPrintingChoiceMessage(choice: AssistantPrintingChoice, card: AssistantCardRef): string {
  const label = printingLabel(card);
  const condition = choice.conditionStated && choice.condition ? CONDITION_NAMES[choice.condition] : null;
  if (choice.intent === 'update') {
    const changes = [
      choice.quantityStated && choice.quantity != null
        ? `${choice.quantity} ${choice.quantity === 1 ? 'copy' : 'copies'}`
        : null,
      condition,
    ].filter(Boolean);
    return changes.length > 0 ? `Update my ${label} to ${changes.join(', ')}` : `Update my ${label}`;
  }
  const slab = choice.grader ? [choice.grader, choice.grade].filter(Boolean).join(' ') : null;
  const parts = [
    'Add',
    choice.quantityStated && choice.quantity != null && choice.quantity > 1 ? String(choice.quantity) : null,
    slab ?? condition,
    label,
    'to my collection',
  ].filter(Boolean);
  return parts.join(' ');
}
