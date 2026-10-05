import { useState } from 'react';
import { router } from 'expo-router';
import { useSession, useApiResource } from '../../../hooks';
import { fetchClinicTypes, fetchFacultySupervisors, createSupervisorAssignment } from '../../../services/longitudinal';
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
} from '../../../components';
import { spacing } from '../../../theme';

interface SupervisorForm {
  clinicTypeId: string;
  facultySupervisorId: string;
  startDate: string;
  endDate: string;
  rotationPeriodMonths: string;
}

const INITIAL_FORM: SupervisorForm = {
  clinicTypeId: '',
  facultySupervisorId: '',
  startDate: '',
  endDate: '',
  rotationPeriodMonths: '3',
};

export default function SupervisorAssignScreen() {
  const { session } = useSession();
  const programId = session?.programId ?? 0;
  const clinicTypes = useApiResource(() => fetchClinicTypes(programId), [programId]);
  const faculty = useApiResource(() => fetchFacultySupervisors(programId), [programId]);
  
  const [form, setForm] = useState<SupervisorForm>(INITIAL_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const clinicTypeError = form.clinicTypeId ? null : 'Choose the clinic this supervisor covers.';
  const facultyError = form.facultySupervisorId ? null : 'Choose a faculty supervisor.';
  const startError = form.startDate ? null : 'Use YYYY-MM-DD.';
  const endError = form.endDate ? null : 'Use YYYY-MM-DD.';
  const monthsError =
    /^\d{1,2}$/.test(form.rotationPeriodMonths) && Number.parseInt(form.rotationPeriodMonths, 10) > 0
      ? null
      : 'Enter a whole number of months above 0.';

  const canSubmit =
    !submitting && !clinicTypeError && !facultyError && !startError && !endError && !monthsError;

  async function handleSubmit() {
    setSubmitting(true);
    setError(null);
    try {
      await createSupervisorAssignment({
        program_id: programId,
        clinic_type_id: parseInt(form.clinicTypeId, 10),
        faculty_supervisor_id: parseInt(form.facultySupervisorId, 10),
        start_date: form.startDate,
        end_date: form.endDate,
        rotation_period_months: parseInt(form.rotationPeriodMonths, 10),
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
      <AppHeader title="Assign Faculty Supervisor" onBack={() => router.back()} />
      {error ? <Banner tone="danger" title="Error" message={error} /> : null}
      {success ? <Banner tone="success" title="Success" message="Supervisor assigned" /> : null}
      <SectionHeader title="Details" />
      <Card>
        <SelectField
          label="Clinic Type"
          value={form.clinicTypeId || null}
          onChange={(v) => setForm((prev) => ({ ...prev, clinicTypeId: v }))}
          options={(clinicTypes.data ?? []).map((c) => ({ value: String(c.id), label: c.clinic_name }))}
          error={clinicTypeError}
          required
        />
        <SelectField
          label="Faculty Supervisor"
          value={form.facultySupervisorId || null}
          onChange={(v) => setForm((prev) => ({ ...prev, facultySupervisorId: v }))}
          options={(faculty.data ?? []).map((f) => ({
            value: String(f.id),
            // `getFacultySupervisors` does not filter on `is_active`, so the
            // list can contain people who have left. Mark them rather than
            // hiding them, so a coordinator can still pick one deliberately.
            label: `${f.first_name} ${f.last_name}${f.is_active ? '' : ' (inactive)'}`,
          }))}
          error={facultyError}
          required
        />
        <DateField
          label="Start Date"
          value={form.startDate}
          onChangeText={(v) => setForm((prev) => ({ ...prev, startDate: v }))}
          error={startError}
          required
        />
        <DateField
          label="End Date"
          value={form.endDate}
          onChangeText={(v) => setForm((prev) => ({ ...prev, endDate: v }))}
          error={endError}
          required
        />
        <TextField
          label="Rotation Period (months)"
          value={form.rotationPeriodMonths}
          onChangeText={(v) => setForm((prev) => ({ ...prev, rotationPeriodMonths: v }))}
          keyboardType="number-pad"
          error={monthsError}
          required
        />
      </Card>
      <Button
        label={submitting ? 'Assigning...' : 'Assign Supervisor'}
        onPress={handleSubmit}
        disabled={!canSubmit}
        loading={submitting}
      />
    </Screen>
  );
}
