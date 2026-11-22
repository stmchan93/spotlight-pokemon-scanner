import { fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { textStyles } from '@spotlight/design-system';
import { AssistantComposer } from '@/features/assistant/components/assistant-composer';

const LINE = textStyles.chatBody.lineHeight;

function renderComposer(value: string) {
  return render(
    <AssistantComposer isSending={false} maxLength={500} onChangeText={jest.fn()} onSend={jest.fn()} value={value} />,
  );
}

const direction = () => StyleSheet.flatten(screen.getByTestId('assistant-composer').props.style).flexDirection;

describe('AssistantComposer', () => {
  it('stays a single row while the text fits on one line', () => {
    renderComposer('Short question');
    fireEvent(screen.getByTestId('assistant-input'), 'contentSizeChange', {
      nativeEvent: { contentSize: { width: 200, height: LINE } },
    });
    expect(direction()).toBe('row');
  });

  it('expands to text-on-top with the send row below once the text wraps', () => {
    renderComposer('A much longer question that wraps onto a second line in the composer');
    fireEvent(screen.getByTestId('assistant-input'), 'contentSizeChange', {
      nativeEvent: { contentSize: { width: 200, height: LINE * 2 } },
    });
    expect(direction()).toBe('column');
  });

  // Regression (2026-11-22): text that wraps in the narrow row but fits one line
  // in the wider stacked field flipped row<->stacked every frame on paste.
  it('stays stacked when the wider stacked field fits the text on one line', () => {
    const text = 'Is Charizard ex from Obsidian Flames worth';
    renderComposer(text);
    const input = screen.getByTestId('assistant-input');
    fireEvent(input, 'contentSizeChange', { nativeEvent: { contentSize: { width: 200, height: LINE * 2 } } });
    expect(direction()).toBe('column');
    fireEvent(input, 'contentSizeChange', { nativeEvent: { contentSize: { width: 300, height: LINE } } });
    expect(direction()).toBe('column');
  });

  it('returns to one row once the text is shorter than where it wrapped', () => {
    const view = renderComposer('A much longer question that wraps onto a second line');
    fireEvent(screen.getByTestId('assistant-input'), 'contentSizeChange', {
      nativeEvent: { contentSize: { width: 200, height: LINE * 2 } },
    });
    expect(direction()).toBe('column');
    view.rerender(
      <AssistantComposer isSending={false} maxLength={500} onChangeText={jest.fn()} onSend={jest.fn()} value="A much" />,
    );
    expect(direction()).toBe('row');
  });

  it('opens stacked straight away for pasted multi-paragraph text', () => {
    renderComposer('First paragraph.\n\nSecond paragraph.');
    expect(direction()).toBe('column');
  });

  it('never lets the one-row field grow past a line', () => {
    renderComposer('Short question');
    expect(StyleSheet.flatten(screen.getByTestId('assistant-input').props.style).maxHeight).toBe(LINE);
  });

  it('is a single row when empty', () => {
    renderComposer('');
    expect(direction()).toBe('row');
  });
});
