import { Redirect, Stack } from 'expo-router';

import { useSession } from '../../hooks';
import { colors } from '../../theme';

/**
 * Coordinator (programme) stack, with the same guard as the resident stack.
 * A coordinator session is scoped to one programme, so screens here filter by
 * `session.programId`.
 */
export default function ProgramLayout() {
  const { session } = useSession();

  if (!session || session.role !== 'coordinator') {
    return <Redirect href="/sign-in" />;
  }

  /**
   * Every nested route is declared explicitly.
   *
   * `headerShown: false` above means the native header — and therefore its back
   * button — is off, and each screen draws its own `AppHeader` chevron, wired to
   * `goBack` rather than to `router.back()` directly, so a screen reached with no
   * history behind it still lands somewhere sensible. Listing the routes keeps
   * that contract checkable: a screen added here without a `Stack.Screen` still
   * works, but a screen *removed* from this list is no longer type-checked
   * against the navigator it is pushed onto.
   */
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.background },
      }}
    >
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="resident/[id]" />
      <Stack.Screen name="onboarding" />
      <Stack.Screen name="block" />
      <Stack.Screen name="block/[id]" />
      <Stack.Screen name="assignments/new" />
      <Stack.Screen name="longitudinal/matrix" />
      <Stack.Screen name="master/grid" />
      <Stack.Screen name="settings" />
      <Stack.Screen name="supervisor/assign" />
    </Stack>
  );
}