import type { AdminReportSummary, AdminUserConsent, AdminUserDetail, AdminUserDevice, AdminUserPurchases, AdminUserSession, AdminUserWallet, AuditEntry } from '@app/shared';
import { useInfiniteQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronUp, Smartphone } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { DetailJson } from '@/components/DetailJson';
import { LoadError, TableSkeleton } from '@/components/QueryState';
import { Badge, StatusDot } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { UserRef } from '@/components/UserRef';
import type { MessageKey } from '@/i18n/messages';
import { useI18n } from '@/i18n/useI18n';
import { auditActionLabel } from '@/lib/audit';
import { apiRequest } from '@/lib/api';
import { formatDate, formatDateTime, formatNumber, formatPlain, languageName, localized } from '@/lib/format';
import { queryKeys, usePlans, useUserPages, useUserTab } from '@/lib/queries';
import { can } from '@/lib/session';
import { useSession } from '@/lib/useSession';
import { cn } from '@/lib/utils';
import { SectionCard } from '../SectionCard';

const reportTone: Readonly<Record<AdminReportSummary['status'], 'green' | 'amber' | 'blue' | 'gray'>> = {
  open: 'amber',
  in_review: 'blue',
  actioned: 'green',
  dismissed: 'gray',
  duplicate: 'gray',
};

/**
 * The read-only tabs of a person's page; each reads once, when it is first
 * opened. Every table sits in the same bordered panel, full width, under its
 * title when it has one.
 */

export function Empty({ text }: { text: string }) {
  return <p className="px-4 py-8 text-center text-sm text-muted-foreground">{text}</p>;
}

export function More({ show, busy, onMore }: { show: boolean; busy: boolean; onMore: () => void }) {
  const { t } = useI18n();
  if (!show) return null;
  return (
    <div className="border-t p-3 text-center">
      <Button variant="outline" size="sm" onClick={onMore} disabled={busy}>
        {t('common.loadMore')}
      </Button>
    </div>
  );
}

export function Panel({ title, children, className }: { title?: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn('overflow-hidden rounded-xl border bg-card text-card-foreground shadow-xs', className)}>
      {title && <h2 className="border-b px-4 py-3 text-base font-semibold sm:px-5">{title}</h2>}
      {children}
    </section>
  );
}

const when = (iso: string | null, locale: Parameters<typeof formatDate>[1], none: string) => (iso ? formatDateTime(iso, locale) : none);

// ─── Reports ────────────────────────────────────────────────────────────

export function ReportsTab({ user }: { user: AdminUserDetail }) {
  const { t, dir } = useI18n();
  const [side, setSide] = useState<'received' | 'filed'>('received');
  return (
    <Tabs value={side} onValueChange={(value) => setSide(value as 'received' | 'filed')} dir={dir} className="gap-3">
      <TabsList aria-label={t('user.tab.reports')} className="h-9">
        <TabsTrigger value="received">{t('reports.side.received')}</TabsTrigger>
        <TabsTrigger value="filed">{t('reports.side.filed')}</TabsTrigger>
      </TabsList>
      <TabsContent value="received">{side === 'received' && <ReportList user={user} side="received" />}</TabsContent>
      <TabsContent value="filed">{side === 'filed' && <ReportList user={user} side="filed" />}</TabsContent>
    </Tabs>
  );
}

