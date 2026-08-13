import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

import {
  getTurnstileSiteKey,
  registerTurnstileExecutor,
} from './turnstile';

/**
 * Invisible Cloudflare Turnstile widget, hosted in a hidden WebView.
 *
 * There is no official Turnstile SDK for React Native, so this uses the
 * established WebView pattern (the auth wave hero already ships
 * react-native-webview): a tiny inline page loads
 * https://challenges.cloudflare.com/turnstile/v0/api.js with our site key,
 * renders the widget, and posts the token back over
 * `window.ReactNativeWebView.postMessage`.
 *
 * The WebView mounts ON DEMAND — only while an auth call is waiting on a
 * token — and unmounts as soon as the execution settles, so there is zero
 * steady-state cost. `baseUrl` is set to https://ekalight.com so the widget's
 * hostname check passes; the Turnstile widget's allowed-hostname list must
 * include ekalight.com.
 *
 * Every request renders a FRESH page (tokens are single-use). Failures of any
 * kind resolve null; `getCaptchaToken()` owns the timeout.
 */

type ActiveRequest = {
  id: number;
  resolve: (token: string | null) => void;
};

type TurnstileMessage = {
  type?: string;
  token?: string;
};

function buildTurnstileHtml(siteKey: string): string {
  // The site key is operator-supplied configuration (not user input), and real
  // Turnstile site keys are alphanumeric with 'x'/'_' separators — but escape
  // anyway so a malformed env value cannot break out of the string literal.
  const escapedSiteKey = siteKey.replace(/[^0-9A-Za-z_-]/g, '');

  return `<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onTurnstileLoad" async defer></script>
</head>
<body>
<div id="turnstile-widget"></div>
<script>
  function post(message) {
    if (window.ReactNativeWebView) {
      window.ReactNativeWebView.postMessage(JSON.stringify(message));
    }
  }
  function onTurnstileLoad() {
    try {
      turnstile.render('#turnstile-widget', {
        sitekey: '${escapedSiteKey}',
        callback: function (token) { post({ type: 'token', token: token }); },
        'error-callback': function () { post({ type: 'error' }); return true; },
        'expired-callback': function () { post({ type: 'error' }); },
        'timeout-callback': function () { post({ type: 'error' }); }
      });
    } catch (error) {
      post({ type: 'error' });
    }
  }
</script>
</body>
</html>`;
}

export function TurnstileCaptchaHost() {
  const [request, setRequest] = useState<ActiveRequest | null>(null);
  const requestRef = useRef<ActiveRequest | null>(null);
  const nextRequestId = useRef(0);
  requestRef.current = request;

  const settle = useCallback((id: number, token: string | null) => {
    const active = requestRef.current;
    if (!active || active.id !== id) {
      return;
    }
    active.resolve(token);
    setRequest(null);
  }, []);

  useEffect(() => {
    const unregister = registerTurnstileExecutor(() => {
      return new Promise<string | null>((resolve) => {
        nextRequestId.current += 1;
        const id = nextRequestId.current;
        setRequest((previous) => {
          // The provider serializes executions, so a live previous request here
          // means its caller already timed out — release it rather than leak it.
          previous?.resolve(null);
          return { id, resolve };
        });
      });
    });

    return () => {
      unregister();
      // Resolve (null) anything still in flight so no auth call hangs on an
      // unmounted host past its timeout.
      requestRef.current?.resolve(null);
      requestRef.current = null;
    };
  }, []);

  const handleMessage = useCallback((event: WebViewMessageEvent) => {
    const active = requestRef.current;
    if (!active) {
      return;
    }

    let message: TurnstileMessage;
    try {
      message = JSON.parse(event.nativeEvent.data) as TurnstileMessage;
    } catch {
      return;
    }

    if (message.type === 'token' && typeof message.token === 'string' && message.token.length > 0) {
      settle(active.id, message.token);
    } else if (message.type === 'error') {
      settle(active.id, null);
    }
  }, [settle]);

  const siteKey = getTurnstileSiteKey();
  if (!request || !siteKey) {
    return null;
  }

  return (
    <View pointerEvents="none" style={styles.hidden} testID="turnstile-captcha-host">
      <WebView
        // Force a fresh page (and a fresh single-use token) per request.
        key={request.id}
        javaScriptEnabled
        onError={() => settle(request.id, null)}
        onHttpError={() => settle(request.id, null)}
        onMessage={handleMessage}
        originWhitelist={['*']}
        source={{
          // Turnstile validates the page hostname against the widget's
          // allowed-hostname list; ekalight.com is configured there.
          baseUrl: 'https://ekalight.com',
          html: buildTurnstileHtml(siteKey),
        }}
        style={styles.webView}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  hidden: {
    height: 1,
    left: -10000,
    opacity: 0,
    position: 'absolute',
    top: 0,
    width: 1,
  },
  webView: {
    backgroundColor: 'transparent',
    height: 1,
    width: 1,
  },
});
