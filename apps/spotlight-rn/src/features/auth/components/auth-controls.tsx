import { useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from 'react-native';
import { Eye, EyeClosed } from 'iconoir-react-native';

import { useSpotlightTheme } from '@spotlight/design-system';

/**
 * Presentational building blocks shared by the email-auth screens. All are
 * prop-driven; none own navigation or async state.
 */

type SecondaryFieldProps = Omit<TextInputProps, 'style'> & {
  /** Floating label shown above the value when the field has a value. */
  floatingLabel?: string;
  testID?: string;
  trailing?: React.ReactNode;
  value?: string;
};

export function SecondaryField({
  floatingLabel,
  placeholder,
  testID,
  trailing,
  value,
  ...inputProps
}: SecondaryFieldProps) {
  const theme = useSpotlightTheme();
  const hasValue = (value ?? '').length > 0;

  return (
    <View
      style={[
        styles.fieldShell,
        {
          backgroundColor: theme.colors.gray0,
          borderColor: theme.colors.gray300,
        },
      ]}
    >
      <View style={styles.fieldBody}>
        {hasValue && floatingLabel ? (
          <Text
            style={[
              theme.typography.overline,
              styles.floatingLabel,
              { color: theme.colors.gray400 },
            ]}
          >
            {floatingLabel}
          </Text>
        ) : null}
        <TextInput
          placeholder={placeholder}
          placeholderTextColor={theme.colors.gray500}
          style={[
            theme.typography.label,
            styles.input,
            { color: theme.colors.gray900 },
          ]}
          testID={testID}
          value={value}
          {...inputProps}
        />
      </View>
      {trailing ? <View style={styles.trailing}>{trailing}</View> : null}
    </View>
  );
}

type PasswordFieldProps = Omit<SecondaryFieldProps, 'trailing' | 'secureTextEntry'> & {
  toggleTestID?: string;
};

export function PasswordField({
  floatingLabel = 'Password',
  placeholder = 'Password',
  testID,
  toggleTestID,
  value,
  ...inputProps
}: PasswordFieldProps) {
  const theme = useSpotlightTheme();
  const [visible, setVisible] = useState(false);

  return (
    <SecondaryField
      autoCapitalize="none"
      autoCorrect={false}
      floatingLabel={floatingLabel}
      placeholder={placeholder}
      secureTextEntry={!visible}
      testID={testID}
      trailing={
        <Pressable
          accessibilityLabel={visible ? 'Hide password' : 'Show password'}
          accessibilityRole="button"
          hitSlop={8}
          onPress={() => setVisible((prev) => !prev)}
          testID={toggleTestID}
        >
          {visible ? (
            <Eye color={theme.colors.gray500} height={20} width={20} />
          ) : (
            <EyeClosed color={theme.colors.gray500} height={20} width={20} />
          )}
        </Pressable>
      }
      value={value}
      {...inputProps}
    />
  );
}

type ReadOnlyFieldProps = {
  label: string;
  testID?: string;
  value: string;
};

export function ReadOnlyField({ label, testID, value }: ReadOnlyFieldProps) {
  const theme = useSpotlightTheme();

  return (
    <View
      style={[
        styles.fieldShell,
        {
          backgroundColor: theme.colors.gray0,
          borderColor: theme.colors.gray300,
        },
      ]}
      testID={testID}
    >
      <View style={styles.fieldBody}>
        <Text
          style={[
            theme.typography.overline,
            styles.floatingLabel,
            { color: theme.colors.gray400 },
          ]}
        >
          {label}
        </Text>
        <Text style={[theme.typography.label, { color: theme.colors.gray900 }]}>
          {value}
        </Text>
      </View>
    </View>
  );
}

type PrimaryButtonProps = {
  /** Solid fill when enabled. Defaults to purple500 (the shared "Continue"). */
  enabledColor?: string;
  disabled?: boolean;
  label: string;
  onPress: () => void;
  testID?: string;
};

export function PrimaryButton({
  enabledColor,
  disabled = false,
  label,
  onPress,
  testID,
}: PrimaryButtonProps) {
  const theme = useSpotlightTheme();
  const background = disabled
    ? theme.colors.gray300
    : (enabledColor ?? theme.colors.purple500);

  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.primaryButton,
        { backgroundColor: background, opacity: pressed && !disabled ? 0.9 : 1 },
      ]}
      testID={testID}
    >
      <Text style={[theme.typography.titleSmall, { color: theme.colors.gray0 }]}>
        {label}
      </Text>
    </Pressable>
  );
}

type TertiaryButtonProps = {
  label: string;
  onPress: () => void;
  testID?: string;
};

export function TertiaryButton({ label, onPress, testID }: TertiaryButtonProps) {
  const theme = useSpotlightTheme();

  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={styles.tertiaryButton}
      testID={testID}
    >
      <Text style={[theme.typography.bodyMedium, { color: theme.colors.gray900 }]}>
        {label}
      </Text>
    </Pressable>
  );
}

export function AuthErrorLine({ message }: { message: string }) {
  const theme = useSpotlightTheme();

  return (
    <Text style={[theme.typography.bodyMedium, { color: theme.colors.danger }]}>
      {message}
    </Text>
  );
}

const styles = StyleSheet.create({
  fieldBody: {
    flex: 1,
    justifyContent: 'center',
  },
  fieldShell: {
    alignItems: 'center',
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 12,
    minHeight: 48,
    paddingHorizontal: 16,
  },
  floatingLabel: {
    marginBottom: 2,
  },
  input: {
    padding: 0,
  },
  primaryButton: {
    alignItems: 'center',
    borderRadius: 8,
    justifyContent: 'center',
    minHeight: 48,
  },
  tertiaryButton: {
    alignItems: 'center',
    height: 40,
    justifyContent: 'center',
  },
  trailing: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidLookingEmail(email: string): boolean {
  return EMAIL_PATTERN.test(email.trim());
}
