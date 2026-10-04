import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { BarChart3 } from 'lucide-react-native';

import {
  AppHeader,
  Banner,
  Card,
  EmptyState,
  ErrorState,
  ListRow,
  ProgressBar,
  Screen,
  SectionHeader,
  SkeletonList,
  StatTile,
  StatusBadge,
  Text,
} from '../../../components';
import { useApiResource, useSession } from '../../../hooks';
import { fetchMockProgrammeReport } from '../../../services/mock';
import { spacing } from '../../../theme';
import { formatDateTime, formatWeeks } from '../../../utils/format';

/**
 * Reports — **entirely sample data**.
 *
 * These are aggregates the database could produce but the API does not expose:
 * cohort mix, block fill rates and compliance counts. The banner is not
 * decoration; it stops a coordinator mistaking placeholder figures for real
 * programme reporting, which on a clinical app would be a genuine harm.
 *
 * Delete `src/services/mock/programReports.ts` when `GET /reports` exists.
 */

export default function ReportsScreen() {
  const { session } = useSession();
  const report = useApiResource(fetchMockProgrammeReport);

  const cohortTotal = useMemo(
    () => report.data?.cohort.reduce((sum, item) => sum + item.count, 0) ?? 0,
    [report.data],
  );

  const blockFill = report.data?.blockFill ?? [];

  return (
    <Screen onRefresh={report.refresh} refreshing={report.isRefreshing} bottomGutter={spacing.xxl}>
      <AppHeader title="Reports" subtitle={session?.programLabel ?? undefined} />

      <Banner
        tone="warning"
        title="Sample data"
        message="The API exposes no reporting endpoint. Every figure below is illustrative and must not be used for real programme decisions."
      />

      {report.isLoading ? <SkeletonList rows={5} /> : null}

      {report.error ? (
        <ErrorState title="Could not load reports" message={report.error.message} onRetry={report.refresh} />
      ) : null}

      {report.data ? (
        <>
          <View style={styles.statRow}>
            <StatTile value={String(cohortTotal)} label="Residents in cohort" icon={BarChart3} />
            <StatTile
              value={String(report.data.compliance.shiftsLogged)}
              label="Shifts logged"
              tone="success"
            />
            <StatTile
              value={String(report.data.compliance.flaggedBreaches)}
              label="Flagged breaches"
              tone={report.data.compliance.flaggedBreaches > 0 ? 'danger' : 'success'}
            />
          </View>

          <SectionHeader title="Cohort by PGY level" />
          <Card>
            {report.data.cohort.map((item) => (
              <View key={item.label} style={styles.barRow}>
                <View style={styles.barHead}>
                  <StatusBadge label={item.label} tone="info" />
                  <Text variant="bodySmall">{item.count}</Text>
                </View>
                <ProgressBar
                  value={Math.round((item.count / Math.max(cohortTotal, 1)) * 100)}
                  label={`${item.label}: ${item.count} residents`}
                />
              </View>
            ))}
          </Card>

          <SectionHeader title="Block fill" />
          {blockFill.length === 0 ? (
            <Card>
              <EmptyState icon={BarChart3} title="No blocks" message="No block data to report on." />
            </Card>
          ) : (
            <Card padded={false}>
              {blockFill.map((block, index) => (
                <ListRow
                  key={block.blockName}
                  title={block.blockName}
                  subtitle={`${block.assignedResidents} resident${block.assignedResidents === 1 ? '' : 's'} assigned`}
                  meta={`${formatWeeks(block.totalWeeks)} of scheduled time`}
                  trailing={
                    <StatusBadge
                      label={block.assignedResidents === 0 ? 'Unfilled' : 'Covered'}
                      tone={block.assignedResidents === 0 ? 'warning' : 'success'}
                    />
                  }
                  last={index === blockFill.length - 1}
                />
              ))}
            </Card>
          )}

          <SectionHeader title="Compliance" />
          <Card>
            <StatTile
              value={String(report.data.compliance.pendingLeaveRequests)}
              label="Leave requests pending a decision"
              style={styles.fullTile}
            />
            <Text variant="caption" tone="muted" style={styles.generated}>
              Generated {formatDateTime(report.data.generatedAt)} — sample data, not a live figure.
            </Text>
          </Card>

          <SectionHeader title="What would make this real" />
          <Card>
            <Text variant="bodySmall" tone="secondary">
              Each figure above maps to a query the backend could answer: a cohort count grouped by year in
              programme, assigned residents per block, and the count of rows in `duty_hour_violations` and
              `resident_leave_requests` with a pending status. Adding a `GET /api/v1/reports?program_id=`
              endpoint would let this screen show real numbers without changing the UI.
            </Text>
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
    marginBottom: spacing.md,
  },
  barRow: {
    marginBottom: spacing.md,
    gap: spacing.xxs,
  },
  barHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  fullTile: {
    marginBottom: spacing.sm,
  },
  generated: {
    marginTop: spacing.xs,
  },
});