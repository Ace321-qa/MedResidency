import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { BellOff } from 'lucide-react-native';

import {
  AppHeader,
  Banner,
  Card,
  ChoiceGroup,
  EmptyState,
  ErrorState,
  ListRow,
  Screen,
  SearchInput,
  SectionHeader,
  SkeletonList,
  StatusBadge,
  Text,
} from '../../components';
import { useApiResource } from '../../hooks';
import { goBack } from '../../navigation/back';
import {
  MOCK_NOTIFICATION_CATEGORY_LABEL,
  MOCK_NOTIFICATION_TONE,
  fetchMockNotifications,
  type MockNotification,
} from '../../services/mock';
import { spacing } from '../../theme';
import { formatDateTime } from '../../utils/format';
import { EMPTY_ARRAY } from '../../utils/empty';

/**
 * Notifications — **entirely sample data**.
 *
 * No notifications table, no notifications endpoint. Read state is tracked
 * locally for this session only, so it resets on sign-out; there is nothing to
 * persist until the backend can store it.
 */

type Filter = 'ALL' | 'UNREAD';

export default function NotificationsScreen() {
  const notifications = useApiResource(fetchMockNotifications);
  const [filter, setFilter] = useState<Filter>('ALL');
  const [readIds, setReadIds] = useState<string[]>([]);
  const [query, setQuery] = useState('');

  const all = notifications.data ?? (EMPTY_ARRAY as MockNotification[]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return all
      .filter((item) => {
        const read = item.read || readIds.includes(item.id);
        return filter === 'ALL' ? true : !read;
      })
      .filter((item) =>
        needle ? `${item.title} ${item.body}`.toLowerCase().includes(needle) : true,
      );
  }, [all, filter, query, readIds]);

  const unreadCount = all.filter((item) => !item.read && !readIds.includes(item.id)).length;

  return (
    <Screen
      onRefresh={notifications.refresh}
      refreshing={notifications.isRefreshing}
      bottomGutter={spacing.xxl}
    >
      <AppHeader title="Notifications" onBack={goBack} />

      <Banner
        tone="warning"
        title="Sample data"
        message="The API has no notifications endpoint, so these entries are illustrative rather than real."
      />

      {notifications.isLoading ? <SkeletonList rows={5} /> : null}

      {notifications.error ? (
        <ErrorState
          title="Could not load"
          message={notifications.error.message}
          onRetry={notifications.refresh}
        />
      ) : null}

      <ChoiceGroup
        label="Filter notifications"
        columns={2}
        value={filter}
        onChange={(value) => setFilter(value as Filter)}
        options={[
          { value: 'ALL', label: `All (${all.length})` },
          { value: 'UNREAD', label: `Unread (${unreadCount})` },
        ]}
      />

      {notifications.status === 'ready' ? (
        <>
          <View style={styles.search}>
            <SearchInput
              accessibilityLabel="Search notifications"
              value={query}
              onChangeText={setQuery}
              placeholder="Search notifications"
            />
          </View>

          <SectionHeader title={`${visible.length} shown`} />

          {visible.length === 0 ? (
            <Card>
              <EmptyState
                icon={BellOff}
                title="Nothing to read"
                message={query ? 'No notification matches that search.' : 'No unread notifications.'}
              />
            </Card>
          ) : (
            <Card padded={false}>
              {visible.map((item: MockNotification, index) => {
                const isRead = item.read || readIds.includes(item.id);
                return (
                  <ListRow
                    key={item.id}
                    title={item.title}
                    subtitle={item.body}
                    meta={`${MOCK_NOTIFICATION_CATEGORY_LABEL[item.category]} · ${formatDateTime(item.timestamp)}`}
                    trailing={
                      <StatusBadge
                        label={isRead ? 'Read' : 'New'}
                        tone={isRead ? 'neutral' : MOCK_NOTIFICATION_TONE[item.category]}
                      />
                    }
                    onPress={() =>
                      setReadIds((prev) => (prev.includes(item.id) ? prev : [...prev, item.id]))
                    }
                    last={index === visible.length - 1}
                    accessibilityHint="Marks this notification as read for this session"
                  />
                );
              })}
            </Card>
          )}

          <Text variant="caption" tone="muted" style={styles.footnote}>
            Read state is kept in memory for this session only, because there is no endpoint to store it.
          </Text>
        </>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  search: {
    marginTop: spacing.md,
  },
  footnote: {
    marginTop: spacing.md,
  },
});