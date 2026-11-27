import type { AdminChatMessage, AdminChatSummary, AdminUserDetail } from '@app/shared';
import { ArrowLeft, ArrowRight, EyeOff, ImageIcon, MessagesSquare, Mic, Phone, PhoneMissed, RefreshCw, SmilePlus, Undo2, Video } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router';
import { ChatBubble, ChatLine } from '@/components/chat/ChatBubble';
import { LoadError, TableSkeleton } from '@/components/QueryState';
import { Badge, StatusDot } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Avatar } from '@/components/UserRef';
import type { MessageKey } from '@/i18n/messages';
import type { Translate } from '@/i18n/translate';
import { useI18n } from '@/i18n/useI18n';
import { Worded } from '@/i18n/Worded';
import { formatDate, formatDateTime, formatDuration } from '@/lib/format';
import { asApiError } from '@/lib/http';
import { problemText } from '@/lib/problemText';
import { queryClient, queryKeys, useUserChat, useUserChats } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { Empty, More, Panel } from './RecordTabs';

/**
 * The person's conversations (`?tab=chats`) and, with `&c=<id>`, one of
 * them: a list beside the open conversation from the `lg` breakpoint, one
 * or the other below it. Every request here is a GET; nothing is read
 * until the tab is open, and a conversation's messages only once it is
 * opened and the list has answered (newest page first, older pages on
 * demand). A person without conversations shows the empty list, whatever
 * `c` says.
 */

const CONVERSATION_ID = /^[1-9][0-9]{0,18}$/;
/** Tailwind's `lg`: from here the list and the conversation sit side by side. */
const WIDE = '(min-width: 64rem)';
const QUOTE_MAX = 80;

const stateTone: Readonly<Record<AdminChatSummary['state'], 'green' | 'amber' | 'red' | 'gray'>> = {
  active: 'green',
  unmatched: 'gray',
  blocked: 'red',
  account_gone: 'gray',
  admin: 'amber',
};

function otherName(chat: AdminChatSummary, t: Translate): string {
  if (chat.other.status === 'purged') return t('chats.deletedAccount');
  return chat.other.name ?? t('users.noName');
}

export function ChatsTab({ user }: { user: AdminUserDetail }) {
  const { t } = useI18n();
  const [params] = useSearchParams();
  const raw = params.get('c');
  const open = raw !== null && CONVERSATION_ID.test(raw) ? raw : null;
  const chats = useUserChats(user.id);
  const items = useMemo(() => chats.data?.pages.flatMap((page) => page.items) ?? [], [chats.data]);
  const list = useRef<HTMLDivElement>(null);
  // A row opened on a phone moves the focus into the conversation that replaces the list.
  const [focusOn, setFocusOn] = useState<string | null>(null);

  // Back to the list on a phone: the focus goes back to the row that was open (its pane is gone).
  const previous = useRef(open);
  useEffect(() => {
    const before = previous.current;
    previous.current = open;
    if (open !== null || before === null) return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    list.current?.querySelector<HTMLElement>(`[data-chat="${before}"]`)?.focus();
  }, [open]);

  const none = chats.isSuccess && items.length === 0;
  // The conversation pane replaces the list below `lg` only while it is there.
  const pane = open !== null && !none;
  return (
    <div className={cn('grid gap-4', !none && 'lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] lg:items-start')}>
      <div ref={list} className={cn('min-w-0', pane && 'hidden lg:block')}>
        <ChatList chats={chats} items={items} open={open} onOpen={(id) => setFocusOn(window.matchMedia?.(WIDE).matches ? null : id)} />
      </div>
      {!none &&
        (open === null ? (
          <div className="sticky top-20 hidden h-[calc(100dvh-7rem)] max-h-[52rem] min-h-[24rem] flex-col items-center justify-center gap-2 rounded-xl border border-dashed text-sm text-muted-foreground lg:flex">
            <MessagesSquare className="size-6" aria-hidden="true" />
            {t('chats.unselected')}
          </div>
        ) : (
          <Conversation
            key={open}
            user={user}
            conversationId={open}
            ready={!chats.isPending}
            known={items.find((chat) => chat.id === open)}
            takeFocus={focusOn === open}
          />
        ))}
    </div>
  );
}

// ─── The list ───────────────────────────────────────────────────────────

