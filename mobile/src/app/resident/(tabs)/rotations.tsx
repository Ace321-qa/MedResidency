import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { CalendarPlus, FilePlus2, Grid3x3, LayoutList, Stethoscope } from 'lucide-react-native';

import {
  AppHeader,
  Banner,
  Button,
  Card,
  ClinicDayField,
  DateField,
  EmptyState,
  ErrorState,
  ListRow,
  MatrixTable,
  Screen,
  SectionHeader,
  SelectField,
  Sheet,
  SheetSelectField,
  SkeletonList,
  StatusBadge,
  Text,
  TextField,
} from '../../../components';
import { useApiResource, useSession } from '../../../hooks';
import { fetchClinicTypes, fetchResidentLongitudinalAssignments } from '../../../services/longitudinal';
import { fetchResidentSchedule } from '../../../services/rotations';
import { fetchRotationCatalogue } from '../../../services/rotationCatalogue';
import { createRotationRequest } from '../../../services/rotationRequests';
import { useInAppNotifications } from '../../../services/inAppNotifications';
import {
  OTHER_REASON,
  OTHER_REASON_LABEL,
  buildReason,
  reasonOptionsFor,
} from '../../../constants/reasons';
import { spacing } from '../../../theme';
import { buildClinicRequestOptions, rotationCatalogueLabel } from '../../../utils/clinicRequestOptions';
import {
  CUSTOM_PERIOD,
  MAX_CLINIC_DAYS,
  MIN_CLINIC_DAYS,
  PERIOD_WEEK_PRESETS,
  clinicDaysAreValid,
  clinicEndDate,
  clinicEndDateLabel,
  clinicStartWeekday,
  formatClinicDays,
  parsePeriodWeeks,
  shortClinicDay,
  sortClinicDays,
} from '../../../utils/clinicRotationRequest';
import { DAY_NAMES, type DayName } from '../../../utils/dateCalc';
import { formatDateRange, formatShortDate, formatWeeks, normalizeToISODate } from '../../../utils/format';
import { groupScheduleByBlock, type RotationPhase } from '../../../utils/insights';
import type { RotationRequestType } from '../../../types/api';

/**
 * Rotations — the resident's schedule, grouped by academic block.
 *
 * Grouping by block rather than showing one flat list matches how a resident
 * actually reads a schedule: "what am I doing this block?", then the detail
 * underneath. Each block is labelled with whether it is active, upcoming or
 * finished, so a historical schedule is never mistaken for a current one.
 *
 * Two extra views sit behind this screen:
 *
 *  - **Master grid** — the same assignments laid out as blocks across the top,
 *    for reading the year as one shape instead of scrolling it.
 *  - **Clinic overview** — the Continuity of Care Clinic (CCC) (longitudinal) assignments,
 *    which are *not* rotation assignments and therefore never appear in the block
 *    list. A resident whose only question is "which clinic am I on?" should not
 *    have to infer it from a rota.
 *
 * And two requests, because those are the only things a resident can ask the
 * programme to change from here. Submitting one writes a row in
 * `rotation_requests` and raises an in-app notification; the coordinator's
 * Approvals queue then shows it.
 */

const PHASE_LABEL: Record<RotationPhase, string> = {
  ACTIVE: 'In progress',
  UPCOMING: 'Upcoming',
  COMPLETED: 'Finished',
};

const PHASE_TONE: Record<RotationPhase, 'info' | 'success' | 'neutral'> = {
  ACTIVE: 'info',
  UPCOMING: 'success',
  COMPLETED: 'neutral',
};

const EMPTY_DATE = 'YYYY-MM-DD';

interface RequestForm {
  /** The catalogue row picked from the department list, as a string id. */
  rotationId: string | null;
  /**
   * The clinic row picked from the clinic pick-list (a `ClinicRequestOption`
   * value). `null` means nothing picked yet, or the resident switched to typing.
   */
  clinicValue: string | null;
  /**
   * Free text — the department field when the catalogue has nothing to offer,
   * and the clinic field when the resident chose to type a clinic that is not
   * in the list.
   */
  departmentClinic: string;
  startDate: string;
  /**
   * How long the request runs, in weeks, as the resident entered it.
   *
   * The end date is *derived* from this and the start date, never typed, so the
   * two can never disagree: the form stores the period and recomputes the end
   * whenever either end of it changes.
   */
  periodValue: string;
  /** Free text, read only when `periodValue` is `CUSTOM_PERIOD`. */
  customWeeks: string;
  /** The recurring weekdays the clinic release asks for, one to three of them. */
  clinicDays: DayName[];
  /** The preset the resident tapped, `OTHER_REASON`, or `''` for "not answered". */
  reasonValue: string;
  /** Free text, read only when `reasonValue` is `OTHER_REASON`. */
  customReason: string;
}

