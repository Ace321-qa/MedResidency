import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Users } from 'lucide-react-native';

import { Card, SectionHeader } from './Card';
import { SearchInput } from './Form';
import { ListRow } from './ListRow';
import { EmptyState, ErrorState, SkeletonList } from './StateView';
import { StatusBadge } from './StatusBadge';
import type { Resource } from '../hooks';
import { spacing } from '../theme';
import { formatDateRange } from '../utils/format';
import { residentFullName } from '../utils/residents';
import type { VisitingResident } from '../types/api';

/**
 * The Visiting / External Residents half of the Roster Management Hub.
 *
 * It answers one question a receiving programme must be able to ask: *who is
 * rotating into our departments but does not belong to our programme?* A
 * Family Medicine PGY-5 posted onto our wards for Block 6 is invisible on the
 * enrolled roster by design — they are not enrolled here — so they get their
 * own tab rather than being mixed into the resident list.
 *
 * Every card carries the five facts a hosting coordinator needs: the person's
 * name, their corporate ID, the programme they call home, the departments they
 * rotate into here, and the date span of their postings (one Block 6 visit
 * reads as its 15 Nov – 12 Dec 2026 window). Tapping a card opens the resident
 * profile, which works for anyone in the directory regardless of programme.
 *
 * The list is read-only: these residents belong to another programme, so their
 * record is maintained there — editing or unenrolling them from this side
 * would reach across a programme boundary this tab does not own.
 */

interface ExternalRosterTabProps {
  resource: Resource<VisitingResident[]>;
}

/** The date span of a visitor's postings here, or nothing when unknown. */
function visitingDates(resident: VisitingResident): string | null {
  if (!resident.assignment_start_date || !resident.assignment_end_date) return null;
  return formatDateRange(resident.assignment_start_date, resident.assignment_end_date);
}

export function ExternalRosterTab({ resource }: ExternalRosterTabProps) {
  const router = useRouter();
  const [query, setQuery] = useState('');

  // Search matches the person *and* their provenance — name, corporate ID,
  // home programme, and the departments they rotate into here — because the
  // query a coordinator types is as often "Family Medicine" or "Wards" as a
  // name.
  const visible = useMemo(() => {
    const rows = resource.data ?? [];
    const needle = query.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((resident) =>
      [
        residentFullName(resident),
        resident.corporate_id,
        resident.home_program_name,
        resident.home_program_code,
        resident.home_specialty_name,
        resident.department_names,
        resident.rotation_names,
      ]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(needle)),
    );
  }, [resource.data, query]);

  return (
    <>
      {resource.isLoading ? <SkeletonList rows={4} /> : null}

      {resource.error ? (
        <ErrorState
          title="Could not load visiting residents"
          message={resource.error.message}
          onRetry={resource.refresh}
        />
      ) : null}

      {resource.status === 'ready' ? (
        <>
          <View style={styles.search}>
            <SearchInput
              accessibilityLabel="Search visiting residents"
              value={query}
              onChangeText={setQuery}
              placeholder="Name, corporate ID, home programme or department"
            />
          </View>

          <SectionHeader
            title={`${visible.length} visiting resident${visible.length === 1 ? '' : 's'}`}
            trailing={query ? 'filtered' : undefined}
          />

          {visible.length === 0 ? (
            <Card>
              <EmptyState
                icon={Users}
                title={query ? 'No match' : 'No visiting residents'}
                message={
                  query
                    ? `No visiting resident matches “${query}”.`
                    : 'Residents enrolled in partner programmes appear here as soon as they hold an assignment in one of this programme’s rotations.'
                }
              />
            </Card>
          ) : (
            <Card padded={false}>
              {visible.map((resident, index) => (
                <ListRow
                  key={resident.resident_id}
                  title={residentFullName(resident)}
                  subtitle={resident.home_program_name}
                  meta={[
                    resident.corporate_id ? `Corporate ID: ${resident.corporate_id}` : 'Corporate ID not recorded',
                    resident.pgy_level ? `PGY-${resident.pgy_level}` : null,
                    resident.department_names ?? 'Department not recorded',
                    visitingDates(resident),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                  trailing={
                    <StatusBadge
                      label={resident.home_program_code ?? 'Visiting'}
                      tone="info"
                    />
                  }
                  onPress={() => router.push(`/program/resident/${resident.resident_id}`)}
                  accessibilityHint={`Opens the profile of ${residentFullName(resident)}, visiting from ${resident.home_program_name}`}
                  last={index === visible.length - 1}
                />
              ))}
            </Card>
          )}
        </>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  search: {
    marginBottom: spacing.md,
  },
});
