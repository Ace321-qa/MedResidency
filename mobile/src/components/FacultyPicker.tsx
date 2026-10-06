import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Mail, Phone } from 'lucide-react-native';

import { colors, radius, spacing } from '../theme';
import { SearchInput } from './Form';
import { StatusBadge } from './StatusBadge';
import { Text } from './Text';

/**
 * FacultyPicker — choosing a supervising faculty member.
 *
 * A chips-only `SelectField` works while the list is a short fixed enum. A
 * faculty roster is neither: it is a hundred names that changes whenever someone
 * is promoted or leaves, and a coordinator scrolling four screens of chips to
 * find one person is the reason this is a search list instead.
 *
 * Two things it deliberately gets right:
 *
 *  - **Inactive faculty are listed, marked, and unselectable by default.** The
 *    API filters to `is_active = 1`, so someone who has left cannot be assigned
 *    to a new posting by accident; but a *continuing* posting is exactly when a
 *    coordinator needs to see that Dr X is no longer active. A toggle brings them
 *    back as selectable rather than pretending they do not exist.
 *  - **An empty roster is explained, not silent.** `faculty_supervisors` is empty
 *    in a fresh install, and a control with no options and no explanation looks
 *    like a bug rather than missing data.
 */

export interface FacultyOption {
  id: number;
  name: string;
  title: string | null;
  email: string | null;
  phone: string | null;
  isActive: boolean;
}

export interface FacultyPickerProps {
  label: string;
  /** `null` when nothing is selected. */
  value: number | null;
  options: FacultyOption[];
  onChange: (id: number | null) => void;
  error?: string | null;
  hint?: string;
  required?: boolean;
  loading?: boolean;
}

export function FacultyPicker({
  label,
  value,
  options,
  onChange,
  error,
  hint,
  required = false,
  loading = false,
}: FacultyPickerProps) {
  const [query, setQuery] = useState('');
  const [showInactive, setShowInactive] = useState(false);

  const active = useMemo(() => options.filter((option) => option.isActive), [options]);
  const inactiveCount = options.length - active.length;

  const visible = useMemo(() => {
    const pool = showInactive ? options : active;
    const needle = query.trim().toLowerCase();
    if (!needle) return pool;

    return pool.filter((option) => {
      const haystack = [option.name, option.title ?? '', option.email ?? ''].join(' ').toLowerCase();
      return haystack.includes(needle);
    });
  }, [active, options, query, showInactive]);

  return (
    <View style={styles.field}>
      <View style={styles.labelRow}>
        <Text variant="label" tone="secondary">
          {label}
          {required ? ' *' : ''}
        </Text>
        {inactiveCount > 0 ? (
          <Pressable
            onPress={() => setShowInactive((current) => !current)}
            hitSlop={8}
            accessibilityRole="switch"
            accessibilityState={{ checked: showInactive }}
            accessibilityLabel="Include faculty who are no longer active"
          >
            <Text variant="caption" tone="brand">
              {showInactive ? 'Hide inactive' : `Include ${inactiveCount} inactive`}
            </Text>
          </Pressable>
        ) : null}
      </View>

      {active.length > 0 ? (
        <SearchInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search by name, title or email"
          accessibilityLabel={`Search ${label.toLowerCase()}`}
        />
      ) : null}

      {loading ? (
        <Text variant="caption" tone="muted">
          Loading faculty…
        </Text>
      ) : null}

      {!loading && options.length === 0 ? (
        <View style={styles.emptyBox}>
          <Text variant="bodySmall" tone="secondary">
            No faculty supervisors are recorded for this programme.
          </Text>
          <Text variant="caption" tone="muted">
            Add a faculty supervisor on the server, then reopen this form — the list is read live from
            the active faculty endpoint.
          </Text>
        </View>
      ) : null}

      {!loading && options.length > 0 && visible.length === 0 ? (
        <Text variant="caption" tone="muted">
          No faculty match “{query.trim()}”.
        </Text>
      ) : null}

      {visible.map((option) => {
        const selected = option.id === value;
        const selectable = option.isActive || showInactive;

        return (
          <Pressable
            key={option.id}
            onPress={() => selectable && onChange(selected ? null : option.id)}
            disabled={!selectable}
            accessibilityRole="radio"
            accessibilityState={{ selected, disabled: !selectable }}
            accessibilityLabel={`${option.name}${option.title ? `, ${option.title}` : ''}${
              option.isActive ? '' : ', no longer active'
            }`}
            style={({ pressed }) => [
              styles.option,
              selected ? styles.optionSelected : null,
              pressed && selectable ? styles.optionPressed : null,
              !selectable ? styles.optionDisabled : null,
            ]}
          >
            <View style={styles.optionText}>
              <Text variant="bodySmall" numberOfLines={1}>
                {option.name}
              </Text>
              <View style={styles.optionMeta}>
                {option.title ? (
                  <Text variant="caption" tone="secondary" numberOfLines={1}>
                    {option.title}
                  </Text>
                ) : null}
                {option.email ? (
                  <Text variant="caption" tone="muted" numberOfLines={1}>
                    {option.email}
                  </Text>
                ) : null}
              </View>
            </View>

            {option.phone ? (
              <Phone color={colors.textMuted} size={14} />
            ) : option.email ? (
              <Mail color={colors.textMuted} size={14} />
            ) : null}

            {option.isActive ? null : <StatusBadge label="Inactive" tone="warning" />}
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
  optionDisabled: {
    opacity: 0.5,
  },
  optionText: {
    flex: 1,
    gap: 1,
  },
  optionMeta: {
    flexDirection: 'row',
    gap: spacing.sm,
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