import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { CalendarPlus, FilePlus2, Grid3x3, LayoutList, Stethoscope } from 'lucide-react-native';

import {
  AppHeader,
  Banner,
  Button,
  Card,
  DateField,
  EmptyState,
  ErrorState,
  ListRow,
  MatrixTable,
  Screen,
  SectionHeader,
  Sheet,
  SkeletonList,
  StatusBadge,
  Text,
  TextField,
} from '../../../components';
import { useApiResource, useSession } from '../../../hooks';
import { fetchResidentLongitudinalAssignments } from '../../../services/longitudinal';
import { fetchResidentSchedule } from '../../../services/rotations';
import { createRotationRequest } from '../../../services/rotationRequests';
import { useInAppNotifications } from '../../../services/inAppNotifications';
import { spacing } from '../../../theme';
import { formatDateRange, formatShortDate, formatWeeks } from '../../../utils/format';
import { groupScheduleByBlock, type RotationPhase } from '../../../utils/insights';
import type { RotationRequestType } from '../../../types/api';

/**
 * Rotations — the resident's schedule, grouped by academic block.
 *
 * Grouping by block rather than showing one flat list matches how a resident
 * actually reads a schedule: "what am I doing this block?", then the detail
 * underneath. Each block is labelled with whether it is active, upcoming or
 * finished, so a historical schedule is never mistaken for a current one.
 *
 * Two extra views sit behind this screen:
 *
 *  - **Master grid** — the same assignments laid out as blocks across the top,
 *    for reading the year as one shape instead of scrolling it.
 *  - **Clinic overview** — the CCC/longitudinal assignments, which are *not*
 *    rotation assignments and therefore never appear in the block list. A
 *    resident whose only question is "which clinic am I on?" should not have to
 *    infer it from a rota.
 *
 * And two requests, because those are the only things a resident can ask the
 * programme to change from here. Submitting one writes a row in
 * `rotation_requests` and raises an in-app notification; the coordinator's
 * Approvals queue then shows it.
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

const EMPTY_DATE = 'YYYY-MM-DD';

interface RequestForm {
  departmentClinic: string;
  startDate: string;
  endDate: string;
  reason: string;
}

const EMPTY_FORM: RequestForm = { departmentClinic: '', startDate: '', endDate: '', reason: '' };

function looksLikeDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
}

export default function RotationsScreen() {
  const { session } = useSession();
  const { notify } = useInAppNotifications();
  const residentId = session?.residentId ?? 0;
  const programId = session?.programId ?? 0;

  const schedule = useApiResource(() => fetchResidentSchedule(residentId), [residentId]);
  const clinics = useApiResource(() => fetchResidentLongitudinalAssignments(residentId), [residentId]);

  const blocks = useMemo(() => groupScheduleByBlock(schedule.data ?? []), [schedule.data]);
  const [showGrid, setShowGrid] = useState(false);
  const [requestType, setRequestType] = useState<RotationRequestType | null>(null);
  const [form, setForm] = useState<RequestForm>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const residentName = session?.residentName ?? 'Your schedule';

  function openRequest(type: RotationRequestType) {
    setForm(EMPTY_FORM);
    setFormError(null);
    setRequestType(type);
  }

  function closeRequest() {
    if (submitting) return;
    setRequestType(null);
    setFormError(null);
  }

  async function submitRequest() {
    if (!requestType) return;

    const departmentClinic = form.departmentClinic.trim();
    const startDate = form.startDate.trim();
    const endDate = form.endDate.trim();

    if (departmentClinic === '') {
      setFormError(
        requestType === 'HOSPITAL' ? 'Enter the department you want to join.' : 'Enter the clinic you want to join.',
      );
      return;
    }
    if (!looksLikeDate(startDate) || !looksLikeDate(endDate)) {
      setFormError(`Dates must be in ${EMPTY_DATE} format — use the calendar button if you prefer.`);
      return;
    }
    if (endDate < startDate) {
      setFormError('End date cannot be before the start date.');
      return;
    }

    setSubmitting(true);
    setFormError(null);

    try {
      await createRotationRequest({
        resident_id: residentId,
        program_id: programId,
        request_type: requestType,
        department_clinic: departmentClinic,
        start_date: startDate,
        end_date: endDate,
        reason: form.reason.trim() || undefined,
      });

      notify({
        title: 'Request submitted',
        message: `${requestType === 'HOSPITAL' ? 'Hospital' : 'Clinic'} rotation request for ${formatShortDate(
          startDate,
        )} – ${formatShortDate(endDate)} is with your coordinator. Watch the Approvals queue for the decision.`,
        tone: 'success',
      });
      setRequestType(null);
      setForm(EMPTY_FORM);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The request could not be sent.';
      setFormError(message);
      notify({ title: 'Request not sent', message, tone: 'danger' });
    } finally {
      setSubmitting(false);
    }
  }

  /**
   * One row of the master grid: every block as a column, this resident's
   * assignments as the cells.
   */
  const gridColumns = useMemo(
    () =>
      blocks.map((block, index) => ({
        key: `block-${index}`,
        title: block.blockName,
        subtitle: block.dateRange,
      })),
    [blocks],
  );

  const gridRows = useMemo(() => {
    if (blocks.length === 0) return [];

    return [
      {
        key: `resident-${residentId}`,
        frozenContent: (
          <View style={styles.frozenCell}>
            <Text variant="label" numberOfLines={2}>
              {residentName}
            </Text>
            <Text variant="caption" tone="muted" numberOfLines={1}>
              {blocks.length} block{blocks.length === 1 ? '' : 's'}
            </Text>
          </View>
        ),
        accent: 'info' as const,
        cells: Object.fromEntries(
          blocks.map((block, index) => [
            `block-${index}`,
            <View key={`cell-${index}`} style={styles.gridCell}>
              {block.assignments.map((assignment) => (
                <Text key={assignment.assignment_id} variant="caption" numberOfLines={3}>
                  {assignment.rotation_name}
                </Text>
              ))}
            </View>,
          ]),
        ),
        accessibilityLabel: `${residentName}, ${blocks.length} blocks`,
      },
    ];
  }, [blocks, residentId, residentName]);

  const clinicList = clinics.data ?? [];

  return (
    <Screen
      onRefresh={() => {
        schedule.refresh();
        clinics.refresh();
      }}
      refreshing={schedule.isRefreshing || clinics.isRefreshing}
      bottomGutter={spacing.xxl}
    >
      <AppHeader title="Rotations" subtitle="Your schedule by academic block" />

      <View style={styles.toolbar}>
        <Button
          label={showGrid ? 'Show block list' : 'Show master grid'}
          variant="outline"
          icon={showGrid ? LayoutList : Grid3x3}
          onPress={() => setShowGrid((current) => !current)}
          accessibilityHint="Switch between the grouped list and the block-by-block grid"
        />
        <Button
          label="Request a Hospital Rotation"
          icon={FilePlus2}
          onPress={() => openRequest('HOSPITAL')}
        />
        <Button
          label="Request a Clinic Rotation"
          variant="outline"
          icon={Stethoscope}
          onPress={() => openRequest('CLINIC')}
        />
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

      {schedule.status === 'ready' && blocks.length > 0 && showGrid ? (
        <>
          <SectionHeader title="Master grid" trailing={`${blocks.length} blocks`} />
          <MatrixTable
            columns={gridColumns}
            rows={gridRows}
            frozenHeader="Resident"
            emptyTitle="No assignments to place"
            caption={
              <Text variant="caption" tone="muted" style={styles.gridCaption}>
                Swipe sideways to move through the academic year. Your row stays pinned on the left.
              </Text>
            }
          />
        </>
      ) : null}

      {schedule.status === 'ready' && blocks.length > 0 && !showGrid
        ? blocks.map((block) => (
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
                      index === 0 ? (
                        <StatusBadge label={PHASE_LABEL[block.phase]} tone={PHASE_TONE[block.phase]} />
                      ) : null
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
          ))
        : null}

      {clinicList.length > 0 ? (
        <>
          <SectionHeader
            title="Clinic overview (CCC & longitudinal)"
            trailing={`${clinicList.length} session${clinicList.length === 1 ? '' : 's'}`}
            icon={Stethoscope}
          />
          <Card padded={false}>
            {clinicList.map((clinic, index) => (
              <ListRow
                key={clinic.longitudinal_assignment_id}
                title={`${clinic.clinic_code}: ${clinic.clinic_name}`}
                subtitle={[
                  clinic.day_of_week,
                  clinic.start_time && clinic.end_time ? `${clinic.start_time} – ${clinic.end_time}` : null,
                  clinic.site_name,
                ]
                  .filter(Boolean)
                  .join(' · ')}
                meta={clinic.supervisor_name ? `Supervisor: ${clinic.supervisor_name}` : 'Supervisor not assigned'}
                trailing={
                  <StatusBadge
                    label={clinic.is_active === 1 ? 'Active' : 'Ended'}
                    tone={clinic.is_active === 1 ? 'success' : 'neutral'}
                  />
                }
                last={index === clinicList.length - 1}
              />
            ))}
          </Card>
        </>
      ) : schedule.status === 'ready' && clinicList.length === 0 && !clinics.isLoading ? (
        <Card>
          <EmptyState
            icon={Stethoscope}
            title="No clinic session yet"
            message="Your CCC or longitudinal clinic has not been assigned. It appears here as soon as your coordinator schedules one."
          />
        </Card>
      ) : null}

      <Sheet
        visible={requestType !== null}
        onClose={closeRequest}
        title={requestType === 'CLINIC' ? 'Request a Clinic Rotation' : 'Request a Hospital Rotation'}
        subtitle="Your coordinator reviews this in the Approvals queue."
        footer={
          <Button
            label="Submit request"
            loading={submitting}
            onPress={submitRequest}
            accessibilityHint="Sends this request to your programme coordinator"
          />
        }
      >
        <View style={styles.form}>
          {formError ? <Banner tone="danger" title="Check the request" message={formError} /> : null}

          <TextField
            label={requestType === 'CLINIC' ? 'Clinic' : 'Department'}
            required
            value={form.departmentClinic}
            onChangeText={(value) => setForm((current) => ({ ...current, departmentClinic: value }))}
            placeholder={requestType === 'CLINIC' ? 'e.g. Antenatal Care Clinic' : 'e.g. Emergency Medicine'}
            hint={
              requestType === 'CLINIC'
                ? 'The clinic you want to be paired with.'
                : 'The department or service you want to rotate through.'
            }
          />

          <DateField
            label="Start date"
            required
            value={form.startDate}
            onChangeText={(value) => setForm((current) => ({ ...current, startDate: value }))}
            placeholder={EMPTY_DATE}
          />

          <DateField
            label="End date"
            required
            value={form.endDate}
            onChangeText={(value) => setForm((current) => ({ ...current, endDate: value }))}
            placeholder={EMPTY_DATE}
          />

          <TextField
            label="Reason"
            value={form.reason}
            onChangeText={(value) => setForm((current) => ({ ...current, reason: value }))}
            placeholder="Why this rotation would help your training"
            hint="Optional, but it is what the coordinator reads first."
            multiline
          />
        </View>
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  toolbar: {
    gap: spacing.sm,
    marginBottom: spacing.lg,
  },
  block: {
    marginBottom: spacing.lg,
  },
  note: {
    marginTop: spacing.xs,
    paddingHorizontal: spacing.xs,
  },
  gridCaption: {
    marginBottom: spacing.sm,
  },
  gridCell: {
    gap: spacing.xxs,
  },
  frozenCell: {
    gap: spacing.xxs,
  },
  form: {
    gap: spacing.md,
  },
});
