/*
  The detail page's top wash (Figma 5882:12595): the event's accent at the top,
  then two lighter stops, then white. Figma draws the yellow event as
  #FFB005 → #FFC23C (30%) → #FFD780 (60%) → #FFFFFF; the mid stops are the
  accent mixed 22% and 49% toward white, which is what `eventGradientStops`
  derives for any accent.
*/
const STOPS: readonly { offset: number; mix: number }[] = [
  { offset: 0, mix: 0 },
  { offset: 0.3, mix: 0.22 },
  { offset: 0.6, mix: 0.49 },
  { offset: 1, mix: 1 },
];

/** `#RRGGBB` moved `amount` (0..1) of the way to white. */
export function mixWithWhite(hex: string, amount: number): string {
  const value = Number.parseInt(hex.replace('#', ''), 16);
  const t = Math.min(1, Math.max(0, amount));
  const channel = (shift: number) => {
    const part = (value >> shift) & 0xff;
    return Math.round(part + (255 - part) * t);
  };
  return `#${[channel(16), channel(8), channel(0)]
    .map((part) => part.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()}`;
}

export function eventGradientStops(accent: string): { offset: number; color: string }[] {
  return STOPS.map((stop) => ({ offset: stop.offset, color: mixWithWhite(accent, stop.mix) }));
}
