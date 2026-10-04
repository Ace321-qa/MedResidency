import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { CircleCheck, CircleX, Inbox } from 'lucide-react-native';

import {
  AppHeader,
  Banner,
  Button,
  Card,
  ChoiceGroup,
  EmptyState,
  ErrorState,
  ListRow,
  Screen,
  SearchInput,
  SectionHeader,
  Sheet,
  SkeletonList,
  StatTile,
  StatusBadge,
  TextField,
} from '../../../components';
import { useApiResource, useSession } from '../../../hooks';
import { fetchLeaves, updateLeaveStatus } from '../../../services/leaves';
import { fetchResidentList } from '../../../services/residents';
import { colors, spacing } from '../../../theme';
import type { LeaveRequest, LeaveStatus } from '../../../types/api';
import { formatDateRange, formatDateTime, humanizeToken } from '../../../utils/format';

/**
 * Approvals — the coordinator's leave review queue.
 *
 * **There is no `GET /api/v1/leaves` endpoint.** The API only serves leave
 * requests one resident at a time (`GET /leaves/resident/:id`), so this queue is
 * assembled by fetching each resident's requests in parallel and merging the
 * results. `Promise.allSettled` rather than `Promise.all` on purpose: one
 * resident's request failing must not blank the whole queue, and the count of
 * residents whose data is missing is shown in the banner below so the coordinator
 * knows the queue is incomplete rather than guessing.
 *
 * The correct fix is a `GET /leaves?program_id=&status=` endpoint in the backend.
 * When that exists, `useApiResource` below collapses to a single call.
 *
 * Approving is `PATCH /leaves/:id/status`. The API requires a
 * `rejection_reason` when rejecting, so the reject action opens a sheet that
 * demands one — it is not an optional field.
 */

type Filter = 'PENDING' | 'ALL';

const OPEN_STATUSES: LeaveStatus[] = ['PENDING', 'APPROVED_BY_CHIEF'];

