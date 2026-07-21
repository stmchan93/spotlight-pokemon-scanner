import { Component, type ErrorInfo, type ReactNode } from 'react';
// Deliberately dependency-light: use react-native's Text directly (not the
// design-system capped Text) so this boundary still renders even if a shared
// primitive is what threw. Apply the Dynamic Type cap inline instead.
// eslint-disable-next-line no-restricted-imports
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { capturePostHogException } from './posthog';

type AppErrorBoundaryProps = {
  children: ReactNode;
};

type AppErrorBoundaryState = {
  hasError: boolean;
};

/**
 * Top-level error boundary. Catches React render/lifecycle errors anywhere in
 * the app tree, reports them to PostHog Error Tracking as a `$exception`, and
 * shows a minimal recovery screen instead of a white-screen death. Tapping
 * "Reload" remounts the tree (recovers transient render failures).
 *
 * Deliberately dependency-light (no design-system imports) so it still renders
 * even if a shared provider/primitive is what threw. Global uncaught JS errors
 * and unhandled promise rejections are captured separately by the PostHog
 * client's `errorTracking.autocapture` config.
 */
export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): AppErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: unknown, errorInfo: ErrorInfo) {
    capturePostHogException(error, {
      source: 'error_boundary',
      component_stack: errorInfo.componentStack ?? null,
    });
  }

  private handleReload = () => {
    this.setState({ hasError: false });
  };

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <View style={styles.container}>
        <Text maxFontSizeMultiplier={1.2} style={styles.title}>Something went wrong</Text>
        <Text maxFontSizeMultiplier={1.2} style={styles.body}>
          The app hit an unexpected error. Reloading usually fixes it.
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={this.handleReload}
          style={({ pressed }) => [styles.button, pressed ? styles.buttonPressed : null]}
          testID="app-error-boundary-reload"
        >
          <Text maxFontSizeMultiplier={1.2} style={styles.buttonLabel}>Reload</Text>
        </Pressable>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    backgroundColor: '#FCFCFA',
    flex: 1,
    gap: 12,
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  title: {
    color: '#0F0F12',
    fontSize: 20,
    fontWeight: '700',
    textAlign: 'center',
  },
  body: {
    color: 'rgba(15, 15, 18, 0.6)',
    fontSize: 15,
    lineHeight: 21,
    textAlign: 'center',
  },
  button: {
    backgroundColor: '#0F0F12',
    borderRadius: 12,
    marginTop: 8,
    paddingHorizontal: 28,
    paddingVertical: 12,
  },
  buttonPressed: {
    opacity: 0.85,
  },
  buttonLabel: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
});
