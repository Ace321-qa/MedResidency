import { StyleSheet, View } from 'react-native';
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
}

export function CapacityBanner({ verdict, loading }: CapacityBannerProps) {
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
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  ok: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
});
