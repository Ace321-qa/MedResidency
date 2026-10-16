import { Stack } from 'expo-router';

import { colors } from '../../../../theme';

/**
 * Stack nested inside the Release Letters tab.
 *
 * The tab's home screen holds the whole letters workspace — templates and the
 * dispatched log — so the only route that leaves it is the generator, pushed on
 * top of the tab so the coordinator keeps the bottom bar and can step back to the
 * workspace they came from.
 */
export default function LettersLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.background },
      }}
    >
      <Stack.Screen name="index" />
      <Stack.Screen name="generate" />
    </Stack>
  );
}
