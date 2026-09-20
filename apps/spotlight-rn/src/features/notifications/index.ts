/**
 * Push notifications. The integration surface other features import from.
 *
 * The Deals band's one-time CTA is `useDealAlertPushCta()` — it owns the whole
 * "should we ask, and have we already" decision, so the band only has to render
 * a row when `isVisible` and wire the two callbacks.
 */
export {
  DEALS_NOTIFICATION_CHANNEL_ID,
  OPS_NOTIFICATION_CHANNEL_ID,
  openNotificationSettings,
  revokePushToken,
  type PushPermissionStatus,
  type PushRegistrationOutcome,
} from '@/features/notifications/push-notifications';
export {
  DEAL_NOTIFICATION_FALLBACK_URL,
  parseNotificationRoute,
  type NotificationRoute,
} from '@/features/notifications/notification-routing';
export { PushNotificationsBridge } from '@/features/notifications/push-notifications-bridge';
export {
  useDealAlertPushCta,
  type DealAlertPushCta,
} from '@/features/notifications/use-deal-alert-push-cta';
export {
  usePushPermissionPrompt,
  usePushRegistration,
  type PushPermissionPrompt,
} from '@/features/notifications/use-push-registration';
