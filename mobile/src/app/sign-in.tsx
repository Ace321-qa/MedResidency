import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { BookUser, Building2, LockKeyhole, Stethoscope, Wifi, WifiOff } from 'lucide-react-native';

import {
  Banner,
  Button,
  Card,
  ChoiceGroup,
  ErrorState,
  ListRow,
  Screen,
  SearchInput,
  SectionHeader,
  SkeletonList,
  Text,
} from '../components';
import { DEFAULT_PROGRAM, useApiResource, useSession } from '../hooks';
import { fetchHealth } from '../services/health';
import { fetchResidentList } from '../services/residents';
import { colors, dimensions, radius, spacing } from '../theme';
import { deriveProgramsFromResidents, filterResidents, residentFullName, residentSubtitle } from '../utils/residents';
import { EMPTY_ARRAY } from '../utils/empty';
import type { ResidentListItem } from '../types/api';

/**
 * Sign-in.
 *
 * The backend has no authentication, no users table and no role concept, so this
 * screen cannot verify an identity — and pretending otherwise would be worse
 * than saying so. It does two real things instead:
 *
 *  1. It loads the actual roster from `GET /residents`, so the person signing in
 *     is a real row in the database, not a hardcoded constant.
 *  2. It records that choice in the session, which decides the tab bar and
 *     scopes every query. Removing the `CURRENT_RESIDENT_ID = 1` constant was
 *     the actual point of this work.
 *
 * When authentication is added to the backend, only the two sign-in handlers
 * change; the rest of the app reads from `useSession()` and does not care where
 * the session came from.
 */

type RoleChoice = 'resident' | 'coordinator';

