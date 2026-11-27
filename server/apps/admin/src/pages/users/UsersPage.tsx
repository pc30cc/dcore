import type { AdminUserFilter, AdminUserSearchResult, AdminUserSummary } from '@app/shared';
import { Search, Users, X } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { listState } from '@/lib/listState';
import { PageHeader } from '@/components/layout/PageHeader';
import { LoadError, TableSkeleton } from '@/components/QueryState';
import { Badge, StatusDot } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { UserRef } from '@/components/UserRef';
import type { MessageKey } from '@/i18n/messages';
import { useI18n } from '@/i18n/useI18n';
import { apiRequest } from '@/lib/api';
import { formatDate, regionName } from '@/lib/format';
import { asApiError } from '@/lib/http';
import { problemText } from '@/lib/problemText';
import { useUsers } from '@/lib/queries';
import { showToast } from '@/lib/toast';
import { can } from '@/lib/session';
import { isUserFilter, statusTone, userFilters } from '@/lib/users';
import { useSession } from '@/lib/useSession';

type Row = AdminUserSummary & {
  matchedBy?: AdminUserSearchResult['items'][number]['matchedBy'];
};

/** `/users`: people newest first, a filter (in the URL), and a search (never in the URL). */
export function UsersPage() {
  const { t } = useI18n();
  const { me } = useSession();
  // Shadowbans are shown to the roles that may see them only (the API refuses the filter to the others).
  const seesShadowbans = can(me, 'users.shadowban') || can(me, 'moderation.read');
  const filters = userFilters.filter((f) => f !== 'shadowbanned' || seesShadowbans);
  const [params, setParams] = useSearchParams();
  const raw = params.get('filter');
  const filter: AdminUserFilter | null = isUserFilter(raw) && filters.includes(raw) ? raw : null;
  const users = useUsers(filter);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Row[] | null>(null);
  const [searching, setSearching] = useState(false);

  async function search(event: FormEvent) {
    event.preventDefault();
    const q = query.trim();
    if (!q || searching) return;
    setSearching(true);
    try {
      const found = await apiRequest<AdminUserSearchResult>('/v1/admin/users/search', { method: 'POST', body: { q } });
      setResults(found.items);
    } catch (error) {
      showToast((t) => problemText(asApiError(error), t), 'error', 6_000);
    } finally {
      setSearching(false);
    }
  }

  function clear() {
    setQuery('');
    setResults(null);
  }

  const rows: Row[] = results ?? users.data?.pages.flatMap((page) => page.items) ?? [];
  const failed = results === null && users.isError;
  return (
    <div className="mx-auto grid max-w-6xl gap-6">
      <PageHeader icon={Users} title={t('users.title')} />
      <Card className="gap-0 overflow-hidden py-0">
        <div className="flex flex-col gap-3 border-b p-3 sm:flex-row sm:items-center">
          <form role="search" className="flex min-w-0 flex-1 items-center gap-2" onSubmit={(event) => void search(event)}>
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              {/* A text box, not type=search: the browser's own clear button would empty the box but leave the results. */}
              <Input
                type="text"
                enterKeyHint="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('users.search.placeholder')}
                aria-label={t('common.search')}
                autoComplete="off"
                className="ps-9"
              />
            </div>
            {results !== null && (
              <Button type="button" variant="ghost" size="icon" onClick={clear} aria-label={t('users.search.clear')}>
                <X aria-hidden="true" />
              </Button>
            )}
            <Button type="submit" variant="secondary" disabled={searching || !query.trim()}>
              {t('common.search')}
            </Button>
          </form>
          <label className="flex items-center gap-2 text-sm text-muted-foreground sm:w-56">
            <span className="shrink-0" aria-hidden="true">
              {t('users.filter.label')}
            </span>
            <NativeSelect
              aria-label={t('users.filter.label')}
              value={filter ?? ''}
              disabled={results !== null}
              onChange={(event) => {
                const value = event.target.value;
                setParams(value ? { filter: value } : {}, { replace: true });
              }}
            >
              <option value="">{t('users.filter.all')}</option>
              {filters.map((f) => (
                <option key={f} value={f}>
                  {t(`users.filter.${f}` as MessageKey)}
                </option>
              ))}
            </NativeSelect>
          </label>
        </div>
        {/* One state at a time: a failed first read is not an empty list. */}
        {failed && !users.data ? (
          <div className="p-4">
            <LoadError error={users.error} onRetry={() => void users.refetch()} />
          </div>
        ) : results === null && users.isPending ? (
          <TableSkeleton />
        ) : rows.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">{results !== null ? t('users.noMatch') : t('users.empty')}</p>
        ) : (
          <UserTable rows={rows} />
        )}
        {failed && users.data && (
          <div className="border-t p-4">
            <LoadError error={users.error} onRetry={() => void users.refetch()} />
          </div>
        )}
        {results === null && users.hasNextPage && (
          <div className="border-t p-3 text-center">
            <Button variant="outline" size="sm" onClick={() => void users.fetchNextPage()} disabled={users.isFetchingNextPage}>
              {t('common.loadMore')}
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}

function UserTable({ rows }: { rows: readonly Row[] }) {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  // The person's page goes back to this filter.
  const state = listState(useLocation().search);
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>{t('users.col.person')}</TableHead>
          <TableHead>{t('users.col.status')}</TableHead>
          <TableHead className="hidden md:table-cell">{t('users.col.country')}</TableHead>
          <TableHead className="hidden sm:table-cell">{t('users.col.joined')}</TableHead>
          <TableHead className="hidden lg:table-cell">{t('users.col.lastActive')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((user) => (
          <TableRow key={user.id} className="cursor-pointer" onClick={(event) => !(event.target as HTMLElement).closest('a') && void navigate(`/users/${user.id}`, { state })}>
            <TableCell className="max-w-64">
              <UserRef user={user} state={state} />
            </TableCell>
            <TableCell>
              <span className="flex flex-wrap items-center gap-1.5">
                <StatusDot tone={statusTone[user.status]}>{t(`status.account.${user.status}` as MessageKey)}</StatusDot>
                {user.shadowbanned && <Badge variant="warning">{t('user.badge.shadowbanned')}</Badge>}
                {user.test && <Badge variant="secondary">{t('user.badge.test')}</Badge>}
                {user.verified && <Badge variant="success">{t('user.badge.verified')}</Badge>}
                {user.matchedBy && <span className="text-xs text-muted-foreground">{t(`users.match.${user.matchedBy}` as MessageKey)}</span>}
              </span>
            </TableCell>
            <TableCell className="hidden text-sm text-muted-foreground md:table-cell">{user.country ? regionName(user.country, locale) : t('common.none')}</TableCell>
            <TableCell className="hidden text-sm whitespace-nowrap text-muted-foreground sm:table-cell">{formatDate(user.createdAt, locale)}</TableCell>
            <TableCell className="hidden text-sm whitespace-nowrap text-muted-foreground lg:table-cell">
              {user.lastActiveOn ? formatDate(`${user.lastActiveOn}T12:00:00.000Z`, locale) : t('common.none')}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
