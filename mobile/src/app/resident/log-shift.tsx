import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { TriangleAlert } from 'lucide-react-native';

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
import { useSession } from '../../hooks';
import { logAttendance } from '../../services/attendance';
import { fetchResidentSchedule } from '../../services/rotations';
import { useApiResource } from '../../hooks/useApiResource';
import { spacing } from '../../theme';
import { ATTENDANCE_STATUSES, type AttendanceStatus } from '../../types/api';
import { combineDateAndTime, durationHours, formatHours, humanizeToken, todayCalendarDate, toMysqlDateTime } from '../../utils/format';

/**
 * Log a shift — `POST /api/v1/attendance`.
 *
 * Two decisions worth knowing about:
 *
 * 1. **Leave statuses are first class.** A resident logging sick leave is not
 *    falsifying attendance, so `SICK_LEAVE`, `ANNUAL_LEAVE` and the rest are
 *    real choices, not an "Other" afterthought. Only `OTHER_LEAVE` demands a
 *    written reason, because the API requires `other_leave_specify` for it.
 *
 * 2. **The server decides whether this breaches.** The response contains
 *    `is_flagged_for_breach` and `breach_details`. The app never guesses — it
 *    posts, then shows exactly what the server said, including a red banner when
 *    the shift was flagged.
 */

interface FormState {
  shiftDate: string;
  clockIn: string;
  clockOut: string;
  hours: string;
  status: AttendanceStatus | null;
  otherLeave: string;
  notes: string;
}

const INITIAL: FormState = {
  shiftDate: todayCalendarDate(),
  clockIn: '',
  clockOut: '',
  hours: '',
  status: null,
  otherLeave: '',
  notes: '',
};

/** The API stores DATETIME columns, so times must be sent as full timestamps. */
function toDateTime(date: string, time: string): string | null {
  const combined = combineDateAndTime(date, time);
  return combined ? toMysqlDateTime(combined) : null;
}

