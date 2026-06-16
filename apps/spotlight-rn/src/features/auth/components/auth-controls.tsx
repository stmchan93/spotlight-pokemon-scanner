import { useState, type ReactNode } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from 'react-native';
import { CheckCircle, CheckCircleSolid, Eye, EyeClosed } from 'iconoir-react-native';

import { fontFamilies, useSpotlightTheme } from '@spotlight/design-system';

/**
 * Presentational building blocks shared by the redesigned (white full-screen)
 * email-auth screens (Figma 1543:2170). All are prop-driven; none own
 * navigation or async state.
 */

type SecondaryFieldProps = Omit<TextInputProps, 'style'> & {
  testID?: string;
  trailing?: ReactNode;
  value?: string;
};

/** Underline input: a single bottom border (gray300), 14px text, optional trailing. */
export function SecondaryField({
  placeholder,
  testID,
  trailing,
  value,
  ...inputProps
}: SecondaryFieldProps) {
  const theme = useSpotlightTheme();

  return (
    <View style={[styles.fieldShell, { borderBottomColor: theme.colors.gray300 }]}>
      <TextInput
        placeholder={placeholder}
        placeholderTextColor={theme.colors.gray400}
        style={[styles.input, { color: theme.colors.gray900 }]}
        testID={testID}
        value={value}
        {...inputProps}
      />
      {trailing ? <View style={styles.trailing}>{trailing}</View> : null}
    </View>
  );
}

type PasswordFieldProps = Omit<SecondaryFieldProps, 'trailing' | 'secureTextEntry'> & {
  toggleTestID?: string;
};

export function PasswordField({
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
            <Eye color={theme.colors.gray600} height={24} width={24} />
          ) : (
            <EyeClosed color={theme.colors.gray600} height={24} width={24} />
          )}
        </Pressable>
      }
      value={value}
      {...inputProps}
    />
  );
}

type ReadOnlyFieldProps = {
  label?: string;
  testID?: string;
  value: string;
};

/** Underline field showing a non-editable value (e.g. the chosen email). */
export function ReadOnlyField({ label, testID, value }: ReadOnlyFieldProps) {
  const theme = useSpotlightTheme();

  return (
    <View
      style={[styles.fieldShell, styles.readOnlyShell, { borderBottomColor: theme.colors.gray300 }]}
      testID={testID}
    >
      {label ? (
        <Text style={[styles.readOnlyLabel, { color: theme.colors.gray400 }]}>{label}</Text>
      ) : null}
      <Text style={[styles.input, { color: theme.colors.gray600 }]}>{value}</Text>
    </View>
  );
}

type PrimaryButtonProps = {
  /** Solid fill when enabled. Defaults to purple500 (the shared "Continue"). */
  enabledColor?: string;
  disabled?: boolean;
  label: string;
  leadingIcon?: ReactNode;
  onPress: () => void;
  testID?: string;
};

export function PrimaryButton({
  enabledColor,
  disabled = false,
  label,
  leadingIcon,
  onPress,
  testID,
}: PrimaryButtonProps) {
  const theme = useSpotlightTheme();
  const background = disabled ? theme.colors.gray50 : (enabledColor ?? theme.colors.purple500);
  const labelColor = disabled ? theme.colors.gray400 : theme.colors.gray0;

  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: background, opacity: pressed && !disabled ? 0.9 : 1 },
      ]}
      testID={testID}
    >
      {leadingIcon ? <View style={styles.buttonIcon}>{leadingIcon}</View> : null}
      <Text style={[styles.buttonLabel, { color: labelColor }]}>{label}</Text>
    </Pressable>
  );
}

type SecondaryActionButtonProps = {
  label: string;
  leadingIcon?: ReactNode;
  disabled?: boolean;
  onPress: () => void;
  testID?: string;
};

/** Neutral action button (Google / Apple): gray50 fill, dark label. */
export function SecondaryActionButton({
  label,
  leadingIcon,
  disabled = false,
  onPress,
  testID,
}: SecondaryActionButtonProps) {
  const theme = useSpotlightTheme();

  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: theme.colors.gray50, opacity: pressed && !disabled ? 0.9 : 1 },
      ]}
      testID={testID}
    >
      {leadingIcon ? <View style={styles.buttonIcon}>{leadingIcon}</View> : null}
      <Text style={[styles.buttonLabel, { color: theme.colors.gray900 }]}>{label}</Text>
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
      <Text style={[styles.tertiaryLabel, { color: theme.colors.gray600 }]}>{label}</Text>
    </Pressable>
  );
}

export type PasswordRule = {
  label: string;
  satisfied: boolean;
};

/** Checklist of password requirements (Figma 1543:2291): check-circle + 11px text. */
export function PasswordRules({ rules, testID }: { rules: PasswordRule[]; testID?: string }) {
  const theme = useSpotlightTheme();

  return (
    <View style={styles.rules} testID={testID}>
      {rules.map((rule) => (
        <View key={rule.label} style={styles.ruleRow}>
          {rule.satisfied ? (
            <CheckCircleSolid color={theme.colors.purple500} height={16} width={16} />
          ) : (
            <CheckCircle color={theme.colors.gray300} height={16} width={16} />
          )}
          <Text style={[styles.ruleLabel, { color: theme.colors.gray600 }]}>{rule.label}</Text>
        </View>
      ))}
    </View>
  );
}

export function AuthErrorLine({ message }: { message: string }) {
  const theme = useSpotlightTheme();

  return (
    <Text style={[styles.errorLine, { color: theme.colors.danger }]}>{message}</Text>
  );
}

const styles = StyleSheet.create({
  button: {
    alignItems: 'center',
    borderRadius: 8,
    flexDirection: 'row',
    gap: 8,
    height: 40,
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  buttonIcon: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonLabel: {
    fontFamily: fontFamilies.bodyMedium,
    fontSize: 14,
    lineHeight: 21,
  },
  errorLine: {
    fontFamily: fontFamilies.bodyMedium,
    fontSize: 13,
    lineHeight: 18,
  },
  fieldShell: {
    alignItems: 'center',
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: 8,
    height: 40,
    paddingLeft: 4,
    paddingRight: 8,
  },
  input: {
    flex: 1,
    fontFamily: fontFamilies.bodyMedium,
    fontSize: 14,
    lineHeight: 21,
    padding: 0,
  },
  readOnlyLabel: {
    fontFamily: fontFamilies.bodyMedium,
    fontSize: 11,
    lineHeight: 14,
  },
  readOnlyShell: {
    alignItems: 'flex-start',
    flexDirection: 'column',
    gap: 2,
    height: undefined,
    justifyContent: 'center',
    paddingVertical: 6,
  },
  ruleLabel: {
    fontFamily: fontFamilies.bodyMedium,
    fontSize: 11,
    lineHeight: 14,
  },
  ruleRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 4,
  },
  rules: {
    gap: 8,
  },
  tertiaryButton: {
    alignItems: 'center',
    height: 32,
    justifyContent: 'center',
  },
  tertiaryLabel: {
    fontFamily: fontFamilies.bodyMedium,
    fontSize: 13,
    lineHeight: 18,
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

export type { SecondaryFieldProps };
