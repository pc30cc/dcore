import type { AdminPurchaseListItem, AdminPurchaseSearchResult, AdminPurchaseSummary, AppStore, PurchaseMatch } from '@app/shared';
import { PlugZap, Receipt, Search, X } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { PageHeader } from '@/components/layout/PageHeader';
import { LoadError, TableSkeleton } from '@/components/QueryState';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useI18n } from '@/i18n/useI18n';
import { apiRequest } from '@/lib/api';
import { asciiDigits, formatDate } from '@/lib/format';
import { asApiError } from '@/lib/http';
import { listState } from '@/lib/listState';
import { problemText } from '@/lib/problemText';
import { isPurchaseState, matchText, purchaseStates, purchaseStores, usePurchases, type PurchaseState } from '@/lib/purchases';
import { showToast } from '@/lib/toast';
import { PersonCell, PurchaseStateDot } from './parts';

interface Results {
  items: AdminPurchaseSummary[];
  matchedBy: PurchaseMatch | null;
}

/**
 * `/revenue/purchases`: a store's purchases newest first (`?store=`, one
 * state at a time `?state=`), and a search by purchase id, person, order
 * id or purchase token whose text stays in this page (posted in a body,
 * never in the address or the browser's history).
 */
export function PurchasesPage() {
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const store: AppStore = params.get('store') === 'bazaar' ? 'bazaar' : 'play';
  const rawState = params.get('state');
  const state: PurchaseState | null = isPurchaseState(rawState) ? rawState : null;
  const purchases = usePurchases(store, state);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Results | null>(null);
  const [searching, setSearching] = useState(false);

  function view(next: { store?: AppStore; state?: PurchaseState | null }) {
    const nextStore = next.store ?? store;
    const nextState = next.state === undefined ? state : next.state;
    const entries: Record<string, string> = {};
    if (nextStore !== 'play') entries.store = nextStore;
    if (nextState) entries.state = nextState;
    setParams(entries, { replace: true });
  }

  async function search(event: FormEvent) {
    event.preventDefault();
    // Ids typed on a Persian keyboard count; a token or an order id is taken as typed otherwise.
    const q = asciiDigits(query.trim());
    if (!q || searching) return;
    setSearching(true);
    try {
      setResults(await apiRequest<AdminPurchaseSearchResult>('/v1/admin/purchases/search', { method: 'POST', body: { q } }));
    } catch (error) {
      const failure = asApiError(error);
      showToast((t, lang) => problemText(failure, t, lang), 'error', 6_000);
    } finally {
      setSearching(false);
    }
  }

  function clear() {
    setQuery('');
    setResults(null);
  }

  const first = purchases.data?.pages[0];
  const rows = results?.items ?? purchases.data?.pages.flatMap((page) => page.items) ?? [];
  const failed = results === null && purchases.isError;
  return (
    <div className="mx-auto grid max-w-6xl grid-cols-1 gap-6">
      <PageHeader icon={Receipt} title={t('purchases.title')} />
      <Tabs
        value={store}
        onValueChange={(value) => {
          clear();
          view({ store: value as AppStore });
        }}
      >
        <TabsList aria-label={t('purchases.col.store')}>
          {purchaseStores.map((code) => (
            <TabsTrigger key={code} value={code}>
              {t(`store.${code}`)}
            </TabsTrigger>
          ))}
        </TabsList>
        {purchaseStores.map((code) => (
          <TabsContent key={code} value={code} className="grid grid-cols-1 gap-4">
            {code === store && (
              <>
                {results === null && first?.connected === false && (
                  <Alert>
                    <PlugZap aria-hidden="true" />
                    <AlertDescription>{t('purchases.storeOff')}</AlertDescription>
                  </Alert>
                )}
                <Card className="gap-0 overflow-hidden py-0">
                  <div className="flex flex-col gap-3 border-b p-3 sm:flex-row sm:items-center">
                    <form role="search" className="flex min-w-0 flex-1 flex-wrap items-center gap-2 sm:flex-nowrap" onSubmit={(event) => void search(event)}>
                      <div className="relative min-w-0 flex-1 basis-full sm:basis-0">
                        <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                        {/* A text box, not type=search: the browser's own clear button would empty the box but leave the results. */}
                        <Input
                          type="text"
                          enterKeyHint="search"
                          value={query}
                          onChange={(event) => setQuery(event.target.value)}
                          placeholder={t('purchases.search.placeholder')}
                          aria-label={t('purchases.search.label')}
                          autoComplete="off"
                          spellCheck={false}
                          className="ps-9"
                        />
                      </div>
                      {results !== null && (
                        <Button type="button" variant="ghost" size="icon" onClick={clear} aria-label={t('purchases.search.clear')} title={t('purchases.search.clear')}>
                          <X aria-hidden="true" />
                        </Button>
                      )}
                      <Button type="submit" variant="secondary" disabled={searching || !query.trim()}>
                        {t('common.search')}
                      </Button>
                    </form>
                    <label className="flex items-center gap-2 text-sm text-muted-foreground sm:w-60">
                      <span className="shrink-0" aria-hidden="true">
                        {t('purchases.col.state')}
                      </span>
                      <NativeSelect
                        aria-label={t('purchases.col.state')}
                        value={state ?? ''}
                        disabled={results !== null}
                        onChange={(event) =>
                          view({
                            state: isPurchaseState(event.target.value) ? event.target.value : null,
                          })
                        }
                      >
                        <option value="">{t('purchases.state.all')}</option>
                        {purchaseStates.map((code) => (
                          <option key={code} value={code}>
                            {t(`purchaseState.${code}`)}
                          </option>
                        ))}
                      </NativeSelect>
                    </label>
                  </div>
                  {results?.matchedBy && (
                    <div className="flex items-center gap-2 border-b px-4 py-2 text-sm text-muted-foreground">
                      <Badge variant="secondary">{t(matchText[results.matchedBy])}</Badge>
                    </div>
                  )}
                  {failed && !purchases.data ? (
                    <div className="p-4">
                      <LoadError error={purchases.error} onRetry={() => void purchases.refetch()} />
                    </div>
                  ) : results === null && purchases.isPending ? (
                    <TableSkeleton rows={8} />
                  ) : rows.length === 0 ? (
                    <p className="px-4 py-8 text-center text-sm text-muted-foreground">{results !== null ? t('purchases.noMatch') : state ? t('purchases.emptyFiltered') : t('purchases.empty')}</p>
                  ) : (
                    <PurchaseTable rows={rows} searched={results !== null} />
                  )}
                  {failed && purchases.data && (
                    <div className="border-t p-4">
                      <LoadError error={purchases.error} onRetry={() => void purchases.refetch()} />
                    </div>
                  )}
                  {results === null && purchases.hasNextPage && (
                    <div className="border-t p-3 text-center">
                      <Button variant="outline" size="sm" onClick={() => void purchases.fetchNextPage()} disabled={purchases.isFetchingNextPage}>
                        {t('common.loadMore')}
                      </Button>
                    </div>
                  )}
                </Card>
              </>
            )}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

/**
 * The list's rows carry no order id (it never pairs order ids with people in
 * bulk); a search's do, and only then is the column shown.
 */
function PurchaseTable({ rows, searched }: { rows: readonly (AdminPurchaseListItem | AdminPurchaseSummary)[]; searched: boolean }) {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  // The purchase's page goes back to this store and state.
  const state = listState(useLocation().search);
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>{t('purchases.col.product')}</TableHead>
          <TableHead>{t('purchases.col.person')}</TableHead>
          <TableHead className="hidden sm:table-cell">{t('purchases.col.state')}</TableHead>
          <TableHead className="hidden sm:table-cell">{t('purchases.col.purchased')}</TableHead>
          <TableHead className="hidden md:table-cell">{t('purchases.col.expires')}</TableHead>
          {searched && <TableHead className="hidden lg:table-cell">{t('purchases.col.order')}</TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((p) => (
          <TableRow key={p.id} className="cursor-pointer" onClick={(event) => !(event.target as HTMLElement).closest('a') && void navigate(`/revenue/purchases/${p.id}`, { state })}>
            <TableCell className="max-w-72">
              <span className="grid justify-items-start gap-1">
                <Link
                  to={`/revenue/purchases/${p.id}`}
                  state={state}
                  dir="ltr"
                  className="max-w-full truncate rounded-sm font-mono text-xs font-medium outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  title={p.basePlanId ? `${p.productId} · ${p.basePlanId}` : p.productId}
                >
                  {p.productId}
                  {p.basePlanId && <span className="font-normal text-muted-foreground"> {p.basePlanId}</span>}
                  {p.quantity > 1 && <span> {t('purchases.quantity', { count: p.quantity })}</span>}
                </Link>
                <span className="flex flex-wrap gap-1">
                  <Badge variant="outline">{t(`productKind.${p.kind}`)}</Badge>
                  {searched && <Badge variant="outline">{t(`store.${p.store}`)}</Badge>}
                  {p.isTest && <Badge variant="secondary">{t('purchases.test')}</Badge>}
                </span>
                {/* On a phone the state and the day sit here (their columns are hidden). */}
                <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground sm:hidden">
                  <PurchaseStateDot state={p.state} className="text-xs text-foreground" />
                  <span>{formatDate(p.purchasedAt, locale)}</span>
                </span>
              </span>
            </TableCell>
            <TableCell className="max-w-56">
              {/* An unclaimed purchase's state already says "no account". */}
              <PersonCell user={p.user} compact />
            </TableCell>
            <TableCell className="hidden sm:table-cell">
              <PurchaseStateDot state={p.state} />
            </TableCell>
            <TableCell className="hidden text-sm whitespace-nowrap text-muted-foreground sm:table-cell">{formatDate(p.purchasedAt, locale)}</TableCell>
            <TableCell className="hidden text-sm whitespace-nowrap text-muted-foreground md:table-cell">{p.expiresAt ? formatDate(p.expiresAt, locale) : t('common.none')}</TableCell>
            {searched && (
              <TableCell className="hidden lg:table-cell">
                {/* The cell keeps the page's direction (start-aligned under its header); only the id reads left to right. */}
                <span className="block max-w-48 truncate font-mono text-xs text-muted-foreground" title={orderIdOf(p) ?? undefined}>
                  {orderIdOf(p) ? <bdi dir="ltr">{orderIdOf(p)}</bdi> : t('common.none')}
                </span>
              </TableCell>
            )}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function orderIdOf(row: AdminPurchaseListItem | AdminPurchaseSummary): string | null {
  return 'orderId' in row ? row.orderId : null;
}
