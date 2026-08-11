import { Fragment, useMemo } from 'react';
import type { StyleProp, TextStyle } from 'react-native';
import { useRouter } from 'expo-router';

import { Text, useSpotlightTheme } from '@spotlight/design-system';

import {
  PROFILE_LINK_PATTERN,
  profileLinkToRoutePath,
} from '@/features/profile/profile-link';

type BodySegment =
  | { kind: 'text'; value: string }
  | { kind: 'link'; value: string; path: string };

/**
 * Splits a message body into plain runs and followable profile links.
 *
 * A `spotlight://` run that {@link profileLinkToRoutePath} refuses stays PLAIN
 * TEXT rather than disappearing — the recipient should still see exactly what
 * they were sent, just without a tap target.
 */
export function splitMessageBody(body: string): BodySegment[] {
  const segments: BodySegment[] = [];
  let lastIndex = 0;

  // A fresh regex per call: PROFILE_LINK_PATTERN is /g and therefore stateful.
  const pattern = new RegExp(PROFILE_LINK_PATTERN.source, 'g');
  let match = pattern.exec(body);
  while (match !== null) {
    if (match.index > lastIndex) {
      segments.push({ kind: 'text', value: body.slice(lastIndex, match.index) });
    }
    const path = profileLinkToRoutePath(match[0]);
    segments.push(
      path ? { kind: 'link', value: match[0], path } : { kind: 'text', value: match[0] },
    );
    lastIndex = match.index + match[0].length;
    match = pattern.exec(body);
  }

  if (lastIndex < body.length) {
    segments.push({ kind: 'text', value: body.slice(lastIndex) });
  }
  return segments;
}

/**
 * A DM body with shared profile/wishlist links made tappable.
 *
 * Routed with expo-router rather than `Linking.openURL`: the link already points
 * at a screen in THIS app, and bouncing out to the OS just to be handed back
 * costs a visible app-switch. See `profile-link.ts` for why only `/u/<slug>` is
 * ever followed.
 */
export function MessageBodyText({
  body,
  linkColor,
  style,
  testID,
}: {
  body: string;
  /**
   * Colour for followable links. MUST be supplied by any caller drawing on a
   * tinted bubble.
   *
   * This defaulted to `purple500` unconditionally, which is invisible on a
   * sender's own message — that bubble IS `purple500` (`dm-thread-screen`).
   * The link was rendered, occupied its line and stayed tappable; it just could
   * not be seen, so sharing a wishlist looked like it had sent plain text with
   * mysterious blank lines where the link was. The recipient, on a `gray100`
   * bubble, saw it fine — so it only ever broke for the person testing it.
   */
  linkColor?: string;
  style?: StyleProp<TextStyle>;
  testID?: string;
}) {
  const theme = useSpotlightTheme();
  const router = useRouter();
  const segments = useMemo(() => splitMessageBody(body), [body]);

  return (
    <Text style={style} testID={testID}>
      {segments.map((segment, index) => (
        <Fragment key={`${segment.kind}-${index}`}>
          {segment.kind === 'link' ? (
            <Text
              accessibilityRole="link"
              onPress={() => router.push(segment.path as never)}
              style={{
                color: linkColor ?? theme.colors.purple500,
                // Underlined as well as coloured. On the tinted bubble the link
                // is the same white as the words around it, so colour alone
                // carries no affordance there; underlining means a link reads as
                // a link on every surface rather than only the light one.
                textDecorationLine: 'underline',
              }}
              testID={testID ? `${testID}-link-${index}` : undefined}
            >
              {segment.value}
            </Text>
          ) : (
            segment.value
          )}
        </Fragment>
      ))}
    </Text>
  );
}
