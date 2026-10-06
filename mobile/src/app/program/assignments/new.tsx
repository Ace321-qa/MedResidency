import { useState, useMemo } from 'react';
import { useSession, useApiResource } from '../../../hooks';
import { fetchBlockCalendar, fetchRotationBlocks, fetchRotations, createAssignment } from '../../../services/rotations';
import { fetchResidentList } from '../../../services/residents';
import {
  AppHeader,
  Banner,
  Button,
  Card,
  DateField,
  Screen,
  SectionHeader,
  SelectField,
  SheetSelectField,
} from '../../../components';
import { spacing } from '../../../theme';
import { getAcademicYears, sameAcademicYear } from '../../../utils/academicYear';
import { isCalendarDate, resolveBlockWindow } from '../../../utils/dateCalc';
import { goBack } from '../../../navigation/back';

interface AssignmentForm {
  residentId: string;
  rotationId: string;
  rotationBlockId: string;
  startDate: string;
  endDate: string;
}

const INITIAL_FORM: AssignmentForm = {
  residentId: '',
  rotationId: '',
  rotationBlockId: '',
  startDate: '',
  endDate: '',
};

export default function NewAssignmentScreen() {
  const { session } = useSession();
  const programId = session?.programId ?? 0;
  const academicYears = useMemo(() => getAcademicYears(7, 3), []);
  const [academicYear, setAcademicYear] = useState(academicYears[0]);
  const blocks = useApiResource(() => fetchRotationBlocks(programId), [programId]);
  const rotations = useApiResource(() => fetchRotations(programId), [programId]);
  const residents = useApiResource(() => fetchResidentList({ programId }), [programId]);
  const calendar = useApiResource(() => fetchBlockCalendar(programId), [programId]);

  /**
   * Blocks for the chosen year.
   *
   * `sameAcademicYear` rather than `===`: the same year exists in the table
   * under both "2026-2027" and "2026/2027", and a strict comparison would show an
   * empty list for a year that demonstrably has blocks — which reads as "this
   * programme has no blocks" and sends the coordinator off to create duplicates.
   */
  const blocksForYear = useMemo(
    () =>
      (blocks.data ?? [])
        .filter((block) => sameAcademicYear(block.academic_year, academicYear))
        .sort((a, b) => a.block_number - b.block_number),
    [blocks.data, academicYear],
  );

  const [form, setForm] = useState<AssignmentForm>(INITIAL_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  /** The block currently chosen, for the window hint and containment check. */
  const selectedBlock = useMemo(
    () => blocksForYear.find((candidate) => String(candidate.block_id) === form.rotationBlockId) ?? null,
    [blocksForYear, form.rotationBlockId],
  );

  const residentIdError = form.residentId ? null : 'Choose the resident this rotation is for.';
  const blockIdError = form.rotationBlockId ? null : 'Choose the block the rotation sits inside.';
  const rotationIdError = form.rotationId ? null : 'Choose a rotation.';

  /**
   * The assignment window, checked against the block it belongs to.
   *
   * The server rejects an assignment that reaches outside its block, because the
   * cohort master grid draws its columns from the block's own dates and would
   * otherwise show the rotation in the wrong column. Catching it here names the
   * block's actual window; catching it there would only say "invalid dates".
   */
  const window = useMemo(
    () =>
      resolveBlockWindow({
        start_date: form.startDate,
        end_date: form.endDate,
        week_start_day: selectedBlock?.week_start_day ?? calendar.data?.week_start_day ?? 'SUNDAY',
      }),
    [form.startDate, form.endDate, selectedBlock?.week_start_day, calendar.data?.week_start_day],
  );

  const startError = !form.startDate
    ? 'Use YYYY-MM-DD.'
    : (window.errors.find((message) => message.startsWith('Use ')) ?? null);
  const endError = !form.endDate
    ? 'Use YYYY-MM-DD.'
    : (window.errors.find((message) => message.includes('end date')) ?? null);
  const containmentError =
    isCalendarDate(form.startDate) &&
    isCalendarDate(form.endDate) &&
    selectedBlock?.start_date_iso &&
    selectedBlock?.end_date_iso &&
    (form.startDate < selectedBlock.start_date_iso || form.endDate > selectedBlock.end_date_iso)
      ? `${selectedBlock.block_name} runs ${selectedBlock.start_date_iso} to ${selectedBlock.end_date_iso}.`
      : null;

  const canSubmit =
    !submitting &&
    !residentIdError &&
    !blockIdError &&
    !rotationIdError &&
    !startError &&
    !endError &&
    !containmentError;

  async function handleSubmit() {
    setSubmitting(true);
    setError(null);
    try {
      await createAssignment({
        resident_id: parseInt(form.residentId, 10),
        rotation_id: parseInt(form.rotationId, 10),
        rotation_block_id: parseInt(form.rotationBlockId, 10),
        start_date: form.startDate,
        end_date: form.endDate,
      });
      setSuccess(true);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Screen bottomGutter={spacing.xxl}>
      <AppHeader title="New Rotation Assignment" onBack={goBack} />
      {error ? <Banner tone="danger" title="Error" message={error} /> : null}
      {success ? <Banner tone="success" title="Success" message="Assignment created" /> : null}
      <SectionHeader title="Selection" />
      <Card>
        <SelectField
          label="Academic Year"
          value={academicYear}
          onChange={setAcademicYear}
          options={academicYears.map((year) => ({ value: year, label: year }))}
        />
        <SheetSelectField
          label="Resident"
          value={form.residentId || null}
          onChange={(value) => setForm((prev) => ({ ...prev, residentId: value }))}
          options={(residents.data ?? []).map((r) => ({
            value: String(r.resident_id),
            label: `${r.first_name} ${r.last_name}`,
          }))}
          error={residentIdError}
          required
          placeholder="Choose a resident"
          hint="Search narrows the roster by name."
        />
        <SheetSelectField
          label="Block"
          value={form.rotationBlockId || null}
          onChange={(value) =>
            setForm((prev) => {
              const block = blocksForYear.find((b) => String(b.block_id) === value);
              return {
                ...prev,
                rotationBlockId: value,
                // `_iso`, not `start_date`: the raw field is a JS Date and would
                // both crash on `.slice` and shift a Saturday by a day.
                startDate: block?.start_date_iso ?? '',
                endDate: block?.end_date_iso ?? '',
              };
            })
          }
          options={blocksForYear.map((b) => ({
            value: String(b.block_id),
            label: `${b.block_name} (Block ${b.block_number})`,
          }))}
          error={blockIdError}
          required
          hint={
            blocksForYear.length === 0
              ? `No blocks exist for ${academicYear}. Add one before assigning.`
              : 'Picking a block fills the dates below.'
          }
        />
        <SheetSelectField
          label="Rotation"
          value={form.rotationId || null}
          onChange={(value) => setForm((prev) => ({ ...prev, rotationId: value }))}
          options={(rotations.data ?? []).map((r) => ({
            value: String(r.rotation_id),
            // `GET /rotations` is not filtered by `is_active` on the server.
            label: `${r.rotation_name}${r.is_active ? '' : ' (inactive)'}`,
          }))}
          error={rotationIdError}
          required
        />
        <DateField
          label="Start Date"
          value={form.startDate}
          onChangeText={(v) => setForm((prev) => ({ ...prev, startDate: v }))}
          error={startError}
          hint={selectedBlock ? `${selectedBlock.actual_start_day} · from ${selectedBlock.start_date_iso}` : undefined}
          minDate={selectedBlock?.start_date_iso ?? undefined}
          required
        />
        <DateField
          label="End Date"
          value={form.endDate}
          onChangeText={(v) => setForm((prev) => ({ ...prev, endDate: v }))}
          error={endError ?? containmentError}
          hint={
            selectedBlock
              ? containmentError
                ? 'Outside the block window — the server will refuse this.'
                : `${selectedBlock.actual_end_day} · to ${selectedBlock.end_date_iso} (${selectedBlock.block_days} days)`
              : undefined
          }
          maxDate={selectedBlock?.end_date_iso ?? undefined}
          required
        />
      </Card>
      <Button
        label={submitting ? 'Creating...' : 'Create Assignment'}
        onPress={handleSubmit}
        disabled={!canSubmit}
        loading={submitting}
      />
    </Screen>
  );
}