function ReportList({ user, side }: { user: AdminUserDetail; side: 'received' | 'filed' }) {
  const { t, locale } = useI18n();
  const pages = useUserPages<AdminReportSummary>(user.id, 'reports', `/v1/admin/users/${user.id}/reports?side=${side}`, side);
  const items = pages.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <Panel>
      {pages.isPending ? (
        <TableSkeleton rows={3} />
      ) : pages.isError ? (
        <div className="p-4">
          <LoadError error={pages.error} onRetry={() => void pages.refetch()} />
        </div>
      ) : items.length === 0 ? (
        <Empty text={t('reports.empty')} />
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>{t('reports.col.reason')}</TableHead>
              <TableHead>{side === 'received' ? t('reports.col.reporter') : t('reports.col.reported')}</TableHead>
              <TableHead className="hidden sm:table-cell">{t('reports.col.context')}</TableHead>
              <TableHead className="hidden sm:table-cell">{t('reports.col.status')}</TableHead>
              <TableHead className="hidden md:table-cell">{t('reports.col.priority')}</TableHead>
              <TableHead className="hidden sm:table-cell">{t('reports.col.filed')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((report) => {
              const other = side === 'received' ? report.reporter : report.reported;
              return (
                <TableRow key={report.id}>
                  <TableCell>
                    <span className="grid justify-items-start gap-1">
                      <Badge variant={report.reason === 'child_safety' ? 'destructive' : 'secondary'} className="whitespace-normal sm:whitespace-nowrap">
                        {t(`reportReason.${report.reason}` as MessageKey)}
                      </Badge>
                      {/* On a phone the status sits under the reason (its column is hidden). */}
                      <StatusDot tone={reportTone[report.status]} className="text-xs sm:hidden">
                        {t(`reportStatus.${report.status}` as MessageKey)}
                      </StatusDot>
                    </span>
                  </TableCell>
                  <TableCell className="max-w-56">{other ? <UserRef user={other} /> : <span className="text-sm text-muted-foreground">{t('common.automatic')}</span>}</TableCell>
                  <TableCell className="hidden text-sm sm:table-cell">{t(`reportContext.${report.context}` as MessageKey)}</TableCell>
                  <TableCell className="hidden text-sm whitespace-nowrap sm:table-cell">
                    <StatusDot tone={reportTone[report.status]}>{t(`reportStatus.${report.status}` as MessageKey)}</StatusDot>
                  </TableCell>
                  <TableCell className="hidden text-sm tabular-nums md:table-cell">{formatNumber(report.priority, locale)}</TableCell>
                  <TableCell className="hidden text-sm whitespace-nowrap text-muted-foreground sm:table-cell">{formatDate(report.filedAt, locale)}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
      <More show={pages.hasNextPage} busy={pages.isFetchingNextPage} onMore={() => void pages.fetchNextPage()} />
    </Panel>
  );
}

// ─── Purchases ──────────────────────────────────────────────────────────

const sourceKey = (store: string | null): MessageKey => (store === null ? 'store.admin' : (`store.${store}` as MessageKey));

/** A plan by its name in the panel's language with its key under it (as the plans page shows it); the key alone without billing.read. */
function PlanName({ planKey }: { planKey: string }) {
  const { locale } = useI18n();
  const { me } = useSession();
  const readable = can(me, 'billing.read');
  const plans = usePlans(readable);
  const plan = plans.data?.items.find((item) => item.key === planKey);
  if (!plan) {
    return (
      <span dir="ltr" className="font-mono text-xs">
        {planKey}
      </span>
    );
  }
  return (
    <span className="grid justify-items-start gap-0.5">
      <span className="text-sm font-medium">{localized(plan.names, locale, plan.key)}</span>
      <span dir="ltr" className="font-mono text-xs text-muted-foreground">
        {plan.key}
      </span>
    </span>
  );
}

export function PurchasesTab({ user }: { user: AdminUserDetail }) {
  const { t, locale } = useI18n();
  const tab = useUserTab<AdminUserPurchases>(user.id, 'purchases', `/v1/admin/users/${user.id}/purchases`);
  if (tab.isPending) return <TableSkeleton rows={3} />;
  if (tab.isError) return <LoadError error={tab.error} onRetry={() => void tab.refetch()} />;
  const { subscriptions, items } = tab.data;
  return (
    <div className="grid gap-6">
      <Panel title={t('purchases.subscriptions')}>
        {subscriptions.length === 0 ? (
          <Empty text={t('purchases.noSubscription')} />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>{t('purchases.col.plan')}</TableHead>
                <TableHead>{t('purchases.col.store')}</TableHead>
                <TableHead>{t('purchases.col.status')}</TableHead>
                <TableHead className="hidden sm:table-cell">{t('purchases.col.started')}</TableHead>
                <TableHead>{t('purchases.col.expires')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {subscriptions.map((s) => (
                <TableRow key={`${s.store ?? 'admin'}-${s.plan}`}>
                  <TableCell>
                    <PlanName planKey={s.plan} />
                  </TableCell>
                  <TableCell className="text-sm">{t(sourceKey(s.store))}</TableCell>
                  <TableCell className="text-sm">{t(`subscriptionStatus.${s.status}` as MessageKey)}</TableCell>
                  <TableCell className="hidden text-sm whitespace-nowrap text-muted-foreground sm:table-cell">{formatDate(s.startedAt, locale)}</TableCell>
                  <TableCell className="text-sm whitespace-nowrap text-muted-foreground">{formatDate(s.expiresAt, locale)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Panel>
      <Panel title={t('purchases.items')}>
        {items.length === 0 ? (
          <Empty text={t('purchases.empty')} />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>{t('purchases.col.product')}</TableHead>
                <TableHead>{t('purchases.col.state')}</TableHead>
                <TableHead className="hidden sm:table-cell">{t('purchases.col.store')}</TableHead>
                <TableHead className="hidden md:table-cell">{t('purchases.col.order')}</TableHead>
                <TableHead>{t('purchases.col.purchased')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((p) => (
                <TableRow key={p.id}>
                  <TableCell>
                    <span className="grid justify-items-start gap-0.5">
                      <span dir="ltr" className="font-mono text-xs">
                        {p.productId}
                        {p.quantity > 1 ? ` ×${p.quantity}` : ''}
                      </span>
                      <span className="flex gap-1">
                        <Badge variant="outline">{t(`productKind.${p.kind}` as MessageKey)}</Badge>
                        {p.isTest && <Badge variant="secondary">{t('purchases.test')}</Badge>}
                      </span>
                    </span>
                  </TableCell>
                  <TableCell className="text-sm whitespace-nowrap">{t(`purchaseState.${p.state}` as MessageKey)}</TableCell>
                  <TableCell className="hidden text-sm sm:table-cell">{t(sourceKey(p.store))}</TableCell>
                  <TableCell className="hidden md:table-cell">
                    <span dir="ltr" className="font-mono text-xs text-muted-foreground">
                      {p.orderId ?? t('common.none')}
                    </span>
                  </TableCell>
                  <TableCell className="text-sm whitespace-nowrap text-muted-foreground">{formatDate(p.purchasedAt, locale)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Panel>
    </div>
  );
}

// ─── Wallet ─────────────────────────────────────────────────────────────

export function WalletTab({ user }: { user: AdminUserDetail }) {
  const { t, locale } = useI18n();
  const pages = useInfiniteQuery({
    queryKey: queryKeys.userTab(user.id, 'wallet'),
    initialPageParam: null as string | null,
    getNextPageParam: (last: AdminUserWallet) => last.ledger.nextCursor,
    queryFn: ({ pageParam, signal }) => apiRequest<AdminUserWallet>(`/v1/admin/users/${user.id}/wallet?limit=20${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`, { signal }),
  });
  if (pages.isPending) return <TableSkeleton rows={3} />;
  if (pages.isError) return <LoadError error={pages.error} onRetry={() => void pages.refetch()} />;
  const balances = pages.data.pages[0]?.balances ?? [];
  const ledger = pages.data.pages.flatMap((page) => page.ledger.items);
  return (
    <div className="grid gap-6">
      <SectionCard title={t('wallet.balances')}>
        {balances.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('wallet.noBalance')}</p>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {balances.map((b) => (
              <li key={`${b.item}-${b.store ?? 'admin'}`} className="grid gap-0.5 rounded-lg border px-3 py-2">
                <span className="text-xs text-muted-foreground">
                  {t(`walletItem.${b.item}` as MessageKey)} · {t(sourceKey(b.store))}
                </span>
                <span className="text-xl font-semibold tabular-nums">{formatNumber(b.balance, locale)}</span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
      <Panel title={t('wallet.ledger')}>
        {ledger.length === 0 ? (
          <Empty text={t('wallet.empty')} />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>{t('wallet.col.when')}</TableHead>
                <TableHead>{t('wallet.col.item')}</TableHead>
                <TableHead>{t('wallet.col.change')}</TableHead>
                <TableHead className="hidden sm:table-cell">{t('wallet.col.after')}</TableHead>
                <TableHead>{t('wallet.col.reason')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ledger.map((l) => (
                <TableRow key={l.id}>
                  <TableCell className="text-sm whitespace-nowrap text-muted-foreground">{formatDateTime(l.at, locale)}</TableCell>
                  <TableCell className="text-sm">{t(`walletItem.${l.item}` as MessageKey)}</TableCell>
                  <TableCell className={cn('text-sm tabular-nums', l.delta > 0 ? 'text-emerald-700 dark:text-emerald-300' : '')}>
                    <span dir="ltr">{l.delta > 0 ? `+${formatNumber(l.delta, locale)}` : formatNumber(l.delta, locale)}</span>
                  </TableCell>
                  <TableCell className="hidden text-sm tabular-nums sm:table-cell">{formatNumber(l.balanceAfter, locale)}</TableCell>
                  <TableCell className="text-sm">
                    {t(`ledgerReason.${l.reason}` as MessageKey)}
                    {l.admin && <span className="text-muted-foreground"> · {l.admin.displayName}</span>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <More show={pages.hasNextPage} busy={pages.isFetchingNextPage} onMore={() => void pages.fetchNextPage()} />
      </Panel>
    </div>
  );
}

// ─── Devices ────────────────────────────────────────────────────────────

export function DevicesTab({ user }: { user: AdminUserDetail }) {
  const { t, locale } = useI18n();
  const tab = useUserTab<{ items: AdminUserDevice[] }>(user.id, 'devices', `/v1/admin/users/${user.id}/devices`);
  if (tab.isPending) return <TableSkeleton rows={3} />;
  if (tab.isError) return <LoadError error={tab.error} onRetry={() => void tab.refetch()} />;
  if (tab.data.items.length === 0) return <Empty text={t('devices.empty')} />;
  return (
    <ul className="grid gap-4 md:grid-cols-2">
      {tab.data.items.map((device) => (
        <li key={device.id} className="grid content-start gap-3 rounded-xl border bg-card p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Smartphone className="size-4 text-muted-foreground" aria-hidden="true" />
            <span className="font-medium">{t(`devices.${device.platform}` as MessageKey)}</span>
            <Badge variant="outline">{t(sourceKey(device.store))}</Badge>
            {device.disabledAt && <Badge variant="muted">{t('devices.disabled')}</Badge>}
          </div>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
            <dt className="text-muted-foreground">{t('devices.appVersion')}</dt>
            <dd className="tabular-nums">{formatPlain(device.appVersion, locale)}</dd>
            <dt className="text-muted-foreground">{t('devices.integrity')}</dt>
            <dd>{t(`integrity.${device.integrity}` as MessageKey)}</dd>
            <dt className="text-muted-foreground">{t('user.field.locale')}</dt>
            <dd>{device.locale ? languageName(device.locale, locale) : t('common.none')}</dd>
            <dt className="text-muted-foreground">{t('devices.push')}</dt>
            <dd>{device.push ? t('common.yes') : t('common.no')}</dd>
            <dt className="text-muted-foreground">{t('devices.updated')}</dt>
            <dd>{formatDateTime(device.updatedAt, locale)}</dd>
          </dl>
          {device.linked.length > 0 && (
            <div className="grid gap-2 border-t pt-3">
              <span className="text-xs font-medium text-muted-foreground">{t('devices.linked')}</span>
              <ul className="grid gap-2">
                {device.linked.map((linked) => (
                  <li key={linked.id}>
                    <UserRef user={linked} />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

// ─── Sessions ───────────────────────────────────────────────────────────

export function SessionsTab({ user }: { user: AdminUserDetail }) {
  const { t, locale } = useI18n();
  const tab = useUserTab<{ items: AdminUserSession[] }>(user.id, 'sessions', `/v1/admin/users/${user.id}/sessions`);
  if (tab.isPending) return <TableSkeleton rows={3} />;
  if (tab.isError) return <LoadError error={tab.error} onRetry={() => void tab.refetch()} />;
  if (tab.data.items.length === 0) return <Empty text={t('sessions.empty')} />;
  return (
    <Panel>
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>{t('sessions.col.started')}</TableHead>
            <TableHead className="hidden sm:table-cell">{t('sessions.col.refreshed')}</TableHead>
            <TableHead className="hidden md:table-cell">{t('purchases.col.store')}</TableHead>
            <TableHead className="hidden md:table-cell">{t('devices.appVersion')}</TableHead>
            <TableHead>{t('sessions.col.state')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {tab.data.items.map((s) => (
            <TableRow key={s.id}>
              <TableCell className="text-sm whitespace-nowrap">{formatDateTime(s.createdAt, locale)}</TableCell>
              <TableCell className="hidden text-sm whitespace-nowrap text-muted-foreground sm:table-cell">{formatDateTime(s.refreshedAt, locale)}</TableCell>
              <TableCell className="hidden text-sm md:table-cell">{t(sourceKey(s.store))}</TableCell>
              <TableCell className="hidden text-sm tabular-nums md:table-cell">{s.appVersion !== null ? formatPlain(s.appVersion, locale) : t('common.none')}</TableCell>
              <TableCell>
                {s.revokedAt ? (
                  <StatusDot tone="gray">
                    {s.revokeReason ? t(`revokeReason.${s.revokeReason}` as MessageKey) : t('common.none')} · {formatDate(s.revokedAt, locale)}
                  </StatusDot>
                ) : (
                  <StatusDot tone="green">{t('sessions.active')}</StatusDot>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Panel>
  );
}

// ─── Consents ───────────────────────────────────────────────────────────

export function ConsentsTab({ user }: { user: AdminUserDetail }) {
  const { t, locale } = useI18n();
  const tab = useUserTab<{ items: AdminUserConsent[] }>(user.id, 'consents', `/v1/admin/users/${user.id}/consents`);
  if (tab.isPending) return <TableSkeleton rows={3} />;
  if (tab.isError) return <LoadError error={tab.error} onRetry={() => void tab.refetch()} />;
  if (tab.data.items.length === 0) return <Empty text={t('consents.empty')} />;
  return (
    <Panel>
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>{t('consents.col.kind')}</TableHead>
            <TableHead>{t('consents.col.version')}</TableHead>
            <TableHead>{t('consents.col.accepted')}</TableHead>
            <TableHead className="hidden sm:table-cell">{t('consents.col.withdrawn')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {tab.data.items.map((c) => (
            <TableRow key={`${c.kind}-${c.version}`}>
              <TableCell className="text-sm">{t(`consentKind.${c.kind}` as MessageKey)}</TableCell>
              <TableCell className="text-sm tabular-nums">{formatNumber(c.version, locale)}</TableCell>
              <TableCell className="text-sm whitespace-nowrap text-muted-foreground">{formatDate(c.acceptedAt, locale)}</TableCell>
              <TableCell className="hidden text-sm whitespace-nowrap text-muted-foreground sm:table-cell">{c.withdrawnAt ? formatDate(c.withdrawnAt, locale) : t('common.none')}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Panel>
  );
}

// ─── Audit ──────────────────────────────────────────────────────────────

export function AuditTab({ user }: { user: AdminUserDetail }) {
  const { t, locale } = useI18n();
  const pages = useUserPages<AuditEntry>(user.id, 'audit', `/v1/admin/users/${user.id}/audit`);
  const [open, setOpen] = useState<string | null>(null);
  if (pages.isPending) return <TableSkeleton rows={3} />;
  if (pages.isError) return <LoadError error={pages.error} onRetry={() => void pages.refetch()} />;
  const items = pages.data.pages.flatMap((page) => page.items);
  if (items.length === 0) return <Empty text={t('audit.empty')} />;
  return (
    <Panel>
      <ul className="divide-y">
        {items.map((entry) => (
          <li key={entry.id} className="grid gap-2 px-4 py-3 text-sm">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <span className="whitespace-nowrap text-muted-foreground">{when(entry.at, locale, '')}</span>
              <span className="grid">
                <span>{auditActionLabel(entry.action, t)}</span>
                <span dir="ltr" className="font-mono text-xs text-muted-foreground">
                  {entry.action}
                </span>
              </span>
              <span className="text-muted-foreground">{entry.admin?.displayName ?? t('audit.system')}</span>
              {entry.ip && (
                <span dir="ltr" className="font-mono text-xs text-muted-foreground">
                  {entry.ip}
                </span>
              )}
              {entry.detail && Object.keys(entry.detail).length > 0 && (
                <Button variant="ghost" size="sm" className="ms-auto" aria-expanded={open === entry.id} onClick={() => setOpen(open === entry.id ? null : entry.id)}>
                  {open === entry.id ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
                  {open === entry.id ? t('audit.hideDetail') : t('audit.showDetail')}
                </Button>
              )}
            </div>
            {open === entry.id && entry.detail && <DetailJson value={entry.detail} />}
          </li>
        ))}
      </ul>
      <More show={pages.hasNextPage} busy={pages.isFetchingNextPage} onMore={() => void pages.fetchNextPage()} />
    </Panel>
  );
}

