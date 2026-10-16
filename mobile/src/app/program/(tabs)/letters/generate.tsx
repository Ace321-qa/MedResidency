import { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Send, TriangleAlert } from 'lucide-react-native';

import { goBack } from '../../../../navigation/back';
import {
  AppHeader,
  Banner,
  Button,
  Card,
  Divider,
  ErrorState,
  Screen,
  SectionHeader,
  SheetSelectField,
  SkeletonList,
  StatusBadge,
  Text,
  TextField,
} from '../../../../components';
import { useApiResource, useSession } from '../../../../hooks';
import { fetchResidentLongitudinalAssignments } from '../../../../services/longitudinal';
import { generateReleaseLetter, previewReleaseLetter } from '../../../../services/letters';
import { fetchResidentSchedule } from '../../../../services/rotations';
import { fetchResidentList } from '../../../../services/residents';
import { useInAppNotifications } from '../../../../services/inAppNotifications';
import { colors, radius, spacing } from '../../../../theme';
import { formatDateRange, formatTime, humanizeToken, todayCalendarDate } from '../../../../utils/format';
import { parseLetterBody, type LetterBlock } from '../../../../utils/letterPreview';
import { residentFullName, residentSubtitle } from '../../../../utils/residents';
import type {
  GenerateLetterPayload,
  LongitudinalAssignment,
  MergedLetterResult,
  RotationAssignment,
} from '../../../../types/api';

/**
 * Generator & dispatch window.
 *
 * One resident, one assignment, one recipient — and a preview of the finished
 * letter before it leaves. The preview is the point of the screen: a release
 * letter is addressed to a named department head and signed by the programme,
 * so the coordinator reads exactly what will be filed before anyone else does.
 *
 * Three merge anchors are supported, matching the backend: a weekly clinic
 * assignment (the usual case), a hospital rotation, or both when the rotation
 * selected for release is also the letter's destination.
 */

const CLINIC_PREFIX = 'clinic:';
const ROTATION_PREFIX = 'rotation:';

interface AssignmentChoice {
  key: string;
  kind: 'clinic' | 'rotation';
  id: number;
  label: string;
  regenerate: boolean;
}

function toClinicChoice(assignment: LongitudinalAssignment): AssignmentChoice {
  const day = assignment.day_of_week ? humanizeToken(assignment.day_of_week) : 'Unscheduled';
  const time =
    assignment.start_time && assignment.end_time
      ? `${formatTime(assignment.start_time)}–${formatTime(assignment.end_time)}`
      : '';
  const dispatched = assignment.release_letter_generated === 1;
  return {
    key: `${CLINIC_PREFIX}${assignment.longitudinal_assignment_id}`,
    kind: 'clinic',
    id: assignment.longitudinal_assignment_id,
    label: `${assignment.clinic_name} · ${day}${time ? ` ${time}` : ''}${dispatched ? ' · letter already sent' : ''}`,
    regenerate: dispatched,
  };
}

function toRotationChoice(assignment: RotationAssignment): AssignmentChoice {
  const department = assignment.department_name ? ` · ${assignment.department_name}` : '';
  return {
    key: `${ROTATION_PREFIX}${assignment.assignment_id}`,
    kind: 'rotation',
    id: assignment.assignment_id,
    label: `${assignment.rotation_name}${department} · ${formatDateRange(assignment.start_date, assignment.end_date)}`,
    regenerate: false,
  };
}

