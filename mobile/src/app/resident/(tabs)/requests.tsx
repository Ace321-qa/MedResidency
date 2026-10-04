import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { CalendarPlus } from 'lucide-react-native';

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
import { fetchLeaves } from '../../../services/leaves';
import { spacing } from '../../../theme';
import { formatDateRange, humanizeToken } from '../../../utils/format';
import { summarizeLeaves } from '../../../utils/insights';

/**
 * Requests — the resident's leave requests.
 *
 * Leave follows a three-step approval chain in the database
 * (PENDING → APPROVED_BY_CHIEF → APPROVED), so the badge distinguishes "waiting
 * on you", "waiting on the chief" and "decided" rather than collapsing everything
 * into approved/declined. A rejected request keeps its rejection reason visible,
 * because the resident needs to know whether to resubmit.
 */

type LeaveTone = 'success' | 'warning' | 'danger' | 'neutral';

const STATUS_TONE: Record<string, LeaveTone> = {
  PENDING: 'warning',
  APPROVED_BY_CHIEF: 'warning',
  APPROVED: 'success',
  REJECTED: 'danger',
  CANCELLED: 'neutral',
};

const STATUS_LABEL: Record<string, string> = {
  PENDING: 'Awaiting chief',
  APPROVED_BY_CHIEF: 'Chief approved',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  CANCELLED: 'Cancelled',
};

export default function RequestsScreen() {
  const router = useRouter();
  const { session } = useSession();
  const residentId = session?.residentId ?? 0;

  const leaves = useApiResource(() => fetchLeaves(residentId), [residentId]);
  const requests = leaves.data ?? [];
  const summary = useMemo(() => summarizeLeaves(requests), [requests]);

  return (
    <Screen onRefresh={leaves.refresh} refreshing={leaves.isRefreshing} bottomGutter={spacing.xxl}>
      <AppHeader title="Requests" subtitle="Leave you have requested" />

      {leaves.isLoading ? <SkeletonList rows={4} /> : null}

      {leaves.error ? (
        <ErrorState
          title="Could not load your requests"
          message={leaves.error.message}
          onRetry={leaves.refresh}
        />
      ) : null}

      {leaves.status === 'ready' ? (
        <>
          <View style={styles.statRow}>
            <StatTile value={String(summary.pendingCount)} label="Awaiting decision" tone="warning" />
            <StatTile value={String(summary.approvedCount)} label="Approved" tone="success" />
            <StatTile value={String(summary.approvedDays)} label="Days approved" />
          </View>

          <SectionHeader title={`History (${requests.length})`} />

          {requests.length === 0 ? (
            <Card>
              <EmptyState
                icon={CalendarPlus}
                title="No leave requested"
                message="When you request annual, sick, study or exam leave it will appear here with its current decision."
              />
            </Card>
          ) : (
            <Card padded={false}>
              {requests.map((request, index) => (
                <ListRow
                  key={request.request_id}
                  title={humanizeToken(request.leave_type)}
                  subtitle={`${formatDateRange(request.start_date, request.end_date)} · ${request.total_days} day${request.total_days === 1 ? '' : 's'}`}
                  meta={request.rejection_reason ? `Reason: ${request.rejection_reason}` : request.reason ?? undefined}
                  trailing={
                    <StatusBadge
                      label={STATUS_LABEL[request.status] ?? humanizeToken(request.status)}
                      tone={STATUS_TONE[request.status] ?? 'neutral'}
                    />
                  }
                  last={index === requests.length - 1}
                  muted={request.status === 'CANCELLED'}
                />
              ))}
            </Card>
          )}

          <Button
            label="Request leave"
            icon={CalendarPlus}
            onPress={() => router.push('/resident/request-leave')}
            style={styles.cta}
          />
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
    marginTop: spacing.lg,
  },
});