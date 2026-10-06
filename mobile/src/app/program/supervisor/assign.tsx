import { useMemo, useState } from 'react';
import { View } from 'react-native';

import {
  AppHeader,
  Banner,
  Button,
  Card,
  DateField,
  FacultyPicker,
  Screen,
  SectionHeader,
  SelectField,
  TextField,
  type SelectOption,
} from '../../../components';
import { useApiResource, useSession } from '../../../hooks';
import {
  createSupervisorAssignment,
  fetchClinicTypes,
  fetchFacultySupervisors,
} from '../../../services/longitudinal';
import { describeWindow, evaluationEndDate, isCalendarDate } from '../../../utils/dateCalc';
import { spacing } from '../../../theme';
import { goBack } from '../../../navigation/back';

/**
 * Assign a faculty supervisor to a clinic — `POST /longitudinal/supervisor-assignments`.
 *
 * ### The end date is computed, not chosen
 *
 * A supervision posting runs for `rotation_period_months` (three by default) from
 * its start date, so the evaluation end date is **derived**, not typed. Two
 * reasons it is not a free field:
 *
 *  - The server derives it too, and rejects a supplied end date that disagrees
 *    with the period (`longitudinalService.createSupervisorAssignment`). So a
 *    hand-typed date is either redundant or an error.
 *  - The field stays visible but read-only, showing the derived value. Hiding it
 *    would make the posting's duration a mystery; letting it be typed would
 *    promise something the API will refuse.
 *
 * ### Why the faculty list is searchable
 *
 * `getFacultySupervisors` now filters to `is_active = 1` on the server. A
 * programme's faculty list is long enough that a wrapping chip group is unusable,
 * so `FacultyPicker` searches by name, title or email and keeps the inactive
 * people one toggle away rather than hiding them.
 */

interface SupervisorForm {
  clinicTypeId: string;
  facultySupervisorId: number | null;
  startDate: string;
  rotationPeriodMonths: string;
}

const INITIAL_FORM: SupervisorForm = {
  clinicTypeId: '',
  facultySupervisorId: null,
  startDate: '',
  rotationPeriodMonths: '3',
};

