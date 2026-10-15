import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { Moon, TriangleAlert } from 'lucide-react-native';

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
  TimeField,
} from '../../components';
import { useSession } from '../../hooks';
import { goBack } from '../../navigation/back';
import { logAttendance, logTimesheetBatch } from '../../services/attendance';
import { fetchResidentSchedule } from '../../services/rotations';
import { useApiResource } from '../../hooks/useApiResource';
import { colors, radius, spacing } from '../../theme';
import { ATTENDANCE_STATUSES, type AttendanceStatus, type TimesheetRowInput } from '../../types/api';
import { formatHours, humanizeToken, todayCalendarDate } from '../../utils/format';

/**
 * Log a shift — `POST /api/v1/attendance` or `/attendance/batch`.
 *
 * A duty-hours row is **one calendar day**. Clock in and clock out are bare
 * `HH:MM` times on the shift date, and `24:00` closes the day. So the screen has
 * one date, two times, and one rule:
 *
 *  - If the out time is on or after the in time (including `24:00`), the shift
 *    fits inside its day and is saved as a single row.
 *  - If the out time lands *before* the in time, the shift crosses midnight. It
 *    is split — `08:00 → 24:00` on the shift date, `00:00 → 06:00` the next
 *    day — and both rows go to `/attendance/batch`, so the server reads them as
 *    the one continuous period they are. The screen previews the split before
 *    saving, because two rows appearing where one shift was typed is a surprise
 *    otherwise.
 *
 * Two further decisions worth knowing about:
 *
 * 1. **Leave statuses are first class.** A resident logging sick leave is not
 *    falsifying attendance, so `SICK_LEAVE`, `ANNUAL_LEAVE` and the rest are
 *    real choices, not an "Other" afterthought. Only `OTHER_LEAVE` demands a
 *    written reason, because the API requires `other_leave_specify` for it.
 *
 * 2. **The server decides whether this breaches.** The response contains the
 *    flag and its details. The app never guesses — it posts, then shows exactly
 *    what the server said, including a red banner when the shift was flagged.
 */

const MINUTES_PER_DAY = 24 * 60;

const COMMON_NOTES = [
  'Regular shift',
  'On-call',
  'Night shift',
  'Post-call',
  'Teaching session',
  'Clinic',
  'Rounds',
  'Call room',
];

interface FormState {
  shiftDate: string;
  clockInTime: string;
  clockOutTime: string;
  hours: string;
  status: AttendanceStatus | null;
  otherLeave: string;
  notes: string;
}

const TODAY = todayCalendarDate();

const INITIAL: FormState = {
  shiftDate: TODAY,
  clockInTime: '',
  clockOutTime: '',
  hours: '',
  status: null,
  otherLeave: '',
  notes: '',
};

/**
 * `HH:MM` → minutes past midnight, accepting `24:00` as the day's end.
 * Returns null for anything that is not a time on the shift day.
 */
function minutesOf(time: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (minutes > 59) return null;
  if (hours === 24 && minutes === 0) return MINUTES_PER_DAY;
  if (hours > 23) return null;
  return hours * 60 + minutes;
}

