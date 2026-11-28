import type { AdminStatsLive, Permission } from '@app/shared';
import { ChevronLeft, ChevronRight, LayoutDashboard, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { StatTile } from '@/components/charts/StatsCard';
import { PageHeader } from '@/components/layout/PageHeader';
import { LoadError } from '@/components/QueryState';
import { Badge, StatusDot } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import type { MessageKey } from '@/i18n/messages';
import { hasMessage, type Translate } from '@/i18n/translate';
import { useI18n } from '@/i18n/useI18n';
import { formatNumber, formatTime } from '@/lib/format';
import { sectionGroups } from '@/lib/sections';
import { can } from '@/lib/session';
import { formatMoney, formatPercent, formatSpan, ratio, useStatsLive } from '@/lib/stats';
import { useSession } from '@/lib/useSession';
import { cn } from '@/lib/utils';

/** Whether a page of the navigation is built (its item has no placeholder number). */
function built(path: string): boolean {
  return sectionGroups.some((group) => group.items.some((item) => item.path === path && item.spec === undefined));
}

/** A table row's header cell (a code attribute, kept out of the JSX). */
const ROW = 'row';

/** A failure rate worth a look. */
const PROVIDER_ALERT = 0.05;
/** A saving queue this far behind is shown in red. */
const STREAM_ALERT_MS = 60_000;

/**
 * `/`: today (UTC) at a glance, read again every 30 s while the tab is
 * visible: people online and active, today's activity, the review queues,
 * the background service and its queues, and the providers' calls. Money
 * only with `dashboard.revenue`. Figures the background service counts read
 * "—" with "Waiting for the background service" while it is not running or
 * has written none in the last 150 seconds (the server leaves them out).
 */
export function DashboardPage() {
  const { t, locale } = useI18n();
  const { me } = useSession();
  const live = useStatsLive();
  const data = live.data;
  const revenue = can(me, 'dashboard.revenue');

  return (
    <div className="mx-auto grid max-w-6xl grid-cols-1 gap-6">
      <PageHeader
        icon={LayoutDashboard}
        title={t('nav.dashboard')}
        meta={
          <>
            <span className="text-muted-foreground">{t('dashboard.today')}</span>
            {data && <span className="text-muted-foreground">{t('dashboard.updated', { time: formatTime(data.at, locale) })}</span>}
            {data && live.isError && (
              <span className="flex items-center gap-1.5 text-amber-700 dark:text-amber-300" role="status">
                <TriangleAlert className="size-3.5" aria-hidden="true" />
                {t('dashboard.stale')}
              </span>
            )}
          </>
        }
      />
      {live.isPending ? (
        <TilesSkeleton />
      ) : !data ? (
        <LoadError error={live.error} onRetry={() => void live.refetch()} />
      ) : (
        <Dashboard data={data} revenue={revenue} />
      )}
    </div>
  );
}

function TilesSkeleton() {
  const { t } = useI18n();
  return (
    <div className="grid gap-3" aria-busy="true">
      <span className="sr-only">{t('common.loading')}</span>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} aria-hidden="true" className="h-24 rounded-xl" />
        ))}
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <Skeleton aria-hidden="true" className="h-56 rounded-xl" />
        <Skeleton aria-hidden="true" className="h-56 rounded-xl" />
      </div>
    </div>
  );
}

function Dashboard({ data, revenue }: { data: AdminStatsLive; revenue: boolean }) {
  const { t, locale } = useI18n();
  const count = (value: number | null) => (value === null ? null : formatNumber(value, locale));
  const waiting = data.snapshotAt === null ? t('dashboard.waiting') : undefined;
  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label={t('dashboard.tile.online')} value={count(data.online)} sub={waiting} />
        <StatTile label={t('dashboard.tile.active')} value={count(data.activeToday)} />
        <StatTile label={t('dashboard.tile.signups')} value={count(data.signupsToday)} sub={waiting} />
        <StatTile label={t('dashboard.tile.matches')} value={count(data.matchesToday)} sub={waiting} />
        <StatTile
          label={t('dashboard.tile.likes')}
          value={count(data.likesToday)}
          sub={t('dashboard.tile.likesSub', { superlikes: formatNumber(data.superlikesToday, locale), passes: formatNumber(data.passesToday, locale) })}
        />
        <StatTile label={t('dashboard.tile.messages')} value={count(data.messagesToday)} />
        <StatTile
          label={t('dashboard.tile.calls')}
          value={count(data.callsToday)}
          sub={
            data.callsAnsweredToday === null
              ? t('dashboard.tile.callsLive', { live: formatNumber(data.callsLive, locale) })
              : t('dashboard.tile.callsSub', { answered: formatNumber(data.callsAnsweredToday, locale), live: formatNumber(data.callsLive, locale) })
          }
        />
        <StatTile label={t('dashboard.tile.reports')} value={count(data.reportsToday)} sub={waiting} />
      </div>
      <div className="grid items-start gap-3 lg:grid-cols-2">
        <div className="grid gap-3">
          {revenue && <RevenueToday data={data} />}
          <ReviewCard data={data} />
        </div>
        <div className="grid gap-3">
          <HealthCard data={data} />
          <ProvidersCard data={data} />
        </div>
      </div>
    </>
  );
}

