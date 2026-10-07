import { useEffect, useState } from 'react';
import { Card } from './Card';
import { Text } from './Text';
import { spacing } from '../theme';
import { todayCalendarDate } from '../utils/format';

function formatLiveTime(date: Date) {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
}

function formatLiveDateLong(date: Date) {
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(date);
}

export function LiveClockCard() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <Card>
      <Text variant="h1">{formatLiveTime(now)}</Text>
      <Text variant="body" tone="secondary">{formatLiveDateLong(now)}</Text>
    </Card>
  );
}
