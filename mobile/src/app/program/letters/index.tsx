import { useState } from 'react';
import { Screen, AppHeader } from '../../../components';
import { goBack } from '../../../navigation/back';

export default function LettersHub() {
  return (
    <Screen>
      <AppHeader title="Release Letters" onBack={goBack} />
    </Screen>
  );
}
