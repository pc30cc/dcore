import type { AdminDeviceBan, DeviceBanKind } from "@app/shared";
import {
  MoreHorizontal,
  Plus,
  Search,
  Smartphone,
  Trash2,
  X,
} from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router";
import { Field } from "@/components/form/Field";
import { PageHeader } from "@/components/layout/PageHeader";
import { LoadError, TableSkeleton } from "@/components/QueryState";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { StatusDot } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { NativeSelect } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { UserRef } from "@/components/UserRef";
import type { MessageKey } from "@/i18n/messages";
import { useI18n } from "@/i18n/useI18n";
import { apiRequest } from "@/lib/api";
import { dayInPanelCalendar, formatDate } from "@/lib/format";
import {
  banExpiry,
  banKinds,
  isBanKind,
  lacksCountryCode,
  type BanExpiry,
} from "@/lib/deviceBans";
import { asApiError } from "@/lib/http";
import { problemText } from "@/lib/problemText";
import { queryClient, useDeviceBans, useUser } from "@/lib/queries";
import { can } from "@/lib/session";
import { showToast } from "@/lib/toast";
import { useSession } from "@/lib/useSession";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyLine } from "./QueueParts";

const changed = () =>
  void queryClient.invalidateQueries({ queryKey: ["deviceBans"] });

/**
 * `/moderation/device-bans`: bans of a device key, a phone number or a
 * Google account (`?kind=`). A number looked up stays in the page only,
 * never in its address.
 */
