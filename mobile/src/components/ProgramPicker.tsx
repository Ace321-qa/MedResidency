import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { colors, radius, spacing } from '../theme';
import { SearchInput } from './Form';
import { StatusBadge } from './StatusBadge';
import { Text } from './Text';

/**
 * ProgramPicker — choosing which registered programme account a rotation is
 * hosted by.
 *
 * This replaces the free-text "Hospital Department" field. That field could
 * take any string, so "Internal Medicine", "IM Wards" and "Internal Med." were
 * three spellings of one ward and none of them carried an identity the system
 * could route a letter to. A picker bound to `programs` makes the department a
 * *reference*: choosing the Internal Medicine Residency Program stores its id
 * as the rotation's `target_program_id`, which is what later files the notice
 * into that programme's inbox and puts its visiting residents on its grid.
 *
 * The searchable list follows `FacultyPicker`: a programme registry is a list
 * that grows as accounts are created, and a coordinator picking between two
 * dozen programmes should not have to scroll a chip row to find one.
 *
 * Selecting a programme also fills the rotation's department *label* with that
 * programme's name — the label is still stored, because letters and the grid
 * read it as display text, but it is now derived rather than typed.
 */

export interface ProgramOption {
  id: number;
  program_name: string;
  program_code: string;
  specialty_name: string | null;
  institution_name: string | null;
  /** Not required to pick, but shown: it is who the notice will reach. */
  coordinator_email?: string | null;
}

export interface ProgramPickerProps {
  label: string;
  /** `null` when no programme is linked. */
  value: number | null;
  options: ProgramOption[];
  onChange: (id: number | null) => void;
  error?: string | null;
  hint?: string;
  required?: boolean;
  loading?: boolean;
  accessibilityLabel?: string;
}

/** The exact option rendering the catalogue spec asks for: `Name (CODE)`. */
export function programOptionLabel(option: ProgramOption): string {
  return `${option.program_name} (${option.program_code})`;
}

export function ProgramPicker({
  label,
  value,
  options,
  onChange,
  error,
  hint,
  required = false,
  loading = false,
  accessibilityLabel,
}: ProgramPickerProps) {
  const [query, setQuery] = useState('');

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return options;
    return options.filter((option) =>
      [option.program_name, option.program_code, option.specialty_name ?? '', option.institution_name ?? '']
        .join(' ')
        .toLowerCase()
        .includes(needle),
    );
  }, [options, query]);

  return (
    <View style={styles.field}>
      <View style={styles.labelRow}>
        <Text variant="label" tone="secondary">
          {label}
          {required ? ' *' : ''}
        </Text>
        {value !== null ? (
          <Pressable
            onPress={() => onChange(null)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Clear the linked programme"
          >
            <Text variant="caption" tone="brand">
              Clear
            </Text>
          </Pressable>
        ) : null}
      </View>

      {options.length > 0 ? (
        <SearchInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search by programme name, code or specialty"
          accessibilityLabel={accessibilityLabel ?? `Search ${label.toLowerCase()}`}
        />
      ) : null}

      {loading ? (
        <Text variant="caption" tone="muted">
          Loading programmes…
        </Text>
      ) : null}

      {!loading && options.length === 0 ? (
        <View style={styles.emptyBox}>
          <Text variant="bodySmall" tone="secondary">
            No registered programmes are available to link.
          </Text>
          <Text variant="caption" tone="muted">
            A programme account must exist before a rotation can be hosted by it. The department name
            can still be entered on the server.
          </Text>
        </View>
      ) : null}

      {!loading && options.length > 0 && visible.length === 0 ? (
        <Text variant="caption" tone="muted">
          No programme matches “{query.trim()}”.
        </Text>
      ) : null}

      {visible.map((option) => {
        const selected = option.id === value;
        return (
          <Pressable
            key={option.id}
            onPress={() => onChange(selected ? null : option.id)}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            accessibilityLabel={`${option.program_name}, code ${option.program_code}${
              option.specialty_name ? `, ${option.specialty_name}` : ''
            }${option.institution_name ? `, ${option.institution_name}` : ''}`}
            style={({ pressed }) => [
              styles.option,
              selected ? styles.optionSelected : null,
              pressed ? styles.optionPressed : null,
            ]}
          >
            <View style={styles.optionText}>
              <View style={styles.optionTitleRow}>
                <Text variant="bodySmall" numberOfLines={1} style={styles.optionName}>
                  {programOptionLabel(option)}
                </Text>
                {selected ? <StatusBadge label="Linked" tone="success" /> : null}
              </View>
              {option.specialty_name || option.institution_name || option.coordinator_email ? (
                <Text variant="caption" tone="muted" numberOfLines={1}>
                  {[option.specialty_name, option.institution_name, option.coordinator_email]
                    .filter(Boolean)
                    .join(' · ')}
                </Text>
              ) : null}
            </View>
          </Pressable>
        );
      })}

      {hint ? (
        <Text variant="caption" tone="muted">
          {hint}
        </Text>
      ) : null}
      {error ? (
        <Text variant="caption" tone="danger">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  field: {
    gap: spacing.xs,
    marginBottom: spacing.lg,
  },
  labelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 52,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
  },
  optionSelected: {
    borderColor: colors.primary,
    backgroundColor: colors.primarySoft,
  },
  optionPressed: {
    backgroundColor: colors.surfaceMuted,
  },
  optionText: {
    flex: 1,
    gap: 1,
  },
  optionTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  optionName: {
    flexShrink: 1,
  },
  emptyBox: {
    gap: spacing.xxs,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.border,
    backgroundColor: colors.surfaceMuted,
  },
});
