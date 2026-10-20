import { Pressable, StyleSheet, View } from 'react-native';
import { Check } from 'lucide-react-native';

import { colors, radius, spacing } from '../theme';
import { Text } from './Text';
import { type DayName } from '../utils/dateCalc';
import {
  CLINIC_DAY_OPTIONS,
  MAX_CLINIC_DAYS,
  toggleClinicDay,
} from '../utils/clinicRotationRequest';

/**
 * ClinicDayField — pick one to three recurring weekdays for a clinic release.
 *
 * Distinct from `ChoiceGroup`, which is a *radio* group: exactly one answer, so
 * its options announce `radio` and `radio-selected`. A clinic release can land on
 * several days at once, and a screen reader told "radio" for a multi-answer
 * question gives the wrong instruction — so this is a real checkbox group, with
 * `checkbox` / `checked` semantics and a tick per chosen day.
 *
 * The one-to-three rule is enforced by disabling the *unchosen* days once three
 * are picked, rather than accepting a fourth tap and rejecting it afterwards: an
 * option the user can see is unavailable explains itself, an error message after
 * the fact does not. A chosen day is never disabled, so removing one is always
 * possible.
 */

interface ClinicDayFieldProps {
  label: string;
  /** The chosen weekdays, in institution order. */
  value: DayName[];
  onChange: (days: DayName[]) => void;
  options?: DayName[];
  hint?: string;
  error?: string | null;
  required?: boolean;
}

export function ClinicDayField({
  label,
  value,
  onChange,
  options = CLINIC_DAY_OPTIONS,
  hint,
  error,
  required = false,
}: ClinicDayFieldProps) {
  const atLimit = value.length >= MAX_CLINIC_DAYS;

  // The one-to-three rule lives in `toggleClinicDay`, not here: it is the same
  // rule the request form validates against before submitting, and having two
  // copies is how a control and its validator drift apart.
  function toggle(day: DayName) {
    onChange(toggleClinicDay(value, day));
  }

  return (
    <View style={styles.field}>
      <Text variant="label" tone="secondary" uppercase>
        {label}
        {required ? <Text variant="label" tone="danger">{' *'}</Text> : null}
      </Text>

      <View style={styles.group}>
        {options.map((day) => {
          const selected = value.includes(day);
          const disabled = !selected && atLimit;
          return (
            <Pressable
              key={day}
              onPress={() => toggle(day)}
              disabled={disabled}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: selected, disabled }}
              accessibilityLabel={day}
              accessibilityHint={
                disabled ? `Three days is the most a clinic request can hold` : undefined
              }
              style={({ pressed }) => [
                styles.option,
                selected && styles.optionSelected,
                disabled && styles.optionDisabled,
                pressed && !disabled && styles.optionPressed,
              ]}
            >
              <Text variant="bodySmall" tone={disabled ? 'muted' : 'primary'}>
                {day}
              </Text>

              <View style={[styles.box, selected && styles.boxSelected]}>
                {selected ? <Check color={colors.onPrimary} size={12} strokeWidth={3} /> : null}
              </View>
            </Pressable>
          );
        })}
      </View>

      {hint && !error ? (
        <Text variant="caption" tone="muted">
          {hint}
        </Text>
      ) : null}

      {error ? (
        <Text variant="caption" tone="danger" accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  field: {
    gap: spacing.xs,
  },
  group: {
    gap: spacing.sm,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
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
  box: {
    width: 20,
    height: 20,
    borderRadius: radius.sm,
    borderWidth: 2,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxSelected: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
});
