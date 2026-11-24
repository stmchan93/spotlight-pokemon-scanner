import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useCallback } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { GlassSurface, Text, isLiquidGlassAvailable, useSpotlightTheme } from '@spotlight/design-system';

import { EkalightAiPillRing } from '@/components/ekalight-ai-glyph';
import { EkalightMark } from '@/components/ekalight-mark';
import { assistantHref } from '@/features/assistant/assistant-route';
import {
  readAssistantPageExtra,
  resolveAssistantOpenContext,
} from '@/features/assistant/page-context/assistant-page-context';
import { readAssistantRoute } from '@/features/assistant/page-context/assistant-route-tracker';
import { AnalyticsEvent } from '@/lib/observability/analytics-events';
import { capturePostHogEvent } from '@/lib/observability/posthog';

// Figma 6725:8999: a 90×44 pill, 4 side padding, a 36pt symbol slot holding the
// 28×25.85 mark, 2 to the "Chat" label.
export const ASSISTANT_CHAT_PILL_WIDTH = 90;
export const ASSISTANT_CHAT_PILL_HEIGHT = 44;
const MARK_WIDTH = 28;
const MARK_HEIGHT = 25.846;
const SYMBOL_SIZE = 36;

/**
 * Ask Ekalight's entry point: the "Chat" pill in the top-left of the tab
 * pages' top bars (Figma 6725:8999). It replaced the floating bubble, and opens
 * the chat with the current page as context exactly as the bubble did.
 */
export function AssistantChatPill({ style, testID = 'assistant-chat-pill' }: { style?: StyleProp<ViewStyle>; testID?: string }) {
  const theme = useSpotlightTheme();
  const router = useRouter();
  const hasGlass = isLiquidGlassAvailable();
  const radius = ASSISTANT_CHAT_PILL_HEIGHT / 2;

  const open = useCallback(() => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    const { pathname, params } = readAssistantRoute();
    const context = resolveAssistantOpenContext(pathname, params, readAssistantPageExtra());
    capturePostHogEvent(AnalyticsEvent.assistantOpened, { source: 'chat_pill', page_kind: context.page.kind });
    router.push(assistantHref(context.source, context.cardIds, context.game, context.page));
  }, [router]);

  return (
    <Pressable
      accessibilityHint="Opens Ask Ekalight about this page."
      accessibilityLabel="Chat with Ekalight"
      accessibilityRole="button"
      hitSlop={8}
      onPress={open}
      style={({ pressed }) => [
        styles.pill,
        theme.shadows.glassPill,
        { opacity: pressed ? 0.84 : 1 },
        style,
      ]}
      testID={testID}
    >
      <GlassSurface
        fallbackColor={theme.colors.gray0}
        glassColorScheme="light"
        glassEffectStyle="regular"
        glassTintColor={theme.colors.frostTint}
        style={[styles.glass, hasGlass ? null : { backgroundColor: theme.colors.gray0 }, { borderRadius: radius }]}
      >
        <View style={styles.symbol}>
          <EkalightMark height={MARK_HEIGHT} testID={`${testID}-mark`} width={MARK_WIDTH} />
        </View>
        <Text style={[theme.typography.bodyStrong, { color: theme.colors.gray900 }]}>Chat</Text>
      </GlassSurface>
      <EkalightAiPillRing height={ASSISTANT_CHAT_PILL_HEIGHT} width={ASSISTANT_CHAT_PILL_WIDTH} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  glass: {
    alignItems: 'center',
    borderCurve: 'continuous',
    flexDirection: 'row',
    gap: 2,
    height: ASSISTANT_CHAT_PILL_HEIGHT,
    justifyContent: 'center',
    overflow: 'hidden',
    paddingHorizontal: 4,
    width: ASSISTANT_CHAT_PILL_WIDTH,
  },
  pill: {
    borderCurve: 'continuous',
    borderRadius: ASSISTANT_CHAT_PILL_HEIGHT / 2,
    height: ASSISTANT_CHAT_PILL_HEIGHT,
    width: ASSISTANT_CHAT_PILL_WIDTH,
  },
  symbol: {
    alignItems: 'center',
    height: SYMBOL_SIZE,
    justifyContent: 'center',
    width: SYMBOL_SIZE,
  },
});
