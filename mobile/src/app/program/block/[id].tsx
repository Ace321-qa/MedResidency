import { useMemo, useState } from 'react';
import { StyleSheet } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';

import {
  AppHeader,
  Banner,
  Button,
  Card,
  DateField,
  Screen,
  SectionHeader,
  SelectField,
  SkeletonList,
  TextField,
  type SelectOption,
} from '../../../components';
import { useApiResource, useSession } from '../../../hooks';
import { goBack } from '../../../navigation/back';
import {
  deleteRotationBlock,
  fetchBlockCalendar,
  fetchRotationBlocks,
  updateRotationBlock,
} from '../../../services/rotations';
import { spacing } from '../../../theme';
import { getAcademicYears } from '../../../utils/academicYear';
import { endDateForDuration, isCalendarDate, resolveBlockWindow } from '../../../utils/dateCalc';
import type { RotationBlock } from '../../../types/api';

/**
 * Edit an academic block — `PUT /rotations/blocks/:id`.
 *
 * Three things this screen had wrong, all of them the same mistake:
 *
 *  1. **It read the dates from the wrong fields.** `block.start_date` is a raw
 *     MySQL DATE and arrives as a JS `Date`, so `block.start_date.slice(0, 10)`
 *     throws; and even where it did not, rendering it would show a Saturday as a
 *     Friday west of UTC. The `*_iso` fields are formatted in SQL for exactly
 *     this.
 *  2. **It only checked `end >= start`.** A block that is four weeks long must
 *     *end the day before it starts*; anything else is a block of a different
 *     length wearing the wrong dates. The window is now validated with the same
 *     rule the server uses, so the message is the message the API returns.
 *  3. **The academic year was a free-text field.** Typing "2026/2027" against a
 *     column that stores "2026-2027" would edit the block *into* a second,
 *     duplicate year that the unique index would then reject. The stored spelling
 *     is preserved and offered as-is; the picker adds the canonical form.
 */

interface FormState {
  academicYear: string;
  blockNumber: string;
  blockName: string;
  startDate: string;
  endDate: string;
}

const DURATION_OPTIONS: SelectOption<string>[] = [
  { value: '1', label: '1 week' },
  { value: '2', label: '2 weeks' },
  { value: '3', label: '3 weeks' },
  { value: '4', label: '4 weeks' },
  { value: '6', label: '6 weeks' },
  { value: '8', label: '8 weeks' },
  { value: '12', label: '12 weeks' },
  { value: '13', label: '13 weeks (full year)' },
];

export default function EditBlockScreen() {
  const { session } = useSession();
  const programId = session?.programId ?? 0;
  const { id } = useLocalSearchParams<{ id: string }>();
  const blockId = Number.parseInt(id ?? '0', 10);

  const blocks = useApiResource(() => fetchRotationBlocks(programId), [programId]);
  const calendar = useApiResource(() => fetchBlockCalendar(programId), [programId]);

  const block = useMemo(
    () => (blocks.data ?? []).find((candidate) => candidate.block_id === blockId) ?? null,
    [blocks.data, blockId],
  );

  const weekStartDay = calendar.data?.week_start_day ?? 'SUNDAY';
  const weekEndDayName = calendar.data?.week_end_day ?? 'Saturday';
  const defaultWeeks = calendar.data?.default_block_duration_weeks ?? 4;

  if (blocks.isLoading || calendar.isLoading) {
    return (
      <Screen>
        <AppHeader title="Edit academic block" onBack={goBack} />
        <SkeletonList rows={4} />
      </Screen>
    );
  }

  if (blocks.error) {
    return (
      <Screen>
        <AppHeader title="Edit academic block" onBack={goBack} />
        <Banner tone="danger" title="Could not load the block" message={blocks.error.message} />
      </Screen>
    );
  }

  if (!block) {
    return (
      <Screen>
        <AppHeader title="Edit academic block" onBack={goBack} />
        <Banner
          tone="warning"
          title="Block not found"
          message={`No block ${blockId} exists in this programme.`}
        />
      </Screen>
    );
  }

  // Keyed by block id so navigating between two blocks remounts the form with the
  // new block's values instead of leaving the previous one's edits in place.
  return (
    <EditBlockForm
      key={`${block.block_id}:${block.start_date_iso}:${block.end_date_iso}`}
      block={block}
      programId={programId}
      weekStartDay={weekStartDay}
      weekEndDayName={weekEndDayName}
      defaultWeeks={defaultWeeks}
    />
  );
}