function ChatList({
  chats,
  items,
  open,
  onOpen,
}: {
  chats: ReturnType<typeof useUserChats>;
  items: AdminChatSummary[];
  open: string | null;
  onOpen: (id: string) => void;
}) {
  const { t } = useI18n();
  const state: unknown = useLocation().state;
  const partial = chats.data?.pages.some((page) => !page.streamComplete) ?? false;
  return (
    <Panel>
      {items.length > 0 && (
        <div className="grid gap-1 border-b px-4 py-2 text-xs text-muted-foreground">
          <p>{t('chats.order')}</p>
          {partial && (
            <StatusDot tone="amber" className="text-xs whitespace-normal">
              {t('chats.listPartial')}
            </StatusDot>
          )}
        </div>
      )}
      {chats.isPending ? (
        <TableSkeleton rows={5} />
      ) : chats.isError && items.length === 0 ? (
        <div className="p-4">
          <LoadError error={chats.error} onRetry={() => void chats.refetch()} />
        </div>
      ) : items.length === 0 ? (
        <Empty text={t('chats.empty')} />
      ) : (
        <ul className="divide-y" aria-label={t('user.tab.chats')}>
          {items.map((chat) => (
            <li key={chat.id}>
              <ChatRow chat={chat} open={chat.id === open} state={state} onOpen={onOpen} />
            </li>
          ))}
        </ul>
      )}
      {chats.isFetchNextPageError && <PageError error={chats.error} />}
      <More show={chats.hasNextPage} busy={chats.isFetchingNextPage} onMore={() => void chats.fetchNextPage()} />
    </Panel>
  );
}

function PageError({ error }: { error: unknown }) {
  const failure = asApiError(error);
  return (
    <p role="alert" className="border-t px-4 py-2 text-center text-xs text-destructive">
      <Worded text={(t) => problemText(failure, t)} />
    </p>
  );
}

function ChatRow({ chat, open, state, onOpen }: { chat: AdminChatSummary; open: boolean; state: unknown; onOpen: (id: string) => void }) {
  const { t, locale } = useI18n();
  const name = otherName(chat, t);
  return (
    <Link
      to={{ search: `?tab=chats&c=${chat.id}` }}
      state={state}
      data-chat={chat.id}
      aria-current={open ? 'true' : undefined}
      onClick={() => onOpen(chat.id)}
      className="flex items-start gap-3 px-4 py-3 outline-none hover:bg-muted/50 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset aria-[current=true]:bg-muted"
    >
      <Avatar url={chat.other.photoUrl} size={40} />
      <span className="grid min-w-0 flex-1 justify-items-start gap-1">
        <span className="max-w-full truncate font-medium" title={name}>
          <bdi>{name}</bdi>
        </span>
        <span dir="ltr" className="font-mono text-xs text-muted-foreground">
          {chat.other.id}
        </span>
        <ChatBadges chat={chat} />
        <span className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
          <span>{t('chats.started', { date: formatDate(chat.startedAt, locale) })}</span>
          <span>{chat.lastActivityAt ? t('chats.last', { date: formatDate(chat.lastActivityAt, locale) }) : t('chats.noneYet')}</span>
          {chat.messages.count > 0 && <span>{messageCount(chat, t)}</span>}
        </span>
      </span>
    </Link>
  );
}

function messageCount(chat: AdminChatSummary, t: Translate): string {
  if (chat.messages.more) return t('chats.countMore', { count: chat.messages.count });
  return chat.messages.count === 1 ? t('chats.countOne') : t('chats.count', { count: chat.messages.count });
}

/** The conversation's state, its hold, whom it is hidden from (while open) and where it came from. */
function ChatBadges({ chat }: { chat: AdminChatSummary }) {
  const { t } = useI18n();
  const hidden = chat.state === 'active' && chat.visibility;
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <StatusDot tone={stateTone[chat.state]} className="text-xs whitespace-normal">
        {t(`chats.state.${chat.state}` as MessageKey)}
      </StatusDot>
      {chat.held && <Badge variant="destructive">{t('user.badge.held')}</Badge>}
      {hidden && !hidden.otherSeesSubject && <Badge variant="warning">{t('chats.hiddenFromOther')}</Badge>}
      {hidden && !hidden.subjectSeesOther && <Badge variant="warning">{t('chats.hiddenFromSubject')}</Badge>}
      {chat.source === 'request' && <Badge variant="outline">{t('chats.fromRequest')}</Badge>}
    </span>
  );
}

// ─── One conversation ───────────────────────────────────────────────────

