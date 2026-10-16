import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { colors, radius, spacing } from '../theme';
import { Text } from './Text';

/**
 * SegmentedControl — pick one option from a short list, laid out as tabs.
 *
 * The difference from `ChoiceGroup` is purely one of weight. `ChoiceGroup`
 * presents each option as a card with room for a description and a tick, which
 * suits a decision the user makes once ("sign in as"). A segmented control is
 * for a filter the user flips between while reading the screen — the academic
 * year, a past cycle — so it stays a single compact bar and lets the content
 * below dominate. It keeps the same radio semantics (`radiogroup`/`radio`) so a
 * screen reader still announces "one of these, and this is the current answer"
 * rather than a row of anonymous buttons.
 *
 * Set `scroll` when the options can outnumber the width — cycle history grows
 * without bound — so the bar scrolls sideways instead of crushing the labels.
 */

export interface SegmentedOption {
  value: string;
  label: string;
}

interface SegmentedControlProps {
  label: string;
  options: SegmentedOption[];
  value: string;
  onChange: (value: string) => void;
  /** Lay the options out on one scrollable row. Use for a growing list. */
  scroll?: boolean;
  hint?: string;
}

export function SegmentedControl({
  label,
  options,
  value,
  onChange,
  scroll = false,
  hint,
}: SegmentedControlProps) {
  const tabs = options.map((option) => {
    const active = option.value === value;
    return (
      <Pressable
        key={option.value || '__empty__'}
        onPress={() => onChange(option.value)}
        accessibilityRole="radio"
        accessibilityState={{ selected: active }}
        accessibilityLabel={option.label}
        style={({ pressed }) => [
          styles.option,
          scroll ? styles.optionScroll : styles.optionFlex,
          active ? styles.optionActive : null,
          pressed && !active ? styles.optionPressed : null,
        ]}
      >
        <Text variant="button" align="center" tone={active ? 'brand' : 'secondary'} numberOfLines={1}>
          {option.label}
        </Text>
      </Pressable>
    );
  });

  return (
    <View style={styles.wrap}>
      <Text variant="label" tone="secondary" uppercase>
        {label}
      </Text>
      {scroll ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          accessibilityRole="radiogroup"
          accessibilityLabel={label}
          contentContainerStyle={styles.trackScroll}
        >
          {tabs}
        </ScrollView>
      ) : (
        <View accessibilityRole="radiogroup" accessibilityLabel={label} style={styles.track}>
          {tabs}
        </View>
      )}
      {hint ? (
        <Text variant="caption" tone="muted">
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    gap: spacing.xs,
  },
  track: {
    flexDirection: 'row',
    backgroundColor: colors.surfaceMuted,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.xxs,
    padding: spacing.xxs,
  },
  trackScroll: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surfaceMuted,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.xxs,
    padding: spacing.xxs,
  },
  option: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.sm,
  },
  optionFlex: {
    flex: 1,
  },
  optionScroll: {
    minWidth: 104,
  },
  optionActive: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.primaryBorder,
  },
  optionPressed: {
    backgroundColor: colors.surface,
  },
});
