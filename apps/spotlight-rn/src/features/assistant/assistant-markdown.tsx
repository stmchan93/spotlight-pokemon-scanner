import { StyleSheet, View, type StyleProp, type TextStyle } from 'react-native';

import { Text, spacing, useSpotlightTheme } from '@spotlight/design-system';

/*
  The assistant's "light markdown": **bold** spans and "- " bullet lines, and
  nothing else (contract). Everything else renders as the literal text, so a
  stray `#` or `_` never turns into formatting the model didn't mean.
*/

export type AssistantTextSpan = { text: string; bold: boolean };
export type AssistantTextBlock =
  | { kind: 'paragraph'; spans: AssistantTextSpan[] }
  | { kind: 'bullet'; spans: AssistantTextSpan[] };

export function parseAssistantInline(line: string): AssistantTextSpan[] {
  const spans: AssistantTextSpan[] = [];
  const pattern = /\*\*(.+?)\*\*/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line)) !== null) {
    if (match.index > cursor) {
      spans.push({ text: line.slice(cursor, match.index), bold: false });
    }
    spans.push({ text: match[1], bold: true });
    cursor = match.index + match[0].length;
  }
  if (cursor < line.length) {
    spans.push({ text: line.slice(cursor), bold: false });
  }
  return spans;
}

export function parseAssistantMarkdown(text: string): AssistantTextBlock[] {
  const blocks: AssistantTextBlock[] = [];
  for (const rawLine of text.replace(/\r\n/g, '\n').split('\n')) {
    const line = rawLine.trimEnd();
    if (!line.trim()) {
      continue;
    }
    const bullet = /^\s*[-•]\s+(.*)$/.exec(line);
    blocks.push(
      bullet
        ? { kind: 'bullet', spans: parseAssistantInline(bullet[1]) }
        : { kind: 'paragraph', spans: parseAssistantInline(line) },
    );
  }
  return blocks;
}

type AssistantRichTextProps = {
  text: string;
  color: string;
  testID?: string;
};

export function AssistantRichText({ text, color, testID }: AssistantRichTextProps) {
  const theme = useSpotlightTheme();
  const base: StyleProp<TextStyle> = [theme.typography.body, { color }];
  const bold: StyleProp<TextStyle> = [theme.typography.bodyStrong, { color }];
  const renderSpans = (spans: AssistantTextSpan[]) =>
    spans.map((span, index) => (
      <Text key={index} style={span.bold ? bold : base}>
        {span.text}
      </Text>
    ));

  return (
    <View style={styles.root} testID={testID}>
      {parseAssistantMarkdown(text).map((block, index) =>
        block.kind === 'bullet' ? (
          <View key={index} style={styles.bulletRow}>
            <Text style={base}>{'•'}</Text>
            <Text style={[base, styles.bulletText]}>{renderSpans(block.spans)}</Text>
          </View>
        ) : (
          <Text key={index} style={base}>
            {renderSpans(block.spans)}
          </Text>
        ),
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    gap: spacing.xxxs,
  },
  bulletRow: {
    flexDirection: 'row',
    gap: spacing.xxs,
  },
  bulletText: {
    flex: 1,
  },
});
