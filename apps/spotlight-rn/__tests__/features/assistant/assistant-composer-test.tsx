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

  it('is a single row when empty', () => {
    renderComposer('');
    expect(direction()).toBe('row');
  });
});