export function DeviceBansPage() {
  const { t } = useI18n();
  const lookupErrorId = useId();
  const { me } = useSession();
  const writer = can(me, "moderation.device_bans");
  const [params, setParams] = useSearchParams();
  const kindParam = params.get("kind");
  const kind = isBanKind(kindParam) ? kindParam : null;
  const bans = useDeviceBans(kind);
  const [phone, setPhone] = useState("");
  const [found, setFound] = useState<AdminDeviceBan[] | null>(null);
  const [phoneError, setPhoneError] = useState<string | undefined>();
  const [searching, setSearching] = useState(false);
  const [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState<AdminDeviceBan | null>(null);
  const [removeReason, setRemoveReason] = useState("");
  const [busy, setBusy] = useState(false);
  // A ban the server wrote by itself (no creator, no action) needs moderation.device_bans_auto.
  const removable = (ban: AdminDeviceBan) =>
    writer &&
    (ban.createdBy !== null ||
      ban.actionId !== null ||
      can(me, "moderation.device_bans_auto"));
  const reasonId = useId();
  const items = found ?? bans.data?.pages.flatMap((page) => page.items) ?? [];

  async function lookup(event: FormEvent) {
    event.preventDefault();
    if (!phone.trim() || searching) return;
    if (lacksCountryCode(phone)) {
      setPhoneError(t("deviceBans.error.phone"));
      return;
    }
    setSearching(true);
    setPhoneError(undefined);
    try {
      const result = await apiRequest<{ items: AdminDeviceBan[] }>(
        "/v1/admin/device-bans/search",
        { method: "POST", body: { phone: phone.trim() } },
      );
      setFound(result.items);
    } catch (failure) {
      const problem = asApiError(failure);
      if (problem.errors[0]?.code === "phone_invalid")
        setPhoneError(t("deviceBans.error.phone"));
      else showToast(problemText(problem, t), "error", 6_000);
    } finally {
      setSearching(false);
    }
  }

  function clearLookup() {
    setPhone("");
    setFound(null);
    setPhoneError(undefined);
  }

  async function remove(ban: AdminDeviceBan) {
    if (busy) return;
    setBusy(true);
    try {
      await apiRequest(`/v1/admin/device-bans/${ban.id}`, {
        method: "DELETE",
        body: { reason: removeReason.trim() },
      });
      changed();
      setFound(
        (current) => current?.filter((item) => item.id !== ban.id) ?? null,
      );
      showToast(t("deviceBans.removed"));
      setRemoving(null);
    } catch (failure) {
      showToast(problemText(asApiError(failure), t), "error", 6_000);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto grid max-w-6xl grid-cols-1 gap-6">
      <PageHeader
        icon={Smartphone}
        title={t("deviceBans.title")}
        actions={
          writer && (
            <Button onClick={() => setCreating(true)}>
              <Plus aria-hidden="true" />
              {t("deviceBans.new")}
            </Button>
          )
        }
      />
      <Card className="gap-0 overflow-hidden py-0">
        <div className="flex flex-col gap-3 border-b p-3 sm:flex-row sm:items-start">
          <form
            role="search"
            className="grid min-w-0 flex-1 gap-1"
            onSubmit={(event) => void lookup(event)}
            noValidate
          >
            <div className="flex min-w-0 items-center gap-2">
              <div className="relative min-w-0 flex-1">
                {/* The number reads left to right in every language: the icon sits on its side. */}
                <Search
                  className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                  aria-hidden="true"
                />
                <Input
                  type="tel"
                  dir="ltr"
                  inputMode="tel"
                  enterKeyHint="search"
                  value={phone}
                  onChange={(event) => {
                    setPhone(event.target.value);
                    setPhoneError(undefined);
                  }}
                  placeholder={t("deviceBans.lookup")}
                  aria-label={t("deviceBans.lookup")}
                  aria-invalid={Boolean(phoneError)}
                  aria-describedby={phoneError ? lookupErrorId : undefined}
                  autoComplete="off"
                  className="pl-9 text-left"
                />
              </div>
              {found !== null && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={clearLookup}
                  aria-label={t("deviceBans.lookupClear")}
                >
                  <X aria-hidden="true" />
                </Button>
              )}
              <Button
                type="submit"
                variant="secondary"
                disabled={searching || !phone.trim()}
              >
                {t("common.search")}
              </Button>
            </div>
            {phoneError && (
              <p id={lookupErrorId} className="text-sm text-destructive">
                {phoneError}
              </p>
            )}
          </form>
          <label className="flex items-center gap-2 text-sm text-muted-foreground sm:w-56">
            <span className="shrink-0" aria-hidden="true">
              {t("deviceBans.col.kind")}
            </span>
            <NativeSelect
              aria-label={t("deviceBans.col.kind")}
              value={kind ?? ""}
              disabled={found !== null}
              onChange={(event) =>
                setParams(
                  event.target.value ? { kind: event.target.value } : {},
                  { replace: true },
                )
              }
            >
              <option value="">{t("deviceBans.kind.all")}</option>
              {banKinds.map((k) => (
                <option key={k} value={k}>
                  {t(`banKind.${k}` as MessageKey)}
                </option>
              ))}
            </NativeSelect>
          </label>
        </div>
        {found === null && bans.isPending ? (
          <TableSkeleton />
        ) : found === null && bans.isError && items.length === 0 ? (
          <div className="p-4">
            <LoadError error={bans.error} onRetry={() => void bans.refetch()} />
          </div>
        ) : items.length === 0 ? (
          <EmptyLine
            text={
              found !== null ? t("deviceBans.noMatch") : t("deviceBans.empty")
            }
          />
        ) : (
          <BanTable
            rows={items}
            writer={writer}
            removable={removable}
            onRemove={(ban) => {
              setRemoveReason("");
              setRemoving(ban);
            }}
          />
        )}
        {found === null && bans.hasNextPage && (
          <div className="border-t p-3 text-center">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void bans.fetchNextPage()}
              disabled={bans.isFetchingNextPage}
            >
              {t("common.loadMore")}
            </Button>
          </div>
        )}
      </Card>
      {creating && (
        <NewBanDialog
          onClose={() => setCreating(false)}
          onDone={() => {
            changed();
            // The lookup shown would not have the new ban: back to the whole list.
            clearLookup();
            showToast(t("common.saved"));
            setCreating(false);
          }}
        />
      )}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && !busy && setRemoving(null)}
        title={t("deviceBans.remove.title")}
        description={removing && <BanSummary ban={removing} />}
        confirmLabel={t("deviceBans.remove")}
        destructive
        busy={busy}
        confirmDisabled={!removeReason.trim()}
        onConfirm={() =>
          removing && removeReason.trim() && void remove(removing)
        }
      >
        <Field id={reasonId} label={t("deviceBans.field.reason")}>
          {(control) => (
            <Textarea
              {...control}
              rows={2}
              maxLength={500}
              value={removeReason}
              onChange={(event) => setRemoveReason(event.target.value)}
            />
          )}
        </Field>
      </ConfirmDialog>
    </div>
  );
}

