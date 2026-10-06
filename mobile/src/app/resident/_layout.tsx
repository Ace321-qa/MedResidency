import { Redirect, Stack } from 'expo-router';

import { useSession } from '../../hooks';
import { colors } from '../../theme';

/**
 * Resident stack.
 *
 * The guard is the important part of this file. Tabs render content for a
 * specific resident, so entering this group without a resident session would
 * either crash on a missing id or, worse, quietly fall back to the old
 * `CURRENT_RESIDENT_ID = 1` and show someone else's attendance record. Instead
 * the route redirects to sign-in.
 */
export default function ResidentLayout() {
  const { session } = useSession();

  if (!session || session.role !== 'resident') {
    return <Redirect href="/sign-in" />;
  }

  /**
   * The guard above decides *who* may enter; this list decides *what* they see
   * once they are in. `headerShown: false` means every nested screen supplies its
   * own `AppHeader` back chevron, so a route added here without one has no way
   * back out of it — declaring the screens explicitly is what keeps that visible
   * at review time rather than on a device.
   */
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.background },
      }}
    >
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="assessments" />
      <Stack.Screen name="log-shift" />
      <Stack.Screen name="notifications" />
      <Stack.Screen name="request-leave" />
      <Stack.Screen name="settings" />
    </Stack>
  );
}