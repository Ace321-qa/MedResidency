import { useState, useEffect } from 'react';
import { router, useLocalSearchParams } from 'expo-router';

import {
  AppHeader,
  Banner,
  Button,
  Card,
  DateField,
  Screen,
  SectionHeader,
  TextField,
} from '../../../components';
import { useSession } from '../../../hooks';
import { fetchRotationBlocks, updateRotationBlock, deleteRotationBlock } from '../../../services/rotations';
import { spacing } from '../../../theme';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

interface FormState {
  academicYear: string;
  blockNumber: string;
  blockName: string;
  startDate: string;
  endDate: string;
}

export default function EditBlockScreen() {
  const { session } = useSession();
  const programId = session?.programId ?? 0;
  const { id } = useLocalSearchParams<{ id: string }>();
  const blockId = parseInt(id || '0', 10);

  const [form, setForm] = useState<FormState>({
    academicYear: '',
    blockNumber: '',
    blockName: '',
    startDate: '',
    endDate: '',
  });
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasDeps, setHasDeps] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const blocks = await fetchRotationBlocks(programId);
        const block = blocks.find(b => b.block_id === blockId);
        if (block) {
          setForm({
            academicYear: block.academic_year,
            blockNumber: block.block_number.toString(),
            blockName: block.block_name,
            startDate: block.start_date.slice(0, 10),
            endDate: block.end_date.slice(0, 10),
          });
        } else {
          setError('Block not found');
        }
      } catch (e: any) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, [programId, blockId]);

  const startError = DATE_PATTERN.test(form.startDate) ? null : 'Use YYYY-MM-DD.';
  const endError = !DATE_PATTERN.test(form.endDate)
    ? 'Use YYYY-MM-DD.'
    : form.endDate < form.startDate
      ? 'The end date must be on or after the start date.'
      : null;
  const blockNumber = Number.parseInt(form.blockNumber, 10);
  const blockNumberError = Number.isInteger(blockNumber) && blockNumber > 0 ? null : 'Enter a whole number above 0.';

  const canSubmit = !submitting && startError === null && endError === null && blockNumberError === null && form.blockName.trim().length > 0;

  async function handleUpdate() {
    setSubmitting(true);
    setError(null);
    try {
      await updateRotationBlock(blockId, {
        program_id: programId,
        academic_year: form.academicYear.trim(),
        block_number: blockNumber,
        block_name: form.blockName.trim(),
        start_date: form.startDate,
        end_date: form.endDate,
      });
      router.replace('/program/rotations');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete() {
    if (hasDeps) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteRotationBlock(blockId);
      router.replace('/program/rotations');
    } catch (e: any) {
      setError(e.message);
      if (e.message && e.message.toLowerCase().includes('dependent')) setHasDeps(true);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Screen bottomGutter={spacing.xxl}>
      <AppHeader title="Edit academic block" onBack={() => router.back()} />
      {error ? <Banner tone="danger" title="Error" message={error} /> : null}
      <SectionHeader title="Block" />
      <Card>
        <TextField label="Block name" value={form.blockName} onChangeText={(v) => setForm(prev => ({ ...prev, blockName: v }))} required />
        <TextField label="Academic year" value={form.academicYear} onChangeText={(v) => setForm(prev => ({ ...prev, academicYear: v }))} required />
        <TextField label="Block number" value={form.blockNumber} onChangeText={(v) => setForm(prev => ({ ...prev, blockNumber: v }))} keyboardType="number-pad" error={blockNumberError} required />
      </Card>
      <SectionHeader title="Dates" />
      <Card>
        <DateField label="Start date" value={form.startDate} onChangeText={(v) => setForm(prev => ({ ...prev, startDate: v }))} error={startError} required />
        <DateField label="End date" value={form.endDate} onChangeText={(v) => setForm(prev => ({ ...prev, endDate: v }))} error={endError} required />
      </Card>
      <Button label={submitting ? 'Updating...' : 'Update block'} onPress={handleUpdate} disabled={!canSubmit || loading} loading={submitting} />
      <Button label={deleting ? 'Deleting...' : 'Delete block'} onPress={handleDelete} disabled={deleting || loading || hasDeps} variant="danger" style={{ marginTop: 8 }} />
    </Screen>
  );
}