function BanSummary({ ban }: { ban: AdminDeviceBan }) {
  const { t } = useI18n();
  return (
    <span className="grid gap-2 rounded-lg bg-muted/50 px-3 py-2.5 text-foreground">
      <span className="font-medium">
        {t(`banKind.${ban.kind}` as MessageKey)}
        {ban.store && (
          <span className="font-normal text-muted-foreground">
            {" "}
            · {t(`store.${ban.store}` as MessageKey)}
          </span>
        )}
      </span>
      {ban.user && <UserRef user={ban.user} link={false} wrap />}
      <span className="bidi-plain text-muted-foreground">{ban.reason}</span>
    </span>
  );
}

function BanTable({
  rows,
  writer,
  removable,
  onRemove,
}: {
  rows: readonly AdminDeviceBan[];
  writer: boolean;
  removable: (ban: AdminDeviceBan) => boolean;
  onRemove: (ban: AdminDeviceBan) => void;
}) {
  const { t, locale, dir } = useI18n();
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>{t("deviceBans.col.kind")}</TableHead>
          <TableHead className="hidden md:table-cell">
            {t("deviceBans.col.store")}
          </TableHead>
          <TableHead className="hidden sm:table-cell">
            {t("deviceBans.col.person")}
          </TableHead>
          <TableHead className="hidden lg:table-cell">
            {t("deviceBans.col.reason")}
          </TableHead>
          <TableHead className="hidden sm:table-cell">
            {t("deviceBans.col.created")}
          </TableHead>
          <TableHead>{t("deviceBans.col.expires")}</TableHead>
          {writer && (
            <TableHead className="w-12">
              <span className="sr-only">{t("common.actions")}</span>
            </TableHead>
          )}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((ban) => (
          <TableRow
            key={ban.id}
            className={cn(!ban.active && "text-muted-foreground")}
          >
            <TableCell className="text-sm">
              <span className="grid justify-items-start">
                <span className="font-medium whitespace-nowrap">
                  {t(`banKind.${ban.kind}` as MessageKey)}
                </span>
                {ban.user && (
                  <Link
                    to={`/users/${ban.user.id}`}
                    dir="ltr"
                    className="font-mono text-xs text-muted-foreground hover:underline sm:hidden"
                  >
                    {ban.user.id}
                  </Link>
                )}
              </span>
            </TableCell>
            <TableCell className="hidden text-sm md:table-cell">
              {ban.store ? (
                t(`store.${ban.store}` as MessageKey)
              ) : (
                <span className="text-muted-foreground">
                  {t("common.none")}
                </span>
              )}
            </TableCell>
            <TableCell className="hidden max-w-56 sm:table-cell">
              {ban.user ? (
                <UserRef user={ban.user} />
              ) : (
                <span className="text-muted-foreground">
                  {t("common.none")}
                </span>
              )}
            </TableCell>
            <TableCell className="hidden max-w-64 text-sm lg:table-cell">
              <span className="bidi-plain line-clamp-2" title={ban.reason}>
                {ban.reason}
              </span>
            </TableCell>
            <TableCell className="hidden text-sm sm:table-cell">
              <span className="grid">
                <span className="whitespace-nowrap">
                  {formatDate(ban.createdAt, locale)}
                </span>
                <span className="text-xs text-muted-foreground">
                  {ban.createdBy?.displayName ?? t("common.automatic")}
                </span>
              </span>
            </TableCell>
            <TableCell className="text-sm">
              <span className="grid gap-0.5">
                <StatusDot tone={ban.active ? "red" : "gray"}>
                  {ban.active
                    ? t("deviceBans.active")
                    : t("deviceBans.expired")}
                </StatusDot>
                <span className="text-xs whitespace-nowrap text-muted-foreground">
                  {ban.expiresAt
                    ? formatDate(ban.expiresAt, locale)
                    : t("common.permanent")}
                </span>
              </span>
            </TableCell>
            {writer && (
              <TableCell className="text-end">
                {removable(ban) && (
                  <DropdownMenu dir={dir}>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={t("deviceBans.actionsFor", {
                          kind: t(`banKind.${ban.kind}` as MessageKey),
                          name: ban.user?.name ?? ban.user?.id ?? ban.id,
                        })}
                      >
                        <MoreHorizontal aria-hidden="true" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        destructive
                        onSelect={() => onRemove(ban)}
                      >
                        <Trash2 aria-hidden="true" />
                        {t("deviceBans.remove")}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </TableCell>
            )}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** A ban made from a person (what they sign in with) or from a typed number. */
function NewBanDialog({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: () => void;
}) {
  const { t, locale } = useI18n();
  const { me } = useSession();
  const id = useId();
  const [from, setFrom] = useState<"user" | "phone">("user");
  const [user, setUser] = useState("");
  const [kinds, setKinds] = useState<DeviceBanKind[]>([...banKinds]);
  const [phone, setPhone] = useState("");
  const [expiry, setExpiry] = useState<BanExpiry>("permanent");
  const [date, setDate] = useState("");
  const [reason, setReason] = useState("");
  const [problems, setProblems] = useState<
    Partial<Record<"user" | "kinds" | "phone" | "expiry" | "reason", string>>
  >({});
  const [busy, setBusy] = useState(false);
  // The person a public id names, shown before their devices are banned (for a role that may read people).
  const publicId = user.trim();
  const wellFormed = /^[a-z2-7]{13}$/.test(publicId);
  const preview = from === "user" && wellFormed && can(me, "users.read");
  const target = useUser(publicId, preview);
  const missing =
    preview && target.isError && asApiError(target.error).code === "not_found";
  const waiting = preview && !target.data;

  async function submit(event: FormEvent) {
    event.preventDefault();
    const found: typeof problems = {};
    const end = banExpiry(expiry, date, Date.now());
    if (from === "user" && !wellFormed) found.user = t("deviceBans.error.user");
    if (from === "user" && kinds.length === 0)
      found.kinds = t("deviceBans.error.kinds");
    if (from === "phone" && !phone.trim()) found.phone = t("form.required");
    else if (from === "phone" && lacksCountryCode(phone))
      found.phone = t("deviceBans.error.phone");
    if (end.error) found.expiry = t(end.error);
    if (!reason.trim()) found.reason = t("form.required");
    setProblems(found);
    if (Object.keys(found).length > 0 || busy || (from === "user" && waiting))
      return;
    setBusy(true);
    try {
      const common = {
        ...(end.expiresAt ? { expiresAt: end.expiresAt } : {}),
        reason: reason.trim(),
      };
      const body =
        from === "user"
          ? {
              from,
              user: user.trim(),
              kinds: banKinds.filter((k) => kinds.includes(k)),
              ...common,
            }
          : { from, phone: phone.trim(), ...common };
      await apiRequest("/v1/admin/device-bans", { method: "POST", body });
      onDone();
    } catch (failure) {
      const problem = asApiError(failure);
      const code = problem.errors[0]?.code;
      if (problem.code === "not_found")
        setProblems({ user: t("deviceBans.error.noUser") });
      else if (code === "nothing_to_ban")
        setProblems({ kinds: t("deviceBans.error.nothing") });
      else if (code === "phone_invalid")
        setProblems({ phone: t("deviceBans.error.phone") });
      else if (code === "ends_in_past" || code === "ends_too_far")
        setProblems({ expiry: t("action.error.untilPast") });
      else showToast(problemText(problem, t), "error", 6_000);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("deviceBans.new")}</DialogTitle>
        </DialogHeader>
        <form
          className="grid gap-5"
          onSubmit={(event) => void submit(event)}
          noValidate
        >
          <Segmented<"user" | "phone">
            label={t("deviceBans.from")}
            value={from}
            options={["user", "phone"]}
            text={(option) =>
              t(
                option === "user"
                  ? "deviceBans.from.user"
                  : "deviceBans.from.phone",
              )
            }
            onChange={(option) => {
              setFrom(option);
              setProblems({});
            }}
          />
          {from === "user" ? (
            <>
              <Field
                id={`${id}-user`}
                label={t("deviceBans.field.user")}
                error={
                  problems.user ??
                  (missing ? t("deviceBans.error.noUser") : undefined)
                }
              >
                {(control) => (
                  <Input
                    {...control}
                    dir="ltr"
                    className="font-mono"
                    maxLength={13}
                    value={user}
                    onChange={(event) => {
                      setUser(event.target.value.toLowerCase());
                      setProblems(({ user: _cleared, ...rest }) => rest);
                    }}
                    autoComplete="off"
                    spellCheck={false}
                  />
                )}
              </Field>
              {preview && !missing && (
                <div
                  className="rounded-lg border px-3 py-2.5"
                  aria-live="polite"
                >
                  {target.data ? (
                    <UserRef user={target.data} link={false} wrap />
                  ) : target.isError ? (
                    <LoadError
                      error={target.error}
                      onRetry={() => void target.refetch()}
                    />
                  ) : (
                    <Skeleton className="h-8 w-48" />
                  )}
                </div>
              )}
              <fieldset
                className="grid gap-2"
                aria-describedby={
                  problems.kinds ? `${id}-kinds-error` : undefined
                }
              >
                <legend className="mb-2 text-sm font-medium">
                  {t("deviceBans.field.kinds")}
                </legend>
                <div className="flex flex-wrap gap-x-5 gap-y-2">
                  {banKinds.map((k) => (
                    <label key={k} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="size-4 accent-primary"
                        checked={kinds.includes(k)}
                        onChange={(event) =>
                          setKinds(
                            event.target.checked
                              ? [...kinds, k]
                              : kinds.filter((x) => x !== k),
                          )
                        }
                      />
                      {t(`banKind.${k}` as MessageKey)}
                    </label>
                  ))}
                </div>
                {problems.kinds && (
                  <p
                    id={`${id}-kinds-error`}
                    className="text-sm text-destructive"
                  >
                    {problems.kinds}
                  </p>
                )}
              </fieldset>
            </>
          ) : (
            <Field
              id={`${id}-phone`}
              label={t("deviceBans.field.phone")}
              error={problems.phone}
            >
              {(control) => (
                <Input
                  {...control}
                  type="tel"
                  dir="ltr"
                  inputMode="tel"
                  className="text-start"
                  placeholder={t("deviceBans.phone.example")}
                  value={phone}
                  onChange={(event) => setPhone(event.target.value)}
                  autoComplete="off"
                />
              )}
            </Field>
          )}
          <div className="grid gap-5 sm:grid-cols-2">
            <Field
              id={`${id}-expiry`}
              label={t("deviceBans.field.expires")}
              error={expiry === "date" ? undefined : problems.expiry}
            >
              {(control) => (
                <NativeSelect
                  {...control}
                  value={expiry}
                  onChange={(event) =>
                    setExpiry(event.target.value as BanExpiry)
                  }
                >
                  <option value="permanent">{t("common.permanent")}</option>
                  <option value="30d">{t("action.preset.30d")}</option>
                  <option value="1y">{t("deviceBans.preset.1y")}</option>
                  <option value="date">{t("action.preset.date")}</option>
                </NativeSelect>
              )}
            </Field>
            {expiry === "date" && (
              <Field
                id={`${id}-date`}
                label={t("action.date")}
                hint={dayInPanelCalendar(date, locale)}
                error={problems.expiry}
              >
                {(control) => (
                  <Input
                    {...control}
                    type="date"
                    dir="ltr"
                    value={date}
                    onChange={(event) => setDate(event.target.value)}
                  />
                )}
              </Field>
            )}
          </div>
          <Field
            id={`${id}-reason`}
            label={t("deviceBans.field.reason")}
            error={problems.reason}
          >
            {(control) => (
              <Textarea
                {...control}
                dir="auto"
                rows={2}
                maxLength={500}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            )}
          </Field>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={busy}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="submit"
              variant="destructive"
              disabled={busy || (from === "user" && (waiting || missing))}
            >
              {busy ? t("common.saving") : t("deviceBans.create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
