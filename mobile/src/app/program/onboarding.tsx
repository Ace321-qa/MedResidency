import { useMemo, useState } from 'react';
import { StyleSheet } from 'react-native';
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
  Text,
  TextField,
} from '../../components';
import { useApiResource, useSession } from '../../hooks';
import { goBack } from '../../navigation/back';
import { fetchResidentList, onboardResident } from '../../services/residents';
import { spacing } from '../../theme';
import type { ResidentListItem } from '../../types/api';
import { humanizeToken, todayCalendarDate } from '../../utils/format';
import { isCalendarDate } from '../../utils/dateCalc';

/**
 * Register a resident — `POST /api/v1/residents/onboard`.
 *
 * The API performs three inserts in one transaction (the resident, a legal
 * identifier, and a programme enrollment), so this form is one form rather than
 * three steps: splitting it would mean either leaving the database half-written
 * or inventing local state that cannot be rolled back.
 *
 * `program_id` comes from the session rather than a picker, because a
 * coordinator is scoped to one programme and the API would reject a mismatch
 * anyway.
 *
 * **Where the options come from.** `sex`, `citizenship_status` and
 * `resident_status` are columns on `residents`, so their option lists are
 * derived from the live roster: whatever codes exist in this database are
 * exactly the codes offered, and an unseen code cannot be sent. The other two
 * are columns the roster does not return, so their values are the ones observed
 * in live records (`position_type` on `residency_enrollments`, `identifier_type`
 * on `resident_identifiers`). Note the casing is not uniform — `sex` stores
 * `Male`/`Female` while `citizenship_status` stores `QATARI_CITIZEN` — so the
 * values are passed through exactly as the database returns them. Any code the
 * enum does not define is rejected by MySQL as a 400, which `ApiError` surfaces
 * verbatim.
 */

/** Values observed on `residency_enrollments.position_type`. */
const POSITION_TYPES = ['FULL_TIME', 'PART_TIME'] as const;

/** Values observed on `resident_identifiers.identifier_type`. */
const IDENTIFIER_TYPES = ['NATIONAL_ID', 'CORPORATE_ID', 'LICENSE_NUMBER', 'PASSPORT'] as const;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

interface FormState {
  firstName: string;
  middleInitial: string;
  lastName: string;
  dateOfBirth: string;
  sex: string | null;
  nationality: string;
  citizenship: string | null;
  identifierType: (typeof IDENTIFIER_TYPES)[number];
  identifierValue: string;
  yearInProgram: string;
  positionType: (typeof POSITION_TYPES)[number];
  residentStatus: string | null;
  startDate: string;
  expectedCompletion: string;
}

const INITIAL: FormState = {
  firstName: '',
  middleInitial: '',
  lastName: '',
  dateOfBirth: '',
  sex: null,
  nationality: '',
  citizenship: null,
  identifierType: 'NATIONAL_ID',
  identifierValue: '',
  yearInProgram: '1',
  positionType: 'FULL_TIME',
  residentStatus: null,
  startDate: '',
  expectedCompletion: '',
};

