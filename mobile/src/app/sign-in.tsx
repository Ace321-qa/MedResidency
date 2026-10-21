import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import {
  BookUser,
  Building2,
  Link2,
  Pencil,
  Plus,
  Stethoscope,
  Trash2,
  Wifi,
  WifiOff,
} from 'lucide-react-native';

import {
  Button,
  Card,
  ChoiceGroup,
  ErrorState,
  IconButton,
  ListRow,
  ProgramConnectionsSheet,
  ProgramEditorSheet,
  Screen,
  SearchInput,
  Sheet,
  SkeletonList,
  Text,
} from '../components';
import { useApiResource, useSession } from '../hooks';
import { fetchHealth } from '../services/health';
import { fetchResidentList } from '../services/residents';
import { deleteProgram, fetchPrograms } from '../services/programs';
import { useInAppNotifications } from '../services/inAppNotifications';
import { colors, dimensions, radius, spacing } from '../theme';
import { filterResidents, residentFullName, residentSubtitle } from '../utils/residents';
import { EMPTY_ARRAY } from '../utils/empty';
import type { Program, ResidentListItem } from '../types/api';

/**
 * Sign-in.
 *
 * The backend has no authentication, no users table and no role concept, so this
 * screen cannot verify an identity — and pretending otherwise would be worse
 * than saying so. It does three real things instead:
 *
 *  1. It loads the actual roster from `GET /residents`, so the person signing in
 *     is a real row in the database, not a hardcoded constant.
 *  2. It loads programmes from `GET /programs` — the registry, not a list
 *     derived from the residents who happen to be on the first page of the
 *     roster. A programme with no enrolled residents used to vanish from this
 *     picker entirely; now it appears, along with its active resident count, and
 *     can be created, renamed or hidden from here.
 *  3. It records the choice in the session, which decides the tab bar and scopes
 *     every query.
 *
 * When authentication is added to the backend, only the sign-in handlers change;
 * the rest of the app reads from `useSession()` and does not care where the
 * session came from.
 */

type RoleChoice = 'resident' | 'coordinator';