/**
 * The form, initialised from the loaded block.
 *
 * Split out so the initial values come from props in a `useState` initialiser.
 * Deriving them in an effect in the parent would mean one render with an empty
 * form — which reads to the coordinator as a blank block, and would flash the
 * skeleton state of a screen that is actually ready.
 */
function EditBlockForm({
  block,
  programId,
  weekStartDay,
  weekEndDayName,
  defaultWeeks,
}: {
  block: RotationBlock;
  programId: number;
  weekStartDay: string;
  weekEndDayName: string;
  defaultWeeks: number;
}) {
  const [form, setForm] = useState<FormState>(() => ({
    academicYear: block.academic_year,
    blockNumber: String(block.block_number),
    blockName: block.block_name,
    // `_iso` is `YYYY-MM-DD` straight from SQL; the raw fields are JS Dates, so
    // `.slice()` on them either throws or shifts a Saturday into a Friday.
    startDate: block.start_date_iso ?? '',
    endDate: block.end_date_iso ?? '',
  }));
  /**
   * The chosen length, or `null` while it is still the stored one.
   *
   * A block whose window is not a whole number of weeks — production block 5 is
   * the known case — has no length to show, so `block.block_weeks` is `null` and
   * the programme default stands in. Choosing a length is what makes the window
   * correct again, which is exactly what the warning below asks for.
   */
  const [chosenWeeks, setChosenWeeks] = useState<number | null>(null);
  /** An end date typed by hand, or `null` while it is derived from the length. */
  const [endDateOverride, setEndDateOverride] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const durationWeeks = chosenWeeks ?? block.block_weeks ?? defaultWeeks;

  /** The end date shown: the coordinator's own, else derived from the length. */
  const endDate = useMemo(() => {
    if (endDateOverride !== null) return endDateOverride;
    if (!isCalendarDate(form.startDate)) return '';
    return endDateForDuration(form.startDate, durationWeeks) ?? '';
  }, [endDateOverride, form.startDate, durationWeeks]);

  const window = useMemo(
    () =>
      resolveBlockWindow({
        start_date: form.startDate,
        end_date: endDate,
        duration_weeks: endDateOverride === null ? durationWeeks : null,
        week_start_day: weekStartDay,
      }),
    [form.startDate, endDate, durationWeeks, endDateOverride, weekStartDay],
  );

  const startError = isCalendarDate(form.startDate) ? null : 'Use YYYY-MM-DD.';
  const startBoundaryError = window.errors.find((message) => message.startsWith('This programme')) ?? null;
  const endError = !isCalendarDate(endDate)
    ? 'Use YYYY-MM-DD.'
    : (window.errors.find((message) => !message.startsWith('This programme')) ?? null);

  const blockNumber = Number.parseInt(form.blockNumber, 10);
  const blockNumberError =
    form.blockNumber.trim().length > 0 && Number.isInteger(blockNumber) && blockNumber > 0
      ? null
      : 'Enter a whole number above 0.';

  const academicYearOptions = useMemo<SelectOption<string>[]>(() => {
    const stored = form.academicYear;
    const generated = getAcademicYears(7, 3);
    // Always offer the year as it is stored; a picker that showed only the
    // canonical spelling would invite an accidental duplicate-year edit.
    return Array.from(new Set([...generated, ...(stored ? [stored] : [])])).map((year) => ({
      value: year,
      label: year,
    }));
  }, [form.academicYear]);

  /**
   * The length choices, with the stored length always present.
   *
   * A block saved at an unusual length (13 weeks, say) must remain selectable, or
   * opening this screen and pressing Save would silently resize it to the nearest
   * standard option.
   */
  const durationOptions = useMemo<SelectOption<string>[]>(() => {
    // Keep the saved length selectable. Resizing a 13-week block to the nearest
    // standard option because the picker did not list it would be a silent
    // change to a block somebody deliberately made long.
    if (block.block_weeks && !DURATION_OPTIONS.some((option) => option.value === String(block.block_weeks))) {
      return [
        ...DURATION_OPTIONS,
        { value: String(block.block_weeks), label: `${block.block_weeks} weeks (saved length)` },
      ];
    }
    return DURATION_OPTIONS;
  }, [block.block_weeks]);

  const canSubmit =
    !submitting &&
    !deleting &&
    form.blockName.trim().length > 0 &&
    startError === null &&
    startBoundaryError === null &&
    endError === null &&
    blockNumberError === null;

  async function handleUpdate() {
    setSubmitting(true);
    setNotice(null);

    try {
      await updateRotationBlock(block.block_id, {
        program_id: programId,
        // Sent as stored: rewriting it would risk colliding with the unique index.
        academic_year: form.academicYear.trim(),
        block_number: blockNumber,
        block_name: form.blockName.trim(),
        start_date: form.startDate,
        end_date: endDate,
      });
      router.replace('/program/rotations');
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : 'Could not update this block.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    setNotice(null);

    try {
      await deleteRotationBlock(block.block_id);
      router.replace('/program/rotations');
    } catch (caught) {
      setNotice(
        caught instanceof Error
          ? caught.message
          : 'Could not delete this block. Remove its resident assignments first.',
      );
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Screen bottomGutter={spacing.xxl}>
      <AppHeader
        title="Edit academic block"
        subtitle={`Block ${block.block_number} · ${block.block_name}`}
        onBack={goBack}
      />

      {notice ? <Banner tone="danger" title="Could not save the block" message={notice} /> : null}

      {block.block_weeks === null ? (
        <Banner
          tone="warning"
          title="This block's window is not a whole number of weeks"
          message={`It runs ${block.block_days} days, ${block.actual_start_day} to ${block.actual_end_day}. Pick a length to correct it, or leave the dates alone if this block is intentionally different.`}
        />
      ) : null}

      <SectionHeader title="Block" />
      <Card>
        <TextField
          label="Block name"
          value={form.blockName}
          onChangeText={(value) => setForm((prev) => ({ ...prev, blockName: value }))}
          required
        />
        <SelectField
          label="Academic year"
          value={form.academicYear || null}
          onChange={(value) => setForm((prev) => ({ ...prev, academicYear: value }))}
          options={academicYearOptions}
          hint="Shown as stored. Changing it can collide with the same year saved another way."
        />
        <TextField
          label="Block number"
          value={form.blockNumber}
          onChangeText={(value) => setForm((prev) => ({ ...prev, blockNumber: value }))}
          keyboardType="number-pad"
          error={blockNumberError}
          required
        />
      </Card>

      <SectionHeader title="Dates" />
      <Card>
        <SelectField
          label="Length"
          value={String(durationWeeks)}
          onChange={(value) => {
            setEndDateOverride(null);
            setChosenWeeks(Number.parseInt(value, 10));
          }}
          options={durationOptions}
          hint={`Sets the end date as ${durationWeeks} whole week${
            durationWeeks === 1 ? '' : 's'
          } from the start date.${
            block.block_weeks !== null && block.block_weeks !== durationWeeks
              ? ` Saved length is ${block.block_weeks}.`
              : ''
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
          durationWeeks={durationWeeks}
          required
        />
        <DateField
          label="End date"
          value={endDate}
          onChangeText={(value) => setEndDateOverride(value)}
          error={endError}
          hint={
            endDateOverride !== null
              ? `Edited by hand. A ${durationWeeks}-week block from ${
                  form.startDate || 'the start date'
                } ends ${endDateForDuration(form.startDate || '', durationWeeks) ?? '—'}.`
              : `Derived: ${durationWeeks} week${
                  durationWeeks === 1 ? '' : 's'
                } ends on ${weekEndDayName.toLowerCase()}.`
          }
          minDate={isCalendarDate(form.startDate) ? form.startDate : undefined}
          required
        />
      </Card>

      <Button
        label={submitting ? 'Updating…' : 'Update block'}
        onPress={handleUpdate}
        disabled={!canSubmit}
        loading={submitting}
      />

      <Button
        label={deleting ? 'Deleting…' : 'Delete block'}
        onPress={handleDelete}
        disabled={submitting || deleting}
        loading={deleting}
        variant="danger"
        style={styles.deleteButton}
        accessibilityHint="The server refuses if residents are still assigned to this block"
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  deleteButton: {
    marginTop: spacing.sm,
  },
});