import { useState } from 'react';
import { router } from 'expo-router';

import {
  AppHeader,
  Banner,
  Button,
  Card,
  DateField,
  Screen,
  SectionHeader,
  TextField,
} from '../../components';
import { useSession } from '../../hooks';
import { createRotationBlock } from '../../services/rotations';
import { spacing } from '../../theme';

/**
 * Add an academic block — `POST /api/v1/rotations/blocks`.
 *
 * A block is the calendar a rotation is scheduled inside, so it has to exist
 * before anything can be assigned to it. The API requires every field and
 * enforces two rules in MySQL rather than in JavaScript:
 *
 * - `(program_id, academic_year, block_number)` is unique, so a repeat returns
 *   409 with "Duplicate block entry".
 * - `CHECK (end_date >= start_date)`, which returns 400 with "Invalid dates".
 *
 * Both messages come back verbatim through `ApiError` and are shown as-is,
 * because they are more specific than anything this form could invent.
 *
 * `program_id` comes from the session, not a picker: a coordinator is scoped to
 * one programme and the API would reject a mismatch.
 *
 * **There is deliberately no first-day-of-week control.** `week_start_day` is a
 * nullable column on `rotation_blocks` and `GET /rotations/blocks` returns it,
 * but `RotationService.createBlock` inserts only `program_id`,
 * `academic_year`, `block_number`, `block_name`, `start_date` and `end_date` —
 * it accepts the field and silently discards it. A picker here would look like
 * it saved and then show a value the database never stored, so the field is left
 * out until the insert covers it. New blocks come back with a null week start,
 * which the rotations list reports as "No first day of week recorded" rather
 * than substituting a guess.
 */

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

interface FormState {
  academicYear: string;
  blockNumber: string;
  blockName: string;
  startDate: string;
  endDate: string;
}

const INITIAL: FormState = {
  academicYear: '',
  blockNumber: '',
  blockName: '',
  startDate: '',
  endDate: '',
};

export default function AddBlockScreen() {
  const { session } = useSession();
  const programId = session?.programId ?? 0;

  const [form, setForm] = useState<FormState>(INITIAL);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: number; name: string } | null>(null);

  /**
   * The date check mirrors the database's own CHECK constraint rather than
   * adding rules of its own: the only thing rejected here is end before start.
   * `DateField` already limits input to a well-formed calendar date, so the
   * pattern test is about shape, not about the 29 February case.
   */
  const startError = DATE_PATTERN.test(form.startDate) ? null : 'Use YYYY-MM-DD.';
  const endError = !DATE_PATTERN.test(form.endDate)
    ? 'Use YYYY-MM-DD.'
    : form.endDate < form.startDate
      ? 'The end date must be on or after the start date.'
      : null;

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
    endError === null &&
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
        end_date: form.endDate,
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
        <AppHeader title="Block created" onBack={() => router.back()} />
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
        onBack={() => router.back()}
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
        <TextField
          label="Academic year"
          value={form.academicYear}
          onChangeText={(value) => setForm((prev) => ({ ...prev, academicYear: value }))}
          placeholder="e.g. 2026/2027"
          required
        />
        <TextField
          label="Block number"
          value={form.blockNumber}
          onChangeText={(value) => setForm((prev) => ({ ...prev, blockNumber: value }))}
          keyboardType="number-pad"
          error={blockNumberError}
          hint="The API treats this number as unique within an academic year."
          required
        />
      </Card>

      <SectionHeader title="Dates" />
      <Card>
        <DateField
          label="Start date"
          value={form.startDate}
          onChangeText={(value) => setForm((prev) => ({ ...prev, startDate: value }))}
          error={startError}
          required
        />
        <DateField
          label="End date"
          value={form.endDate}
          onChangeText={(value) => setForm((prev) => ({ ...prev, endDate: value }))}
          error={endError}
          required
        />
      </Card>

      <Button
        label={submitting ? 'Creating…' : 'Create block'}
        onPress={handleSubmit}
        disabled={!canSubmit}
        loading={submitting}
      />
    </Screen>
  );
}
