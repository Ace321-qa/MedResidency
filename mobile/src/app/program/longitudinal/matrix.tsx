import { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Pencil, Plus, Trash2 } from 'lucide-react-native';

import {
  AppHeader,
  Banner,
  Button,
  Card,
  Screen,
  SectionHeader,
  SelectField,
  Text,
  TextField,
} from '../../../components';
import { useSession } from '../../../hooks';
import {
  fetchCycleSchedule,
  fetchFacultySupervisors,
  updateBackupFaculty,
  updateCycleHeader,
  updateCycleSlot,
} from '../../../services/longitudinal';
import { colors, radius, spacing } from '../../../theme';
import { goBack } from '../../../navigation/back';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday'] as const;

const CLINIC_COLUMNS = Array.from({ length: 10 }, (_, i) => ({
  key: `clinic-${i + 1}`,
  title: `Clinic ${i + 1}`,
  clinicNumber: i + 1,
}));

const SPECIAL_COLUMNS = [
  { key: 'wbc', title: 'WBC - Well Baby Clinic', clinicNumber: 11 },
  { key: 'leaves', title: 'Leaves', clinicNumber: 12 },
];

const ALL_COLUMNS = [...CLINIC_COLUMNS, ...SPECIAL_COLUMNS];

const DAY_CONFIG: Record<string, { shift: string; pgy: string }> = {
  Sunday: { shift: '10:30 – 2:00', pgy: 'PGY-3' },
  Monday: { shift: '10:30 – 2:00', pgy: 'PGY-2' },
  Tuesday: { shift: '07:00 – 2:00', pgy: 'FMC' },
  Wednesday: { shift: '10:30 – 2:00', pgy: 'PGY-1' },
  Thursday: { shift: '07:00 – 2:00', pgy: 'FMC' },
};

