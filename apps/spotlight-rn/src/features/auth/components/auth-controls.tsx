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
 * Presentational building blocks shared by the light-theme email-auth screens
 * (Figma 2161:6847 "Log In" / 2170:7283 "Password Reset"). All are prop-driven;
 * none own navigation or async state. Colors are tuned for the white surface.
 */

type SecondaryFieldProps = Omit<TextInputProps, 'style'> & {
  /**
   * Floating mini-label shown above the value once the field is non-empty
   * (Figma 216:147 — 11px uppercase gray400, e.g. "EMAIL"). Falls back to the
   * uppercased placeholder when omitted.
   */
  label?: string;
  testID?: string;
  trailing?: ReactNode;
  value?: string;
};

/** Underline input: 48px row, single gray300 bottom border, floating label. */
export function SecondaryField({
  label,
  placeholder,
  testID,
  trailing,
  value,
  ...inputProps
}: SecondaryFieldProps) {
  const theme = useSpotlightTheme();
  const showLabel = (value ?? '').length > 0;
  const labelText = (label ?? placeholder ?? '').toUpperCase();

  return (
    <View style={[styles.fieldShell, { borderBottomColor: theme.colors.gray300 }]}>
      <View style={styles.fieldColumn}>
        {showLabel && labelText ? (
          <Text style={[styles.fieldLabel, { color: theme.colors.gray400 }]}>{labelText}</Text>
        ) : null}
        <TextInput
          placeholder={placeholder}
          placeholderTextColor={theme.colors.gray400}
          style={[styles.input, { color: theme.colors.gray900 }]}
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
            <Eye color={theme.colors.gray400} height={24} width={24} />
          ) : (
            <EyeClosed color={theme.colors.gray400} height={24} width={24} />
          )}
        </Pressable>
      }
      value={value}
      {...inputProps}
    />
  );
}

type PrimaryButtonProps = {
  disabled?: boolean;
  label: string;
  leadingIcon?: ReactNode;
  onPress: () => void;
  testID?: string;
};

/** Filled CTA: 32px tall, radius 8; enabled = gray900/black, disabled = gray200. */
export function PrimaryButton({
  disabled = false,
  label,
  leadingIcon,
  onPress,
  testID,
}: PrimaryButtonProps) {
  const theme = useSpotlightTheme();
  const background = disabled ? theme.colors.gray200 : theme.colors.gray900;
  const labelColor = disabled ? theme.colors.gray500 : theme.colors.gray0;

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

/** Outline action (Google / Apple / Sign Up): white fill, gray200 border. */
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
        {
          backgroundColor: theme.colors.gray0,
          borderColor: theme.colors.gray200,
          borderWidth: 1,
          opacity: disabled ? 0.5 : pressed ? 0.9 : 1,
        },
      ]}
      testID={testID}
    >
      {leadingIcon ? <View style={styles.buttonIcon}>{leadingIcon}</View> : null}
      <Text style={[styles.buttonLabel, { color: theme.colors.gray900 }]}>{label}</Text>
    </Pressable>
  );
}

type TertiaryButtonProps = {
  disabled?: boolean;
  label: string;
  onPress: () => void;
  testID?: string;
};

export function TertiaryButton({ disabled = false, label, onPress, testID }: TertiaryButtonProps) {
  const theme = useSpotlightTheme();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.tertiaryButton,
        { opacity: disabled ? 0.5 : pressed ? 0.7 : 1 },
      ]}
      testID={testID}
    >
      <Text style={[styles.tertiaryLabel, { color: theme.colors.gray900 }]}>{label}</Text>
    </Pressable>
  );
}

/** Screen section title, e.g. "LOG IN" / "SIGN UP" / "PASSWORD RESET" (15px). */
export function AuthSectionTitle({ children }: { children: string }) {
  const theme = useSpotlightTheme();
  return (
    <Text style={[styles.sectionTitle, { color: theme.colors.gray900 }]}>{children}</Text>
  );
}

