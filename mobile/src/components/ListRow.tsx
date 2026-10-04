import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { ChevronRight } from 'lucide-react-native';
import type { LucideIcon } from 'lucide-react-native';

import { colors, radius, spacing } from '../theme';
import { Text } from './Text';

/**
 * ListRow — the workhorse of every list in the app.
 *
 * A row has a fixed three-part structure: an optional leading icon or avatar, a
 * text block (title + one or two supporting lines), and an optional trailing
 * element (a badge, a chevron, a value). Because the structure is identical
 * everywhere, a resident learns it once.
 */

interface ListRowProps {
  title: string;
  /** Supporting line under the title. */
  subtitle?: string;
  /** Third line, e.g. a date range. Rendered in caption size. */
  meta?: string;
  leadingIcon?: LucideIcon;
  leading?: ReactNode;
  trailing?: ReactNode;
  onPress?: () => void;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  /** Removes the bottom rule — use on the last row of a list. */
  last?: boolean;
  /** Dims the row, for archived or cancelled records. */
  muted?: boolean;
  /**
   * A row that exists but cannot be opened — a resident with no programme
   * enrollment, an archived rotation. It stays visible so the user understands
   * why it is missing, but it is dimmed, not pressable, and announced as
   * disabled rather than silently ignoring taps.
   */
  disabled?: boolean;
}

export function ListRow({
  title,
  subtitle,
  meta,
  leadingIcon: LeadingIcon,
  leading,
  trailing,
  onPress,
  accessibilityLabel,
  accessibilityHint,
  last = false,
  muted = false,
  disabled = false,
}: ListRowProps) {
  const dimmed = muted || disabled;
  const chevronVisible = Boolean(onPress) && !disabled;

  const body = (
    <>
      {leading ??
        (LeadingIcon ? (
          <View style={styles.iconBubble}>
            <LeadingIcon color={colors.textSecondary} size={18} />
          </View>
        ) : null)}

      <View style={styles.textBlock}>
        <Text variant="h3" numberOfLines={2} tone={dimmed ? 'muted' : 'primary'}>
          {title}
        </Text>
        {subtitle ? (
          <Text variant="bodySmall" tone="secondary" numberOfLines={2} style={styles.subtitle}>
            {subtitle}
          </Text>
        ) : null}
        {meta ? (
          <Text variant="caption" tone="muted" numberOfLines={1} style={styles.meta}>
            {meta}
          </Text>
        ) : null}
      </View>

      {trailing ?? (chevronVisible ? <ChevronRight color={colors.textMuted} size={18} /> : null)}
    </>
  );

  if (!onPress || disabled) {
    return <View style={[styles.row, dimmed && styles.rowDisabled, last ? styles.rowLast : null]}>{body}</View>;
  }

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityHint={accessibilityHint}
      style={({ pressed }) => [styles.row, last ? styles.rowLast : null, pressed ? styles.rowPressed : null]}
    >
      {body}
    </Pressable>
  );
}

/**
 * DetailRow — a label/value pair for profile and record screens. The value is
 * allowed to wrap, because clinical text is not always short.
 */
export function DetailRow({
  label,
  value,
  tone = 'primary',
}: {
  label: string;
  value: string;
  tone?: 'primary' | 'secondary' | 'danger';
}) {
  return (
    <View style={styles.detailRow} accessible accessibilityLabel={`${label}: ${value}`}>
      <Text variant="bodySmall" tone="secondary" style={styles.detailLabel}>
        {label}
      </Text>
      <Text variant="bodySmall" tone={tone} style={styles.detailValue}>
        {value}
      </Text>
    </View>
  );
}

/** Avatar — initials on a neutral circle. Decorative, so hidden from readers. */
export function Avatar({ name, size = 44 }: { name: string; size?: number }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');

  return (
    <View
      style={[styles.avatar, { width: size, height: size, borderRadius: size / 2 }]}
      importantForAccessibility="no"
      accessibilityElementsHidden
    >
      <Text variant="h3" tone="brand">
        {initials}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    minHeight: 64,
  },
  rowLast: {
    borderBottomWidth: 0,
  },
  rowPressed: {
    backgroundColor: colors.surfaceMuted,
  },
  rowDisabled: {
    opacity: 0.55,
  },
  iconBubble: {
    width: 36,
    height: 36,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  textBlock: {
    flex: 1,
    gap: spacing.xxs,
  },
  subtitle: {
    marginTop: 1,
  },
  meta: {
    marginTop: 1,
  },
  detailRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    paddingVertical: spacing.sm,
  },
  detailLabel: {
    width: 116,
  },
  detailValue: {
    flex: 1,
    fontWeight: '500',
  },
  avatar: {
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
});