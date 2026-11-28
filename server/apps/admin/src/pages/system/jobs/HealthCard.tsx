import type { AdminSystemHealth } from '@app/shared';
import type { UseQueryResult } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Badge, StatusDot } from '@/components/ui/badge';
import { useI18n } from '@/i18n/useI18n';
import { formatDateTime, formatTime } from '@/lib/format';
import { behind, formatBytes, formatMs, memoryTone, queueLabel } from '@/lib/system';
import { cn } from '@/lib/utils';
import { CardQuery, Code, SystemCard } from './parts';

type Health = AdminSystemHealth;
type Valkey = Health['valkey'][number];

/**
 * The database and both Valkey instances (up or down, how fast, Valkey's
 * memory), the job runner's beat, and the processes heard from in the last
 * 90 seconds: the background workers and the servers, each with the
 * settings version it has loaded (behind the current one in amber).
 */
export function HealthCard({ query }: { query: UseQueryResult<Health> }) {
  const { t } = useI18n();
  return (
    <SystemCard title={t('jobs.health.title')}>
      <CardQuery query={query} rows={4}>
        {(health) => (
          <div className="grid gap-6 lg:grid-cols-3">
            <Services health={health} />
            <Workers health={health} />
            <Servers health={health} />
          </div>
        )}
      </CardQuery>
    </SystemCard>
  );
}

function Up({ up, latencyMs }: { up: boolean; latencyMs?: number }) {
  const { t, locale } = useI18n();
  return (
    <span className="flex flex-wrap items-center justify-end gap-x-2">
      <StatusDot tone={up ? 'green' : 'red'} className={cn(!up && 'font-medium text-destructive')}>
        {t(up ? 'jobs.health.up' : 'jobs.health.down')}
      </StatusDot>
      {up && latencyMs !== undefined && <span className="text-xs text-muted-foreground tabular-nums">{formatMs(latencyMs, locale)}</span>}
    </span>
  );
}

const BAR: Readonly<Record<ReturnType<typeof memoryTone>, string>> = { green: 'bg-emerald-500', amber: 'bg-amber-500', red: 'bg-red-500' };

function Memory({ valkey }: { valkey: Valkey }) {
  const { t, locale } = useI18n();
  if (valkey.usedBytes === null) return null;
  if (valkey.maxBytes === null) {
    return (
      <p className="text-xs text-muted-foreground">
        {formatBytes(valkey.usedBytes, locale)} · {t('jobs.health.noLimit')}
      </p>
    );
  }
  const share = Math.min(1, valkey.usedBytes / valkey.maxBytes);
  const tone = memoryTone(valkey.usedBytes, valkey.maxBytes);
  const percent = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(share);
  return (
    <div className="grid gap-1">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 text-xs">
        <span className="text-muted-foreground">{t('jobs.health.memory', { used: formatBytes(valkey.usedBytes, locale), max: formatBytes(valkey.maxBytes, locale) })}</span>
        <span className={cn('font-medium tabular-nums', tone === 'red' ? 'text-destructive' : tone === 'amber' ? 'text-amber-700 dark:text-amber-300' : 'text-muted-foreground')}>{percent}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
        <div className={cn('h-full rounded-full', BAR[tone])} style={{ width: `${Math.max(2, share * 100)}%` }} />
      </div>
    </div>
  );
}

function ServiceRow({ label, children, below }: { label: string; children: ReactNode; below?: ReactNode }) {
  return (
    <li className="grid gap-1.5 py-2.5 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span className="text-sm">{label}</span>
        {children}
      </div>
      {below}
    </li>
  );
}

