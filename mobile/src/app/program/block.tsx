import { useState, useMemo } from 'react';
import { router } from 'expo-router';

import {
  AppHeader,
  Banner,
  Button,
  Card,
  DateField,
  Screen,
  SectionHeader,
  SelectField,
  TextField,
} from '../../components';
import { useSession, useApiResource } from '../../hooks';
import { goBack } from '../../navigation/back';
import { createRotationBlock, fetchBlockCalendar, fetchRotationBlocks } from '../../services/rotations';
import { spacing } from '../../theme';
import { getAcademicYears, normalizeAcademicYear } from '../../utils/academicYear';
import { endDateForDuration, isCalendarDate, resolveBlockWindow } from '../../utils/dateCalc';

/**
 * Add an academic block — `POST /api/v1/rotations/blocks`.
 *
 * A block is the calendar a rotation is scheduled inside, so it has to exist
 * before anything can be assigned to it. The API requires every field and
 * enforces three rules:
 *
 * - `(program_id, academic_year, block_number)` is unique, so a repeat returns
 *   409 with "Duplicate block entry".
 * - `CHECK (end_date >= start_date)`, which returns 400 with "Invalid dates".
 * - The end date must be the day before the start date — a Sunday-start
 *   programme ends Saturday, a Monday-start one ends Sunday — so the server
 *   re-derives the window from `programs.week_start_day` rather than trusting
 *   the pair typed here. See `resolveBlockWindow`.
 *
 * **The end date is derived, not typed.** `RotationService.createBlock` ignores
 * an end date that disagrees with the duration and rejects it, so the only
 * useful thing this form can do is state the duration and show the resulting
 * window. That is why there is a duration select and an end date that updates
 * itself; the end field remains editable for the case where a coordinator has a
 * fixed date from the registrar, and the mismatch is reported before submitting.
 *
 * `program_id` comes from the session, not a picker: a coordinator is scoped to
 * one programme and the API would reject a mismatch.
 */

const DURATION_OPTIONS = [
  { value: '1', label: '1 week' },
  { value: '2', label: '2 weeks' },
  { value: '3', label: '3 weeks' },
  { value: '4', label: '4 weeks' },
];

interface FormState {
  academicYear: string;
  blockNumber: string;
  blockName: string;
  startDate: string;
  endDate: string;
  durationWeeks: number;
}

const INITIAL: FormState = {
  academicYear: '',
  blockNumber: '',
  blockName: '',
  startDate: '',
  endDate: '',
  durationWeeks: 4,
};