function Card({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="grid min-w-0 content-start gap-3 rounded-xl border bg-card p-4 text-card-foreground shadow-xs sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function Waiting() {
  const { t } = useI18n();
  return <p className="text-sm text-muted-foreground">{t('dashboard.waiting')}</p>;
}

/** Every currency of the day, by code (amounts of different currencies are not compared, so none is left out). */
function RevenueToday({ data }: { data: AdminStatsLive }) {
  const { t, locale } = useI18n();
  const lines = data.revenueToday ?? [];
  return (
    <Card title={t('dashboard.revenue.title')}>
      {data.snapshotAt === null ? (
        <Waiting />
      ) : lines.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('dashboard.revenue.none')}</p>
      ) : (
        <ul className="grid gap-2">
          {lines.map((line) => (
            <li key={line.currency} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="text-2xl font-semibold tracking-tight">{formatMoney(line.amountMicros, line.currency, locale)}</span>
              {line.estimated && <Badge variant="muted">{t('dashboard.estimate')}</Badge>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** A row of a card: a name (a link when the admin may open its page), its figure, and what it adds. */
function Row({ label, value, sub, to, alert = false }: { label: string; value: string; sub?: ReactNode; to?: string | null; alert?: boolean }) {
  const { dir } = useI18n();
  const Chevron = dir === 'rtl' ? ChevronLeft : ChevronRight;
  const inner = (
    <>
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="truncate text-sm">{label}</span>
        {sub && <span className={cn('truncate text-xs', alert ? 'text-destructive' : 'text-muted-foreground')}>{sub}</span>}
      </span>
      <span className="text-lg font-semibold tabular-nums">{value}</span>
      {/* A row without a page keeps the chevron's place, so every count lines up. */}
      {to ? <Chevron className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" /> : <span className="size-4 shrink-0" aria-hidden="true" />}
    </>
  );
  return (
    <li>
      {to ? (
        <Link to={to} className="-mx-2 flex items-center gap-3 rounded-md px-2 py-2 outline-none hover:bg-muted/60 focus-visible:ring-[3px] focus-visible:ring-ring/50">
          {inner}
        </Link>
      ) : (
        <div className="-mx-2 flex items-center gap-3 px-2 py-2">{inner}</div>
      )}
    </li>
  );
}

function ReviewCard({ data }: { data: AdminStatsLive }) {
  const { t, locale } = useI18n();
  const { me } = useSession();
  const q = data.queues;
  const capped = (c: { count: number; more: boolean }) => (c.more ? t('dashboard.countMore', { count: formatNumber(c.count, locale) }) : formatNumber(c.count, locale));
  const link = (path: string, permission: Permission) => (built(path) && can(me, permission) ? `/${path}` : null);
  return (
    <Card title={t('dashboard.review.title')}>
      {!q ? (
        <Waiting />
      ) : (
        <ul className="grid divide-y">
          <Row label={t('nav.photos')} value={capped(q.photos)} to={link('moderation/photos', 'moderation.read')} />
          <Row label={t('nav.texts')} value={capped(q.texts)} to={link('moderation/texts', 'moderation.read')} />
          <Row
            label={t('dashboard.review.reports')}
            value={capped(q.reports)}
            sub={q.urgentReports.count > 0 ? t('dashboard.review.urgent', { count: capped(q.urgentReports) }) : undefined}
            alert={q.urgentReports.count > 0}
            to={link('moderation/reports', 'reports.read')}
          />
          <Row label={t('nav.appeals')} value={capped(q.appeals)} to={link('moderation/appeals', 'appeals.read')} />
          <Row label={t('dashboard.review.tickets')} value={capped(q.tickets)} to={link('support', 'support.read')} />
        </ul>
      )}
    </Card>
  );
}

/** A job queue's words; a queue this build has none for (a newer worker) keeps its code. */
function queueName(queue: string, t: Translate): { name: string; mono?: boolean } {
  const key = `dashboard.queue.${queue}`;
  return hasMessage(key) ? { name: t(key) } : { name: queue, mono: true };
}

function HealthCard({ data }: { data: AdminStatsLive }) {
  const { t, locale } = useI18n();
  const { me } = useSession();
  const jobs = (data.jobs ?? []).filter((job) => job.waiting + job.active + job.delayed + job.failed > 0);
  const jobsLink = built('system/jobs') && can(me, 'system.read');
  return (
    <Card
      title={t('dashboard.health.title')}
      action={
        jobsLink ? (
          <Link to="/system/jobs" className="text-sm text-primary hover:underline">
            {t('nav.system')}
          </Link>
        ) : undefined
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm">{t('dashboard.health.worker')}</span>
        {data.worker.alive && data.worker.lastBeatAt ? (
          <StatusDot tone="green">{t('dashboard.health.workerUp', { time: formatTime(data.worker.lastBeatAt, locale) })}</StatusDot>
        ) : (
          <StatusDot tone="red" className="text-destructive">
            {t('dashboard.health.workerDown')}
          </StatusDot>
        )}
      </div>
      {data.snapshotAt === null ? (
        <Waiting />
      ) : (
        <>
          <MiniTable
            title={t('dashboard.health.streams')}
            columns={[t('dashboard.health.col.waiting'), t('dashboard.health.col.delay'), t('dashboard.health.col.failed')]}
            rows={(data.streams ?? []).map((stream) => ({
              key: stream.name,
              name: t(`dashboard.stream.${stream.name}` as MessageKey),
              cells: [
                { text: formatNumber(stream.pending, locale) },
                { text: stream.lagMs === null ? '—' : formatSpan(stream.lagMs / 1000, locale), alert: stream.lagMs !== null && stream.lagMs > STREAM_ALERT_MS },
                { text: formatNumber(stream.dead, locale), alert: stream.dead > 0 },
              ],
            }))}
          />
          {jobs.length === 0 ? (
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="text-xs font-medium text-muted-foreground">{t('dashboard.health.jobs')}</span>
              <span className="text-muted-foreground">{t('dashboard.health.idle')}</span>
            </div>
          ) : (
            <MiniTable
              title={t('dashboard.health.jobs')}
              columns={[t('dashboard.health.col.waiting'), t('dashboard.health.col.running'), t('dashboard.health.col.scheduled'), t('dashboard.health.col.failed')]}
              rows={jobs.map((job) => ({
                key: job.queue,
                ...queueName(job.queue, t),
                cells: [
                  { text: formatNumber(job.waiting, locale) },
                  { text: formatNumber(job.active, locale) },
                  { text: formatNumber(job.delayed, locale) },
                  { text: formatNumber(job.failed, locale), alert: job.failed > 0 },
                ],
              }))}
            />
          )}
        </>
      )}
    </Card>
  );
}

/** A small table of a card: a name per row and a few figures, red where something is wrong; the names give way, never the figures, so it fits a phone's card. */
function MiniTable({
  title,
  hideTitle = false,
  columns,
  rows,
}: {
  title: string;
  /** The card's title already says it (a screen reader still hears it). */
  hideTitle?: boolean;
  columns: readonly string[];
  rows: readonly { key: string; name: string; mono?: boolean; cells: readonly { text: string; alert?: boolean }[] }[];
}) {
  return (
    <table className="w-full text-sm">
      <caption className={cn('pb-1 text-start text-xs font-medium text-muted-foreground', hideTitle && 'sr-only')}>{title}</caption>
      <thead>
        <tr className="text-xs text-muted-foreground">
          <td />
          {columns.map((column) => (
            <th key={column} className="py-1 ps-2 text-end font-normal whitespace-nowrap sm:ps-3">
              {column}
            </th>
          ))}
        </tr>
      </thead>
      <tbody className="divide-y">
        {rows.map((row) => (
          <tr key={row.key}>
            <th scope={ROW} className={cn('py-1.5 text-start font-normal hyphens-auto wrap-anywhere', row.mono && 'font-mono text-xs')}>
              {row.name}
            </th>
            {row.cells.map((cell, i) => (
              <td key={i} className={cn('py-1.5 ps-2 text-end tabular-nums whitespace-nowrap sm:ps-3', cell.alert && 'font-medium text-destructive')}>
                {cell.text}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ProvidersCard({ data }: { data: AdminStatsLive }) {
  const { t, locale } = useI18n();
  return (
    <Card title={t('dashboard.providers.title')}>
      <MiniTable
        title={t('dashboard.providers.title')}
        hideTitle
        columns={[t('stats.provider.col.ok'), t('stats.provider.col.failed'), t('stats.provider.col.rate')]}
        rows={data.providers.map((provider) => {
          const rate = ratio(provider.failed, provider.ok + provider.failed);
          return {
            key: provider.name,
            name: t(`stats.provider.${provider.name}` as MessageKey),
            cells: [
              { text: formatNumber(provider.ok, locale) },
              { text: formatNumber(provider.failed, locale), alert: provider.failed > 0 && (rate ?? 0) >= PROVIDER_ALERT },
              { text: rate === null ? '—' : formatPercent(rate, locale), alert: (rate ?? 0) >= PROVIDER_ALERT },
            ],
          };
        })}
      />
    </Card>
  );
}