function Services({ health }: { health: Health }) {
  const { t, locale } = useI18n();
  const valkey = (name: Valkey['name']) => health.valkey.find((v) => v.name === name);
  const core = valkey('core');
  const cache = valkey('cache');
  return (
    <ul className="grid content-start divide-y">
      <ServiceRow label={t('jobs.health.database')}>
        <Up up={health.database.status === 'up'} latencyMs={health.database.latencyMs} />
      </ServiceRow>
      {core && (
        <ServiceRow label={t('jobs.health.core')} below={core.status === 'up' && <Memory valkey={core} />}>
          <Up up={core.status === 'up'} latencyMs={core.latencyMs} />
        </ServiceRow>
      )}
      {cache && (
        <ServiceRow label={t('jobs.health.cache')} below={cache.status === 'up' && !cache.sharedWithCore && <Memory valkey={cache} />}>
          {cache.sharedWithCore ? <span className="text-sm text-muted-foreground">{t('jobs.health.shared')}</span> : <Up up={cache.status === 'up'} latencyMs={cache.latencyMs} />}
        </ServiceRow>
      )}
      <ServiceRow label={t('jobs.health.runner')}>
        {health.heartbeat ? (
          <StatusDot tone="green">{t('jobs.health.beat', { time: formatTime(health.heartbeat.at, locale) })}</StatusDot>
        ) : (
          <StatusDot tone="red" className="font-medium text-destructive">
            {t('jobs.health.noBeat')}
          </StatusDot>
        )}
      </ServiceRow>
    </ul>
  );
}

/** A process's seen and start times and its settings version. */
function ProcessFacts({ at, startedAt, cfgVersion, current }: { at: string; startedAt: string; cfgVersion: number | null; current: number | null }) {
  const { t, locale } = useI18n();
  return (
    <>
      <span className="text-xs text-muted-foreground">
        {t('jobs.health.seen', { time: formatTime(at, locale) })} · {t('jobs.health.since', { time: formatDateTime(startedAt, locale) })}
      </span>
      {cfgVersion !== null && (
        <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {t('jobs.health.settings', { version: cfgVersion })}
          {behind(cfgVersion, current) && <Badge variant="warning">{t('jobs.health.behind')}</Badge>}
        </span>
      )}
    </>
  );
}

function ProcessList({ title, count, empty, children }: { title: string; count: number; empty: string; children: ReactNode }) {
  const { locale } = useI18n();
  return (
    <div className="grid content-start gap-2">
      <h3 className="flex items-center gap-2 text-sm font-medium">
        {title}
        <span className="text-muted-foreground tabular-nums">{new Intl.NumberFormat(locale).format(count)}</span>
      </h3>
      {count === 0 ? (
        <StatusDot tone="red" className="font-medium text-destructive">
          {empty}
        </StatusDot>
      ) : (
        <ul className="grid divide-y rounded-lg border">{children}</ul>
      )}
    </div>
  );
}

function Workers({ health }: { health: Health }) {
  const { t } = useI18n();
  return (
    <ProcessList title={t('jobs.health.workers')} count={health.workers.length} empty={t('jobs.health.workers.none')}>
      {health.workers.map((worker) => (
        <li key={worker.name} className="grid gap-1 px-3 py-2.5">
          <span className="flex min-w-0 items-center gap-2">
            <Code className="text-sm">{worker.name}</Code>
            {worker.maint && <Badge variant="secondary">{t('dashboard.queue.maint')}</Badge>}
          </span>
          <ProcessFacts at={worker.at} startedAt={worker.startedAt} cfgVersion={worker.cfgVersion} current={health.config.version} />
          {worker.queues.length > 0 && (
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer select-none">{t('jobs.health.queues', { count: worker.queues.length })}</summary>
              <ul className="mt-1.5 flex flex-wrap gap-1.5">
                {worker.queues.map((queue) => (
                  <li key={queue}>
                    <Badge variant="outline">{queueLabel(queue, t).name}</Badge>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </li>
      ))}
    </ProcessList>
  );
}

function Servers({ health }: { health: Health }) {
  const { t } = useI18n();
  return (
    <ProcessList title={t('jobs.health.servers')} count={health.apis.length} empty={t('jobs.health.servers.none')}>
      {health.apis.map((api) => (
        <li key={api.name} className="grid gap-1 px-3 py-2.5">
          <span className="flex min-w-0 items-center gap-2">
            <Code className="text-sm">{api.name}</Code>
            {api.self && <Badge variant="muted">{t('jobs.health.self')}</Badge>}
          </span>
          <ProcessFacts at={api.at} startedAt={api.startedAt} cfgVersion={api.cfgVersion} current={health.config.version} />
          {api.rolesFailing && (
            <StatusDot tone="red" className="text-xs font-medium text-destructive">
              {t('jobs.health.rolesFailing')}
            </StatusDot>
          )}
        </li>
      ))}
    </ProcessList>
  );
}
