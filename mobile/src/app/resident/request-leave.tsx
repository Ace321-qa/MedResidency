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
import { useSession } from '../../hooks';
import { goBack } from '../../navigation/back';
import { submitLeaveRequest } from '../../services/leaves';
import { spacing } from '../../theme';
import { LEAVE_TYPES, type LeaveType } from '../../types/api';
import { humanizeToken, todayCalendarDate } from '../../utils/format';

/**
 * Request leave — `POST /api/v1/leaves/request`.
 *
 * The form validates the same things the API does, but it validates them locally
 * first so a resident gets an instant, specific message instead of a round trip
 * and a generic 400. Two cases matter:
 *
 *  - `OTHER_LEAVE` requires `other_leave_specify`, so the field only appears
 *    once that type is chosen.
 *  - The server derives `total_days` from the date range when it is omitted, so
 *    the day count shown here is a preview and the stored value comes from the
 *    server's own calendar arithmetic.
 */

interface FormState {
  leaveType: LeaveType | null;
  otherLeave: string;
  startDate: string;
  endDate: string;
  reason: string;
}

const INITIAL: FormState = {
  leaveType: null,
  otherLeave: '',
  startDate: todayCalendarDate(),
  endDate: todayCalendarDate(),
  reason: '',
};

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isCalendarDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  // Guards against 2026-02-31 silently becoming 3 March.
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

function daysInclusive(start: string, end: string): number | null {
  const [sy, sm, sd] = start.split('-').map(Number);
  const [ey, em, ed] = end.split('-').map(Number);
  const from = new Date(sy, sm - 1, sd).getTime();
  const to = new Date(ey, em - 1, ed).getTime();
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) return null;
  return Math.round((to - from) / 86_400_000) + 1;
}

export default function RequestLeaveScreen() {
  const { session } = useSession();
  const residentId = session?.residentId ?? 0;

  const [form, setForm] = useState<FormState>(INITIAL);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const startError = isCalendarDate(form.startDate) ? null : 'Use a real date in YYYY-MM-DD.';
  const endError = isCalendarDate(form.endDate)
    ? daysInclusive(form.startDate, form.endDate) === null
      ? 'The last day cannot be before the first day.'
      : null
    : 'Use a real date in YYYY-MM-DD.';
  const otherError =
    form.leaveType === 'OTHER_LEAVE' && form.otherLeave.trim().length === 0
      ? 'The API requires a description for other leave.'
      : null;

  const dayCount = useMemo(
    () => (startError === null && endError === null ? daysInclusive(form.startDate, form.endDate) : null),
    [form.startDate, form.endDate, startError, endError],
  );

  const canSubmit =
    !submitting &&
    form.leaveType !== null &&
    startError === null &&
    endError === null &&
    otherError === null;

  async function handleSubmit() {
    if (form.leaveType === null) return;
    setSubmitting(true);
    setSubmitError(null);

    try {
      const created = await submitLeaveRequest({
        resident_id: residentId,
        leave_type: form.leaveType,
        start_date: form.startDate,
        end_date: form.endDate,
        ...(form.leaveType === 'OTHER_LEAVE' && form.otherLeave.trim()
          ? { other_leave_specify: form.otherLeave.trim() }
          : {}),
        ...(form.reason.trim() ? { reason: form.reason.trim() } : {}),
      });

      setSaved(
        `${created.total_days} day${created.total_days === 1 ? '' : 's'} requested. It is now with the chief resident.`,
      );
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'Could not submit this request.');
    } finally {
      setSubmitting(false);
    }
  }

  if (saved) {
    return (
      <Screen bottomGutter={spacing.xl}>
        <AppHeader title="Request sent" onBack={goBack} />
        <Banner tone="success" title="Leave requested" message={saved} />
        <Button label="View my requests" onPress={() => router.replace('/resident/requests')} />
      </Screen>
    );
  }

  return (
    <Screen bottomGutter={spacing.xxl}>
      <AppHeader
        title="Request leave"
        subtitle="Goes to the chief resident for approval"
        onBack={goBack}
      />

      {submitError ? <Banner tone="danger" title="Could not submit" message={submitError} /> : null}

      <Card>
        <SelectField
          label="Leave type"
          value={form.leaveType}
          onChange={(value) => setForm((prev) => ({ ...prev, leaveType: value }))}
          options={LEAVE_TYPES.map((type) => ({ value: type, label: humanizeToken(type) }))}
          required
          error={form.leaveType === 'OTHER_LEAVE' ? otherError : null}
        />
      </Card>

      {form.leaveType === 'OTHER_LEAVE' ? (
        <Card>
          <TextField
            label="Specify the leave type"
            value={form.otherLeave}
            onChangeText={(value) => setForm((prev) => ({ ...prev, otherLeave: value }))}
            placeholder="e.g. compassionate leave"
            required
            error={otherError}
          />
        </Card>
      ) : null}

      <SectionHeader title="Dates" />
      <Card>
        <DateField
          label="First day"
          value={form.startDate}
          onChangeText={(value) => setForm((prev) => ({ ...prev, startDate: value }))}
          error={startError}
          required
          // The last day cannot precede the first, so the two fields are linked:
          // moving the first day forward pulls the last day with it when the old
          // last day is now invalid, rather than leaving a range that only fails
          // on submit.
          maxDate={isCalendarDate(form.endDate) ? form.endDate : undefined}
          hint="YYYY-MM-DD, inclusive"
        />
        <DateField
          label="Last day"
          value={form.endDate}
          onChangeText={(value) => setForm((prev) => ({ ...prev, endDate: value }))}
          error={endError}
          required
          minDate={isCalendarDate(form.startDate) ? form.startDate : undefined}
          hint={isCalendarDate(form.startDate) ? `On or after ${form.startDate}.` : undefined}
        />

        {dayCount !== null ? (
          <Text variant="caption" tone="secondary">
            {dayCount} day{dayCount === 1 ? '' : 's'}, counting both the first and last day.
          </Text>
        ) : null}
      </Card>

      <SectionHeader title="Reason" />
      <Card>
        <TextField
          label="Reason (optional)"
          value={form.reason}
          onChangeText={(value) => setForm((prev) => ({ ...prev, reason: value }))}
          multiline
          placeholder="Help the chief resident understand the request"
          hint="Shown to whoever reviews this request."
        />
      </Card>

      <Button
        label={submitting ? 'Sending…' : 'Send request'}
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