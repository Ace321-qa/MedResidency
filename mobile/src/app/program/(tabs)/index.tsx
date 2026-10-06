import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Settings, TriangleAlert, UserPlus, Users } from 'lucide-react-native';

import {
  AppHeader,
  Button,
  Card,
  EmptyState,
  ErrorState,
  ListRow,
  Screen,
  SectionHeader,
  SkeletonList,
  StatTile,
  StatusBadge,
} from '../../../components';
import { useApiResource, useSession } from '../../../hooks';
import { fetchResidentList } from '../../../services/residents';
import { fetchRotationBlocks } from '../../../services/rotations';
import { spacing } from '../../../theme';
import { formatDateRange, humanizeToken, todayCalendarDate } from '../../../utils/format';
import { residentFullName, residentSubtitle } from '../../../utils/residents';
import { EMPTY_ARRAY } from '../../../utils/empty';
import type { ResidentListItem, RotationBlock } from '../../../types/api';

/**
 * Programme overview — the coordinator's home screen.
 *
 * Scoped to the programme chosen at sign-in. Three questions: how many residents
 * do we have, what is coming up, and what needs attention. Leave approvals get
 * their own tab, so this screen reports the queue depth rather than listing it.
 */

export default function ProgramOverviewScreen() {
  const router = useRouter();
  const { session } = useSession();
  const programId = session?.programId ?? 0;

  const residents = useApiResource(() => fetchResidentList({ programId, limit: 100 }), [programId]);
  const blocks = useApiResource(() => fetchRotationBlocks(programId), [programId]);

  const roster = residents.data ?? (EMPTY_ARRAY as ResidentListItem[]);
  const blockList = blocks.data ?? (EMPTY_ARRAY as RotationBlock[]);

  const activeResidents = useMemo(
    () => roster.filter((resident) => resident.resident_status === 'ACTIVE_FULL_TIME').length,
    [roster],
  );

  const upcoming = useMemo(
    () =>
      [...blockList]
        .sort((a, b) => a.start_date.localeCompare(b.start_date))
        .filter((block) => block.end_date >= todayCalendarDate())
        .slice(0, 2),
    [blockList],
  );

  return (
    <Screen
      onRefresh={() => {
        residents.refresh();
        blocks.refresh();
      }}
      refreshing={residents.isRefreshing || blocks.isRefreshing}
      bottomGutter={spacing.xxl}
    >
      <AppHeader
        title="Programme"
        subtitle={session?.programLabel ?? undefined}
        action={
          <Button
            label="Add"
            variant="ghost"
            fullWidth={false}
            icon={UserPlus}
            onPress={() => router.push('/program/onboarding')}
            accessibilityLabel="Register a new resident"
          />
        }
      />

      {residents.isLoading || blocks.isLoading ? <SkeletonList rows={4} /> : null}

      {residents.error ? (
        <ErrorState
          title="Could not load the programme"
          message={residents.error.message}
          onRetry={residents.refresh}
        />
      ) : null}

      {residents.status === 'ready' ? (
        <>
          <View style={styles.statRow}>
            <StatTile value={String(roster.length)} label="Residents enrolled" icon={Users} />
            <StatTile value={String(activeResidents)} label="Active full time" tone="success" />
            <StatTile value={String(blockList.length)} label="Rotation blocks" />
          </View>

          <SectionHeader title="Next blocks" />
          {upcoming.length === 0 ? (
            <Card>
              <EmptyState
                icon={TriangleAlert}
                title="No upcoming blocks"
                message="Every block on record has already ended. New blocks are created by the academic office, not by this app."
              />
            </Card>
          ) : (
            <Card padded={false}>
              {upcoming.map((block, index) => (
                <ListRow
                  key={block.block_id}
                  title={`${block.block_name} · ${block.academic_year}`}
                  subtitle={
                    block.week_start_day
                      ? `Week starting ${humanizeToken(block.week_start_day)}`
                      : 'No first day of week recorded'
                  }
                  meta={formatDateRange(block.start_date, block.end_date)}
                  last={index === upcoming.length - 1}
                  onPress={() => router.push('/program/rotations')}
                />
              ))}
            </Card>
          )}

          <SectionHeader title="Resident status" />
          {roster.length === 0 ? (
            <Card>
              <EmptyState
                icon={Users}
                title="No residents enrolled"
                message="No resident on the system is enrolled in this programme. Register one to get started."
                actionLabel="Register a resident"
                onActionPress={() => router.push('/program/onboarding')}
              />
            </Card>
          ) : (
            <Card padded={false}>
              {roster.slice(0, 6).map((resident, index) => (
                <ListRow
                  key={resident.resident_id}
                  title={residentFullName(resident)}
                  subtitle={residentSubtitle(resident)}
                  meta={humanizeToken(resident.resident_status)}
                  trailing={
                    <StatusBadge
                      label={resident.resident_status === 'ACTIVE_FULL_TIME' ? 'Active' : 'Other'}
                      tone={resident.resident_status === 'ACTIVE_FULL_TIME' ? 'success' : 'neutral'}
                    />
                  }
                  onPress={() => router.push(`/program/resident/${resident.resident_id}`)}
                  last={index === Math.min(roster.length, 6) - 1}
                />
              ))}
            </Card>
          )}

          {roster.length > 6 ? (
            <Button
              label={`See all ${roster.length} residents`}
              variant="outline"
              onPress={() => router.push('/program/roster')}
              style={styles.cta}
            />
          ) : null}

          <SectionHeader title="Settings" />
          <Card padded={false}>
            <ListRow
              title="Connection and session"
              subtitle="API address, database check, sign out"
              leadingIcon={Settings}
              onPress={() => router.push('/program/settings')}
              last
            />
          </Card>
        </>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  statRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  cta: {
    marginTop: spacing.md,
  },
});