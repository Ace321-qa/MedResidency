import { useMemo, useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import * as DocumentPicker from 'expo-document-picker';
import { UserPlus, Users } from 'lucide-react-native';

import {
  AppHeader,
  Button,
  Card,
  EmptyState,
  ErrorState,
  ListRow,
  Screen,
  SearchInput,
  SectionHeader,
  SkeletonList,
  StatusBadge,
} from '../../../components';
import { useApiResource, useSession } from '../../../hooks';
import { fetchResidentList } from '../../../services/residents';
import { downloadRosterTemplate, uploadRoster } from '../../../services/rosterImport';
import { spacing } from '../../../theme';
import { humanizeToken } from '../../../utils/format';
import { filterResidents, residentFullName, residentSubtitle } from '../../../utils/residents';

/**
 * Roster — every resident in the signed-in programme.
 *
 * Search covers name, programme code, specialty and PGY level, because a
 * coordinator looking for "the PGY-2" is as likely to type that as a name.
 */

export default function RosterScreen() {
  const router = useRouter();
  const { session } = useSession();
  const programId = session?.programId ?? 0;
  const [query, setQuery] = useState('');
  const [uploading, setUploading] = useState(false);


  const residents = useApiResource(() => fetchResidentList({ programId, limit: 100 }), [programId]);

  const visible = useMemo(
    () => filterResidents(residents.data ?? [], query),
    [residents.data, query],
  );


  async function handleDownloadTemplate() {
    try {
      await downloadRosterTemplate();
      Alert.alert('Template downloaded', 'roster_template.xlsx ready');
    } catch (e: any) {
      Alert.alert('Error', e.message);
    }
  }

  async function handleUpload() {
    try {
      setUploading(true);
      const res = await DocumentPicker.getDocumentAsync({ type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      if (res.canceled) return;
      const file = res.assets[0] as any;
      const result = await uploadRoster(file);
      if (result.success) {
        Alert.alert('Imported', `${result.added?.length || 0} residents added`);
        residents.refresh();
      } else {
        Alert.alert('Import failed', result.error || JSON.stringify(result.errors));
      }
    } catch (e: any) {
      Alert.alert('Error', e.message);
    } finally {
      setUploading(false);
    }
  }

  return (
    <Screen onRefresh={residents.refresh} refreshing={residents.isRefreshing} bottomGutter={spacing.xxl}>
      <AppHeader title="Roster" subtitle="Enrolled into Family Medicine Program (Code: 1207800001)" />

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

          <SectionHeader title={`${visible.length} resident${visible.length === 1 ? '' : 's'}`} />

          <View style={{ flexDirection: 'row', gap: 8, marginBottom: spacing.md }}>
            <Button label="Download Template (.xlsx)" variant="outline" onPress={handleDownloadTemplate} style={{ flex: 1 }} />
            <Button label="Upload Excel Roster" onPress={handleUpload} loading={uploading} style={{ flex: 1 }} />
          </View>
          {visible.length === 0 ? (
            <Card>
              <EmptyState
                icon={Users}
                title={query ? 'No match' : 'No residents enrolled'}
                message={
                  query
                    ? `No resident in this programme matches “${query}”.`
                    : 'Register the first resident to build the roster.'
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