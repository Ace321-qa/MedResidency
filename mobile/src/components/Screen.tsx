import type { ReactNode } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, dimensions, spacing } from '../theme';

/**
 * `Screen` is the frame every screen sits in.
 *
 * It owns four things that are easy to get wrong screen by screen:
 *  1. the background colour and the horizontal gutter,
 *  2. safe-area padding (notches, Dynamic Island, Android gesture bar),
 *  3. the centred max-width column that keeps tablets readable,
 *  4. keyboard avoidance, so a form never hides behind the keyboard.
 *
 * A screen supplies its own content and its own header.
 */

interface ScreenProps {
  children: ReactNode;
  /** Removes the top inset — for screens that draw their own coloured header. */
  topInset?: boolean;
  /** Removes the bottom inset — for screens sitting inside a tab bar. */
  bottomInset?: boolean;
  /** Set false when a screen manages its own scrolling (e.g. a FlatList). */
  scroll?: boolean;
  /** Pull-to-refresh. Omit for screens with nothing to refresh. */
  onRefresh?: () => void;
  refreshing?: boolean;
  /** Extra bottom padding, e.g. to clear a floating action button. */
  bottomGutter?: number;
}

export function Screen({
  children,
  topInset = true,
  bottomInset = true,
  scroll = true,
  onRefresh,
  refreshing = false,
  bottomGutter = 0,
}: ScreenProps) {
  const insets = useSafeAreaInsets();
  const paddingTop = topInset ? insets.top : 0;
  const paddingBottom = (bottomInset ? insets.bottom : 0) + bottomGutter;

  const column = (
    <View style={[styles.column, { paddingTop, paddingBottom }]}>{children}</View>
  );

  if (!scroll) {
    return <View style={styles.root}>{column}</View>;
  }

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        showsVerticalScrollIndicator={false}
        refreshControl={
          onRefresh ? (
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={colors.primary}
              colors={[colors.primary]}
              progressBackgroundColor={colors.surface}
            />
          ) : undefined
        }
      >
        {column}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background,
    alignItems: 'center',
  },
  scroll: {
    flex: 1,
    backgroundColor: colors.background,
  },
  scrollContent: {
    flexGrow: 1,
    alignItems: 'center',
    paddingHorizontal: dimensions.screenPadding,
  },
  column: {
    width: '100%',
    maxWidth: dimensions.maxContentWidth,
    paddingTop: spacing.md,
    paddingBottom: spacing.xxxl,
  },
});