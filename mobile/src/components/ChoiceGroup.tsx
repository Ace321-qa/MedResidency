import type { LucideIcon } from 'lucide-react-native';
import { Pressable, StyleSheet, View } from 'react-native';
import { Check } from 'lucide-react-native';

import { colors, radius, spacing } from '../theme';
import { Text } from './Text';

/**
 * ChoiceGroup — pick one option from a short list.
 *
 * Used wherever the user chooses between a few named things: signing in as a
 * resident or coordinator, filtering a list, choosing a reviewer. It exists as a
 * component because a hand-rolled set of `Pressable`s gets two things wrong:
 * it loses the radio semantics (`radio`/`radio-selected`) that tell a screen
 * reader "one of these, and this is the current answer", and it signals the
 * selection with colour alone. Here the selection is colour *and* a tick *and*
 * an accessibility state.
 *
 * Unlike a button group, options can carry a description, which is what makes it
 * usable for the sign-in role choice where the two options look identical.
 */

export interface ChoiceOption {
  value: string;
  label: string;
  description?: string;
  icon?: LucideIcon;
  disabled?: boolean;
}

interface ChoiceGroupProps {
  label: string;
  options: ChoiceOption[];
  value: string | null;
  onChange: (value: string) => void;
  /** >1 lays the options out side by side. Keep it at 2 for readability. */
  columns?: number;
}

export function ChoiceGroup({ label, options, value, onChange, columns = 1 }: ChoiceGroupProps) {
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
      style={[styles.group, columns > 1 && styles.groupRow]}
    >
      {options.map((option) => (
        <Choice
          key={option.value}
          option={option}
          selected={option.value === value}
          wide={columns > 1}
          onPress={() => onChange(option.value)}
        />
      ))}
    </View>
  );
}

interface ChoiceProps {
  option: ChoiceOption;
  selected: boolean;
  wide: boolean;
  onPress: () => void;
}

function Choice({ option, selected, wide, onPress }: ChoiceProps) {
  const { icon: Icon, label, description, disabled = false } = option;

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="radio"
      accessibilityState={{ selected, disabled }}
      accessibilityLabel={description ? `${label}. ${description}` : label}
      style={({ pressed }) => [
        styles.option,
        wide && styles.optionWide,
        selected && styles.optionSelected,
        disabled && styles.optionDisabled,
        pressed && !disabled && styles.optionPressed,
      ]}
    >
      {Icon ? (
        <Icon color={selected ? colors.primary : colors.textSecondary} size={20} strokeWidth={2} />
      ) : null}

      <View style={styles.optionText}>
        <Text variant="h3" tone={disabled ? 'muted' : 'primary'}>
          {label}
        </Text>
        {description ? (
          <Text variant="caption" tone="secondary">
            {description}
          </Text>
        ) : null}
      </View>

      <View style={[styles.marker, selected && styles.markerSelected]}>
        {selected ? <Check color={colors.onPrimary} size={12} strokeWidth={3} /> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  group: {
    gap: spacing.sm,
  },
  groupRow: {
    flexDirection: 'row',
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  optionWide: {
    flex: 1,
    alignItems: 'flex-start',
  },
  optionSelected: {
    borderColor: colors.primary,
    borderWidth: 2,
    backgroundColor: colors.primarySoft,
  },
  optionDisabled: {
    opacity: 0.5,
  },
  optionPressed: {
    opacity: 0.75,
  },
  optionText: {
    flex: 1,
    gap: 2,
  },
  marker: {
    width: 20,
    height: 20,
    borderRadius: radius.pill,
    borderWidth: 2,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  markerSelected: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
});