const EMPTY_FORM: RequestForm = {
  rotationId: null,
  clinicValue: null,
  departmentClinic: '',
  startDate: '',
  periodValue: '4',
  customWeeks: '',
  clinicDays: [],
  reasonValue: '',
  customReason: '',
};

function looksLikeDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
}

export default function RotationsScreen() {
  const { session } = useSession();
  const { notify } = useInAppNotifications();
  const residentId = session?.residentId ?? 0;
  const programId = session?.programId ?? 0;

  const schedule = useApiResource(() => fetchResidentSchedule(residentId), [residentId]);
  const clinics = useApiResource(() => fetchResidentLongitudinalAssignments(residentId), [residentId]);
  /**
   * The Rotations Catalogue, fetched for the request form rather than for the
   * coordinator's editor. A resident picking "Internal Medicine Inpatient Wards
   * (IM-WARDS)" stores that row's id on the request, which is what lets the
   * approval place them on the exact rotation instead of on whatever the typed
   * department string happens to match.
   */
  const catalogue = useApiResource(() => fetchRotationCatalogue(programId), [programId]);

  /** Active rotations only — a retired row is not something to ask for. */
  const catalogueOptions = useMemo(
    () =>
      (catalogue.data ?? [])
        .filter((entry) => entry.is_active === 1)
        .map((entry) => ({ value: String(entry.id), label: rotationCatalogueLabel(entry) })),
    [catalogue.data],
  );

  /**
   * The programme's clinic catalogue (`longitudinal_clinic_types`), for the
   * clinic request form. Read separately from the resident's own clinic
   * assignments: what a resident is *on* and what the programme *runs* are two
   * different questions.
   */
  const clinicTypes = useApiResource(() => fetchClinicTypes(programId), [programId]);

  /**
   * The clinic pick-list: the standard primary-care clinics, the programme's
   * active clinics, then the active Rotations Catalogue entries. Built in a
   * pure function (`utils/clinicRequestOptions`) so the ordering and the
   * deduplication are testable without rendering the sheet.
   */
  const clinicOptions = useMemo(
    () =>
      buildClinicRequestOptions({
        clinicTypes: clinicTypes.data ?? [],
        catalogue: catalogue.data ?? [],
      }),
    [clinicTypes.data, catalogue.data],
  );

  const blocks = useMemo(() => groupScheduleByBlock(schedule.data ?? []), [schedule.data]);
  const [showGrid, setShowGrid] = useState(false);
  const [requestType, setRequestType] = useState<RotationRequestType | null>(null);
  const [form, setForm] = useState<RequestForm>(EMPTY_FORM);
  /** True when the resident chose "my clinic is not listed" and is typing instead. */
  const [clinicManual, setClinicManual] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  /**
   * The request window: a start date the resident picks, a period in weeks they
   * choose, and an end date the two *derive*.
   *
   * The end date is read-only on purpose. Two independent date fields let a
   * resident ask for "4 weeks" and then type an end date that is five weeks out,
   * and the approval has no way to tell which one they meant. Deriving it means
   * the period is the single source of truth and the arithmetic
   * (`start + weeks × 7 − 1`) happens exactly once, in `clinicRotationRequest`.
   */
  const periodWeeks = useMemo(() => {
    const raw = form.periodValue === CUSTOM_PERIOD ? form.customWeeks : form.periodValue;
    return parsePeriodWeeks(raw);
  }, [form.periodValue, form.customWeeks]);

  const derivedEndDate = useMemo(
    () => clinicEndDate(form.startDate, periodWeeks),
    [form.startDate, periodWeeks],
  );

  const startWeekday = useMemo(() => clinicStartWeekday(form.startDate), [form.startDate]);

  const endDateLabel = useMemo(
    () => (derivedEndDate ? clinicEndDateLabel(form.startDate, periodWeeks) : ''),
    [derivedEndDate, form.startDate, periodWeeks],
  );

  const periodOptions = useMemo(
    () => [
      ...PERIOD_WEEK_PRESETS.map((weeks) => ({
        value: String(weeks),
        label: `${weeks} ${weeks === 1 ? 'week' : 'weeks'}`,
      })),
      { value: CUSTOM_PERIOD, label: 'Custom…' },
    ],
    [],
  );

  /** The clinic days as a compact list, e.g. `Wed, Fri` — for the field hint. */
  const chosenClinicDays = useMemo(() => sortClinicDays(form.clinicDays), [form.clinicDays]);

  const reasonOptions = useMemo(() => {
    const presets = reasonOptionsFor(requestType ?? 'HOSPITAL');
    return [
      ...presets.map((option) => ({ value: option.value, label: option.label })),
      { value: OTHER_REASON, label: OTHER_REASON_LABEL },
    ];
  }, [requestType]);

  /** The hint under the reason group: what the chosen option means, once chosen. */
  const reasonHint = useMemo(() => {
    if (form.reasonValue === OTHER_REASON) return 'Opens a field for your own words.';
    const picked = reasonOptionsFor(requestType ?? 'HOSPITAL').find(
      (option) => option.value === form.reasonValue,
    );
    return picked ? picked.hint : 'Optional, but it is what the coordinator reads first.';
  }, [form.reasonValue, requestType]);

  /**
   * Which department control a hospital request gets.
   *
   * A hospital request picks from the catalogue when the catalogue answers;
   * while it is loading, and when it comes back empty or errors, the resident
   * falls back to typing rather than being blocked by a screen they cannot fix.
   *
   * A clinic request always has a pick-list — the standard primary-care clinics
   * are constants, so it cannot be empty — and the "type it instead" control is
   * the fallback for a clinic the programme has not catalogued.
   */
  const showCataloguePicker = requestType === 'HOSPITAL' && catalogueOptions.length > 0;
  const showLoadingPicker = requestType === 'HOSPITAL' && catalogue.isLoading && catalogueOptions.length === 0;
  const showManualDepartment = requestType === 'HOSPITAL' && !catalogue.isLoading && catalogueOptions.length === 0;
  const clinicListIncomplete =
    requestType === 'CLINIC' && Boolean(clinicTypes.error || catalogue.error);

  const residentName = session?.residentName ?? 'Your schedule';

  function openRequest(type: RotationRequestType) {
    setForm(EMPTY_FORM);
    setClinicManual(false);
    setFormError(null);
    setRequestType(type);
    // The pick-list is fetched when the screen mounts, but the catalogue is the
    // kind of thing a coordinator edits while residents are looking at it, so
    // re-read it as the form opens. The previous list stays on screen until the
    // fresh one lands, so a slow or offline reload never blanks the field.
    catalogue.refresh();
    clinicTypes.refresh();
  }

  function closeRequest() {
    if (submitting) return;
    setRequestType(null);
    setFormError(null);
  }

  async function submitRequest() {
    if (!requestType) return;

    // A picked row travels two ways: as `department_clinic` (what the queue
    // shows and the notification reads) and as `rotation_id` (what approval
    // actually places). The id is the one that counts — the string is only the
    // fallback for a typed name or a catalogue entry deleted in between.
    //
    // A clinic picked from the standard / programme list carries no rotation id:
    // it is a clinic name, and the coordinator pairs the resident by that name.
    // Only a Rotations Catalogue entry brings its id along.
    let departmentClinic = form.departmentClinic.trim();
    let rotationId: number | undefined;

    if (requestType === 'HOSPITAL') {
      const picked =
        form.rotationId !== null
          ? (catalogue.data ?? []).find((entry) => String(entry.id) === form.rotationId) ?? null
          : null;
      if (picked) {
        departmentClinic = picked.department.trim() || picked.full_name.trim();
        rotationId = Number(picked.id);
      }
    } else if (!clinicManual) {
      const pickedClinic = clinicOptions.find((option) => option.value === form.clinicValue) ?? null;
      if (pickedClinic) {
        departmentClinic = pickedClinic.clinicName;
        rotationId = pickedClinic.rotationId ?? undefined;
      }
    }
    // `DateField` normalises on blur, so in practice the start already reads
    // `YYYY-MM-DD`. Normalising again here means a pasted `18/10` still submits
    // correctly when the field never lost focus — e.g. the button is tapped
    // straight after typing — and keeps the error message about the *unreadable*
    // input rather than the readable-but-shorthand kind.
    //
    // The end date is not read from a field: it is derived from the start date
    // and the period above, so "4 weeks" can never be submitted alongside a
    // window that is not four weeks long.
    const startDate = normalizeToISODate(form.startDate) ?? form.startDate.trim();
    const endDate = derivedEndDate ?? '';
    const clinicDays = sortClinicDays(form.clinicDays);

    if (departmentClinic === '') {
      setFormError(
        requestType === 'HOSPITAL'
          ? 'Choose the department you want to join.'
          : clinicManual
            ? 'Enter the clinic you want to join.'
            : 'Choose the clinic you want to join.',
      );
      return;
    }
    if (!looksLikeDate(startDate)) {
      setFormError(`Start date must be in ${EMPTY_DATE} format — a DD/MM shorthand works too.`);
      return;
    }
    if (periodWeeks === null) {
      setFormError(
        form.periodValue === CUSTOM_PERIOD && form.customWeeks.trim() === ''
          ? 'Enter how many weeks this rotation runs for.'
          : `Enter a period of between 1 and 52 weeks.`,
      );
      return;
    }
    if (!looksLikeDate(endDate)) {
      setFormError('The end date could not be worked out — check the start date and the period.');
      return;
    }
    // A clinic release is released for one, two or three recurring weekdays, and
    // the approval needs to know which; a hospital request has no such field.
    if (requestType === 'CLINIC' && !clinicDaysAreValid(clinicDays)) {
      setFormError(
        clinicDays.length === 0
          ? `Choose the day${'s'} the clinic runs — you can pick up to ${MAX_CLINIC_DAYS}.`
          : `A clinic request can hold at most ${MAX_CLINIC_DAYS} days.`,
      );
      return;
    }

    const reason = buildReason(form.reasonValue, form.customReason);
    if (form.reasonValue === OTHER_REASON && !reason) {
      setFormError('Please specify your reason below — "Other" needs your own words.');
      return;
    }
    // The server caps the reason at 500 characters; saying so here keeps the
    // resident from losing a paste to a 400 they cannot act on.
    if (reason && reason.length > 500) {
      setFormError(`Keep your reason to 500 characters — this one is ${reason.length}.`);
      return;
    }

    setSubmitting(true);
    setFormError(null);

    try {
      await createRotationRequest({
        resident_id: residentId,
        program_id: programId,
        request_type: requestType,
        department_clinic: departmentClinic,
        rotation_id: rotationId,
        start_date: startDate,
        end_date: endDate,
        // Only a clinic request carries the recurring weekdays; the server
        // ignores the field on a hospital request.
        clinic_days: requestType === 'CLINIC' ? clinicDays : undefined,
        reason,
      });

      const dayText =
        requestType === 'CLINIC' && clinicDays.length > 0
          ? ` on ${formatClinicDays(clinicDays)}`
          : '';
      notify({
        title: 'Request submitted',
        message: `${requestType === 'HOSPITAL' ? 'Hospital' : 'Clinic'} rotation request for ${formatShortDate(
          startDate,
        )} – ${formatShortDate(endDate)}${dayText} is with your coordinator. Watch the Approvals queue for the decision.`,
        tone: 'success',
      });
      setRequestType(null);
      setForm(EMPTY_FORM);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The request could not be sent.';
      setFormError(message);
      notify({ title: 'Request not sent', message, tone: 'danger' });
    } finally {
      setSubmitting(false);
    }
  }

  /**
   * One row of the master grid: every block as a column, this resident's
   * assignments as the cells.
   */
  const gridColumns = useMemo(
    () =>
      blocks.map((block, index) => ({
        key: `block-${index}`,
        title: block.blockName,
        subtitle: block.dateRange,
      })),
    [blocks],
  );

  const gridRows = useMemo(() => {
    if (blocks.length === 0) return [];

    return [
      {
        key: `resident-${residentId}`,
        frozenContent: (
          <View style={styles.frozenCell}>
            <Text variant="label" numberOfLines={2}>
              {residentName}
            </Text>
            <Text variant="caption" tone="muted" numberOfLines={1}>
              {blocks.length} block{blocks.length === 1 ? '' : 's'}
            </Text>
          </View>
        ),
        accent: 'info' as const,
        cells: Object.fromEntries(
          blocks.map((block, index) => [
            `block-${index}`,
            <View key={`cell-${index}`} style={styles.gridCell}>
              {block.assignments.map((assignment) => (
                <Text key={assignment.assignment_id} variant="caption" numberOfLines={3}>
                  {assignment.rotation_name}
                </Text>
              ))}
            </View>,
          ]),
        ),
        accessibilityLabel: `${residentName}, ${blocks.length} blocks`,
      },
    ];
  }, [blocks, residentId, residentName]);

  const clinicList = clinics.data ?? [];

  return (
    <Screen
      onRefresh={() => {
        schedule.refresh();
        clinics.refresh();
      }}
      refreshing={schedule.isRefreshing || clinics.isRefreshing}
      bottomGutter={spacing.xxl}
    >
      <AppHeader title="Rotations" subtitle="Your schedule by academic block" />

      <View style={styles.toolbar}>
        <Button
          label={showGrid ? 'Show block list' : 'Show master grid'}
          variant="outline"
          icon={showGrid ? LayoutList : Grid3x3}
          onPress={() => setShowGrid((current) => !current)}
          accessibilityHint="Switch between the grouped list and the block-by-block grid"
        />
        <Button
          label="Request a Hospital Rotation"
          icon={FilePlus2}
          onPress={() => openRequest('HOSPITAL')}
        />
        <Button
          label="Request a Clinic Rotation"
          variant="outline"
          icon={Stethoscope}
          onPress={() => openRequest('CLINIC')}
        />
      </View>

      {schedule.isLoading ? <SkeletonList rows={5} /> : null}

      {schedule.error ? (
        <ErrorState
          title="Could not load your schedule"
          message={schedule.error.message}
          onRetry={schedule.refresh}
        />
      ) : null}

      {schedule.status === 'ready' && blocks.length === 0 ? (
        <Card>
          <EmptyState
            icon={CalendarPlus}
            title="No rotations assigned"
            message="You have no rotation assignments on record. Your programme coordinator publishes these, so there is nothing to show until they do."
          />
        </Card>
      ) : null}

      {schedule.status === 'ready' && blocks.length > 0 && showGrid ? (
        <>
          <SectionHeader title="Master grid" trailing={`${blocks.length} blocks`} />
          <MatrixTable
            columns={gridColumns}
            rows={gridRows}
            frozenHeader="Resident"
            emptyTitle="No assignments to place"
            caption={
              <Text variant="caption" tone="muted" style={styles.gridCaption}>
                Swipe sideways to move through the academic year. Your row stays pinned on the left.
              </Text>
            }
          />
        </>
      ) : null}

      {schedule.status === 'ready' && blocks.length > 0 && !showGrid
        ? blocks.map((block) => (
            <View key={block.blockName} style={styles.block}>
              <SectionHeader title={block.blockName} trailing={block.dateRange} />
              <Card padded={false}>
                {block.assignments.map((assignment, index) => (
                  <ListRow
                    key={assignment.assignment_id}
                    title={assignment.rotation_name}
                    subtitle={assignment.department_name ?? 'Department not assigned'}
                    meta={`${formatDateRange(assignment.start_date, assignment.end_date)} · ${formatWeeks(assignment.assigned_weeks)}`}
                    trailing={
                      index === 0 ? (
                        <StatusBadge label={PHASE_LABEL[block.phase]} tone={PHASE_TONE[block.phase]} />
                      ) : null
                    }
                    last={index === block.assignments.length - 1}
                    muted={block.phase === 'COMPLETED'}
                  />
                ))}
              </Card>

              {block.assignments.some((item) => item.notes) ? (
                <Text variant="caption" tone="muted" style={styles.note}>
                  {block.assignments.find((item) => item.notes)?.notes}
                </Text>
              ) : null}
            </View>
          ))
        : null}

      {clinicList.length > 0 ? (
        <>
          <SectionHeader
            title="Clinic overview (Continuity Care Clinics)"
            trailing={`${clinicList.length} session${clinicList.length === 1 ? '' : 's'}`}
            icon={Stethoscope}
          />
          <Card padded={false}>
            {clinicList.map((clinic, index) => (
              <ListRow
                key={clinic.longitudinal_assignment_id}
                title={`${clinic.clinic_code}: ${clinic.clinic_name}`}
                subtitle={[
                  clinic.day_of_week,
                  clinic.start_time && clinic.end_time ? `${clinic.start_time} – ${clinic.end_time}` : null,
                  clinic.site_name,
                ]
                  .filter(Boolean)
                  .join(' · ')}
                meta={clinic.supervisor_name ? `Supervisor: ${clinic.supervisor_name}` : 'Supervisor not assigned'}
                trailing={
                  <StatusBadge
                    label={clinic.is_active === 1 ? 'Active' : 'Ended'}
                    tone={clinic.is_active === 1 ? 'success' : 'neutral'}
                  />
                }
                last={index === clinicList.length - 1}
              />
            ))}
          </Card>
        </>
      ) : schedule.status === 'ready' && clinicList.length === 0 && !clinics.isLoading ? (
        <Card>
          <EmptyState
            icon={Stethoscope}
            title="No clinic session yet"
            message="Your Continuity Care Clinic or longitudinal clinic has not been assigned. It appears here as soon as your coordinator schedules one."
          />
        </Card>
      ) : null}

      <Sheet
        visible={requestType !== null}
        onClose={closeRequest}
        title={requestType === 'CLINIC' ? 'Request a Clinic Rotation' : 'Request a Hospital Rotation'}
        subtitle="Your coordinator reviews this in the Approvals queue."
        footer={
          <Button
            label="Submit request"
            loading={submitting}
            onPress={submitRequest}
            accessibilityHint="Sends this request to your programme coordinator"
          />
        }
      >
        <View style={styles.form}>
          {formError ? <Banner tone="danger" title="Check the request" message={formError} /> : null}

          {showCataloguePicker ? (
            <SheetSelectField
              label="Department"
              required
              searchable
              value={form.rotationId}
              onChange={(value) => setForm((current) => ({ ...current, rotationId: value }))}
              options={catalogueOptions}
              placeholder="Choose a department"
              hint="Type to filter by rotation name, abbreviation or hospital department."
            />
          ) : null}

          {showLoadingPicker ? (
            <SheetSelectField
              label="Department"
              required
              disabled
              value={null}
              onChange={(value) => setForm((current) => ({ ...current, rotationId: value }))}
              options={[]}
              placeholder="Loading the Rotations Catalogue…"
              hint="The list of rotations your programme offers."
            />
          ) : null}

          {showManualDepartment ? (
            <View style={styles.catalogueFallback}>
              <Banner
                tone={catalogue.error ? 'warning' : 'info'}
                title={catalogue.error ? 'Catalogue unavailable' : 'No rotations catalogued yet'}
                message={
                  catalogue.error
                    ? 'The list of rotations could not be loaded, so type the department yourself — it is still matched when your coordinator approves.'
                    : 'Your programme has no rotations listed yet, so type the department yourself — it will be catalogued when your coordinator approves.'
                }
              />
              <Button
                label="Retry the list"
                variant="outline"
                onPress={catalogue.refresh}
                accessibilityHint="Reloads the Rotations Catalogue"
              />
              <TextField
                label="Department"
                required
                value={form.departmentClinic}
                onChangeText={(value) => setForm((current) => ({ ...current, departmentClinic: value }))}
                placeholder="e.g. Emergency Medicine"
                hint="The department or service you want to rotate through."
              />
            </View>
          ) : null}

          {requestType === 'CLINIC' ? (
            <>
              {clinicListIncomplete ? (
                <View style={styles.catalogueFallback}>
                  <Banner
                    tone="warning"
                    title="Clinic list may be incomplete"
                    message="The standard primary-care clinics are always listed, but the programme's clinic and rotation catalogue could not be loaded. You can still type the clinic instead."
                  />
                  <Button
                    label="Retry the list"
                    variant="outline"
                    onPress={() => {
                      clinicTypes.refresh();
                      catalogue.refresh();
                    }}
                    accessibilityHint="Reloads the programme's clinic list"
                  />
                </View>
              ) : null}

              {clinicManual ? (
                <>
                  <TextField
                    label="Clinic"
                    required
                    value={form.departmentClinic}
                    onChangeText={(value) => setForm((current) => ({ ...current, departmentClinic: value }))}
                    placeholder="e.g. Well Women Clinic"
                    hint="The exact clinic name — your coordinator matches it when approving."
                  />
                  <Button
                    label="Back to the clinic list"
                    variant="ghost"
                    fullWidth={false}
                    onPress={() => setClinicManual(false)}
                    accessibilityHint="Returns to the list of catalogued clinics"
                  />
                </>
              ) : (
                <>
                  <SheetSelectField
                    label="Clinic"
                    required
                    searchable
                    value={form.clinicValue}
                    onChange={(value) => setForm((current) => ({ ...current, clinicValue: value }))}
                    options={clinicOptions}
                    placeholder="Choose a clinic"
                    hint="Type to filter by clinic name, abbreviation or specialty."
                  />
                  <Button
                    label="My clinic is not listed — type it instead"
                    variant="ghost"
                    fullWidth={false}
                    onPress={() => setClinicManual(true)}
                    accessibilityHint="Opens a text field for a clinic that is not in the list"
                  />
                </>
              )}
            </>
          ) : null}

          <DateField
            label="Start date"
            required
            value={form.startDate}
            onChangeText={(value) => setForm((current) => ({ ...current, startDate: value }))}
            placeholder={EMPTY_DATE}
            durationWeeks={periodWeeks}
            hint={
              startWeekday
                ? `This is a ${startWeekday}. The period is counted from here.`
                : 'The day this rotation begins.'
            }
          />

          <SelectField
            label="Period in weeks"
            required
            value={form.periodValue}
            onChange={(value) => setForm((current) => ({ ...current, periodValue: value }))}
            options={periodOptions}
            hint="How long the rotation runs, counted in whole weeks from the start date."
          />

          {form.periodValue === CUSTOM_PERIOD ? (
            <TextField
              label="Weeks"
              required
              value={form.customWeeks}
              onChangeText={(value) => setForm((current) => ({ ...current, customWeeks: value }))}
              keyboardType="number-pad"
              placeholder="e.g. 6"
              hint="A whole number of weeks, up to 52."
            />
          ) : null}

          <TextField
            label="End date"
            value={derivedEndDate ?? ''}
            onChangeText={() => {}}
            editable={false}
            placeholder="Chosen by the start date and period"
            hint={
              endDateLabel
                ? `Works out to ${endDateLabel} — the last day of week ${periodWeeks}.`
                : 'Worked out from the start date and the period.'
            }
          />

          {requestType === 'CLINIC' ? (
            <ClinicDayField
              label="Clinic days"
              required
              value={chosenClinicDays}
              onChange={(days) => setForm((current) => ({ ...current, clinicDays: days }))}
              hint={
                chosenClinicDays.length > 0
                  ? `Releases you every ${formatClinicDays(chosenClinicDays)} for the whole period. Pick up to ${MAX_CLINIC_DAYS}.`
                  : `Pick ${MIN_CLINIC_DAYS} to ${MAX_CLINIC_DAYS} weekdays this clinic runs on — e.g. ${
                      shortClinicDay(DAY_NAMES[3])
                    }.`
              }
            />
          ) : null}

          <SelectField
            label="Reason for request"
            value={form.reasonValue === '' ? null : form.reasonValue}
            onChange={(value) => setForm((current) => ({ ...current, reasonValue: value }))}
            options={reasonOptions}
            hint={reasonHint}
          />

          {form.reasonValue === OTHER_REASON ? (
            <TextField
              label="Your reason"
              required
              multiline
              value={form.customReason}
              onChangeText={(value) => setForm((current) => ({ ...current, customReason: value }))}
              placeholder={
                requestType === 'CLINIC'
                  ? 'Please specify your reason for requesting this clinic rotation...'
                  : 'Please specify your reason for requesting this rotation...'
              }
              hint="One or two lines is plenty — it is what your coordinator reads first."
            />
          ) : null}
        </View>
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  toolbar: {
    gap: spacing.sm,
    marginBottom: spacing.lg,
  },
  block: {
    marginBottom: spacing.lg,
  },
  note: {
    marginTop: spacing.xs,
    paddingHorizontal: spacing.xs,
  },
  gridCaption: {
    marginBottom: spacing.sm,
  },
  gridCell: {
    gap: spacing.xxs,
  },
  frozenCell: {
    gap: spacing.xxs,
  },
  form: {
    gap: spacing.md,
  },
  /** The catalogue's absence: notice, retry, then the field it stands in for. */
  catalogueFallback: {
    gap: spacing.sm,
  },
});
