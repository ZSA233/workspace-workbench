import { useState } from 'react';
import { Text } from 'react-native';
import { useWorkbenchCopy } from '../i18n';
import { formatObservedTime } from '../model';
import { AnchoredMenu } from './navigation';
import { IconButton } from './icon-button';
import type { makeStyles } from './ui';

/** Region status stays in the header; details appear only when requested. */
export function ObservationIndicator({ error, loading = false, refreshing = false, stale = false,
  lastSuccessfulAt, hasContent = true, theme, styles }: {
  error?: string | null; loading?: boolean; refreshing?: boolean; stale?: boolean;
  lastSuccessfulAt?: string | null; hasContent?: boolean;
  theme: Parameters<typeof makeStyles>[0]; styles: ReturnType<typeof makeStyles>;
}) {
  const copy = useWorkbenchCopy(), [open, setOpen] = useState(false);
  if (!error && !loading && !refreshing && !stale) return null;
  const label = error || (stale ? copy.observationStale : copy.observationRefreshing);
  const color = error && !hasContent ? theme.colors.statusDanger
    : error || stale ? theme.colors.statusWarning : theme.colors.foregroundMuted;
  return <>
    <IconButton label={label} icon={error || stale ? 'CircleAlert' : 'RefreshCw'} color={color} onPress={() => setOpen(true)} />
    <AnchoredMenu open={open} onClose={() => setOpen(false)} theme={theme} width={280}>
      <Text selectable style={styles.layoutMenuHint}>{label}</Text>
      <Text selectable style={styles.layoutMenuHint}>{copy.text_a6625c543c}{formatObservedTime(lastSuccessfulAt, copy)}</Text>
    </AnchoredMenu>
  </>;
}