export default function LogShiftScreen() {
  const { session } = useSession();
  const residentId = session?.residentId ?? 0;

  const schedule = useApiResource(() => fetchResidentSchedule(residentId), [residentId]);
  const [form, setForm] = useState<FormState>(INITIAL);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [result, setResult] = useState<{ flagged: boolean; details: string | null; hours: string } | null>(null);

  const isLeave = form.status !== null && form.status !== 'PRESENT';

  /** Live total so the resident sees what will be saved before saving it. */
  const computedHours = useMemo(() => {
    if (form.hours.trim()) {
      const parsed = Number.parseFloat(form.hours);
      return Number.isFinite(parsed) ? parsed : null;
    }
    if (form.clockIn && form.clockOut) {
      const start = combineDateAndTime(form.shiftDate, form.clockIn);
      const end = combineDateAndTime(form.shiftDate, form.clockOut);
      if (start && end && end > start) return durationHours(start, end);
    }
    return null;
  }, [form.hours, form.clockIn, form.clockOut, form.shiftDate]);

  const dateError = /^\d{4}-\d{2}-\d{2}$/.test(form.shiftDate) ? null : 'Use the format YYYY-MM-DD.';

  const canSubmit =
    !submitting && dateError === null && form.status !== null && (isLeave || computedHours !== null);

  async function handleSubmit() {
    if (form.status === null) return;
    setSubmitting(true);
    setSubmitError(null);

    try {
      const response = await logAttendance({
        resident_id: residentId,
        shift_date: form.shiftDate,
        attendance_status: form.status,
        ...(form.clockIn ? { clock_in: toDateTime(form.shiftDate, form.clockIn) ?? undefined } : {}),
        ...(form.clockOut ? { clock_out: toDateTime(form.shiftDate, form.clockOut) ?? undefined } : {}),
        ...(computedHours !== null ? { total_hours: computedHours } : {}),
        ...(form.status === 'OTHER_LEAVE' && form.otherLeave.trim()
          ? { other_leave_specify: form.otherLeave.trim() }
          : {}),
        ...(form.notes.trim() ? { notes: form.notes.trim() } : {}),
      });

      setResult({
        flagged: response.is_flagged_for_breach,
        details: response.breach_details,
        hours: formatHours(response.total_hours),
      });
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'Could not save this shift.');
    } finally {
      setSubmitting(false);
    }
  }

  if (result) {
    return (
      <Screen bottomGutter={spacing.xl}>
        <AppHeader title="Shift logged" onBack={() => router.back()} />
        {result.flagged ? (
          <Banner
            tone="danger"
            icon={TriangleAlert}
            title="The server flagged this shift"
            message={result.details ?? 'A duty-hour rule was exceeded. Discuss this with your programme director.'}
          />
        ) : (
          <Banner
            tone="success"
            title="Shift saved"
            message={`${result.hours} recorded for ${form.shiftDate}. No duty-hour rule was triggered.`}
          />
        )}
        <Button
          label="Back to duty hours"
          onPress={() => router.replace('/resident/duty-hours')}
        />
      </Screen>
    );
  }

  return (
    <Screen bottomGutter={spacing.xxl}>
      <AppHeader title="Log a shift" subtitle="Record the hours you worked" onBack={() => router.back()} />

      {submitError ? <Banner tone="danger" title="Could not save" message={submitError} /> : null}

      <Card>
        <DateField
          label="Shift date"
          value={form.shiftDate}
          onChangeText={(value) => setForm((prev) => ({ ...prev, shiftDate: value }))}
          error={dateError}
          required
          hint="YYYY-MM-DD"
        />

        <SelectField
          label="Attendance status"
          value={form.status}
          onChange={(value) => setForm((prev) => ({ ...prev, status: value, hours: '', clockIn: '', clockOut: '' }))}
          options={ATTENDANCE_STATUSES.map((status) => ({ value: status, label: humanizeToken(status) }))}
          required
          hint="Leave and on-call are recorded here too, not as absence."
        />
      </Card>

      {!isLeave ? (
        <>
          <SectionHeader title="Times and hours" />
          <Card>
            <TextField
              label="Clock in"
              value={form.clockIn}
              onChangeText={(value) => setForm((prev) => ({ ...prev, clockIn: value }))}
              placeholder="HH:MM"
              keyboardType="numbers-and-punctuation"
              autoCapitalize="none"
              hint="24-hour time. Leave blank if you did not record it."
            />
            <TextField
              label="Clock out"
              value={form.clockOut}
              onChangeText={(value) => setForm((prev) => ({ ...prev, clockOut: value }))}
              placeholder="HH:MM"
              keyboardType="numbers-and-punctuation"
              autoCapitalize="none"
            />
            <TextField
              label="Total hours"
              value={form.hours}
              onChangeText={(value) => setForm((prev) => ({ ...prev, hours: value }))}
              placeholder={computedHours !== null && !form.hours.trim() ? String(computedHours) : '0'}
              keyboardType="decimal-pad"
              hint="Leave blank to use the difference between clock in and clock out."
            />

            {computedHours !== null ? (
              <View style={styles.computed}>
                <Text variant="caption" tone="secondary">
                  This shift will be saved as {formatHours(computedHours)}.
                </Text>
              </View>
            ) : null}
          </Card>
        </>
      ) : null}

      {form.status === 'OTHER_LEAVE' ? (
        <>
          <SectionHeader title="Reason" />
          <Card>
            <TextField
              label="Specify the leave type"
              value={form.otherLeave}
              onChangeText={(value) => setForm((prev) => ({ ...prev, otherLeave: value }))}
              placeholder="e.g.bereavement leave"
              required
              hint="The API requires a description when the status is OTHER_LEAVE."
            />
          </Card>
        </>
      ) : null}

      <SectionHeader title="Notes" />
      <Card>
        <TextField
          label="Notes (optional)"
          value={form.notes}
          onChangeText={(value) => setForm((prev) => ({ ...prev, notes: value }))}
          multiline
          placeholder="Anything your programme director should know"
        />
      </Card>

      <View style={styles.submit}>
        <Button
          label={submitting ? 'Saving…' : 'Save shift'}
          onPress={handleSubmit}
          loading={submitting}
          disabled={!canSubmit}
        />
        <Text variant="caption" tone="muted" align="center">
          {schedule.data && schedule.data.length > 0
            ? 'Your coordinator sees this shift as soon as it is saved.'
            : 'The shift is saved against your resident record immediately.'}
        </Text>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  computed: {
    marginTop: spacing.xs,
  },
  submit: {
    marginTop: spacing.lg,
    gap: spacing.sm,
  },
});