export default function AddBlockScreen() {
  const { session } = useSession();
  const programId = session?.programId ?? 0;

  const [form, setForm] = useState<FormState>(INITIAL);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: number; name: string } | null>(null);

  /**
   * An end date the coordinator typed, or `null` while the end date is derived.
   *
   * Storing the override rather than syncing `form.endDate` from an effect keeps
   * the end date a pure function of the start date and duration: there is no
   * render in which the field shows a date derived from inputs that have already
   * changed, and no effect that overwrites a hand-typed registrar date. The
   * override is discarded when either derivation input moves, which are the only
   * two changes that justify re-deriving it.
   */
  const [endDateOverride, setEndDateOverride] = useState<string | null>(null);

  const academicYears = useMemo(() => getAcademicYears(7, 3), []);
  const existingBlocks = useApiResource(() => fetchRotationBlocks(programId), [programId]);
  const calendar = useApiResource(() => fetchBlockCalendar(programId), [programId]);

  const assignedBlockNumbers = useMemo(() => {
    if (!form.academicYear || !existingBlocks.data) return new Set<number>();
    return new Set(
      existingBlocks.data
        .filter((b) => normalizeAcademicYear(b.academic_year) === normalizeAcademicYear(form.academicYear))
        .map((b) => b.block_number)
    );
  }, [form.academicYear, existingBlocks.data]);

  // The programme's own rules decide what a valid end date even is. Falling back
  // to Sunday keeps the form usable before the request resolves, and matches
  // every programme in the database today.
  const weekStartDay = calendar.data?.week_start_day ?? 'SUNDAY';
  const weekEndDayName = calendar.data?.week_end_day ?? 'Saturday';
  const defaultWeeks = calendar.data?.default_block_duration_weeks ?? 4;

  /**
   * The end date currently shown: the coordinator's own if they typed one,
   * otherwise derived from the start date and duration.
   *
   * Derived during render rather than written into state by an effect, so the
   * field and the validation below can never disagree — there is no intermediate
   * render where the duration has changed but the end date still shows the old
   * window.
   */
  const endDate = useMemo(() => {
    if (endDateOverride !== null) return endDateOverride;
    if (!isCalendarDate(form.startDate)) return '';
    return endDateForDuration(form.startDate, form.durationWeeks) ?? '';
  }, [endDateOverride, form.startDate, form.durationWeeks]);

  /**
   * Validated with the same rule the server applies, so the message a
   * coordinator sees is the message the API would have returned: the block has
   * to start on the programme's week-start day and end the day before it, or be
   * a whole number of weeks.
   */
  const window = useMemo(
    () =>
      resolveBlockWindow({
        start_date: form.startDate,
        end_date: endDate,
        // A hand-typed end date is validated against the duration instead of
        // being replaced by it, so the coordinator is told they disagree rather
        // than having their date silently discarded.
        duration_weeks: endDateOverride === null ? form.durationWeeks : null,
        week_start_day: weekStartDay,
      }),
    [form.startDate, endDate, form.durationWeeks, endDateOverride, weekStartDay],
  );

  const startError = isCalendarDate(form.startDate) ? null : 'Use YYYY-MM-DD.';
  const endError = !isCalendarDate(endDate)
    ? 'Use YYYY-MM-DD.'
    : window.errors.find((message) => !message.startsWith('start_date')) ?? null;
  const startBoundaryError = window.errors.find((message) => message.startsWith('This programme')) ?? null;

  const blockNumber = Number.parseInt(form.blockNumber, 10);
  const blockNumberError =
    form.blockNumber.trim().length > 0 && Number.isInteger(blockNumber) && blockNumber > 0
      ? null
      : 'Enter a whole number above 0.';

  const canSubmit =
    !submitting &&
    form.academicYear.trim().length > 0 &&
    form.blockName.trim().length > 0 &&
    startError === null &&
    startBoundaryError === null &&
    endError === null &&
    window.errors.length === 0 &&
    blockNumberError === null;

  async function handleSubmit() {
    setSubmitting(true);
    setSubmitError(null);

    try {
      const block = await createRotationBlock({
        program_id: programId,
        academic_year: form.academicYear.trim(),
        block_number: blockNumber,
        block_name: form.blockName.trim(),
        start_date: form.startDate,
        end_date: endDate,
      });

      setCreated({ id: block.block_id, name: block.block_name });
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'Could not create this block.');
    } finally {
      setSubmitting(false);
    }
  }

  if (created) {
    return (
      <Screen bottomGutter={spacing.xl}>
        <AppHeader title="Block created" onBack={goBack} />
        <Banner
          tone="success"
          title={`${created.name} added`}
          message="Rotations and assignments can now be placed inside this block."
        />
        <Button label="Back to rotations" onPress={() => router.replace('/program/rotations')} />
      </Screen>
    );
  }

  return (
    <Screen bottomGutter={spacing.xxl}>
      <AppHeader
        title="Add academic block"
        subtitle={session?.programLabel ?? 'This programme'}
        onBack={goBack}
      />

      {submitError ? <Banner tone="danger" title="Could not create the block" message={submitError} /> : null}

      <SectionHeader title="Block" />
      <Card>
        <TextField
          label="Block name"
          value={form.blockName}
          onChangeText={(value) => setForm((prev) => ({ ...prev, blockName: value }))}
          placeholder="e.g. Block 3 — General Surgery"
          required
        />
        <SelectField
          label="Academic year"
          value={form.academicYear}
          onChange={(value) => setForm((prev) => ({ ...prev, academicYear: value, blockNumber: '' }))}
          options={academicYears.map((year) => ({ value: year, label: year }))}
          required
        />
        <SelectField
          label="Block number"
          value={form.blockNumber}
          onChange={(value) => setForm((prev) => ({ ...prev, blockNumber: value }))}
          options={Array.from({ length: 13 }, (_, i) => i + 1)
            .filter((n) => !assignedBlockNumbers.has(n))
            .map((n) => ({ value: String(n), label: String(n) }))}
          error={blockNumberError}
          required
          hint={
            assignedBlockNumbers.size > 0
              ? `Blocks ${[...assignedBlockNumbers].sort((a, b) => a - b).join(', ')} already exist for this year.`
              : undefined
          }
        />
      </Card>

      <SectionHeader title="Dates" />
      <Card>
        <SelectField
          label="Duration"
          value={String(form.durationWeeks)}
          onChange={(value) => {
            setEndDateOverride(null);
            setForm((prev) => ({ ...prev, durationWeeks: Number.parseInt(value, 10) }));
          }}
          options={DURATION_OPTIONS}
          hint={`Sets the end date as ${form.durationWeeks} week${form.durationWeeks === 1 ? '' : 's'} from the start date.${
            defaultWeeks !== form.durationWeeks ? ` This programme's default is ${defaultWeeks}.` : ''
          }`}
        />
        <DateField
          label="Start date"
          value={form.startDate}
          onChangeText={(value) => {
            setEndDateOverride(null);
            setForm((prev) => ({ ...prev, startDate: value }));
          }}
          error={startError ?? startBoundaryError}
          hint={`This programme's week starts on ${weekStartDay.toLowerCase()}.`}
          weekStartDay={weekStartDay}
          durationWeeks={form.durationWeeks}
          required
        />
        <DateField
          label="End date"
          value={endDate}
          onChangeText={(value) => setEndDateOverride(value)}
          error={endError}
          hint={
            endDateOverride !== null
              ? `Edited by hand. A ${form.durationWeeks}-week block from ${
                  form.startDate || 'the start date'
                } ends ${endDateForDuration(form.startDate || '', form.durationWeeks) ?? '—'}.`
              : `Derived: a ${form.durationWeeks}-week block ends on ${weekEndDayName.toLowerCase()}.`
          }
          minDate={isCalendarDate(form.startDate) ? form.startDate : undefined}
          required
        />
      </Card>

      {window.errors.length > 0 && window.start_date && window.end_date ? (
        <Banner
          tone="warning"
          title="Check the block window"
          message={window.errors.join(' ')}
        />
      ) : null}

      <Button
        label={submitting ? 'Creating…' : 'Create block'}
        onPress={handleSubmit}
        disabled={!canSubmit}
        loading={submitting}
      />
    </Screen>
  );
}
