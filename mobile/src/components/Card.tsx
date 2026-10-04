import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import type { LucideIcon } from 'lucide-react-native';

import { colors, radius, shadow, spacing } from '../theme';
import { Text } from './Text';

/**
 * Card — the standard container for a block of related information.
 *
 * Cards are flat with a hairline border rather than heavily shadowed: on a
 * clinical tool, a subtle lift is enough to group content without making the
 * page look decorative.
 */
interface CardProps {
  children: ReactNode;
  /** Adds horizontal padding — off for edge-to-edge list cards. */
  padded?: boolean;
  /** Removes the bottom margin so a stack of cards can control its own rhythm. */
  flush?: boolean;
  /** Turns the card into a single tappable target. */
  onPress?: () => void;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
}

export function Card({
  children,
  padded = true,
  flush = false,
  onPress,
  accessibilityLabel,
  accessibilityHint,
  style,
}: CardProps) {
  const content = (
    <>
      {children}
    </>
  );

  const composed = [styles.card, padded ? styles.padded : null, flush ? styles.flush : null, style];

  if (!onPress) {
    return <View style={composed}>{content}</View>;
  }

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      style={({ pressed }) => [...composed, pressed ? styles.pressed : null]}
    >
      {content}
    </Pressable>
  );
}

/**
 * SectionHeader — a small uppercase label that introduces a group of content.
 * The optional action sits on the right, e.g. "See all".
 */
interface SectionHeaderProps {
  title: string;
  icon?: LucideIcon;
  actionLabel?: string;
  onActionPress?: () => void;
  /** Small trailing text, e.g. a count. */
  trailing?: string;
}

export function SectionHeader({
  title,
  icon: Icon,
  actionLabel,
  onActionPress,
  trailing,
}: SectionHeaderProps) {
  return (
    <View style={styles.sectionHeader}>
      <View style={styles.sectionTitleGroup}>
        {Icon ? <Icon color={colors.textSecondary} size={14} /> : null}
        <Text variant="label" tone="secondary" uppercase>
          {title}
        </Text>
        {trailing ? (
          <Text variant="caption" tone="muted">
            {trailing}
          </Text>
        ) : null}
      </View>

      {actionLabel && onActionPress ? (
        <Pressable
          onPress={onActionPress}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={actionLabel}
          style={styles.sectionAction}
        >
          <Text variant="bodySmall" tone="brand" style={styles.sectionActionText}>
            {actionLabel}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** A 1px rule used between list rows and sections. */
export function Divider({ inset = 0 }: { inset?: number }) {
  return <View style={[styles.divider, { marginLeft: inset }]} />;
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.md,
    ...shadow.card,
  },
  padded: {
    padding: spacing.lg,
  },
  flush: {
    marginBottom: 0,
  },
  pressed: {
    backgroundColor: colors.surfaceMuted,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    marginBottom: spacing.sm,
    marginTop: spacing.sm,
  },
  sectionTitleGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    flexShrink: 1,
  },
  sectionAction: {
    minHeight: 32,
    justifyContent: 'center',
  },
  sectionActionText: {
    fontWeight: '600',
  },
  divider: {
    height: 1,
    backgroundColor: colors.border,
  },
});