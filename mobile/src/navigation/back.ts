import { router } from 'expo-router';

/**
 * The app's single answer to "go back".
 *
 * `router.back()` is a no-op when there is no history behind the current
 * screen: a deep link, a push notification or a cold start can land someone on
 * `/program/settings` directly, and in that state the chevron `AppHeader` draws
 * does nothing at all. On a phone that reads as a dead control — the user taps
 * it, nothing moves, and they assume the app has frozen.
 *
 * So every back affordance routes through here instead. With history, this is
 * exactly `router.back()`. Without it, the entry screen decides where the
 * session belongs, which is the one destination that is always correct for both
 * roles.
 */
export function goBack(): void {
  if (router.canGoBack()) {
    router.back();
    return;
  }

  router.replace('/');
}
