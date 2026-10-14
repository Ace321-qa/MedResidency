import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import {
  AppHeader,
  FacultyRosterTab,
  ResidentRosterTab,
  Screen,
  Text,
} from '../../../components';
import { useApiResource, useSession } from '../../../hooks';
import { fetchResidentList } from '../../../services/residents';
import { fetchFacultySupervisors } from '../../../services/longitudinal';
import { colors, radius, spacing } from '../../../theme';

/**
 * Roster — the Roster Management Hub for the signed-in programme.
 *
 * One section, two rosters: the *residents* enrolled in the programme and the
 * *faculty preceptors* who supervise them. They are kept on one screen rather
 * than two tabs in the tab bar because they answer the same question — "who is
 * part of this programme" — and a coordinator maintaining the teaching faculty
 * expects to find them beside the people they teach.
 *
 * The hub owns the two fetches and the count badges, so a tab's list and its
 * badge can never disagree about how many people are on that roster. Each tab
 * component owns its own search, filters, forms and mutations.
 */

type RosterTab = 'residents' | 'faculty';

export default function RosterScreen() {
  const { session } = useSession();
  const programId = session?.programId ?? 0;

  const [activeTab, setActiveTab] = useState<RosterTab>('residents');

  const residents = useApiResource(
    () => fetchResidentList({ programId, limit: 100 }),
    [programId],
  );
  // Faculty are pulled with inactive people included so the tab can filter to
  // them; the badge counts only the active ones.
  const faculty = useApiResource(
    () => fetchFacultySupervisors(programId, { includeInactive: true }),
    [programId],
  );

  // The header has to name the *programme*, and there is no GET /programs, so
  // it is derived from the roster itself — every row carries the code and name.
  const programme = useMemo(() => {
    const first = (residents.data ?? []).find((row) => row.program_code);
    if (!first) return null;
    return { name: first.specialty_name, code: first.program_code };
  }, [residents.data]);

  const headerSubtitle = programme?.code
    ? `Enrolled into ${programme.name ?? 'Programme'} Program (Code: ${programme.code})`
    : (session?.programLabel ?? 'Residents enrolled in this programme');

  const tabs = useMemo(
    () => [
      {
        value: 'residents' as const,
        label: 'Resident Roster',
        count: residents.data?.length ?? 0,
        countLabel: 'residents',
      },
      {
        value: 'faculty' as const,
        label: 'Faculty Preceptors',
        count: (faculty.data ?? []).filter((row) => row.is_active === 1).length,
        countLabel: 'active',
      },
    ],
    [residents.data, faculty.data],
  );

  return (
    <Screen
      onRefresh={() => {
        residents.refresh();
        faculty.refresh();
      }}
      refreshing={residents.isRefreshing || faculty.isRefreshing}
      bottomGutter={spacing.xxl}
    >
      <AppHeader title="Roster" subtitle={headerSubtitle} />

      <View accessibilityRole="radiogroup" accessibilityLabel="Roster section" style={styles.toggle}>
        {tabs.map((tab) => {
          const active = activeTab === tab.value;
          return (
            <Pressable
              key={tab.value}
              onPress={() => setActiveTab(tab.value)}
              accessibilityRole="radio"
              accessibilityState={{ selected: active }}
              accessibilityLabel={`${tab.label}, ${tab.count} ${tab.countLabel}`}
              style={({ pressed }) => [
                styles.toggleOption,
                active ? styles.toggleOptionActive : null,
                pressed && !active ? styles.toggleOptionPressed : null,
              ]}
            >
              <Text variant="button" align="center" tone={active ? 'brand' : 'secondary'}>
                {tab.label}
              </Text>
              <Text variant="caption" align="center" tone="muted">
                {`${tab.count} ${tab.countLabel}`}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {activeTab === 'residents' ? (
        <ResidentRosterTab resource={residents} programId={programId} />
      ) : (
        <FacultyRosterTab resource={faculty} programId={programId} />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  toggle: {
    flexDirection: 'row',
    backgroundColor: colors.surfaceMuted,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.xxs,
    padding: spacing.xxs,
    marginBottom: spacing.md,
  },
  toggleOption: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xxs,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
  },
  toggleOptionActive: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.primaryBorder,
  },
  toggleOptionPressed: {
    backgroundColor: colors.surface,
  },
});