export default function OnboardingScreen() {
  const { session } = useSession();
  const programId = session?.programId ?? 0;

  /**
   * The roster is read only to build the option lists. Every distinct value in
   * the database is therefore selectable, and nothing else is.
   */
  const roster = useApiResource(() => fetchResidentList({ limit: 100 }));
  const enumOptions = useMemo(() => distinctRosterValues(roster.data ?? []), [roster.data]);

  const [form, setForm] = useState<FormState>(INITIAL);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: number; name: string } | null>(null);

  const dobError = isCalendarDate(form.dateOfBirth)
    ? form.dateOfBirth > todayCalendarDate()
      ? 'Nobody is born in the future.'
      : null
    : 'Use a real date in YYYY-MM-DD.';
  const identifierError = form.identifierValue.trim().length === 0 ? 'The API requires one identifier.' : null;

  /**
   * Programme window ordering.
   *
   * Both dates are optional, so this only fires when the coordinator has typed
   * both. An expected completion before the start is not a warning worth
   * suppressing: it makes every PGY calculation downstream meaningless, and it
   * is the kind of error only noticed a year later.
   */
  const programmeWindowError = useMemo(() => {
    const start = isCalendarDate(form.startDate) ? form.startDate : null;
    const end = isCalendarDate(form.expectedCompletion) ? form.expectedCompletion : null;

    return {
      start: null as string | null,
      end: start && end && end < start ? 'Completion cannot precede the programme start.' : null,
    };
  }, [form.startDate, form.expectedCompletion]);

  const canSubmit =
    !submitting &&
    form.residentStatus !== null &&
    form.firstName.trim().length > 0 &&
    form.lastName.trim().length > 0 &&
    form.nationality.trim().length > 0 &&
    form.sex !== null &&
    form.citizenship !== null &&
    dobError === null &&
    identifierError === null &&
    // `programmeWindowError` is always an object — `{ start, end }` — so this
    // used to read `programmeWindowError === null`, which is never true and left
    // "Create resident" permanently disabled. The condition that actually matters
    // is whether either message is set.
    programmeWindowError.start === null &&
    programmeWindowError.end === null;

  async function handleSubmit() {
    if (form.sex === null || form.citizenship === null) return;

    setSubmitting(true);
    setSubmitError(null);

    const year = Number.parseInt(form.yearInProgram, 10);

    try {
      const result = await onboardResident({
        personal_info: {
          first_name: form.firstName.trim(),
          ...(form.middleInitial.trim() ? { middle_initial: form.middleInitial.trim() } : {}),
          last_name: form.lastName.trim(),
          date_of_birth: form.dateOfBirth,
          sex: form.sex,
          nationality: form.nationality.trim(),
          citizenship_status: form.citizenship,
        },
        identifiers: [
          {
            identifier_type: form.identifierType,
            identifier_value: form.identifierValue.trim(),
            is_primary: true,
          },
        ],
        enrollment: {
          program_id: programId,
          ...(form.residentStatus ? { resident_status: form.residentStatus } : {}),
          position_type: form.positionType,
          year_in_program: Number.isFinite(year) ? year : 1,
          ...(DATE_PATTERN.test(form.startDate) ? { start_date: form.startDate } : {}),
          ...(DATE_PATTERN.test(form.expectedCompletion)
            ? { expected_completion_date: form.expectedCompletion }
            : {}),
        },
      });

      setCreated({
        id: result.resident_id,
        name: `${result.first_name} ${result.last_name}`,
      });
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'Could not register this resident.');
    } finally {
      setSubmitting(false);
    }
  }

  if (created) {
    return (
      <Screen bottomGutter={spacing.xl}>
        <AppHeader title="Resident registered" onBack={goBack} />
        <Banner
          tone="success"
          title={`${created.name} added`}
          message={`Resident #${created.id} was created and enrolled in this programme in a single transaction.`}
        />
        <Button
          label="Open the resident record"
          onPress={() => router.replace(`/program/resident/${created.id}`)}
        />
      </Screen>
    );
  }

  return (
    <Screen bottomGutter={spacing.xxl}>
      <AppHeader
        title="Register a resident"
        subtitle={`Enrolled in ${session?.programLabel ?? 'this programme'}`}
        onBack={goBack}
      />

      {submitError ? <Banner tone="danger" title="Could not register" message={submitError} /> : null}

      <SectionHeader title="Personal details" />
      <Card>
        <TextField
          label="First name"
          value={form.firstName}
          onChangeText={(value) => setForm((prev) => ({ ...prev, firstName: value }))}
          required
          autoCapitalize="words"
        />
        <TextField
          label="Middle initial"
          value={form.middleInitial}
          onChangeText={(value) => setForm((prev) => ({ ...prev, middleInitial: value }))}
          autoCapitalize="characters"
          hint="Optional."
        />
        <TextField
          label="Last name"
          value={form.lastName}
          onChangeText={(value) => setForm((prev) => ({ ...prev, lastName: value }))}
          required
          autoCapitalize="words"
        />
        <DateField
          label="Date of birth"
          value={form.dateOfBirth}
          onChangeText={(value) => setForm((prev) => ({ ...prev, dateOfBirth: value }))}
          error={dobError}
          required
          // Nobody is born in the future. This is the one date on this form with
          // an unambiguous bound, and it is checked here rather than by the API
          // because a wrong DOB quietly corrupts PGY placement and every
          // age-dependent rule that reads it afterwards.
          maxDate={todayCalendarDate()}
          hint={`YYYY-MM-DD, on or before ${todayCalendarDate()}.`}
        />
        <TextField
          label="Nationality"
          value={form.nationality}
          onChangeText={(value) => setForm((prev) => ({ ...prev, nationality: value }))}
          required
          autoCapitalize="words"
        />
        <SelectField
          label="Sex"
          value={form.sex}
          onChange={(value) => setForm((prev) => ({ ...prev, sex: value }))}
          options={enumOptions.sex}
          required
          hint="The values used by existing residents in this database."
        />
        <SelectField
          label="Citizenship status"
          value={form.citizenship}
          onChange={(value) => setForm((prev) => ({ ...prev, citizenship: value }))}
          options={enumOptions.citizenshipStatus}
          required
        />
      </Card>

      <SectionHeader title="Legal identifier" />
      <Card>
        <SelectField
          label="Identifier type"
          value={form.identifierType}
          onChange={(value) => setForm((prev) => ({ ...prev, identifierType: value }))}
          options={IDENTIFIER_TYPES.map((value) => ({ value, label: humanizeToken(value) }))}
          required
          hint="The API requires at least one identifier row."
        />
        <TextField
          label="Identifier value"
          value={form.identifierValue}
          onChangeText={(value) => setForm((prev) => ({ ...prev, identifierValue: value }))}
          required
          error={identifierError}
          autoCapitalize="characters"
          hint="Stored as the primary identifier for this resident."
        />
      </Card>

      <SectionHeader title="Programme enrollment" />
      <Card>
        <TextField
          label="Year in programme"
          value={form.yearInProgram}
          onChangeText={(value) => setForm((prev) => ({ ...prev, yearInProgram: value }))}
          keyboardType="number-pad"
          hint="1 for PGY-1. Stored as year_in_program."
        />
        <SelectField
          label="Position type"
          value={form.positionType}
          onChange={(value) => setForm((prev) => ({ ...prev, positionType: value }))}
          options={POSITION_TYPES.map((value) => ({ value, label: humanizeToken(value) }))}
          required
        />
        <SelectField
          label="Resident status"
          value={form.residentStatus}
          onChange={(value) => setForm((prev) => ({ ...prev, residentStatus: value }))}
          options={enumOptions.residentStatus}
          required
        />
        <DateField
          label="Programme start date"
          value={form.startDate}
          onChangeText={(value) => setForm((prev) => ({ ...prev, startDate: value }))}
          error={programmeWindowError?.start}
          hint="Optional. Defaults to the programme's first block when omitted."
          maxDate={
            isCalendarDate(form.expectedCompletion) ? form.expectedCompletion : undefined
          }
        />
        <DateField
          label="Expected completion date"
          value={form.expectedCompletion}
          onChangeText={(value) => setForm((prev) => ({ ...prev, expectedCompletion: value }))}
          error={programmeWindowError?.end}
          hint="Optional. Leave blank and it is derived from the programme length."
          minDate={isCalendarDate(form.startDate) ? form.startDate : undefined}
        />
        <Text variant="caption" tone="muted">
          {session?.programCode
            ? `Enrolled into ${session.programLabel ?? 'this'} Program (Code: ${session.programCode}).`
            : `Enrolled into ${session?.programLabel ?? `programme #${programId}`} — the programme you signed in to.`}
        </Text>
      </Card>

      <Button
        label={submitting ? 'Registering…' : 'Register resident'}
        onPress={handleSubmit}
        loading={submitting}
        disabled={!canSubmit}
        style={styles.submit}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  submit: {
    marginTop: spacing.lg,
  },
});
/**
 * Builds select options from the codes already present in the roster.
 *
 * `resident_status` is nullable on `residents` — residents who exist but are not
 * enrolled in a programme have no status — so nulls are dropped rather than
 * becoming an empty chip. Sorts alphabetically so the order is stable between
 * launches instead of following database row order.
 */
function distinctRosterValues(residents: ResidentListItem[]) {
  const pick = (values: (string | null)[]) =>
    [...new Set(values.filter((value): value is string => typeof value === 'string' && value.length > 0))]
      .sort()
      .map((value) => ({ value, label: humanizeToken(value) }));

  return {
    sex: pick(residents.map((resident) => resident.sex)),
    citizenshipStatus: pick(residents.map((resident) => resident.citizenship_status)),
    residentStatus: pick(residents.map((resident) => resident.resident_status)),
  };
}