export default function SignInScreen() {
  const router = useRouter();
  const { signInAsResident, signInAsCoordinator } = useSession();
  const { notify } = useInAppNotifications();

  const [role, setRole] = useState<RoleChoice>('resident');
  const [query, setQuery] = useState('');

  const roster = useApiResource(() => fetchResidentList({ limit: 50 }));
  const programs = useApiResource(() => fetchPrograms());
  const health = useApiResource(fetchHealth);

  // Programme editor / delete state. `editorSeq` re-keys the editor for every
  // open so each session starts from a fresh seed (see `ProgramEditorSheet`).
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorProgram, setEditorProgram] = useState<Program | null>(null);
  const [editorSeq, setEditorSeq] = useState(0);
  const [pendingDelete, setPendingDelete] = useState<Program | null>(null);
  /** The programme whose "Connect to other programme" sheet is open. */
  const [connectionsProgram, setConnectionsProgram] = useState<Program | null>(null);
  const [deleting, setDeleting] = useState(false);

  const residents = roster.data ?? (EMPTY_ARRAY as ResidentListItem[]);
  const programList = programs.data ?? (EMPTY_ARRAY as Program[]);
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

  const handleProgram = (program: Program) => {
    if (program.is_active !== 1) return;
    signInAsCoordinator(program.id, program.program_name, program.program_code);
    router.replace('/program');
  };

  function openAdd() {
    setEditorProgram(null);
    setEditorSeq((seq) => seq + 1);
    setEditorOpen(true);
  }

  function openEdit(program: Program) {
    setEditorProgram(program);
    setEditorSeq((seq) => seq + 1);
    setEditorOpen(true);
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      const result = await deleteProgram(pendingDelete.id);
      notify({
        title: result.deleted ? 'Programme deleted' : 'Programme deactivated',
        message: result.deleted
          ? `${pendingDelete.program_name} was removed.`
          : `${pendingDelete.program_name} still has ${result.resident_count} enrolled resident${result.resident_count === 1 ? '' : 's'}, so it was hidden instead.`,
        tone: 'success',
      });
      setPendingDelete(null);
      programs.refresh();
    } catch (error) {
      notify({
        title: 'Could not delete programme',
        message: error instanceof Error ? error.message : 'Please try again.',
        tone: 'danger',
      });
    } finally {
      setDeleting(false);
    }
  }

  const apiReachable = health.status === 'ready' && health.data?.status === 'success';

  return (
    <>
      <Screen bottomGutter={spacing.xl}>
        <View style={styles.brand}>
          <View style={styles.mark}>
            <Stethoscope color={colors.onPrimary} size={26} strokeWidth={2} />
          </View>
          <Text variant="h1">MedResidency</Text>
          <Text variant="body" tone="secondary">
            Attendance, rotations and letters for residency programmes
          </Text>
        </View>

        <View style={styles.roleGroup}>
          <ChoiceGroup
            label="I am signing in as"
            columns={2}
            value={role}
            onChange={(value) => setRole(value as RoleChoice)}
            options={[
              {
                value: 'resident',
                label: 'Resident',
                description: 'My attendance, rotations and letters',
                icon: BookUser,
              },
              {
                value: 'coordinator',
                label: 'Coordinator',
                description: 'Roster, rotations and letters management',
                icon: Building2,
              },
            ]}
          />
        </View>

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
                {programs.status === 'ready'
                  ? `${programList.length} registered programme${programList.length === 1 ? '' : 's'}`
                  : 'Loading programmes…'}
              </Text>
            </View>

            <View style={styles.addProgram}>
              <Button
                label="Add programme"
                variant="outline"
                icon={Plus}
                fullWidth={false}
                onPress={openAdd}
                accessibilityHint="Register a new residency programme"
              />
            </View>

            {programs.status === 'loading' ? <SkeletonList rows={3} /> : null}

            {programs.error ? (
              <View style={styles.stateBlock}>
                <ErrorState
                  title="Could not load programmes"
                  message={programs.error.message}
                  onRetry={programs.refresh}
                />
              </View>
            ) : null}

            {programList.map((program, index) => {
              const active = program.is_active === 1;
              const subtitle = program.coordinator_email
                ? `${program.program_code} · ${program.coordinator_email}`
                : program.program_code;
              return (
                <ListRow
                  key={program.id}
                  title={program.program_name}
                  subtitle={subtitle}
                  meta={
                    `${program.resident_count} resident${program.resident_count === 1 ? '' : 's'}` +
                    (active ? '' : ' · Hidden from sign-in')
                  }
                  muted={!active}
                  disabled={!active}
                  onPress={active ? () => handleProgram(program) : undefined}
                  last={index === programList.length - 1}
                  accessibilityHint={
                    active
                      ? `Open the ${program.program_name} coordinator area`
                      : 'Hidden programmes cannot be opened; edit to make it active again'
                  }
                  trailing={
                    <View style={styles.programActions}>
                      <Button
                        label="Open"
                        variant="ghost"
                        fullWidth={false}
                        disabled={!active}
                        onPress={() => handleProgram(program)}
                        accessibilityLabel={`Open ${program.program_name}`}
                      />
                      <IconButton
                        icon={Link2}
                        tone="primary"
                        accessibilityLabel={`Connect ${program.program_name} to another programme`}
                        onPress={() => setConnectionsProgram(program)}
                      />
                      <IconButton
                        icon={Pencil}
                        tone="primary"
                        accessibilityLabel={`Edit ${program.program_name}`}
                        onPress={() => openEdit(program)}
                      />
                      <IconButton
                        icon={Trash2}
                        tone="danger"
                        accessibilityLabel={`Delete ${program.program_name}`}
                        onPress={() => setPendingDelete(program)}
                      />
                    </View>
                  }
                />
              );
            })}

            {programs.status === 'ready' && programList.length === 0 ? (
              <View style={styles.stateBlock}>
                <Text variant="body" tone="muted">
                  No programmes are registered yet. Add one to get started.
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

      <ProgramEditorSheet
        key={editorSeq}
        visible={editorOpen}
        program={editorProgram}
        onClose={() => setEditorOpen(false)}
        onSaved={() => programs.refresh()}
      />

      {/* Keyed on the programme so opening the sheet from a different card
          remounts it with that programme's connections rather than showing the
          previous card's list. */}
      <ProgramConnectionsSheet
        key={`connections-${connectionsProgram?.id ?? 'none'}`}
        visible={connectionsProgram !== null}
        program={connectionsProgram}
        onClose={() => setConnectionsProgram(null)}
        onChanged={() => programs.refresh()}
      />

      <Sheet
        visible={pendingDelete !== null}
        onClose={() => (deleting ? undefined : setPendingDelete(null))}
        title="Delete this programme?"
        subtitle={pendingDelete?.program_name}
        footer={
          <View style={styles.deleteActions}>
            <Button
              label="Delete programme"
              variant="danger"
              icon={Trash2}
              loading={deleting}
              onPress={() => void confirmDelete()}
            />
            <Button
              label="Keep it"
              variant="ghost"
              disabled={deleting}
              onPress={() => setPendingDelete(null)}
            />
          </View>
        }
      >
        <Text variant="bodySmall" tone="secondary">
          {pendingDelete && pendingDelete.resident_count > 0
            ? `Are you sure you want to delete ${pendingDelete.program_name}? It has ${pendingDelete.resident_count} enrolled resident${pendingDelete.resident_count === 1 ? '' : 's'}, so it will be hidden from sign-in instead of removed — the roster, rotations and letters stay intact.`
            : `Are you sure you want to delete ${pendingDelete?.program_name ?? 'this programme'}? This cannot be undone.`}
        </Text>
      </Sheet>
    </>
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
  roleGroup: {
    marginBottom: spacing.md,
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
  addProgram: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
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
  programActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xxs,
  },
  deleteActions: {
    gap: spacing.sm,
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