export default function SupervisorAssignScreen() {
  const { session } = useSession();
  const programId = session?.programId ?? 0;

  const clinicTypes = useApiResource(() => fetchClinicTypes(programId), [programId]);
  /**
 * Inactive faculty are requested too.
 *
 * The server filters to `is_active = 1` unless asked not to. Asking here is what
 * makes `FacultyPicker`'s "Include N inactive" toggle do anything: without the
 * inactive rows in the payload that count is always zero and the control never
 * appears. A posting that is still running needs to be editable after its
 * supervisor has left, which is exactly when the person is inactive.
 */
  const faculty = useApiResource(
    () => fetchFacultySupervisors(programId, { includeInactive: true }),
    [programId],
  );

  const [form, setForm] = useState<SupervisorForm>(INITIAL_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const months = Number.parseInt(form.rotationPeriodMonths, 10);

  const clinicTypeOptions = useMemo<SelectOption<string>[]>(
    () =>
      (clinicTypes.data ?? []).map((clinic) => ({
        value: String(clinic.id),
        label: clinic.clinic_code ? `${clinic.clinic_name} (${clinic.clinic_code})` : clinic.clinic_name,
      })),
    [clinicTypes.data],
  );

  const facultyOptions = useMemo(
    () =>
      (faculty.data ?? []).map((person) => ({
        id: person.id,
        name: `${person.first_name} ${person.last_name}`,
        title: person.title,
        email: person.email,
        phone: person.phone,
        isActive: person.is_active === 1,
      })),
    [faculty.data],
  );

  /**
   * The derived evaluation window.
   *
   * Computed on every render rather than stored in form state: a value that has
   * to be kept in sync is a value that will drift, and this one has two inputs
   * (start date, period) that can each change.
   */
  const derivedEndDate = useMemo(() => {
    if (!isCalendarDate(form.startDate) || !Number.isInteger(months) || months <= 0) return null;
    return evaluationEndDate(form.startDate, months);
  }, [form.startDate, months]);

  const clinicTypeError = form.clinicTypeId ? null : 'Choose the clinic this supervisor covers.';
  const facultyError = form.facultySupervisorId ? null : 'Choose a faculty supervisor.';
  const startError = !form.startDate ? null : isCalendarDate(form.startDate) ? null : 'Use YYYY-MM-DD.';
  const monthsError =
    /^\d{1,2}$/.test(form.rotationPeriodMonths) && months > 0 ? null : 'Enter a whole number of months above 0.';
  const endError = derivedEndDate ? null : 'Choose a start date to derive the evaluation end date.';

  const canSubmit =
    !submitting && !clinicTypeError && !facultyError && !startError && !monthsError && !endError;

  async function handleSubmit() {
    if (form.facultySupervisorId === null || !derivedEndDate) return;

    setSubmitting(true);
    setError(null);

    try {
      await createSupervisorAssignment({
        program_id: programId,
        clinic_type_id: parseInt(form.clinicTypeId, 10),
        faculty_supervisor_id: form.facultySupervisorId,
        start_date: form.startDate,
        // Sent explicitly, and equal to the derived value by construction, so a
        // server-side change to the derivation surfaces as a visible conflict
        // rather than as a silent difference.
        end_date: derivedEndDate,
        rotation_period_months: months,
      });
      setSuccess(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not assign this supervisor.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Screen bottomGutter={spacing.xxl}>
      <AppHeader
        title="Assign Faculty Supervisor"
        subtitle={session?.programLabel ?? undefined}
        onBack={goBack}
      />

      {error ? <Banner tone="danger" title="Could not assign the supervisor" message={error} /> : null}
      {success ? (
        <Banner
          tone="success"
          title="Supervisor assigned"
          message="The posting now appears in the CCC matrix."
        />
      ) : null}

      <SectionHeader title="Details" />
      <Card>
        <SelectField
          label="Clinic Type"
          value={form.clinicTypeId || null}
          onChange={(value) => setForm((prev) => ({ ...prev, clinicTypeId: value }))}
          options={clinicTypeOptions}
          error={clinicTypeError}
          required
        />

        <FacultyPicker
          label="Faculty Supervisor"
          value={form.facultySupervisorId}
          options={facultyOptions}
          onChange={(id) => setForm((prev) => ({ ...prev, facultySupervisorId: id }))}
          error={facultyError}
          loading={faculty.isLoading}
          hint={
            facultyOptions.length > 0
              ? `${facultyOptions.filter((person) => person.isActive).length} active of ${facultyOptions.length} recorded.`
              : undefined
          }
          required
        />

        <DateField
          label="Start Date"
          value={form.startDate}
          onChangeText={(value) => setForm((prev) => ({ ...prev, startDate: value }))}
          error={startError}
          required
        />

        <TextField
          label="Rotation Period (months)"
          value={form.rotationPeriodMonths}
          onChangeText={(value) => setForm((prev) => ({ ...prev, rotationPeriodMonths: value }))}
          keyboardType="number-pad"
          error={monthsError}
          hint="How long the posting runs. Three months is the programme default."
          required
        />

        {/**
         * The derived end date, shown but not editable.
         *
         * `editable={false}` rather than omitting the field: the coordinator needs
         * to see when the evaluation closes, and a read-only field says that
         * without pretending it is theirs to change.
         */}
        <View style={styles.derivedBlock}>
          <TextField
            label="Evaluation End Date"
            value={derivedEndDate ?? ''}
            onChangeText={() => undefined}
            editable={false}
            error={endError}
            hint={
              derivedEndDate
                ? `${months} month${months === 1 ? '' : 's'} from ${form.startDate} · ${describeWindow(form.startDate, derivedEndDate)}`
                : 'Derived from the start date and the rotation period.'
            }
          />
        </View>
      </Card>

      <Button
        label={submitting ? 'Assigning…' : 'Assign Supervisor'}
        onPress={handleSubmit}
        disabled={!canSubmit}
        loading={submitting}
      />
    </Screen>
  );
}

const styles = {
  derivedBlock: {
    opacity: 0.95,
  },
};