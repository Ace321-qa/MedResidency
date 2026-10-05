import { useState, useMemo } from 'react';
import { ScrollView, View, StyleSheet } from 'react-native';
import { useSession, useApiResource } from '../../../hooks';
import { fetchAllLongitudinalAssignments, fetchFacultySupervisors, fetchSupervisorAssignments } from '../../../services/longitudinal';
import { fetchClinicTypes } from '../../../services/longitudinal';
import { SelectField } from '../../../components/Form';
import { Screen, AppHeader, Text } from '../../../components';
import { spacing } from '../../../theme';

export default function LongitudinalMatrixScreen() {
  const { session } = useSession();
  const programId = session?.programId ?? 0;
  const clinicTypes = useApiResource(() => fetchClinicTypes(programId), [programId]);
  const [clinicTypeId, setClinicTypeId] = useState<string>('');
  const assignments = useApiResource(() => fetchAllLongitudinalAssignments(programId), [programId]);
  const faculty = useApiResource(() => fetchFacultySupervisors(programId), [programId]);

  /**
   * `'ALL'` means "do not filter" — an empty `clinicTypeId` is the sentinel for
   * that, and `SelectField` needs a selectable chip for it because the clinic
   * type list is the only thing that otherwise narrows the matrix.
   */
  const clinicTypeOptions = useMemo(
    () => [
      { value: 'ALL', label: 'All' },
      ...(clinicTypes.data ?? []).map((c) => ({ value: String(c.id), label: c.clinic_name })),
    ],
    [clinicTypes.data],
  );
  const selectedClinicTypeId = clinicTypeId === '' ? 'ALL' : clinicTypeId;

  const supervisors = useApiResource(() => fetchSupervisorAssignments(programId, selectedClinicTypeId !== 'ALL' ? parseInt(selectedClinicTypeId) : undefined), [programId, selectedClinicTypeId]);

  const filtered = useMemo(() => {
    if (selectedClinicTypeId === 'ALL') return assignments.data ?? [];
    return (assignments.data ?? []).filter(a => String(a.clinic_type_id) === selectedClinicTypeId);
  }, [assignments.data, selectedClinicTypeId]);

  return (
    <Screen>
      <AppHeader title="Health Center Master Matrix (CCC)" />
      <View style={styles.filters}>
        <SelectField
          label="Clinic Type"
          value={selectedClinicTypeId}
          onChange={setClinicTypeId}
          options={clinicTypeOptions}
        />
      </View>
      <ScrollView>
        <View style={styles.table}>
          <View style={styles.row}>
            <Text style={[styles.cell, styles.header]}>Resident</Text>
            <Text style={[styles.cell, styles.header]}>Day</Text>
            <Text style={[styles.cell, styles.header]}>Time</Text>
            <Text style={[styles.cell, styles.header]}>Site</Text>
            <Text style={[styles.cell, styles.header]}>Supervisor</Text>
          </View>
          {filtered.map((a, idx) => (
            <View key={idx} style={styles.row}>
              <Text style={styles.cell}>{a.resident_name || '-'}</Text>
              <Text style={styles.cell}>{a.day_of_week || '-'}</Text>
              <Text style={styles.cell}>{a.start_time || '-'} - {a.end_time || '-'}</Text>
              <Text style={styles.cell}>{a.site_name || '-'}</Text>
              <Text style={styles.cell}>{a.supervisor_name || '-'}</Text>
            </View>
          ))}
        </View>
        <Text style={{ marginTop: spacing.md }}>Supervisor Assignments: {supervisors.data?.length || 0}</Text>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  filters: { gap: spacing.sm, marginBottom: spacing.md },
  table: { borderWidth: 1, borderColor: '#ddd' },
  row: { flexDirection: 'row' },
  cell: { padding: 8, borderWidth: 1, borderColor: '#ddd', minWidth: 120, flex: 1 },
  header: { fontWeight: 'bold', backgroundColor: '#f5f5f5' },
});
