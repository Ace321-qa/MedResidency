import { ActivityIndicator, StyleSheet, View } from 'react-native';
import type { LucideIcon } from 'lucide-react-native';

import { colors, radius, spacing } from '../theme';
import { Button } from './Button';
import { Text } from './Text';

/**
 * The three states every data-driven screen must be able to show.
 *
 *  - Loading: says what is being loaded, so the wait is explained.
 *  - Empty:   says there is genuinely nothing here *and* what would put
 *             something here. Never a blank page.
 *  - Error:   says what went wrong in plain language and offers the way out.
 *             "Something went wrong" is never acceptable copy.
 */

interface StateProps {
  /** Reserves vertical space so a loading state does not collapse the layout. */
  minHeight?: number;
}

export function LoadingState({ label = 'Loading…', minHeight = 220 }: StateProps & { label?: string }) {
  return (
    <View style={[styles.container, { minHeight }]} accessibilityRole="progressbar" accessibilityLabel={label}>
      <ActivityIndicator color={colors.primary} />
      <Text variant="bodySmall" tone="secondary" align="center">
        {label}
      </Text>
    </View>
  );
}

interface ErrorStateProps extends StateProps {
  /** Short, specific headline. e.g. "Cannot reach the server" */
  title: string;
  /** The reason, in language a resident can act on. */
  message: string;
  onRetry?: () => void;
}

export function ErrorState({ title, message, onRetry, minHeight = 220 }: ErrorStateProps) {
  return (
    <View style={[styles.container, { minHeight }]}>
      <View style={styles.glyph}>
        <Text variant="h2" tone="danger">
          !
        </Text>
      </View>
      <Text variant="h3" align="center">
        {title}
      </Text>
      <Text variant="bodySmall" tone="secondary" align="center">
        {message}
      </Text>
      {onRetry ? (
        <Button label="Try again" onPress={onRetry} variant="outline" fullWidth={false} style={styles.retry} />
      ) : null}
    </View>
  );
}

interface EmptyStateProps extends StateProps {
  icon?: LucideIcon;
  title: string;
  message: string;
  actionLabel?: string;
  onActionPress?: () => void;
}

export function EmptyState({
  icon: Icon,
  title,
  message,
  actionLabel,
  onActionPress,
  minHeight = 200,
}: EmptyStateProps) {
  return (
    <View style={[styles.container, { minHeight }]}>
      {Icon ? (
        <View style={styles.glyphMuted}>
          <Icon color={colors.textMuted} size={24} />
        </View>
      ) : null}
      <Text variant="h3" align="center">
        {title}
      </Text>
      <Text variant="bodySmall" tone="secondary" align="center">
        {message}
      </Text>
      {actionLabel && onActionPress ? (
        <Button
          label={actionLabel}
          onPress={onActionPress}
          variant="outline"
          fullWidth={false}
          style={styles.retry}
        />
      ) : null}
    </View>
  );
}

/**
 * Skeleton rows for a list that is loading. Preferred over a single spinner when
 * the shape of the content is already known, because it avoids a layout jump.
 */
export function SkeletonList({ rows = 3, minHeight }: StateProps & { rows?: number }) {
  return (
    <View style={[styles.skeleton, { minHeight }]} accessibilityLabel="Loading content">
      {Array.from({ length: rows }).map((_, index) => (
        <View key={index} style={styles.skeletonCard}>
          <View style={styles.skeletonLineWide} />
          <View style={styles.skeletonLine} />
          <View style={styles.skeletonLineShort} />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xxl,
    paddingHorizontal: spacing.lg,
  },
  glyph: {
    width: 40,
    height: 40,
    borderRadius: radius.pill,
    backgroundColor: colors.dangerSurface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  glyphMuted: {
    width: 48,
    height: 48,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  retry: {
    marginTop: spacing.xs,
  },
  skeleton: {
    gap: spacing.md,
  },
  skeletonCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  skeletonLineWide: {
    height: 14,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceMuted,
    width: '70%',
  },
  skeletonLine: {
    height: 11,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceMuted,
    width: '45%',
  },
  skeletonLineShort: {
    height: 11,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceMuted,
    width: '28%',
  },
});