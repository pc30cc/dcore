import { RefreshCw, Server, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/i18n/useI18n';
import { formatTime } from '@/lib/format';
import { can } from '@/lib/session';
import { refreshSystem, useSystemHealth, useSystemPartitions, useSystemQueues, useSystemStreams } from '@/lib/system';
import { useSession } from '@/lib/useSession';
import { cn } from '@/lib/utils';
import { HealthCard } from './jobs/HealthCard';
import { PartitionsCard } from './jobs/PartitionsCard';
import { QueuesCard } from './jobs/QueuesCard';
import { StreamsCard } from './jobs/StreamsCard';
import { TasksCard } from './jobs/TasksCard';

/**
 * `/system/jobs` (`system.read`): the health of the database, Valkey and
 * the processes, the saving queues, the job queues, the scheduled tasks and
 * the partitions, each card read on its own (a Valkey outage leaves the
 * partitions readable) and polled while the tab is visible. Actions only
 * with `system.write`; nothing on the page names a person.
 */
export function JobsPage() {
  const { t, locale } = useI18n();
  const { me } = useSession();
  const canWrite = can(me, 'system.write');
  const health = useSystemHealth();
  const queues = useSystemQueues();
  const streams = useSystemStreams();
  const partitions = useSystemPartitions();
  const [refreshing, setRefreshing] = useState(false);
  const reads = [health, queues, streams];
  const times = reads.map((read) => read.data?.at).filter((at): at is string => at !== undefined);
  const newest = times.length > 0 ? times.reduce((a, b) => (Date.parse(a) > Date.parse(b) ? a : b)) : null;
  // A poll that failed while the card still shows its last answer.
  const stale = [...reads, partitions].some((read) => read.isError && read.data !== undefined);

  async function refresh() {
    setRefreshing(true);
    try {
      await refreshSystem();
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="mx-auto grid max-w-6xl grid-cols-1 gap-6">
      <PageHeader
        icon={Server}
        title={t('nav.system')}
        meta={
          <>
            {newest && <span className="text-muted-foreground">{t('dashboard.updated', { time: formatTime(newest, locale) })}</span>}
            {stale && (
              <span className="flex items-center gap-1.5 text-amber-700 dark:text-amber-300" role="status">
                <TriangleAlert className="size-3.5" aria-hidden="true" />
                {t('dashboard.stale')}
              </span>
            )}
          </>
        }
        actions={
          <Button variant="outline" size="sm" disabled={refreshing} onClick={() => void refresh()}>
            <RefreshCw className={cn(refreshing && 'animate-spin')} aria-hidden="true" />
            {t('queue.refresh')}
          </Button>
        }
      />
      <HealthCard query={health} />
      <StreamsCard query={streams} canWrite={canWrite} />
      <QueuesCard query={queues} canWrite={canWrite} />
      <TasksCard query={queues} health={health.data} canWrite={canWrite} />
      <PartitionsCard query={partitions} />
    </div>
  );
}
