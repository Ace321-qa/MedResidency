import { Pressable, StyleSheet, View } from 'react-native';
import { AlertTriangle, Ban, Check } from 'lucide-react-native';

import { colors, radius, spacing } from '../theme';
import { capacityTone } from '../utils/capacityStatus';
import type { CapacityVerdict } from '../types/api';
import { Text } from './Text';

/**
 * CapacityBanner — the overcapacity verdict, shown before the write is attempted.
 *
 * The verdict comes from the server (`POST /rotations/assignments/check-capacity`),
 * which runs the same engine the write runs, so this banner and the enforcement
 * cannot disagree. The banner's job is to say three things in order: which tier
 * this placement falls into, how many residents and for which weeks, and what
 * the coordinator has to do about it.
 *
 * `BLOCKED` is drawn differently from the rest on purpose. The amber and red
 * tiers are warnings with a way forward; a locked limit is a refusal, and a
 * banner that looked the same would suggest a rationale might get past it.
 */

interface CapacityBannerProps {
  verdict: CapacityVerdict | null;
  /** True while a fresh verdict is being fetched. */
  loading?: boolean;
  /**
   * True when the check itself could not be completed.
   *
   * This is shown, not swallowed. A preview that failed and a rotation that is
   * within capacity used to render the same empty space, so an over-capacity
   * department looked fine precisely when the app could not tell — the most
   * misleading state to fail in. The write still enforces the limit, but the
   * coordinator is told the preview is unavailable.
   */
  failed?: boolean;
  /** Re-runs the check, so a transient failure is recoverable in place. */
  onRetry?: () => void;
}

export function CapacityBanner({ verdict, loading, failed, onRetry }: CapacityBannerProps) {
  if (failed && !verdict) {
    return (
      <View
        style={[styles.banner, styles.failed]}
        accessible
        accessibilityRole="alert"
        accessibilityLabel="Seat capacity could not be checked"
      >
        <View style={styles.header}>
          <AlertTriangle size={16} color={colors.warning} />
          <Text variant="label" uppercase style={{ color: colors.warning }}>
            Capacity not checked
          </Text>
        </View>
        <Text variant="bodySmall" style={{ color: colors.warning }}>
          The departmental seat check could not be completed, so this placement has
          not been verified against the limit.
        </Text>
        <Text variant="caption" style={{ color: colors.warning }}>
          The limit is still enforced when you assign, so an over-capacity
          placement will be refused there.
        </Text>
        {onRetry ? (
          <Pressable
            onPress={onRetry}
            accessibilityRole="button"
            accessibilityLabel="Retry capacity check"
            style={styles.retry}
          >
            <Text variant="label" style={{ color: colors.warning }}>
              Retry check
            </Text>
          </Pressable>
        ) : null}
      </View>
    );
  }

  if (loading && !verdict) {
    return (
      <View style={[styles.banner, styles.neutral]}>
        <Text variant="bodySmall" tone="secondary">
          Checking departmental seat capacity…
        </Text>
      </View>
    );
  }

  if (!verdict) return null;

  // Green placements need no banner: a rotation with no limit, or a week that is
  // comfortably inside it, is the ordinary case and does not warrant a notice.
  if (verdict.status === 'GREEN') return null;

  const tone = capacityTone(verdict.status);
  const blocked = verdict.status === 'BLOCKED';
  const Icon = blocked ? Ban : AlertTriangle;

  const weeks = verdict.weeks.filter((week) => week.over_by > 0);
  const weekText =
    weeks.length === 1
      ? `${weeks[0].week_start} to ${weeks[0].week_end}`
      : weeks
          .map((week) => week.week_start)
          .slice(0, 3)
          .join(', ') + (weeks.length > 3 ? '…' : '');

  return (
    <View
      style={[styles.banner, { backgroundColor: tone.surface, borderColor: tone.border }]}
      accessible
      accessibilityRole="alert"
      accessibilityLabel={`${tone.label}. ${verdict.message}`}
    >
      <View style={styles.header}>
        <Icon size={16} color={tone.foreground} />
        <Text variant="label" uppercase style={{ color: tone.foreground }}>
          {tone.label}
        </Text>
      </View>

      <Text variant="bodySmall" style={{ color: tone.foreground }}>
        {verdict.capacity !== null
          ? `Approved capacity is ${verdict.capacity}. `
          : 'This rotation has no seat limit. '}
        {verdict.peak} resident{verdict.peak === 1 ? '' : 's'} in the busiest week
        {weeks.length > 0 ? `, over the limit for ${weeks.length} week${weeks.length === 1 ? '' : 's'}` : ''}
        {weekText ? ` (${weekText})` : ''}.
      </Text>

      <Text variant="caption" style={{ color: tone.foreground }}>
        {blocked
          ? 'This department has locked its seat limit, so this placement cannot be made — no rationale can override it.'
          : tone.summary}
      </Text>
    </View>
  );
}

/**
 * A one-line confirmation that the placement is allowed without an exception.
 *
 * Shown so the absence of a warning is not mistaken for a missing check.
 */
export function CapacityOkNote({ verdict }: { verdict: CapacityVerdict | null }) {
  if (!verdict || verdict.status !== 'GREEN') return null;
  return (
    <View style={styles.ok}>
      <Check size={14} color={colors.success} />
      <Text variant="caption" tone="secondary">
        {verdict.capacity === null
          ? 'This rotation has no seat limit.'
          : `Within capacity: ${verdict.peak} of ${verdict.capacity} seats in the busiest week.`}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    gap: spacing.xs,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.md,
  },
  neutral: {
    backgroundColor: colors.surfaceMuted,
    borderColor: colors.border,
  },
  /** The check failed: a warning, not a refusal, so amber rather than red. */
  failed: {
    backgroundColor: colors.warningSurface,
    borderColor: colors.warning,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  retry: {
    alignSelf: 'flex-start',
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.warning,
  },
  ok: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
});