export default function ApprovalsScreen() {
  const { session } = useSession();
  const programId = session?.programId ?? 0;

  const [filter, setFilter] = useState<Filter>('PENDING');
  const [query, setQuery] = useState('');
  const [busyId, setBusyId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<LeaveRequest | null>(null);
  const [rejectionReason, setRejectionReason] = useState('');

  const queue = useApiResource(async () => {
    const roster = await fetchResidentList({ programId, limit: 100 });

    const settled = await Promise.allSettled(
      roster.map((resident) => fetchLeaves(resident.resident_id)),
    );

    const merged: LeaveRequest[] = [];
    /**
     * Leave rows carry `resident_name` but no `resident_id`, and the server's
     * name does not match ours: it concatenates `first_name` and `last_name`
     * only, so our "Omar K. Al-Nouri" arrives here as "Omar Al-Nouri". Joining
     * on a name would miss and the row would open nothing. The id is recorded
     * per row instead, while we still know which resident's response it came
     * from. `request_id` is the primary key of the leave request table, so it
     * keys the map uniquely.
     */
    const residentIdByRequest: Record<number, number> = {};
    let failed = 0;

    settled.forEach((outcome, index) => {
      if (outcome.status === 'fulfilled') {
        outcome.value.forEach((request) => {
          residentIdByRequest[request.request_id] = roster[index].resident_id;
        });
        merged.push(...outcome.value);
      } else {
        failed += 1;
      }
    });

    merged.sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));

    return {
      requests: merged,
      failedResidents: failed,
      rosterSize: roster.length,
      residentIdByRequest,
    };
  }, [programId]);

  const requests = queue.data?.requests ?? [];
  const openCount = requests.filter((request) => OPEN_STATUSES.includes(request.status)).length;

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return requests
      .filter((request) => (filter === 'ALL' ? true : OPEN_STATUSES.includes(request.status)))
      .filter((request) =>
        needle ? `${request.resident_name} ${request.leave_type}`.toLowerCase().includes(needle) : true,
      );
  }, [requests, filter, query]);

  async function decide(request: LeaveRequest, status: LeaveStatus, rejection_reason?: string) {
    setBusyId(request.request_id);
    setActionError(null);

    try {
      await updateLeaveStatus(request.request_id, {
        status,
        ...(rejection_reason ? { rejection_reason } : {}),
      });

      // Patch the queue in place rather than refetching every resident again.
      queue.setData((current) =>
        current
          ? {
              ...current,
              requests: current.requests.map((item) =>
                item.request_id === request.request_id
                  ? { ...item, status, rejection_reason: rejection_reason ?? item.rejection_reason }
                  : item,
              ),
            }
          : current,
      );
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not update this request.');
    } finally {
      setBusyId(null);
    }
  }

  function submitRejection() {
    if (!rejecting) return;
    const reason = rejectionReason.trim();
    if (reason.length === 0) return;

    void decide(rejecting, 'REJECTED', reason);
    setRejecting(null);
    setRejectionReason('');
  }

  const busy = busyId !== null;

  return (
    <Screen onRefresh={queue.refresh} refreshing={queue.isRefreshing} bottomGutter={spacing.xxl}>
      <AppHeader title="Approvals" subtitle="Leave requests awaiting a decision" />

      {queue.isLoading ? <SkeletonList rows={5} /> : null}

      {queue.error ? (
        <ErrorState
          title="Could not build the queue"
          message={queue.error.message}
          onRetry={queue.refresh}
        />
      ) : null}

      {queue.data && queue.data.failedResidents > 0 ? (
        <Banner
          tone="warning"
          title="Queue is incomplete"
          message={`Leave could not be read for ${queue.data.failedResidents} of ${queue.data.rosterSize} residents, so some requests are missing. Pull to refresh to try again.`}
        />
      ) : null}

      {actionError ? <Banner tone="danger" title="Decision failed" message={actionError} /> : null}

      {queue.status === 'ready' ? (
        <>
          <View style={styles.statRow}>
            <StatTile value={String(openCount)} label="Awaiting decision" tone={openCount > 0 ? 'warning' : 'success'} />
            <StatTile value={String(requests.length)} label="Total on record" />
            <StatTile value={String(queue.data?.rosterSize ?? 0)} label="Residents checked" />
          </View>

          <ChoiceGroup
            label="Filter requests"
            columns={2}
            value={filter}
            onChange={(value) => setFilter(value as Filter)}
            options={[
              { value: 'PENDING', label: `Awaiting (${openCount})` },
              { value: 'ALL', label: `All (${requests.length})` },
            ]}
          />

          <View style={styles.search}>
            <SearchInput
              accessibilityLabel="Search leave requests"
              value={query}
              onChangeText={setQuery}
              placeholder="Resident name or leave type"
            />
          </View>

          <SectionHeader title={`${visible.length} request${visible.length === 1 ? '' : 's'}`} />

          {visible.length === 0 ? (
            <Card>
              <EmptyState
                icon={Inbox}
                title="Nothing to review"
                message={
                  query
                    ? 'No request matches that search.'
                    : 'No leave request in this programme is awaiting a decision.'
                }
              />
            </Card>
          ) : (
            <Card padded={false}>
              {visible.map((request, index) => (
                <View key={request.request_id} style={styles.requestWrap}>
                  <ListRow
                    title={request.resident_name}
                    subtitle={`${humanizeToken(request.leave_type)} · ${formatDateRange(request.start_date, request.end_date)} · ${request.total_days} day${request.total_days === 1 ? '' : 's'}`}
                    meta={`${request.reason ?? 'No reason given'} · requested ${formatDateTime(request.created_at)}`}
                    trailing={
                      <StatusBadge
                        label={humanizeToken(request.status)}
                        tone={
                          request.status === 'APPROVED'
                            ? 'success'
                            : request.status === 'REJECTED'
                              ? 'danger'
                              : request.status === 'CANCELLED'
                                ? 'neutral'
                                : 'warning'
                        }
                      />
                    }
                    onPress={() => {
                      const id = queue.data?.residentIdByRequest[request.request_id];
                      if (id) router.push(`/program/resident/${id}`);
                    }}
                    muted={request.status === 'CANCELLED'}
                  />

                  {OPEN_STATUSES.includes(request.status) ? (
                    <View style={styles.actions}>
                      <Button
                        label="Approve"
                        variant="outline"
                        icon={CircleCheck}
                        fullWidth={false}
                        disabled={busy}
                        onPress={() => void decide(request, 'APPROVED')}
                      />
                      <Button
                        label="Reject"
                        variant="danger"
                        icon={CircleX}
                        fullWidth={false}
                        disabled={busy}
                        onPress={() => {
                          setRejecting(request);
                          setRejectionReason('');
                        }}
                      />
                    </View>
                  ) : null}
                  {index === visible.length - 1 ? null : <View style={styles.divider} />}
                </View>
              ))}
            </Card>
          )}
        </>
      ) : null}

      <Sheet
        visible={rejecting !== null}
        onClose={() => setRejecting(null)}
        title="Reject this request"
        subtitle={
          rejecting
            ? `${rejecting.resident_name} · ${humanizeToken(rejecting.leave_type)} · ${formatDateRange(rejecting.start_date, rejecting.end_date)}`
            : undefined
        }
        footer={
          <>
            <Button
              label="Confirm rejection"
              variant="danger"
              disabled={rejectionReason.trim().length === 0 || busy}
              onPress={submitRejection}
            />
            <Button label="Cancel" variant="ghost" onPress={() => setRejecting(null)} />
          </>
        }
      >
        <TextField
          label="Reason for rejection"
          value={rejectionReason}
          onChangeText={setRejectionReason}
          multiline
          placeholder="e.g. overlapping with the on-call roster"
          required
          hint="The API requires a reason when rejecting, and the resident sees this text on their request."
        />
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  statRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  search: {
    marginVertical: spacing.md,
  },
  requestWrap: {
    position: 'relative',
  },
  actions: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
  },
  divider: {
    height: 1,
    backgroundColor: colors.border,
    marginHorizontal: spacing.lg,
  },
});