import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Alert, Modal, ScrollView, TouchableOpacity } from 'react-native';
import { CalendarPlus, Grid3x3, FileText } from 'lucide-react-native';

import {
  AppHeader,
  Card,
  EmptyState,
  ErrorState,
  ListRow,
  Screen,
  SectionHeader,
  SkeletonList,
  StatusBadge,
  Text,
  Button,
  SearchInput,
} from '../../../components';
import { useApiResource, useSession } from '../../../hooks';
import { fetchResidentSchedule } from '../../../services/rotations';
import { createRotationRequest } from '../../../services/rotationRequests';
import { spacing } from '../../../theme';
import { formatDateRange, formatWeeks } from '../../../utils/format';
import { groupScheduleByBlock, type RotationPhase } from '../../../utils/insights';

/**
 * Rotations — the resident's schedule, grouped by academic block.
 *
 * Grouping by block rather than showing one flat list matches how a resident
 * actually reads a schedule: "what am I doing this block?", then the detail
 * underneath. Each block is labelled with whether it is active, upcoming or
 * finished, so a historical schedule is never mistaken for a current one.
 */

const PHASE_LABEL: Record<RotationPhase, string> = {
  ACTIVE: 'In progress',
  UPCOMING: 'Upcoming',
  COMPLETED: 'Finished',
};

const PHASE_TONE: Record<RotationPhase, 'info' | 'success' | 'neutral'> = {
  ACTIVE: 'info',
  UPCOMING: 'success',
  COMPLETED: 'neutral',
};

export default function RotationsScreen() {
  const { session } = useSession();
  const residentId = session?.residentId ?? 0;

  const schedule = useApiResource(() => fetchResidentSchedule(residentId), [residentId]);
  const blocks = useMemo(() => groupScheduleByBlock(schedule.data ?? []), [schedule.data]);
  const [showGrid, setShowGrid] = useState(false);
  const [showHospitalReq, setShowHospitalReq] = useState(false);
  const [showClinicReq, setShowClinicReq] = useState(false);

  return (
    <Screen onRefresh={schedule.refresh} refreshing={schedule.isRefreshing} bottomGutter={spacing.xxl}>
      <AppHeader title="Rotations" subtitle="Your schedule by academic block" />

      <View style={{ flexDirection: 'row', gap: 8, marginBottom: spacing.md }}>
        <Button label="Master Grid" variant="outline" icon={Grid3x3} onPress={() => setShowGrid(!showGrid)} style={{ flex: 1 }} />
        <Button label="+ Request Hospital" variant="outline" icon={FileText} onPress={() => setShowHospitalReq(true)} style={{ flex: 1 }} />
        <Button label="+ Request Clinic" variant="outline" icon={FileText} onPress={() => setShowClinicReq(true)} style={{ flex: 1 }} />
      </View>

      {schedule.isLoading ? <SkeletonList rows={5} /> : null}

      {schedule.error ? (
        <ErrorState
          title="Could not load your schedule"
          message={schedule.error.message}
          onRetry={schedule.refresh}
        />
      ) : null}

      {schedule.status === 'ready' && blocks.length === 0 ? (
        <Card>
          <EmptyState
            icon={CalendarPlus}
            title="No rotations assigned"
            message="You have no rotation assignments on record. Your programme coordinator publishes these, so there is nothing to show until they do."
          />
        </Card>
      ) : null}

      {blocks.map((block) => (
        <View key={block.blockName} style={styles.block}>
          <SectionHeader title={block.blockName} trailing={block.dateRange} />
          <Card padded={false}>
            {block.assignments.map((assignment, index) => (
              <ListRow
                key={assignment.assignment_id}
                title={assignment.rotation_name}
                subtitle={assignment.department_name ?? 'Department not assigned'}
                meta={`${formatDateRange(assignment.start_date, assignment.end_date)} · ${formatWeeks(assignment.assigned_weeks)}`}
                trailing={
                  index === 0 ? <StatusBadge label={PHASE_LABEL[block.phase]} tone={PHASE_TONE[block.phase]} /> : null
                }
                last={index === block.assignments.length - 1}
                muted={block.phase === 'COMPLETED'}
              />
            ))}
          </Card>

          {block.assignments.some((item) => item.notes) ? (
            <Text variant="caption" tone="muted" style={styles.note}>
              {block.assignments.find((item) => item.notes)?.notes}
            </Text>
          ) : null}
        </View>
      ))}
    </Screen>
  );
}

const styles = StyleSheet.create({
  block: {
    marginBottom: spacing.lg,
  },
  note: {
    marginTop: spacing.xs,
    paddingHorizontal: spacing.xs,
  },
});