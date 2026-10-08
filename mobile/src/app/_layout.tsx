import 'react-native-gesture-handler';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { Platform, StyleSheet, View } from 'react-native';

import { SessionProvider } from '../hooks';
import { InAppNotificationProvider } from '../services/inAppNotifications';
import { colors } from '../theme';

/**
 * Root layout.
 *
 * This file wraps the whole app in the two providers every screen relies on:
 *  - `SafeAreaProvider` knows the notches, Dynamic Island and Android gesture
 *    bar, so `Screen` can pad correctly.
 *  - `SessionProvider` holds who is signed in, which decides the tab bar.
 *
 * Note that `resident` and `program` are real path segments, not route groups.
 * They began as groups — `(resident)` and `(program)` — which produced two
 * screens claiming the URL `/` and a collision between the two `rotations` and
 * `requests` tabs. Real segments make every URL unambiguous:
 * `/resident/duty-hours` and `/program/rotations` cannot be confused.
 *
 * Only one of the three areas is reachable at a time: the entry screen
 * redirects to `/sign-in` when nobody is signed in, and to `/resident` or
 * `/program` depending on the role.
 */
export default function RootLayout() {
  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider style={styles.root}>
        <SessionProvider>
          <InAppNotificationProvider>
            <StatusBar style="dark" />
            <View style={styles.container}>
              <Stack
                screenOptions={{
                  headerShown: false,
                  contentStyle: { backgroundColor: colors.background },
                }}
              >
                <Stack.Screen name="index" />
                <Stack.Screen name="sign-in" />
                <Stack.Screen name="resident" />
                <Stack.Screen name="program" />
              </Stack>
            </View>
          </InAppNotificationProvider>
        </SessionProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    ...(Platform.OS === 'web'
      ? ({ minHeight: '100vh' } as any)
      : ({ minHeight: '100%' } as any)),
    width: '100%',
  },
  container: {
    flex: 1,
    ...(Platform.OS === 'web'
      ? ({ minHeight: '100vh' } as any)
      : ({ minHeight: '100%' } as any)),
    width: '100%',
    backgroundColor: colors.background,
  },
});