/** Minutes past midnight → `HH:MM`, rendering `1440` as `24:00`. */
function timeOf(minutes: number): string {
  if (minutes === MINUTES_PER_DAY) return '24:00';
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** `YYYY-MM-DD` moved by whole days, staying a calendar day. */
function addDays(date: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(date.trim());
  if (!match) return date;
  const moved = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  moved.setUTCDate(moved.getUTCDate() + days);
  return moved.toISOString().slice(0, 10);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
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

  const inMinutes = minutesOf(form.clockInTime);
  const outMinutes = minutesOf(form.clockOutTime);

  // A shift whose out time is before its in time crosses midnight.
  const isSplit = inMinutes !== null && outMinutes !== null && outMinutes < inMinutes;

  /** Live total, including a shift that spans the split. */
  const computedHours = useMemo(() => {
    if (form.hours.trim()) {
      const parsed = Number.parseFloat(form.hours);
      return Number.isFinite(parsed) ? parsed : null;
    }
    if (inMinutes === null || outMinutes === null || outMinutes === inMinutes) return null;
    const minutes = outMinutes > inMinutes ? outMinutes - inMinutes : MINUTES_PER_DAY - inMinutes + outMinutes;
    return round2(minutes / 60);
  }, [form.hours, inMinutes, outMinutes]);

  /** The two rows an overnight shift becomes, or null when it fits one day. */
  const splitRows = useMemo<TimesheetRowInput[] | null>(() => {
    if (!isSplit || inMinutes === null || outMinutes === null || form.status === null) return null;
    return [
      {
        shift_date: form.shiftDate,
        clock_in: timeOf(inMinutes),
        clock_out: '24:00',
        total_hours: round2((MINUTES_PER_DAY - inMinutes) / 60),
        attendance_status: form.status,
      },
      {
        shift_date: addDays(form.shiftDate, 1),
        clock_in: '00:00',
        clock_out: timeOf(outMinutes),
        total_hours: round2(outMinutes / 60),
        attendance_status: form.status,
      },
    ];
  }, [isSplit, inMinutes, outMinutes, form.shiftDate, form.status]);

  const dateError = /^\d{4}-\d{2}-\d{2}$/.test(form.shiftDate) ? null : 'Use the format YYYY-MM-DD.';

  // Clock times are hour-and-minute only. A time that cannot be read as `HH:MM`
  // (or `24:00` for an end) is rejected here rather than silently dropped.
  const clockInError =
    form.clockInTime.trim() && inMinutes === null ? 'Use HH:MM, in 24-hour time.' : undefined;

  const clockOutError = useMemo(() => {
    if (!form.clockOutTime.trim()) return undefined;
    if (outMinutes === null) return 'Use HH:MM, between 00:00 and 24:00.';
    if (inMinutes !== null && outMinutes === inMinutes) return 'Clock out must be after clock in.';
    return undefined;
  }, [form.clockOutTime, inMinutes, outMinutes]);

  const canSubmit =
    !submitting &&
    dateError === null &&
    form.status !== null &&
    (isLeave || (computedHours !== null && !clockInError && !clockOutError));

  async function handleSubmit() {
    if (form.status === null) return;
    setSubmitting(true);
    setSubmitError(null);

    try {
      if (splitRows) {
        // Overnight: two calendar rows, judged together by the server.
        const response = await logTimesheetBatch(residentId, splitRows);
        setResult({
          flagged: response.breaches.violations.length > 0,
          details: response.breaches.violations[0]?.details ?? null,
          hours: formatHours(computedHours),
        });
      } else {
        const response = await logAttendance({
          resident_id: residentId,
          shift_date: form.shiftDate,
          attendance_status: form.status,
          ...(form.clockInTime.trim() ? { clock_in: form.clockInTime.trim() } : {}),
          ...(form.clockOutTime.trim() ? { clock_out: form.clockOutTime.trim() } : {}),
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
      }
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'Could not save this shift.');
    } finally {
      setSubmitting(false);
    }
  }

  if (result) {
    return (
      <Screen bottomGutter={spacing.xl}>
        <AppHeader title="Shift logged" onBack={goBack} />
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
      <AppHeader title="Log a shift" subtitle="Record the hours you worked" onBack={goBack} />

      {submitError ? <Banner tone="danger" title="Could not save" message={submitError} /> : null}

      <Card>
        <DateField
          label="Shift date"
          value={form.shiftDate}
          onChangeText={(value) => setForm((prev) => ({ ...prev, shiftDate: value }))}
          error={dateError}
          required
          // A resident records a shift they have already worked. Allowing a
          // future date here produces duty hours that inflate the totals the
          // programme is measured on, and the error only surfaces weeks later in
          // a compliance report.
          maxDate={todayCalendarDate()}
          hint="Back-fill a past shift, or pick today."
        />

        <SelectField
          label="Attendance status"
          value={form.status}
          onChange={(value) =>
            setForm((prev) => ({
              ...prev,
              status: value,
              hours: '',
              clockInTime: '',
              clockOutTime: '',
            }))
          }
          options={ATTENDANCE_STATUSES.map((status) => ({ value: status, label: humanizeToken(status) }))}
          required
          hint="Leave and on-call are recorded here too, not as absence."
        />
      </Card>

      {!isLeave ? (
        <>
          <SectionHeader title="Shift times" />
          <Card>
            <TimeField
              label="Clock in time"
              value={form.clockInTime}
              onChangeText={(value) => setForm((prev) => ({ ...prev, clockInTime: value }))}
              error={clockInError}
              hint="24-hour time on the shift date."
            />
            <TimeField
              label="Clock out time"
              value={form.clockOutTime}
              onChangeText={(value) => setForm((prev) => ({ ...prev, clockOutTime: value }))}
              error={clockOutError}
              allowEndOfDay
              hint="Same day, up to 24:00. An out time before the in time is an overnight shift and is split into two days."
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

          {splitRows ? (
            <Banner
              tone="info"
              icon={Moon}
              title="This shift crosses midnight"
              message={`It is saved as two days, so the hours land on the day they were worked:\n• ${splitRows[0].shift_date} — ${splitRows[0].clock_in} to ${splitRows[0].clock_out} (${formatHours(splitRows[0].total_hours)})\n• ${splitRows[1].shift_date} — ${splitRows[1].clock_in} to ${splitRows[1].clock_out} (${formatHours(splitRows[1].total_hours)})`}
            />
          ) : null}
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
        <Text variant="label" tone="secondary" uppercase style={styles.commonLabel}>
          Common choices
        </Text>
        <View style={styles.chipGroup}>
          {COMMON_NOTES.map((note) => {
            const selected = form.notes.trim() === note;
            return (
              <Pressable
                key={note}
                onPress={() => setForm((prev) => ({ ...prev, notes: prev.notes.trim() === note ? '' : note }))}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                style={({ pressed }) => [
                  styles.chip,
                  selected ? styles.chipSelected : null,
                  pressed && !selected ? styles.chipPressed : null,
                ]}
              >
                <Text variant="bodySmall" style={selected ? styles.chipTextSelected : styles.chipText}>
                  {note}
                </Text>
              </Pressable>
            );
          })}
        </View>
        <TextField
          label="Notes (optional)"
          value={form.notes}
          onChangeText={(value) => setForm((prev) => ({ ...prev, notes: value }))}
          multiline
          placeholder="Or type your own notes here..."
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
  commonLabel: {
    marginBottom: spacing.sm,
  },
  chipGroup: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xxs,
    minHeight: 36,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipSelected: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  chipPressed: {
    backgroundColor: colors.primarySoft,
  },
  chipText: {
    color: colors.textSecondary,
  },
  chipTextSelected: {
    color: colors.onPrimary,
    fontWeight: '600',
  },
  submit: {
    marginTop: spacing.lg,
    gap: spacing.sm,
  },
});