function Conversation({
  user,
  conversationId,
  ready,
  known,
  takeFocus,
}: {
  user: AdminUserDetail;
  conversationId: string;
  /** The list has answered: the first page is read only then (no request for a person without conversations). */
  ready: boolean;
  /** The list's row, so the header shows before the first page arrives. */
  known: AdminChatSummary | undefined;
  /** Opened from the list on a phone: the conversation replaces the list, so it takes the focus. */
  takeFocus: boolean;
}) {
  const { t, locale } = useI18n();
  const query = useUserChat(user.id, conversationId, ready);
  const pages = useMemo(() => query.data?.pages ?? [], [query.data]);
  const chat = pages[0]?.conversation ?? known;
  const section = useRef<HTMLElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const failure = query.isError ? asApiError(query.error) : null;
  const missing = failure !== null && pages.length === 0 && (failure.code === 'not_found' || failure.code === 'validation_failed');

  const items = useMemo(() => {
    const seen = new Set<string>();
    const out: AdminChatMessage[] = [];
    // Older pages first; each page is oldest first.
    for (const page of [...pages].reverse()) {
      for (const message of page.items) {
        if (seen.has(message.id)) continue;
        seen.add(message.id);
        out.push(message);
      }
    }
    return out;
  }, [pages]);
  const byId = useMemo(() => new Map(items.map((message) => [message.id, message])), [items]);
  const days = useMemo(() => {
    const day = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });
    const groups: { label: string; items: AdminChatMessage[] }[] = [];
    for (const message of items) {
      const label = day.format(new Date(message.at));
      const last = groups.at(-1);
      if (last?.label === label) last.items.push(message);
      else groups.push({ label, items: [message] });
    }
    return groups;
  }, [items, locale]);

  // The first page opens at its newest message; an older page goes on top without moving what is on screen.
  const shownPages = useRef(0);
  const shownHeight = useRef(0);
  useLayoutEffect(() => {
    const box = scroller.current;
    if (box) {
      if (shownPages.current === 0 && pages.length > 0) box.scrollTop = box.scrollHeight;
      else if (pages.length > shownPages.current) box.scrollTop += box.scrollHeight - shownHeight.current;
      shownHeight.current = box.scrollHeight;
    }
    shownPages.current = box ? pages.length : 0;
  });

  // The pane is as tall as the window under the sticky header: when it opens partly out of view, the page
  // scrolls it into place (once), so its newest message shows.
  useEffect(() => {
    const element = section.current;
    if (!element) return;
    const box = element.getBoundingClientRect();
    if (box.top < 0 || box.bottom > window.innerHeight) element.scrollIntoView?.({ block: 'start' });
    if (takeFocus) element.focus({ preventScroll: true });
  }, [takeFocus]);

  const subjectName = user.name ?? t('users.noName');
  const name = chat ? otherName(chat, t) : '';
  // A page that could not read every message not saved yet says so; one that stopped early goes on with the next.
  const partial = pages.some((page) => page.stream === 'partial');
  const backlog = query.hasNextPage && pages.at(-1)?.stream === 'backlog';

  return (
    <section
      ref={section}
      tabIndex={-1}
      aria-label={chat ? t('chats.conversationWith', { name }) : t('chats.messages')}
      className="flex h-[calc(100dvh-5rem)] max-h-[52rem] min-h-[24rem] min-w-0 scroll-mt-20 flex-col overflow-hidden rounded-xl border bg-card text-card-foreground shadow-xs outline-none lg:sticky lg:top-20 lg:h-[calc(100dvh-7rem)]"
    >
      <header className="grid gap-2 border-b px-4 py-3">
        <BackToList />
        {chat ? (
          <ConversationHeader chat={chat} fetching={query.isFetching && !query.isFetchingNextPage} onRefresh={() => void queryClient.resetQueries({ queryKey: queryKeys.userChat(user.id, conversationId) })} />
        ) : missing ? null : (
          <span className="flex items-center gap-3" aria-hidden="true">
            <Skeleton className="size-10 rounded-full" />
            <span className="grid gap-2">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-3 w-24" />
            </span>
          </span>
        )}
        {partial && (
          <StatusDot tone="amber" className="text-xs whitespace-normal">
            {t('chats.partial')}
          </StatusDot>
        )}
      </header>
      {query.isPending ? (
        <div className="grid flex-1 content-end gap-3 p-4" aria-hidden="true">
          <Skeleton className="h-12 w-2/3 justify-self-start rounded-2xl" />
          <Skeleton className="h-10 w-1/2 justify-self-end rounded-2xl" />
          <Skeleton className="h-16 w-3/5 justify-self-start rounded-2xl" />
        </div>
      ) : missing ? (
        <p className="grid flex-1 place-items-center p-6 text-center text-sm text-muted-foreground">{t('chats.notFound')}</p>
      ) : pages.length === 0 ? (
        <div className="p-4">
          <LoadError error={query.error} onRetry={() => void query.refetch()} />
        </div>
      ) : (
        <div
          ref={scroller}
          role="region"
          aria-label={t('chats.messages')}
          tabIndex={0}
          className="flex-1 overflow-y-auto overscroll-contain px-3 py-4 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset sm:px-4"
        >
          <div className="grid gap-4">
            {query.hasNextPage ? (
              <div className="grid justify-items-center gap-1">
                {backlog && (
                  <StatusDot tone="amber" className="max-w-prose text-center text-xs whitespace-normal">
                    {t('chats.backlog')}
                  </StatusDot>
                )}
                <Button variant="outline" size="sm" onClick={() => void query.fetchNextPage()} disabled={query.isFetchingNextPage}>
                  {t('chats.loadOlder')}
                </Button>
                {query.isFetchNextPageError && <PageError error={query.error} />}
              </div>
            ) : (
              items.length > 0 && <p className="text-center text-xs text-muted-foreground">{t('chats.noOlder')}</p>
            )}
            {items.length === 0 ? (
              // Older pages may still hold messages (a page that stopped early): no "no messages" then.
              !query.hasNextPage && (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  {chat?.retentionDays ? t('chats.retention', { days: chat.retentionDays }) : t('chats.noMessages')}
                </p>
              )
            ) : (
              days.map((group) => (
                <div key={group.label} className="grid gap-2">
                  <h3 className="justify-self-center rounded-full border bg-card px-3 py-0.5 text-xs font-normal text-muted-foreground">{group.label}</h3>
                  <ol className="grid gap-2">
                    {group.items.map((message) => (
                      <MessageItem key={message.id} message={message} names={{ subject: subjectName, other: name }} byId={byId} />
                    ))}
                  </ol>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </section>
  );
}

/** The way back to the list where the list is hidden (below `lg`). */
function BackToList() {
  const { t, dir } = useI18n();
  const state: unknown = useLocation().state;
  const Back = dir === 'rtl' ? ArrowRight : ArrowLeft;
  return (
    <Link to={{ search: '?tab=chats' }} state={state} className="inline-flex w-fit items-center gap-1 rounded-sm text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 lg:hidden">
      <Back className="size-4" aria-hidden="true" />
      {t('chats.back')}
    </Link>
  );
}

/** Who the other person is (their page, on the same conversation), the conversation's state and its dates, and a fresh read of its newest page. */
function ConversationHeader({ chat, fetching, onRefresh }: { chat: AdminChatSummary; fetching: boolean; onRefresh: () => void }) {
  const { t, locale } = useI18n();
  const name = otherName(chat, t);
  const purged = chat.other.status === 'purged';
  const ended = chat.endedAt ? formatDateTime(chat.endedAt, locale) : null;
  const endedLine = ended === null ? null : chat.endedBy ? t(`chats.endedBy.${chat.endedBy}` as MessageKey, { date: ended }) : t('chats.ended', { date: ended });
  const title = (
    <span className="truncate" title={name}>
      <bdi>{name}</bdi>
    </span>
  );
  return (
    <div className="grid gap-2">
      <div className="flex items-start gap-3">
        <Avatar url={chat.other.photoUrl} size={40} />
        <div className="grid min-w-0 flex-1 justify-items-start gap-0.5">
          <h2 className="flex max-w-full min-w-0 text-base font-semibold">
            {purged ? (
              title
            ) : (
              <Link to={`/users/${chat.other.id}?tab=chats&c=${chat.id}`} className="flex min-w-0 rounded-sm outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50">
                {title}
              </Link>
            )}
          </h2>
          <span dir="ltr" className="font-mono text-xs text-muted-foreground">
            {chat.other.id}
          </span>
        </div>
        <Button variant="ghost" size="icon" onClick={onRefresh} disabled={fetching} aria-label={t('chats.refresh')} title={t('chats.refresh')}>
          <RefreshCw className={cn(fetching && 'animate-spin motion-reduce:animate-none')} aria-hidden="true" />
        </Button>
      </div>
      <ChatBadges chat={chat} />
      <p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
        <span>{t('chats.started', { date: formatDateTime(chat.startedAt, locale) })}</span>
        {chat.messages.count > 0 && <span>{messageCount(chat, t)}</span>}
        {endedLine && <span className="basis-full">{endedLine}</span>}
      </p>
    </div>
  );
}

// ─── Messages ───────────────────────────────────────────────────────────

function quoteOf(message: AdminChatMessage, t: Translate): string | null {
  if (message.kind === 'image') return t('chats.media.image');
  if (message.kind === 'voice') return t('chats.media.voice');
  if (message.body === null || message.body === '') return null;
  const points = Array.from(message.body);
  return points.length > QUOTE_MAX ? `${points.slice(0, QUOTE_MAX).join('')}…` : message.body;
}


function MessageItem({ message, names, byId }: { message: AdminChatMessage; names: { subject: string; other: string }; byId: ReadonlyMap<string, AdminChatMessage> }) {
  const { t, locale } = useI18n();
  const name = message.from === 'subject' ? names.subject : names.other;
  const note = message.pending ? t('chats.pending') : undefined;

  if (message.kind === 'call') {
    const call = message.call;
    const Icon = call?.outcome === 'missed' ? PhoneMissed : call?.kind === 'video' ? Video : Phone;
    return (
      <ChatLine icon={Icon} at={message.at} timeOnly note={note}>
        <Worded
          text={(say) => {
            if (!call) return say('chats.call.unknown', { name });
            const what = say(call.kind === 'video' ? 'chats.call.video' : 'chats.call.audio', { name });
            const detail = call.outcome === 'completed' ? formatDuration(call.durationSeconds, locale) : say(`chats.call.${call.outcome}` as MessageKey);
            return say('chats.call.detail', { call: what, detail });
          }}
        />
      </ChatLine>
    );
  }
  if (message.kind === 'reaction') {
    const emoji = message.body ?? '';
    return (
      <ChatLine icon={SmilePlus} at={message.at} timeOnly note={note}>
        <Worded text={(say) => (emoji === '' ? say('chats.line.reactionRemoved', { name }) : say('chats.line.reaction', { name, emoji }))} />
      </ChatLine>
    );
  }
  if (message.kind === 'unsend') {
    const hidden = message.flags.includes('hidden');
    return (
      <ChatLine icon={hidden ? EyeOff : Undo2} at={message.at} timeOnly note={note}>
        <Worded text={(say) => (hidden ? say('chats.line.hidden') : say('chats.line.unsend', { name }))} />
      </ChatLine>
    );
  }

  const removed = message.body === null && message.flags.includes('body_removed');
  // A text's reference is the message it answers; a GIF's is read as one only when that message is loaded
  // (a photo's or a voice message's reference is its upload, a like note's the item liked).
  const target = message.refId === null ? undefined : byId.get(message.refId);
  const reply = message.refId !== null && (message.kind === 'text' || (message.kind === 'gif' && target !== undefined));
  const quote = reply && target ? quoteOf(target, t) : null;
  const badges: ReactNode[] = [];
  if (message.unsentAt && !removed) {
    badges.push(
      <Badge key="unsent" variant="secondary">
        {t('chats.unsentAt', { date: formatDateTime(message.unsentAt, locale) })}
      </Badge>,
    );
  }
  if (message.shadowed) {
    badges.push(
      <Badge key="shadowed" variant="warning">
        {t('chats.shadowed')}
      </Badge>,
    );
  }

  let body: ReactNode = message.body;
  if (message.kind === 'image' || message.kind === 'voice') {
    const Icon = message.kind === 'image' ? ImageIcon : Mic;
    body = (
      <span className="inline-flex items-center gap-1.5 text-muted-foreground">
        <Icon className="size-4 shrink-0" aria-hidden="true" />
        {t(message.kind === 'image' ? 'chats.media.image' : 'chats.media.voice')}
      </span>
    );
  } else if (removed) {
    body = <span className="text-muted-foreground">{message.unsentAt ? t('chats.unsentRemoved') : t('messageFlag.body_removed')}</span>;
  } else if (message.kind === 'gif' && message.body !== null) {
    body = (
      <span dir="ltr" className="font-mono text-xs break-all">
        {message.body}
      </span>
    );
  }

  return (
    <ChatBubble
      side={message.from === 'subject' ? 'end' : 'start'}
      tone={message.from === 'subject' ? 'end' : 'start'}
      label={<bdi>{name}</bdi>}
      kind={message.kind === 'image' || message.kind === 'voice' ? undefined : message.kind}
      flags={message.flags.filter((flag) => flag !== 'body_removed')}
      badges={badges}
      quote={
        reply ? (
          <span className="grid gap-0.5 border-s-2 border-foreground/20 ps-2 text-xs text-muted-foreground">
            <span className="font-medium">{t('chats.reply')}</span>
            {quote && (
              <span dir="auto" className="line-clamp-2 break-words">
                {quote}
              </span>
            )}
          </span>
        ) : undefined
      }
      at={message.at}
      timeOnly
      note={note}
    >
      {body}
    </ChatBubble>
  );
}
