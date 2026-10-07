import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { UserPlus, Users } from 'lucide-react-native';

import {
  AppHeader,
  Button,
  Card,
  EmptyState,
  ErrorState,
  ImportTools,
  ListRow,
  Screen,
  SearchInput,
  SectionHeader,
  SkeletonList,
  StatusBadge,
} from '../../../components';
import { useApiResource, useSession } from '../../../hooks';
import { fetchResidentList } from '../../../services/residents';
import { uploadRoster } from '../../../services/excelTemplates';
import { spacing } from '../../../theme';
import { humanizeToken } from '../../../utils/format';
import { filterResidents, residentFullName, residentSubtitle } from '../../../utils/residents';

/**
 * Roster — every resident in the signed-in programme.
 *
 * Search covers name, programme code, specialty and PGY level, because a
 * coordinator looking for "the PGY-2" is as likely to type that as a name.
 *
 * The import path is deliberately two independent buttons rather than one
 * ambiguous "Import": downloading the template must work even when the API is
 * down, and a failed upload has to say *which row* broke instead of a generic
 * error alert.
 */

export default function RosterScreen() {
  const router = useRouter();
  const { session } = useSession();
  const programId = session?.programId ?? 0;
  const [query, setQuery] = useState('');

  const residents = useApiResource(() => fetchResidentList({ programId, limit: 100 }), [programId]);

  const visible = useMemo(
    () => filterResidents(residents.data ?? [], query),
    [residents.data, query],
  );

  // The header has to name the *programme*, and there is no GET /programs, so
  // it is derived from the roster itself — every row carries the code and name.
  const programme = useMemo(() => {
    const first = (residents.data ?? []).find((row) => row.program_code);
    if (!first) return null;
    return { name: first.specialty_name, code: first.program_code };
  }, [residents.data]);

  const headerSubtitle = programme?.code
    ? `Enrolled into ${programme.name ?? 'Programme'} Program (Code: ${programme.code})`
    : (session?.programLabel ?? 'Residents enrolled in this programme');

  return (
    <Screen onRefresh={residents.refresh} refreshing={residents.isRefreshing} bottomGutter={spacing.xxl}>
      <AppHeader title="Roster" subtitle={headerSubtitle} />

      {residents.isLoading ? <SkeletonList rows={6} /> : null}

      {residents.error ? (
        <ErrorState
          title="Could not load the roster"
          message={residents.error.message}
          onRetry={residents.refresh}
        />
      ) : null}

      {residents.status === 'ready' ? (
        <>
          <View style={styles.search}>
            <SearchInput
              accessibilityLabel="Search residents"
              value={query}
              onChangeText={setQuery}
              placeholder="Name, programme or PGY level"
            />
          </View>

          <ImportTools
            template="roster"
            uploadLabel="Upload Excel Roster"
            upload={(file) => uploadRoster(file, programId)}
            onImported={() => residents.refresh()}
          />

          <SectionHeader title={`${visible.length} resident${visible.length === 1 ? '' : 's'}`} />

          {visible.length === 0 ? (
            <Card>
              <EmptyState
                icon={Users}
                title={query ? 'No match' : 'No residents enrolled'}
                message={
                  query
                    ? `No resident in this programme matches “${query}”.`
                    : 'Register the first resident, or upload the roster template with the rows you already have.'
                }
                actionLabel={query ? undefined : 'Register a resident'}
                onActionPress={query ? undefined : () => router.push('/program/onboarding')}
              />
            </Card>
          ) : (
            <Card padded={false}>
              {visible.map((resident, index) => (
                <ListRow
                  key={resident.resident_id}
                  title={residentFullName(resident)}
                  subtitle={residentSubtitle(resident)}
                  meta={humanizeToken(resident.resident_status)}
                  trailing={
                    <StatusBadge
                      label={resident.resident_status === 'ACTIVE_FULL_TIME' ? 'Active' : 'Other'}
                      tone={resident.resident_status === 'ACTIVE_FULL_TIME' ? 'success' : 'neutral'}
                    />
                  }
                  onPress={() => router.push(`/program/resident/${resident.resident_id}`)}
                  last={index === visible.length - 1}
                />
              ))}
            </Card>
          )}

          <Button
            label="Register a resident"
            icon={UserPlus}
            onPress={() => router.push('/program/onboarding')}
            style={styles.cta}
          />
        </>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  search: {
    marginBottom: spacing.md,
  },
  cta: {
    marginTop: spacing.lg,
  },
});
