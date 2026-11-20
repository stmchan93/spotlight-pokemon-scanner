import { StyleSheet, View, type StyleProp, type TextStyle } from 'react-native';

import { Text, spacing, useSpotlightTheme } from '@spotlight/design-system';

/*
  The assistant's "light markdown": **bold** spans, "#"/"##"/"###" headings,
  "- " / "* " / "• " bullets and "1. " numbered lines. Nothing else: a stray
  `_`, a lone `*`, or "#hashtag" (no space) renders as the literal text, so
  the model never gets formatting it didn't mean.
*/

export type AssistantTextSpan = { text: string; bold: boolean };
export type AssistantTextBlock =
  | { kind: 'paragraph'; spans: AssistantTextSpan[] }
  | { kind: 'heading'; spans: AssistantTextSpan[] }
  | { kind: 'bullet'; spans: AssistantTextSpan[] }
  | { kind: 'numbered'; marker: string; spans: AssistantTextSpan[] };

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
    const heading = /^\s*#{1,3}\s+(.*)$/.exec(line);
    if (heading) {
      // A heading that is entirely **bold** shouldn't double up the weight.
      blocks.push({ kind: 'heading', spans: parseAssistantInline(heading[1].replace(/^\*\*(.*)\*\*$/, '$1')) });
      continue;
    }
    const bullet = /^\s*[-•*]\s+(.*)$/.exec(line);
    if (bullet) {
      blocks.push({ kind: 'bullet', spans: parseAssistantInline(bullet[1]) });
      continue;
    }
    const numbered = /^\s*(\d{1,2})[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      blocks.push({ kind: 'numbered', marker: `${numbered[1]}.`, spans: parseAssistantInline(numbered[2]) });
      continue;
    }
    blocks.push({ kind: 'paragraph', spans: parseAssistantInline(line) });
  }
  return blocks;
}

function isListBlock(block: AssistantTextBlock | undefined): boolean {
  return block?.kind === 'bullet' || block?.kind === 'numbered';
}

type AssistantRichTextProps = {
  text: string;
  color: string;
  /** Headings and bold runs; defaults to `color`. */
  strongColor?: string;
  testID?: string;
};

/**
 * Reading typography for a reply (Figma 6502:16657): Regular 15 body, SemiBold
 * 17 headings 4pt above their text, list items tight, blocks spaced like a chat app.
 */
export function AssistantRichText({ text, color, strongColor = color, testID }: AssistantRichTextProps) {
  const theme = useSpotlightTheme();
  const base: StyleProp<TextStyle> = [theme.typography.chatBody, { color }];
  // bodyStrong is SemiBold at chatBody's size/leading, so bold runs inline.
  const bold: StyleProp<TextStyle> = [theme.typography.bodyStrong, { color: strongColor }];
  const heading: StyleProp<TextStyle> = [theme.typography.titleSmall, { color: strongColor }];
  const markerColor = { color: theme.colors.gray600 };
  const renderSpans = (spans: AssistantTextSpan[]) =>
    spans.map((span, index) => (
      <Text key={index} style={span.bold ? bold : base}>
        {span.text}
      </Text>
    ));

  const blocks = parseAssistantMarkdown(text);
  return (
    <View style={styles.root} testID={testID}>
      {blocks.map((block, index) => {
        const previous = blocks[index - 1];
        // Consecutive list items sit tight; everything else gets paragraph air,
        // and a heading gets a bit more above it than below.
        const gapStyle = index === 0
          ? null
          : previous?.kind === 'heading'
            ? styles.afterHeadingGap
            : isListBlock(block) && isListBlock(previous)
              ? styles.listGap
              : block.kind === 'heading'
                ? styles.headingGap
                : styles.blockGap;
        if (block.kind === 'bullet' || block.kind === 'numbered') {
          return (
            <View key={index} style={[styles.listRow, gapStyle]}>
              <Text style={[base, markerColor, block.kind === 'numbered' ? styles.numberMarker : styles.bulletMarker]}>
                {block.kind === 'numbered' ? block.marker : '•'}
              </Text>
              <Text style={[base, styles.listText]}>{renderSpans(block.spans)}</Text>
            </View>
          );
        }
        return (
          <Text
            accessibilityRole={block.kind === 'heading' ? 'header' : undefined}
            key={index}
            style={[block.kind === 'heading' ? heading : base, gapStyle]}
          >
            {block.kind === 'heading' ? block.spans.map((span) => span.text).join('') : renderSpans(block.spans)}
          </Text>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    alignSelf: 'stretch',
  },
  blockGap: {
    marginTop: spacing.xs,
  },
  headingGap: {
    marginTop: spacing.sm,
  },
  listGap: {
    marginTop: spacing.xxxs,
  },
  afterHeadingGap: {
    marginTop: spacing.xxxs,
  },
  listRow: {
    flexDirection: 'row',
    gap: spacing.xxs,
    paddingLeft: spacing.xxxs,
  },
  // Fixed marker columns so wrapped lines and multi-digit numbers align.
  bulletMarker: {
    minWidth: spacing.xs,
  },
  numberMarker: {
    minWidth: spacing.md,
  },
  listText: {
    flex: 1,
  },
});