export default function SignInScreen() {
  const router = useRouter();
  const { signInAsResident, signInAsCoordinator } = useSession();

  const [role, setRole] = useState<RoleChoice>('resident');
  const [query, setQuery] = useState('');

  const roster = useApiResource(() => fetchResidentList({ limit: 50 }));
  const health = useApiResource(fetchHealth);

  const residents = roster.data ?? (EMPTY_ARRAY as ResidentListItem[]);
  const programs = useMemo(() => deriveProgramsFromResidents(residents), [residents]);
  const visibleResidents = useMemo(() => filterResidents(residents, query), [residents, query]);

  const handleResident = (residentId: number) => {
    const resident = residents.find((item) => item.resident_id === residentId);
    if (!resident || resident.program_id === null) return;

    signInAsResident({
      id: resident.resident_id,
      fullName: residentFullName(resident),
      programId: resident.program_id,
    });
    router.replace('/resident');
  };

  const handleProgram = (programId: number) => {
    const program = programs.find((item) => item.programId === programId);
    signInAsCoordinator(programId, program?.programName ?? DEFAULT_PROGRAM.label);
    router.replace('/program');
  };

  const apiReachable = health.status === 'ready' && health.data?.status === 'success';

  return (
    <Screen bottomGutter={spacing.xl}>
      <View style={styles.brand}>
        <View style={styles.mark}>
          <Stethoscope color={colors.onPrimary} size={26} strokeWidth={2} />
        </View>
        <Text variant="h1">MedResidency</Text>
        <Text variant="body" tone="secondary">
          Attendance, rotations and duty hours for residency programmes
        </Text>
      </View>

      <Banner
        tone="info"
        icon={LockKeyhole}
        title="Demo sign-in"
        message="This build has no authentication yet. Choose a resident or a programme from the real roster; nothing you pick is verified or stored on a server."
      />

      <SectionHeader title="I am signing in as" />
      <ChoiceGroup
        label="Role"
        columns={2}
        value={role}
        onChange={(value) => setRole(value as RoleChoice)}
        options={[
          {
            value: 'resident',
            label: 'Resident',
            description: 'My rotations, attendance and requests',
            icon: BookUser,
          },
          {
            value: 'coordinator',
            label: 'Coordinator',
            description: 'Roster, scheduling and leave decisions',
            icon: Building2,
          },
        ]}
      />

      {role === 'resident' ? (
        <Card padded={false} style={styles.listCard}>
          <View style={styles.listHeader}>
            <Text variant="h3">Choose a resident</Text>
            <Text variant="caption" tone="muted">
              {residents.length > 0 ? `${residents.length} on the roster` : 'Loading roster…'}
            </Text>
          </View>

          <View style={styles.search}>
            <SearchInput
              accessibilityLabel="Search roster"
              value={query}
              onChangeText={setQuery}
              placeholder="Name, programme or PGY level"
            />
          </View>

          {roster.status === 'loading' ? <SkeletonList rows={5} /> : null}

          {roster.error ? (
            <View style={styles.stateBlock}>
              <ErrorState
                title="Could not load the roster"
                message={roster.error.message}
                onRetry={roster.refresh}
              />
            </View>
          ) : null}

          {roster.status === 'ready' && visibleResidents.length === 0 ? (
            <View style={styles.stateBlock}>
              <Text variant="body" tone="muted">
                {query ? `No resident matches “${query}”.` : 'No residents on this roster.'}
              </Text>
            </View>
          ) : null}

          {visibleResidents.map((resident, index) => (
            <ListRow
              key={resident.resident_id}
              title={residentFullName(resident)}
              subtitle={residentSubtitle(resident)}
              meta={resident.program_code ?? undefined}
              last={index === visibleResidents.length - 1}
              trailing={<Text variant="caption" tone="primary">Open</Text>}
              onPress={() => handleResident(resident.resident_id)}
              disabled={resident.program_id === null}
              accessibilityHint={
                resident.program_id === null
                  ? 'Not enrolled in a programme, so this record cannot be opened'
                  : undefined
              }
            />
          ))}
        </Card>
      ) : (
        <Card padded={false} style={styles.listCard}>
          <View style={styles.listHeader}>
            <Text variant="h3">Choose a programme</Text>
            <Text variant="caption" tone="muted">
              Derived from the roster — the API has no programmes endpoint
            </Text>
          </View>

          {roster.status === 'loading' ? <SkeletonList rows={3} /> : null}

          {programs.map((program, index) => (
            <ListRow
              key={program.programId}
              title={program.programName}
              subtitle={program.programCode}
              meta={`${program.residentCount} resident${program.residentCount === 1 ? '' : 's'}`}
              last={index === programs.length - 1}
              trailing={<Text variant="caption" tone="primary">Open</Text>}
              onPress={() => handleProgram(program.programId)}
            />
          ))}

          {roster.status === 'ready' && programs.length === 0 ? (
            <View style={styles.stateBlock}>
              <Text variant="body" tone="muted">
                No programme enrollments were found on the roster.
              </Text>
            </View>
          ) : null}
        </Card>
      )}

      <View style={styles.apiStatus}>
        {health.status === 'ready' && apiReachable ? (
          <>
            <Wifi color={colors.success} size={14} strokeWidth={2.2} />
            <Text variant="caption" tone="secondary">
              API reachable · database connected
            </Text>
          </>
        ) : (
          <>
            <WifiOff color={colors.danger} size={14} strokeWidth={2.2} />
            <Text variant="caption" tone="danger">
              {health.status === 'error'
                ? 'API unreachable — set EXPO_PUBLIC_API_URL'
                : 'Checking the API…'}
            </Text>
            {health.status === 'error' ? (
              <Button label="Retry" variant="ghost" fullWidth={false} onPress={health.refresh} />
            ) : null}
          </>
        )}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  brand: {
    alignItems: 'center',
    gap: spacing.xs,
    paddingTop: spacing.xxl,
    paddingBottom: spacing.lg,
  },
  mark: {
    width: dimensions.touchTarget + 14,
    height: dimensions.touchTarget + 14,
    borderRadius: radius.lg,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.sm,
  },
  listCard: {
    marginTop: spacing.md,
    overflow: 'hidden',
  },
  listHeader: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    gap: 2,
  },
  search: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xs,
  },
  stateBlock: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md,
  },
  apiStatus: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    paddingTop: spacing.lg,
    paddingBottom: spacing.sm,
  },
});