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
      <Stack.Screen name="settings" />
    </Stack>
  );
}