export default function LongitudinalMatrixScreen() {
  const { session } = useSession();
  const programId = session?.programId ?? 0;

  const [cycleData, setCycleData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [faculty, setFaculty] = useState<any[]>([]);
  const [editingCell, setEditingCell] = useState<any>(null);
  const [cellForm, setCellForm] = useState({ resident1: '', resident2: '', faculty: '' });

  const facultyOptions = useMemo(
    () => faculty.map((f) => ({ label: `Dr. ${f.first_name} ${f.last_name}`, value: `Dr. ${f.first_name} ${f.last_name}` as any })),
    [faculty]
  );

  useEffect(() => {
    loadData();
  }, [programId]);

  async function loadData() {
    if (!programId) return;
    setLoading(true);
    setError(null);
    try {
      const [cycle, fac] = await Promise.all([
        fetchCycleSchedule(programId),
        fetchFacultySupervisors(programId, { includeInactive: false }),
      ]);
      setCycleData(cycle);
      setFaculty(fac);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  function getSlotForDayAndClinic(day: string, clinicNumber: number) {
    const dayHeader = cycleData?.dailyHeaders?.find((h: any) => h.day_of_week === day);
    if (!dayHeader) return null;
    const slot = cycleData?.slots?.find((s: any) => s.daily_header_id === dayHeader.id && s.clinic_number === clinicNumber);
    return slot || null;
  }

  function getInCharge(day: string) {
    const dayHeader = cycleData?.dailyHeaders?.find((h: any) => h.day_of_week === day);
    if (dayHeader?.in_charge_faculty_name) {
      return dayHeader.in_charge_faculty_name.startsWith('Dr.') ? dayHeader.in_charge_faculty_name : `Dr. ${dayHeader.in_charge_faculty_name}`;
    }
    return '';
  }

  function getBackups(day: string) {
    return cycleData?.backups?.[day] || [];
  }

  async function saveHeader() {
    if (!programId || !cycleData) return;
    setSaving(true);
    try {
      await updateCycleHeader({
        program_id: programId,
        cycle_id: cycleData.cycle?.id,
        cycle_number: cycleData.cycle?.cycle_number,
        week_number: cycleData.cycle?.week_number,
        start_date: cycleData.cycle?.start_date,
        dailyHeaders: cycleData.dailyHeaders?.map((dh: any) => ({
          id: dh.id,
          day_of_week: dh.day_of_week,
          shift_time: dh.shift_time,
          pgy_level: dh.pgy_level,
          in_charge_faculty_name: dh.in_charge_faculty_name,
        })),
      });
      await loadData();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function saveCell() {
    if (!editingCell) return;
    setSaving(true);
    try {
      await updateCycleSlot(editingCell.slot.id, {
        resident_1_name: cellForm.resident1.trim() || null,
        resident_2_name: cellForm.resident2.trim() || null,
        faculty_name: cellForm.faculty.trim() || null,
      });
      setEditingCell(null);
      await loadData();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function saveBackups(day: string, facultyNames: string[]) {
    if (!programId) return;
    setSaving(true);
    try {
      await updateBackupFaculty({
        program_id: programId,
        cycle_id: cycleData?.cycle?.id,
        day_of_week: day,
        faculty_list: facultyNames.filter((n) => n.trim()).map((n) => ({ faculty_name: n.trim().replace(/^Dr\.\s*/i, '') })),
      });
      await loadData();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  const cycle = cycleData?.cycle || {};

  return (
    <Screen>
      <AppHeader title="Primary Care Clinics (CCC)" onBack={goBack} />
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        {error ? <Banner tone="danger" title="Error" message={error} /> : null}

        <Card>
          <SectionHeader title="Cycle Header & Metadata" />
          <View style={styles.row}>
            <TextField label="Cycle Number" value={cycle.cycle_number || ''} onChangeText={(t) => setCycleData({ ...cycleData, cycle: { ...cycle, cycle_number: t } })} />
            <TextField label="Week Number" value={cycle.week_number || ''} onChangeText={(t) => setCycleData({ ...cycleData, cycle: { ...cycle, week_number: t } })} />
          </View>
          <TextField label="Start Date (First Day of Week)" value={cycle.start_date || ''} onChangeText={(t) => setCycleData({ ...cycleData, cycle: { ...cycle, start_date: t } })} placeholder="YYYY-MM-DD" />
          <View style={styles.row}>
            <Button label="Save Header" onPress={saveHeader} loading={saving} disabled={saving} />
          </View>
        </Card>

        {DAYS.map((day) => {
          const config = DAY_CONFIG[day];
          const dayHeader = cycleData?.dailyHeaders?.find((h: any) => h.day_of_week === day);
          return (
            <Card key={day}>
              <SectionHeader title={`${day} (${config.shift}) - ${config.pgy}`} />
              <TextField label={`Shift Time (${day})`} value={dayHeader?.shift_time || config.shift} onChangeText={(t) => {
                const headers = (cycleData.dailyHeaders || []).map((h: any) => h.day_of_week === day ? { ...h, shift_time: t } : h);
                setCycleData({ ...cycleData, dailyHeaders: headers });
              }} />
              <TextField label={`PGY Level / Day Context (${day})`} value={dayHeader?.pgy_level || config.pgy} onChangeText={(t) => {
                const headers = (cycleData.dailyHeaders || []).map((h: any) => h.day_of_week === day ? { ...h, pgy_level: t } : h);
                setCycleData({ ...cycleData, dailyHeaders: headers });
              }} />
              <TextField label={`In-Charge Faculty Lead (${day})`} value={dayHeader?.in_charge_faculty_name || ''} onChangeText={(t) => {
                const headers = (cycleData.dailyHeaders || []).map((h: any) => h.day_of_week === day ? { ...h, in_charge_faculty_name: t } : h);
                setCycleData({ ...cycleData, dailyHeaders: headers });
              }} placeholder="e.g., Dr. Areen" />
              <Button label="Save Day Header" onPress={saveHeader} loading={saving} disabled={saving} />
            </Card>
          );
        })}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: spacing.lg, gap: spacing.lg },
  row: { flexDirection: 'row', gap: spacing.md },
});
