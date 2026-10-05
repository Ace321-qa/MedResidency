import { useState, useMemo } from 'react';
import { router } from 'expo-router';
import { useSession, useApiResource } from '../../../hooks';
import { fetchRotationBlocks, fetchRotations, createAssignment } from '../../../services/rotations';
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
} from '../../../components';
import { spacing } from '../../../theme';

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
  const academicYears = useMemo(() => ['2026/2027', '2027/2028', '2028/2029'], []);
  const [academicYear, setAcademicYear] = useState(academicYears[0]);
  const blocks = useApiResource(() => fetchRotationBlocks(programId), [programId]);
  const rotations = useApiResource(() => fetchRotations(programId), [programId]);
  const residents = useApiResource(() => fetchResidentList({ programId }), [programId]);
  
  const blocksForYear = useMemo(() => (blocks.data ?? []).filter(b => b.academic_year === academicYear).sort((a,b) => a.block_number - b.block_number), [blocks.data, academicYear]);
  
  const [form, setForm] = useState<AssignmentForm>(INITIAL_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const residentIdError = form.residentId ? null : 'Choose the resident this rotation is for.';
  const blockIdError = form.rotationBlockId ? null : 'Choose the block the rotation sits inside.';
  const rotationIdError = form.rotationId ? null : 'Choose a rotation.';
  const startError = form.startDate ? null : 'Use YYYY-MM-DD.';
  const endError = form.endDate ? null : 'Use YYYY-MM-DD.';

  const canSubmit = !submitting && !residentIdError && !blockIdError && !rotationIdError && !startError && !endError;

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
      <AppHeader title="New Rotation Assignment" onBack={() => router.back()} />
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
        <SelectField
          label="Resident"
          value={form.residentId || null}
          onChange={(value) => setForm((prev) => ({ ...prev, residentId: value }))}
          options={(residents.data ?? []).map((r) => ({
            value: String(r.resident_id),
            label: `${r.first_name} ${r.last_name}`,
          }))}
          error={residentIdError}
          required
        />
        <SelectField
          label="Block"
          value={form.rotationBlockId || null}
          onChange={(value) =>
            setForm((prev) => {
              const block = blocksForYear.find((b) => String(b.block_id) === value);
              return {
                ...prev,
                rotationBlockId: value,
                startDate: block?.start_date?.slice(0, 10) ?? '',
                endDate: block?.end_date?.slice(0, 10) ?? '',
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
        <SelectField
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
          required
        />
        <DateField
          label="End Date"
          value={form.endDate}
          onChangeText={(v) => setForm((prev) => ({ ...prev, endDate: v }))}
          error={endError}
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