export default function GenerateReleaseLetterScreen() {
  const router = useRouter();
  const { session } = useSession();
  const { notify } = useInAppNotifications();
  const programId = session?.programId ?? 0;

  const residents = useApiResource(
    () => fetchResidentList({ programId, limit: 200 }),
    [programId],
  );

  const [residentId, setResidentId] = useState<string | null>(null);
  const [assignmentKey, setAssignmentKey] = useState<string | null>(null);
  const [deptHead, setDeptHead] = useState('');
  const [deptName, setDeptName] = useState('');
  const [faculty, setFaculty] = useState('');
  const [busy, setBusy] = useState(false);
  const [dispatchError, setDispatchError] = useState<string | null>(null);

  const residentIdNum = residentId ? Number(residentId) : 0;

  const longitudinal = useApiResource(
    () =>
      residentIdNum ? fetchResidentLongitudinalAssignments(residentIdNum) : Promise.resolve([]),
    [residentIdNum],
  );
  const schedule = useApiResource(
    () => (residentIdNum ? fetchResidentSchedule(residentIdNum) : Promise.resolve([])),
    [residentIdNum],
  );

  const residentOptions = useMemo(
    () =>
      (residents.data ?? []).map((resident) => ({
        value: String(resident.resident_id),
        label: `${residentFullName(resident)} · ${residentSubtitle(resident)}`,
      })),
    [residents.data],
  );

  /**
   * Every assignment a release letter can be anchored to: active clinics that
   * still require a release, and rotations that have not finished yet. A clinic
   * whose letter was already sent is still listed — regenerating supersedes it —
   * and carries the flag that makes dispatch do exactly that.
   */
  const assignments = useMemo<AssignmentChoice[]>(() => {
    const today = todayCalendarDate();
    const clinics = (longitudinal.data ?? [])
      .filter((row) => row.requires_release_letter !== 0 && row.is_active === 1)
      .map(toClinicChoice);
    const rotations = (schedule.data ?? [])
      .filter((row) => row.end_date >= today)
      .map(toRotationChoice);
    return [...clinics, ...rotations];
  }, [longitudinal.data, schedule.data]);

  const assignmentOptions = useMemo(
    () => assignments.map((choice) => ({ value: choice.key, label: choice.label })),
    [assignments],
  );

  const selection = useMemo(
    () => assignments.find((choice) => choice.key === assignmentKey) ?? null,
    [assignments, assignmentKey],
  );

  // Prefill the destination department from the chosen rotation; a clinic
  // release has no destination until the coordinator names it.
  const lastPrefillKey = useRef<string | null>(null);
  useEffect(() => {
    if (!selection || selection.kind !== 'rotation') return;
    if (lastPrefillKey.current === selection.key) return;
    lastPrefillKey.current = selection.key;
    const rotation = (schedule.data ?? []).find((row) => row.assignment_id === selection.id);
    setDeptName(rotation?.department_name ?? '');
  }, [selection, schedule.data]);

  /** The exact payload /preview and /generate will receive. */
  const payload = useMemo<GenerateLetterPayload | null>(() => {
    if (!residentIdNum || !selection || deptHead.trim() === '') return null;
    return {
      resident_id: residentIdNum,
      ...(selection.kind === 'clinic'
        ? { longitudinal_assignment_id: selection.id }
        : { rotation_assignment_id: selection.id }),
      recipient_dept_head: deptHead.trim(),
      hospital_department_name: deptName.trim() || undefined,
      supervising_faculty: faculty.trim() || undefined,
    };
  }, [residentIdNum, selection, deptHead, deptName, faculty]);

  const payloadKey = payload ? JSON.stringify(payload) : null;

  /**
   * Preview state is keyed by the payload that produced it, so a response that
   * arrives after the coordinator has changed a field is never shown next to
   * the new field — a *stale* letter preview is worse than none.
   */
  const [previewState, setPreviewState] = useState<{ key: string; data: MergedLetterResult } | null>(
    null,
  );
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const previewSeq = useRef(0);

  useEffect(() => {
    if (!payload || !payloadKey) return undefined;
    const seq = ++previewSeq.current;
    const timer = setTimeout(() => {
      setPreviewing(true);
      previewReleaseLetter(payload)
        .then((data) => {
          if (seq !== previewSeq.current) return;
          setPreviewState({ key: payloadKey, data });
          setPreviewError(null);
        })
        .catch((error) => {
          if (seq !== previewSeq.current) return;
          setPreviewError(error instanceof Error ? error.message : 'Could not build the preview.');
        })
        .finally(() => {
          if (seq === previewSeq.current) setPreviewing(false);
        });
    }, 450);

    return () => clearTimeout(timer);
  }, [payload, payloadKey]);

  const preview =
    previewState && previewState.key === payloadKey ? previewState.data : null;

  async function dispatch() {
    if (!payload || !selection) {
      notify({
        title: 'Nothing to send yet',
        message: 'Choose a resident, an assignment and the receiving department head first.',
        tone: 'warning',
      });
      return;
    }

    setBusy(true);
    setDispatchError(null);
    try {
      const result = await generateReleaseLetter({
        ...payload,
        sent_status: 'SENT',
        regenerate: selection.regenerate,
      });
      const unresolved = result.unresolved_placeholders ?? [];
      notify({
        title: unresolved.length ? 'Letter sent — incomplete' : 'Release letter sent',
        message: unresolved.length
          ? `${result.resident_name}: ${unresolved.join(', ')} could not be filled in.`
          : `${result.resident_name} · ${result.hospital_department_name ?? 'department'} · to ${result.recipient_dept_head}.`,
        tone: unresolved.length ? 'warning' : 'success',
      });
      router.replace('/program/letters');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The letter could not be sent.';
      setDispatchError(message);
      notify({ title: 'Dispatch failed', message, tone: 'danger' });
    } finally {
      setBusy(false);
    }
  }

  const loadingAssignments =
    residentIdNum > 0 && (longitudinal.isLoading || schedule.isLoading);

  return (
    <Screen bottomGutter={spacing.xxl}>
      <AppHeader
        title="Generate Release Letter"
        onBack={goBack}
        subtitle="Merge, preview and dispatch the official release letter"
      />

      {residents.isLoading ? <SkeletonList rows={3} /> : null}

      {residents.error ? (
        <ErrorState
          title="Could not load residents"
          message={residents.error.message}
          onRetry={residents.refresh}
        />
      ) : null}

      {residents.status === 'ready' ? (
        <>
          <SectionHeader title="1. Who is being released" />
          <Card>
            <View style={styles.form}>
              <SheetSelectField
                label="Resident"
                required
                value={residentId}
                options={residentOptions}
                onChange={(value) => {
                  setResidentId(value);
                  setAssignmentKey(null);
                  setDeptName('');
                }}
                placeholder="Choose a resident"
                hint="The letter is addressed on behalf of this resident."
              />

              <SheetSelectField
                label="Assignment needing release"
                required
                value={assignmentKey}
                options={assignmentOptions}
                onChange={setAssignmentKey}
                disabled={!residentId}
                placeholder={
                  residentId
                    ? assignments.length > 0
                      ? 'Choose an assignment'
                      : 'No assignment awaiting release'
                    : 'Choose a resident first'
                }
                hint="Clinic releases and upcoming hospital rotations both appear here."
              />

              {loadingAssignments ? (
                <Text variant="caption" tone="muted">
                  Loading assignments…
                </Text>
              ) : null}
            </View>
          </Card>

          <SectionHeader title="2. Who receives it" />
          <Card>
            <View style={styles.form}>
              <TextField
                label="Receiving department head"
                required
                value={deptHead}
                onChangeText={setDeptHead}
                placeholder="Dr. Head of Internal Medicine"
                hint="The chair or head the letter is formally addressed to."
              />
              <TextField
                label="Department name"
                value={deptName}
                onChangeText={setDeptName}
                placeholder="Internal Medicine Inpatient Wards"
                hint="Fills the {{HOSPITAL_DEPT}} token."
              />
              <TextField
                label="Supervising faculty (optional)"
                value={faculty}
                onChangeText={setFaculty}
                placeholder="Dr. Preceptor supervising the hospital rotation"
                hint="Fills {{SUPERVISING_FACULTY}} when the template uses it."
              />
            </View>
          </Card>

          <SectionHeader title="3. Preview" />
          <Card>
            {!payload ? (
              <Text variant="bodySmall" tone="muted">
                Choose a resident, an assignment and a receiving department head — the merged letter
                appears here before it is sent.
              </Text>
            ) : null}

            {payload && previewing && !preview ? (
              <SkeletonList rows={3} />
            ) : null}

            {payload && previewError ? (
              <Banner tone="danger" title="Preview unavailable" message={previewError} />
            ) : null}

            {preview ? (
              <View style={styles.preview}>
                {preview.unresolved_placeholders.length > 0 ? (
                  <View style={styles.warning} accessibilityRole="alert">
                    <TriangleAlert size={16} color={colors.warning} />
                    <Text variant="caption" tone="warning" style={styles.warningText}>
                      {preview.unresolved_placeholders.join(', ')} could not be filled in. The letter
                      will be sent with those tokens still visible.
                    </Text>
                  </View>
                ) : null}

                <View style={styles.metaRow}>
                  <StatusBadge label={preview.template_code} tone="info" />
                  {preview.existing_letter_id ? (
                    <StatusBadge label="Supersedes a sent letter" tone="warning" />
                  ) : null}
                </View>

                <Text variant="h3">{preview.letter_subject}</Text>

                <Divider />

                <MetaRow label="To" value={`${preview.recipient_dept_head ?? 'Department head'} — ${preview.hospital_department_name ?? 'Department'}`} />
                <MetaRow
                  label="From"
                  value={`${preview.merge_values.PROGRAM_NAME ?? 'Residency programme'}${preview.merge_values.INSTITUTION_NAME ? ` · ${preview.merge_values.INSTITUTION_NAME}` : ''}`}
                />
                <MetaRow
                  label="Resident"
                  value={`${preview.resident_name}${preview.pgy_level ? ` (${preview.pgy_level})` : ''}`}
                />
                <MetaRow
                  label="Release"
                  value={
                    preview.merge_values.CLINIC_NAME
                      ? `${preview.merge_values.CLINIC_NAME} · ${humanizeToken(preview.merge_values.RELEASE_DAY ?? '')} ${preview.merge_values.START_TIME ?? ''}–${preview.merge_values.END_TIME ?? ''}`.trim()
                      : `${preview.merge_values.ROTATION_NAME ?? 'Rotation'} · ${preview.merge_values.RELEASE_START_DATE ?? ''} to ${preview.merge_values.RELEASE_END_DATE ?? ''}`
                  }
                />
                <MetaRow
                  label="Supervising"
                  value={preview.supervising_faculty ?? 'Not assigned'}
                />

                <Divider />

                <MergedBody body={preview.generated_letter_body} />
              </View>
            ) : null}
          </Card>

          {dispatchError ? (
            <Banner tone="danger" title="Could not dispatch" message={dispatchError} />
          ) : null}

          <View style={styles.cta}>
            <Button
              label="Generate & Send Official Release Letter"
              icon={Send}
              loading={busy}
              disabled={!payload}
              onPress={() => void dispatch()}
              accessibilityHint="Merges the letter and records it as sent"
            />
            <Text variant="caption" tone="muted">
              The letter is stored inside one transaction and the assignment is flagged as released.
              Sending again supersedes the previous letter rather than duplicating it.
            </Text>
          </View>
        </>
      ) : null}
    </Screen>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metaLine}>
      <Text variant="caption" tone="secondary" style={styles.metaLabel}>
        {label}
      </Text>
      <Text variant="bodySmall" style={styles.metaValue}>
        {value}
      </Text>
    </View>
  );
}