/** Small group label above a cross-flow action, e.g. "NEW ACCOUNT" / "LOG IN". */
export function AuthGroupLabel({ children }: { children: string }) {
  const theme = useSpotlightTheme();
  return (
    <Text style={[styles.groupLabel, { color: theme.colors.gray900 }]}>{children}</Text>
  );
}

/** "──── OR ────" divider between email auth and the social buttons. */
export function OrDivider() {
  const theme = useSpotlightTheme();
  return (
    <View style={styles.divider}>
      <View style={[styles.dividerLine, { backgroundColor: theme.colors.gray200 }]} />
      <Text style={[styles.dividerLabel, { color: theme.colors.gray500 }]}>OR</Text>
      <View style={[styles.dividerLine, { backgroundColor: theme.colors.gray200 }]} />
    </View>
  );
}

/**
 * Bottom terms/privacy line (Figma 2161:6738). The links are styled per design;
 * no hosted terms pages exist yet, so they are not tappable.
 */
export function TermsFooter() {
  const theme = useSpotlightTheme();
  return (
    <Text style={[styles.terms, { color: theme.colors.gray600 }]}>
      By signing up, you confirm to have read and agree to our{' '}
      <Text style={styles.termsLink}>Terms of Use</Text> and{' '}
      <Text style={styles.termsLink}>Privacy Policy</Text>.
    </Text>
  );
}

export type PasswordRule = {
  label: string;
  satisfied: boolean;
};

export function buildPasswordRules(password: string): PasswordRule[] {
  return [
    { label: 'Contains 8 characters', satisfied: password.length >= 8 },
    { label: 'Contains at least one number', satisfied: /\d/.test(password) },
    { label: 'Contains at least one special character', satisfied: /[^A-Za-z0-9]/.test(password) },
  ];
}

/** Checklist of password requirements: check-circle + 11px text. */
export function PasswordRules({ rules, testID }: { rules: PasswordRule[]; testID?: string }) {
  const theme = useSpotlightTheme();

  return (
    <View style={styles.rules} testID={testID}>
      {rules.map((rule) => (
        <View key={rule.label} style={styles.ruleRow}>
          {rule.satisfied ? (
            <CheckCircleSolid color={theme.colors.gray900} height={16} width={16} />
          ) : (
            <CheckCircle color={theme.colors.gray300} height={16} width={16} />
          )}
          <Text
            style={[
              styles.ruleLabel,
              { color: rule.satisfied ? theme.colors.gray900 : theme.colors.gray500 },
            ]}
          >
            {rule.label}
          </Text>
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
    height: 32,
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  buttonIcon: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonLabel: {
    fontFamily: fontFamilies.bodyMedium,
    fontSize: 13,
    lineHeight: 18,
  },
  divider: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  dividerLabel: {
    fontFamily: fontFamilies.bodyMedium,
    fontSize: 13,
    lineHeight: 18,
  },
  dividerLine: {
    flex: 1,
    height: 1,
  },
  errorLine: {
    fontFamily: fontFamilies.bodyMedium,
    fontSize: 13,
    lineHeight: 18,
  },
  fieldColumn: {
    flex: 1,
    justifyContent: 'center',
  },
  fieldLabel: {
    fontFamily: fontFamilies.bodyMedium,
    fontSize: 11,
    lineHeight: 14,
  },
  fieldShell: {
    alignItems: 'center',
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: 8,
    height: 48,
    paddingRight: 4,
  },
  groupLabel: {
    fontFamily: fontFamilies.bodyMedium,
    fontSize: 13,
    lineHeight: 18,
  },
  // No explicit lineHeight: on iOS a lineHeight near the fontSize clips the
  // custom font's descenders inside TextInput (the "cut off text" bug); let
  // the font's own metrics size the line.
  input: {
    fontFamily: fontFamilies.bodyRegular,
    fontSize: 16,
    minHeight: 24,
    padding: 0,
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
  sectionTitle: {
    fontFamily: fontFamilies.bodyRegular,
    fontSize: 15,
    lineHeight: 23,
  },
  terms: {
    fontFamily: fontFamilies.bodyRegular,
    fontSize: 12,
    lineHeight: 17,
    textAlign: 'center',
  },
  termsLink: {
    textDecorationLine: 'underline',
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
