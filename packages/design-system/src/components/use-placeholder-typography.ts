import { useCallback, useState } from 'react';
import type { TextInputProps, TextStyle } from 'react-native';

import { textStyles } from '../tokens';

// Family + size only: the field keeps its own lineHeight so swapping between
// empty and filled never changes the input's height.
const placeholderInputStyle: TextStyle = {
  fontFamily: textStyles.placeholder.fontFamily,
  fontSize: textStyles.placeholder.fontSize,
};

/**
 * RN TextInput can't font the placeholder separately from typed text, so the
 * placeholder typography is applied to the whole input while it is empty.
 * Tracks uncontrolled inputs too (no `value` prop) via the wrapped onChangeText.
 */
export function usePlaceholderTypography({
  defaultValue,
  onChangeText,
  value,
}: Pick<TextInputProps, 'defaultValue' | 'onChangeText' | 'value'>) {
  const [uncontrolledText, setUncontrolledText] = useState(defaultValue ?? '');
  const handleChangeText = useCallback(
    (text: string) => {
      setUncontrolledText(text);
      onChangeText?.(text);
    },
    [onChangeText],
  );
  const isEmpty = (value ?? uncontrolledText).length === 0;

  return {
    onChangeText: handleChangeText,
    placeholderStyle: isEmpty ? placeholderInputStyle : null,
  };
}