/**
 * The merged body, drawn the way the resident's preview draws it: headings are
 * headings, `Label: value` runs become rows, and any token the merge could not
 * fill stays visible and highlighted rather than silently blanked.
 */
function MergedBody({ body }: { body: string }) {
  const blocks = useMemo(() => parseLetterBody(body), [body]);

  if (blocks.length === 0) {
    return (
      <Text variant="bodySmall" tone="muted">
        The template produced no body text.
      </Text>
    );
  }

  return (
    <>
      {blocks.map((block, index) => (
        <BlockView key={`${block.kind}-${index}`} block={block} />
      ))}
    </>
  );
}

function BlockView({ block }: { block: LetterBlock }) {
  if (block.kind === 'fields' && block.rows) {
    return (
      <View style={styles.fields}>
        {block.rows.map((row) => (
          <View key={`${row.label}-${row.value}`} style={styles.metaLine}>
            <Text variant="caption" tone="secondary" style={styles.metaLabel}>
              {row.label}
            </Text>
            <Text variant="bodySmall" tone={row.unresolved ? 'warning' : 'primary'}>
              {row.value}
            </Text>
          </View>
        ))}
      </View>
    );
  }

  const variant = block.kind === 'heading' ? 'h3' : 'body';
  const tone =
    block.kind === 'closing' || block.kind === 'salutation' || block.kind === 'signature'
      ? 'secondary'
      : 'primary';

  return (
    <Text variant={variant} tone={tone} style={styles.block}>
      {block.spans.map((span, index) =>
        span.unresolved ? (
          <Text
            key={`token-${index}`}
            variant="caption"
            style={[styles.unresolved, { backgroundColor: colors.warningSurface, color: colors.warning }]}
          >
            {span.token ?? 'unfilled field'}
          </Text>
        ) : (
          <Text key={`text-${index}`} variant={variant}>
            {span.text}
          </Text>
        ),
      )}
    </Text>
  );
}

const styles = StyleSheet.create({
  form: {
    gap: spacing.md,
  },
  preview: {
    gap: spacing.xs,
  },
  warning: {
    flexDirection: 'row',
    gap: spacing.sm,
    backgroundColor: colors.warningSurface,
    borderRadius: radius.md,
    padding: spacing.sm,
    marginBottom: spacing.xs,
  },
  warningText: {
    flex: 1,
  },
  metaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  metaLine: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  metaLabel: {
    width: 96,
  },
  metaValue: {
    flex: 1,
  },
  fields: {
    gap: spacing.xxs,
  },
  block: {
    marginTop: spacing.xs,
  },
  unresolved: {
    fontWeight: '700',
    borderRadius: radius.sm,
    paddingHorizontal: spacing.xs,
    paddingVertical: 1,
    overflow: 'hidden',
  },
  cta: {
    gap: spacing.sm,
    marginTop: spacing.md,
  },
});
