import { ADMIN_CONFIG_BOUNDS, type AdminConfigItem, type AdminConfigKey, type AppConfig, type Locale } from '@app/shared';
import { Lock, Plus, Trash2 } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Field } from '@/components/form/Field';
import { ConfirmDialog } from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import type { MessageKey } from '@/i18n/messages';
import type { Translate, Wording } from '@/i18n/translate';
import { useI18n } from '@/i18n/useI18n';
import {
  closedBySave,
  countriesCheck,
  countriesFormOf,
  countryCode,
  fieldsInDigitsOf,
  legalCheck,
  legalFormOf,
  legalInDigitsOf,
  legalTexts,
  limitNames,
  limitsCheck,
  limitsFormOf,
  MAINTENANCE_MESSAGE_MAX,
  maintenanceFormOf,
  maintenanceProblems,
  maintenanceValue,
  newRowId,
  numberInput,
  raisedRequired,
  raisedTexts,
  retentionCheck,
  retentionKeys,
  retentionUnit,
  serverProblems,
  storeOfVersionKey,
  typedNumber,
  units,
  useDigitsFollowLocale,
  versionsCheck,
  versionsFormOf,
  versionsInDigitsOf,
  versionStores,
  wordedProblems,
  type CountriesForm,
  type LegalForm,
  type LegalText,
  type LimitName,
  type Problem,
  type Problems,
  type RetentionKey,
  type Stores,
} from '@/lib/appConfigForm';
import { appKeys, latestChange, putConfig, storeConfigItem } from '@/lib/appSettings';
import { asciiDigits, formatPlain, languageName, listOf, regionName } from '@/lib/format';
import { asApiError } from '@/lib/http';
import { problemText } from '@/lib/problemText';
import { queryClient } from '@/lib/queries';
import { can } from '@/lib/session';
import { showToast } from '@/lib/toast';
import { useSession } from '@/lib/useSession';
import { cn } from '@/lib/utils';
import { SettingsCard } from './SettingsCard';

/**
 * The cards of `/app/config`. Each holds one form over its settings and
 * saves only those, with the versions they were read at. A save the API
 * refuses at a field shows there; one refused because another admin saved
 * meanwhile reloads the card. The page keys each card by its versions, so a
 * save (or a newer read) starts it again from the stored values; a change of
 * the panel's language redraws the numbers in its digits, keeping edits.
 */

export interface CardNotice {
  notice: Wording | null;
  setNotice: (notice: Wording | null) => void;
}

type Items = Partial<Record<AdminConfigKey, AdminConfigItem>>;

interface Pending {
  title: string;
  body: ReactNode;
  action: string;
  destructive?: boolean;
  run: () => void;
}

/** Whether the admin may write a setting (the API checks it again). */
function useWritable(...items: AdminConfigItem[]): boolean {
  const { me } = useSession();
  return items.length > 0 && items.every((item) => item.write !== null && can(me, item.write));
}

/** A card without fields of its own: a refusal at a field is said in the footer alone. */
const ignoreFields = (_fields: Problems): void => undefined;

/** A field's problem worded in the panel's language of this render (problems are kept as data). */
const problemOf = (problems: Problems, t: Translate, field: string): string | undefined => {
  const problem = problems[field];
  return problem ? t(problem.key, problem.values) : undefined;
};

/**
 * Saves settings one after another, stopping at the first refusal; what was
 * saved is stored at the end (the card then starts again from it).
 */
function useSaver({ setNotice }: CardNotice, onFields: (fields: Problems) => void, bounds?: (key: AdminConfigKey, path: string) => { min: number; max: number } | null) {
  const [saving, setSaving] = useState(false);
  async function save(
    entries: readonly {
      item: AdminConfigItem;
      value: unknown;
      prefix?: string;
    }[],
  ): Promise<boolean> {
    setSaving(true);
    setNotice(null);
    const saved: AdminConfigItem[] = [];
    try {
      for (const entry of entries) saved.push(await putConfig(entry.item.key, entry.value, entry.item.version));
      showToast((t) => t('common.saved'));
      return true;
    } catch (error) {
      const failure = asApiError(error);
      const entry = entries[saved.length];
      if (failure.code === 'conflict' && failure.reason === 'settings_changed') {
        showToast((t) => t('settings.conflict'), 'error', 6_000);
        void queryClient.invalidateQueries({ queryKey: appKeys.config });
      } else if (failure.code === 'field_invalid' && entry) {
        onFields(serverProblems(failure.errors, entry.prefix ?? '', (path) => bounds?.(entry.item.key, path) ?? null));
        setNotice((t) => t('form.fixMarked'));
      } else {
        setNotice((t, lang) => problemText(failure, t, lang));
      }
      return false;
    } finally {
      setSaving(false);
      for (const item of saved) storeConfigItem(item);
    }
  }
  return { saving, save };
}

function ConfirmPending({ pending, saving, onClose, children, confirmDisabled }: { pending: Pending | null; saving: boolean; onClose: () => void; children?: ReactNode; confirmDisabled?: boolean }) {
  return (
    <ConfirmDialog
      open={pending !== null}
      onOpenChange={(open) => !open && !saving && onClose()}
      title={pending?.title ?? ''}
      description={pending?.body}
      confirmLabel={pending?.action ?? ''}
      destructive={pending?.destructive ?? false}
      busy={saving}
      confirmDisabled={confirmDisabled ?? false}
      onConfirm={() => pending?.run()}
    >
      {children}
    </ConfirmDialog>
  );
}

/** A switch with its label on the start side, as one row. */
function SwitchRow({ id, label, checked, onChange, children }: { id: string; label: string; checked: boolean; onChange: (on: boolean) => void; children?: ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <label htmlFor={id} className="min-w-0 flex-1 text-sm font-medium">
        {label}
      </label>
      {children}
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

const VERSION_FIELDS = ['required', 'recommended'] as const;
const CALL_KINDS = ['audio', 'video'] as const;
/** The maintenance message's languages, Persian first. */
const MESSAGE_LOCALES: readonly Locale[] = ['fa', 'en', 'tr'];

// ─── App versions ─────────────────────────────────────────────────────────

export function VersionsCard({ item, ...notice }: { item: AdminConfigItem } & CardNotice) {
  const { t, locale } = useI18n();
  const id = useId();
  const stored = item.value as AppConfig['app.min_version'];
  const plain = (n: number) => formatPlain(n, locale);
  const [initial, setInitial] = useState(() => versionsFormOf(stored, plain));
  const [form, setForm] = useState(initial);
  useDigitsFollowLocale(locale, versionsInDigitsOf, setInitial, setForm);
  const [problems, setProblems] = useState<Problems>({});
  const [fieldErrors, setFieldErrors] = useState<Problems>({});
  const [pending, setPending] = useState<{
    value: AppConfig['app.min_version'];
    raised: { store: Stores; code: number }[];
  } | null>(null);
  const [typed, setTyped] = useState<Partial<Record<Stores, string>>>({});
  const writable = useWritable(item);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const { saving, save } = useSaver(notice, setFieldErrors, () => ({
    min: 0,
    max: ADMIN_CONFIG_BOUNDS.versionCodeMax,
  }));
  const storeName = (store: Stores) => t(`store.${storeOfVersionKey[store]}`);

  function set(store: Stores, field: 'required' | 'recommended', value: string) {
    setForm({ ...form, [store]: { ...form[store], [field]: value } });
    setProblems({});
    setFieldErrors({});
    notice.setNotice(null);
  }

  function submit() {
    const checked = versionsCheck(form);
    setProblems(checked.problems);
    if (!checked.value) {
      notice.setNotice((t) => t('form.fixMarked'));
      return;
    }
    const raised = raisedRequired(stored, checked.value);
    if (raised.length > 0) {
      setTyped({});
      setPending({ value: checked.value, raised });
    } else void save([{ item, value: checked.value }]);
  }

  const confirmed = pending?.raised.every((r) => typedNumber(typed[r.store] ?? '') === r.code) ?? false;

  return (
    <SettingsCard
      className="lg:col-span-2"
      title={t('appConfig.versions.title')}
      writable={writable}
      dirty={dirty}
      saving={saving}
      notice={notice.notice}
      changed={latestChange([item])}
      onSubmit={submit}
      onDiscard={() => {
        setForm(initial);
        setProblems({});
        setFieldErrors({});
        notice.setNotice(null);
      }}
    >
      <div className="grid gap-4">
        {versionStores.map((store) => (
          <div key={store} className="grid items-start gap-3 sm:grid-cols-[minmax(7rem,10rem)_minmax(0,12rem)_minmax(0,12rem)]">
            <span className="text-sm font-medium sm:pt-8">{storeName(store)}</span>
            <div className="grid grid-cols-2 gap-3 sm:contents">
              {VERSION_FIELDS.map((field) => {
                const key = `${store}/${field}`;
                return (
                  <Field
                    key={field}
                    id={`${id}-${key}`}
                    label={t(field === 'required' ? 'appConfig.versions.required' : 'appConfig.versions.suggested')}
                    error={problemOf(problems, t, key) ?? problemOf(fieldErrors, t, key)}
                  >
                    {(control) => (
                      <Input
                        {...control}
                        {...numberInput}
                        aria-label={t(field === 'required' ? 'appConfig.versions.requiredOf' : 'appConfig.versions.suggestedOf', { store: storeName(store) })}
                        className="tabular-nums"
                        value={form[store][field]}
                        onChange={(event) => set(store, field, event.target.value)}
                      />
                    )}
                  </Field>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => !open && !saving && setPending(null)}
        title={t('appConfig.versions.confirm.title')}
        description={
          <ul className="grid gap-2">
            {pending?.raised.map((r) => (
              <li key={r.store}>
                {t('appConfig.versions.confirm', {
                  code: formatPlain(r.code, locale),
                  store: storeName(r.store),
                })}
              </li>
            ))}
          </ul>
        }
        confirmLabel={t('appConfig.versions.confirm.action')}
        destructive
        busy={saving}
        confirmDisabled={!confirmed}
        onConfirm={() => {
          if (!pending || !confirmed) return;
          void save([{ item, value: pending.value }]).then(() => setPending(null));
        }}
      >
        <div className="grid gap-3">
          {pending?.raised.map((r) => (
            <Field
              key={r.store}
              id={`${id}-type-${r.store}`}
              label={t('appConfig.versions.confirm.type', {
                code: formatPlain(r.code, locale),
                store: storeName(r.store),
              })}
            >
              {(control) => <Input {...control} {...numberInput} className="tabular-nums" value={typed[r.store] ?? ''} onChange={(event) => setTyped({ ...typed, [r.store]: event.target.value })} />}
            </Field>
          ))}
        </div>
      </ConfirmDialog>
    </SettingsCard>
  );
}

// ─── Maintenance ──────────────────────────────────────────────────────────

export function MaintenanceCard({ item, ...notice }: { item: AdminConfigItem } & CardNotice) {
  const { t, locale } = useI18n();
  const id = useId();
  const stored = item.value as AppConfig['app.maintenance'];
  const [initial] = useState(() => maintenanceFormOf(stored));
  const [form, setForm] = useState(initial);
  const [problems, setProblems] = useState<Problems>({});
  const [fieldErrors, setFieldErrors] = useState<Problems>({});
  const [pending, setPending] = useState<Pending | null>(null);
  const writable = useWritable(item);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const { saving, save } = useSaver(notice, setFieldErrors);

  function submit() {
    const found = maintenanceProblems(form);
    setProblems(found);
    if (Object.keys(found).length > 0) {
      notice.setNotice((t) => t('form.fixMarked'));
      return;
    }
    const value = maintenanceValue(form);
    if (value.enabled && !stored.enabled) {
      setPending({
        title: t('appConfig.maintenance.confirm.title'),
        body: t('appConfig.maintenance.confirm'),
        action: t('settings.turnOn'),
        destructive: true,
        run: () => void save([{ item, value }]).then(() => setPending(null)),
      });
    } else void save([{ item, value }]);
  }

  return (
    <SettingsCard
      className="lg:col-span-2"
      title={t('appConfig.maintenance.title')}
      badges={stored.enabled && <Badge variant="destructive">{t('appConfig.maintenance.on')}</Badge>}
      writable={writable}
      dirty={dirty}
      saving={saving}
      notice={notice.notice}
      changed={latestChange([item])}
      onSubmit={submit}
      onDiscard={() => {
        setForm(initial);
        setProblems({});
        setFieldErrors({});
        notice.setNotice(null);
      }}
    >
      <SwitchRow
        id={`${id}-on`}
        label={t('appConfig.maintenance.switch')}
        checked={form.enabled}
        onChange={(enabled) => {
          setForm({ ...form, enabled });
          notice.setNotice(null);
        }}
      />
      <div className="grid gap-4 lg:grid-cols-3">
        {MESSAGE_LOCALES.map((lang) => {
          const field = `message/${lang}`;
          return (
            <Field
              key={lang}
              id={`${id}-${lang}`}
              label={
                <span className="flex w-full items-center gap-2">
                  <span className="flex-1">
                    {t('appConfig.maintenance.message', {
                      language: languageName(lang, locale),
                    })}
                  </span>
                  <span className="text-xs font-normal text-muted-foreground tabular-nums">
                    {t('form.counter', {
                      count: [...form.message[lang]].length,
                      max: MAINTENANCE_MESSAGE_MAX,
                    })}
                  </span>
                </span>
              }
              error={problemOf(problems, t, field) ?? problemOf(fieldErrors, t, field)}
            >
              {(control) => (
                <Textarea
                  {...control}
                  lang={lang}
                  dir={lang === 'fa' ? 'rtl' : 'ltr'}
                  rows={3}
                  placeholder={t('appConfig.maintenance.placeholder')}
                  value={form.message[lang]}
                  onChange={(event) => {
                    setForm({
                      ...form,
                      message: { ...form.message, [lang]: event.target.value },
                    });
                    setProblems({});
                    notice.setNotice(null);
                  }}
                />
              )}
            </Field>
          );
        })}
      </div>
      <ConfirmPending pending={pending} saving={saving} onClose={() => setPending(null)} />
    </SettingsCard>
  );
}

// ─── Sign-up ──────────────────────────────────────────────────────────────

export function SignupCard({ item, ...notice }: { item: AdminConfigItem } & CardNotice) {
  const { t } = useI18n();
  const { me } = useSession();
  const id = useId();
  const stored = item.value as AppConfig['onboarding.waitlist'];
  const [enabled, setEnabled] = useState(stored.enabled);
  const [pending, setPending] = useState<Pending | null>(null);
  const writable = useWritable(item);
  const { saving, save } = useSaver(notice, ignoreFields);

  function submit() {
    const value = { enabled };
    if (enabled && !stored.enabled) {
      setPending({
        title: t('appConfig.signup.confirm.title'),
        body: t('appConfig.signup.confirm'),
        action: t('settings.turnOn'),
        run: () => void save([{ item, value }]).then(() => setPending(null)),
      });
    } else void save([{ item, value }]);
  }

  return (
    <SettingsCard
      title={t('appConfig.signup.title')}
      writable={writable}
      dirty={enabled !== stored.enabled}
      saving={saving}
      notice={notice.notice}
      changed={latestChange([item])}
      onSubmit={submit}
      onDiscard={() => {
        setEnabled(stored.enabled);
        notice.setNotice(null);
      }}
    >
      <SwitchRow
        id={`${id}-waitlist`}
        label={t('appConfig.signup.waitlist')}
        checked={enabled}
        onChange={(on) => {
          setEnabled(on);
          notice.setNotice(null);
        }}
      />
      {can(me, 'moderation.read') && (
        <Link to="/moderation/profiles" className="w-fit rounded-sm text-sm text-primary outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50">
          {t('nav.profiles')}
        </Link>
      )}
      <ConfirmPending pending={pending} saving={saving} onClose={() => setPending(null)} />
    </SettingsCard>
  );
}

// ─── Calls ────────────────────────────────────────────────────────────────

export function CallsCard({ item, ...notice }: { item: AdminConfigItem } & CardNotice) {
  const { t } = useI18n();
  const id = useId();
  const stored = item.value as AppConfig['calls.enabled'];
  const [form, setForm] = useState(stored);
  const [pending, setPending] = useState<Pending | null>(null);
  const writable = useWritable(item);
  const { saving, save } = useSaver(notice, ignoreFields);

  function submit() {
    const off = CALL_KINDS.filter((kind) => stored[kind] && !form[kind]);
    if (off.length > 0) {
      const which = off.length === 2 ? 'both' : off[0] === 'audio' ? 'audio' : 'video';
      const kind = t(`appConfig.calls.kind.${which}`);
      setPending({
        title: t(`appConfig.calls.confirm.title.${which}`),
        body: t('appConfig.calls.confirm', { kind }),
        action: t('settings.turnOff'),
        destructive: true,
        run: () => void save([{ item, value: form }]).then(() => setPending(null)),
      });
    } else void save([{ item, value: form }]);
  }

  return (
    <SettingsCard
      title={t('appConfig.calls.title')}
      writable={writable}
      dirty={form.audio !== stored.audio || form.video !== stored.video}
      saving={saving}
      notice={notice.notice}
      changed={latestChange([item])}
      onSubmit={submit}
      onDiscard={() => {
        setForm(stored);
        notice.setNotice(null);
      }}
    >
      {CALL_KINDS.map((kind) => (
        <SwitchRow
          key={kind}
          id={`${id}-${kind}`}
          label={t(kind === 'audio' ? 'appConfig.calls.audio' : 'appConfig.calls.video')}
          checked={form[kind]}
          onChange={(on) => {
            setForm({ ...form, [kind]: on });
            notice.setNotice(null);
          }}
        />
      ))}
      <ConfirmPending pending={pending} saving={saving} onClose={() => setPending(null)} />
    </SettingsCard>
  );
}

// ─── Countries ────────────────────────────────────────────────────────────

const UNIT_LABEL: Record<(typeof units)[number], MessageKey> = {
  km: 'appConfig.countries.unit.km',
  mi: 'appConfig.countries.unit.mi',
};

export function CountriesCard({ item, ...notice }: { item: AdminConfigItem } & CardNotice) {
  const { t, locale } = useI18n();
  const id = useId();
  const stored = item.value as AppConfig['signup.countries'];
  const [initial] = useState(() => countriesFormOf(stored));
  const [form, setForm] = useState<CountriesForm>(initial);
  const [problems, setProblems] = useState<Problems>({});
  const [fieldErrors, setFieldErrors] = useState<Problems>({});
  const [pending, setPending] = useState<Pending | null>(null);
  const writable = useWritable(item);
  const strip = (f: CountriesForm) =>
    JSON.stringify({
      ...f,
      countries: f.countries.map(({ rowId: _, ...row }) => ({
        ...row,
        code: countryCode(row.code),
      })),
    });
  const dirty = strip(form) !== strip(initial);
  const { saving, save } = useSaver(notice, setFieldErrors);
  const name = (code: string) => (/^[A-Z]{2}$/.test(countryCode(code)) ? regionName(countryCode(code), locale) : '');

  function update(next: CountriesForm) {
    setForm(next);
    setProblems({});
    setFieldErrors({});
    notice.setNotice(null);
  }

  function setRow(index: number, patch: Partial<CountriesForm['countries'][number]>) {
    update({
      ...form,
      countries: form.countries.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    });
  }

  function submit() {
    const checked = countriesCheck(form);
    setProblems(checked.problems);
    if (!checked.value) {
      notice.setNotice((t) => t('form.fixMarked'));
      return;
    }
    const value = checked.value;
    const closed = closedBySave(stored, value);
    const places = [...closed.codes.map((code) => regionName(code, locale)), ...(closed.others ? [t('appConfig.countries.confirm.others')] : [])];
    if (places.length > 0) {
      setPending({
        title: t('appConfig.countries.confirm.title'),
        body: t('appConfig.countries.confirm', {
          places: listOf(places, locale),
        }),
        action: t('appConfig.countries.confirm.action'),
        destructive: true,
        run: () => void save([{ item, value }]).then(() => setPending(null)),
      });
    } else void save([{ item, value }]);
  }

  return (
    <SettingsCard
      className="lg:col-span-2"
      title={t('appConfig.countries.title')}
      writable={writable}
      dirty={dirty}
      saving={saving}
      notice={notice.notice}
      changed={latestChange([item])}
      onSubmit={submit}
      onDiscard={() => {
        setForm(initial);
        setProblems({});
        setFieldErrors({});
        notice.setNotice(null);
      }}
    >
      <SwitchRow id={`${id}-others`} label={t('appConfig.countries.others')} checked={form.defaultAllowed} onChange={(on) => update({ ...form, defaultAllowed: on })}>
        <span className="text-sm text-muted-foreground">{t(form.defaultAllowed ? 'appConfig.countries.open' : 'appConfig.countries.closed')}</span>
      </SwitchRow>
      {form.countries.length > 0 && (
        <div className="grid gap-3">
          <div className="hidden grid-cols-[minmax(0,1fr)_8rem_9rem_2.25rem] gap-3 text-xs font-medium text-muted-foreground md:grid" aria-hidden="true">
            <span>{t('appConfig.countries.col.country')}</span>
            <span>{t('appConfig.countries.col.unit')}</span>
            <span>{t('appConfig.countries.col.signup')}</span>
            <span />
          </div>
          <ul className="grid gap-3">
            {form.countries.map((row, i) => {
              const error = problemOf(problems, t, `countries/${i}/code`) ?? problemOf(fieldErrors, t, `countries/${i}/code`) ?? problemOf(fieldErrors, t, `countries/${i}`);
              const label = name(row.code) || t('appConfig.countries.code');
              return (
                <li key={row.rowId} className="grid grid-cols-[minmax(0,1fr)_6.5rem] items-center gap-3 rounded-lg border p-3 md:grid-cols-[minmax(0,1fr)_8rem_9rem_2.25rem] md:items-start md:border-0 md:p-0">
                  <div className="grid gap-1">
                    <div className="flex items-center gap-3">
                      <Input
                        dir="ltr"
                        autoComplete="off"
                        spellCheck={false}
                        maxLength={2}
                        aria-label={t('appConfig.countries.code')}
                        aria-invalid={Boolean(error)}
                        aria-describedby={error ? `${id}-${row.rowId}-error` : undefined}
                        className="w-16 shrink-0 text-center font-mono uppercase"
                        value={row.code}
                        onChange={(event) => setRow(i, { code: event.target.value.toUpperCase() })}
                      />
                      <span dir="auto" className="min-w-0 flex-1 truncate text-sm">
                        {name(row.code)}
                      </span>
                    </div>
                    {error && (
                      <p id={`${id}-${row.rowId}-error`} className="text-sm text-destructive">
                        {error}
                      </p>
                    )}
                  </div>
                  <NativeSelect
                    className="h-9 text-sm"
                    aria-label={t('appConfig.countries.unitIn', {
                      country: label,
                    })}
                    value={row.unit}
                    onChange={(event) => setRow(i, { unit: event.target.value as (typeof units)[number] })}
                  >
                    {units.map((unit) => (
                      <option key={unit} value={unit}>
                        {t(UNIT_LABEL[unit])}
                      </option>
                    ))}
                  </NativeSelect>
                  <label className="flex h-9 items-center gap-2 text-sm">
                    <Switch
                      checked={row.allowed}
                      onCheckedChange={(allowed) => setRow(i, { allowed })}
                      aria-label={t('appConfig.countries.signupIn', {
                        country: label,
                      })}
                    />
                    <span className="text-muted-foreground">{t(row.allowed ? 'appConfig.countries.open' : 'appConfig.countries.closed')}</span>
                  </label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="col-start-2 row-start-1 justify-self-end md:col-start-auto md:row-start-auto md:justify-self-auto"
                    aria-label={t('appConfig.countries.remove', {
                      country: label,
                    })}
                    onClick={() =>
                      update({
                        ...form,
                        countries: form.countries.filter((_, j) => j !== i),
                      })
                    }
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {writable && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-fit"
          disabled={form.countries.length >= 300}
          onClick={() =>
            update({
              ...form,
              countries: [
                ...form.countries,
                {
                  rowId: newRowId(),
                  code: '',
                  allowed: !form.defaultAllowed,
                  unit: 'km',
                  language: '',
                },
              ],
            })
          }
        >
          <Plus aria-hidden="true" />
          {t('appConfig.countries.add')}
        </Button>
      )}
      <ConfirmPending pending={pending} saving={saving} onClose={() => setPending(null)} />
    </SettingsCard>
  );
}

// ─── Limits ───────────────────────────────────────────────────────────────

const limitLabel: Readonly<Record<LimitName, MessageKey>> = {
  swipes_per_hour: 'appConfig.limits.swipesPerHour',
  messages_per_minute: 'appConfig.limits.messagesPerMinute',
  messages_per_conversation: 'appConfig.limits.messagesPerConversation',
  reports_per_day: 'appConfig.limits.reportsPerDay',
};

export function LimitsCard({ item, ...notice }: { item: AdminConfigItem } & CardNotice) {
  const { t, locale } = useI18n();
  const id = useId();
  const stored = item.value as AppConfig['limits.rates'];
  const plain = (n: number) => formatPlain(n, locale);
  const [initial, setInitial] = useState(() => limitsFormOf(stored, plain));
  const [form, setForm] = useState(initial);
  useDigitsFollowLocale(locale, fieldsInDigitsOf, setInitial, setForm);
  const [problems, setProblems] = useState<Problems>({});
  const [fieldErrors, setFieldErrors] = useState<Problems>({});
  const writable = useWritable(item);
  const dirty = limitNames.some((name) => asciiDigits(form[name].trim()) !== asciiDigits(initial[name]));
  const { saving, save } = useSaver(notice, setFieldErrors, (_, path) => ADMIN_CONFIG_BOUNDS.limits[path as LimitName] ?? null);

  function submit() {
    const checked = limitsCheck(form);
    setProblems(checked.problems);
    if (!checked.value) {
      notice.setNotice((t) => t('form.fixMarked'));
      return;
    }
    void save([{ item, value: checked.value }]);
  }

  return (
    <SettingsCard
      title={t('appConfig.limits.title')}
      writable={writable}
      dirty={dirty}
      saving={saving}
      notice={notice.notice}
      changed={latestChange([item])}
      onSubmit={submit}
      onDiscard={() => {
        setForm(initial);
        setProblems({});
        setFieldErrors({});
        notice.setNotice(null);
      }}
    >
      <div className="grid gap-5 sm:grid-cols-2">
        {limitNames.map((name) => {
          const { min, max } = ADMIN_CONFIG_BOUNDS.limits[name];
          return (
            <Field
              key={name}
              // Side by side, a label that wraps keeps both inputs on one line.
              className="sm:row-span-3 sm:grid-rows-subgrid sm:[&>label]:self-end"
              id={`${id}-${name}`}
              label={t(limitLabel[name])}
              hint={t('appConfig.range', {
                min: formatPlain(min, locale),
                max: formatPlain(max, locale),
              })}
              error={problemOf(problems, t, name) ?? problemOf(fieldErrors, t, name)}
            >
              {(control) => (
                <Input
                  {...control}
                  {...numberInput}
                  className="w-32 tabular-nums"
                  value={form[name]}
                  onChange={(event) => {
                    setForm({ ...form, [name]: event.target.value });
                    setProblems({});
                    setFieldErrors({});
                    notice.setNotice(null);
                  }}
                />
              )}
            </Field>
          );
        })}
      </div>
    </SettingsCard>
  );
}

// ─── Legal ────────────────────────────────────────────────────────────────

const legalLabel: Readonly<Record<LegalText, MessageKey>> = {
  terms: 'appConfig.legal.terms',
  privacy: 'appConfig.legal.privacy',
  guidelines: 'appConfig.legal.guidelines',
};
const legalName: Readonly<Record<LegalText, MessageKey>> = {
  terms: 'appConfig.legal.name.terms',
  privacy: 'appConfig.legal.name.privacy',
  guidelines: 'appConfig.legal.name.guidelines',
};

export function LegalCard({ versions, contact, ...notice }: { versions: AdminConfigItem; contact: AdminConfigItem } & CardNotice) {
  const { t, locale } = useI18n();
  const id = useId();
  const storedVersions = versions.value as AppConfig['legal.versions'];
  const storedContact = contact.value as AppConfig['safety.child_safety_contact'];
  const [initial, setInitial] = useState<LegalForm>(() => legalFormOf(storedVersions, storedContact, (n) => formatPlain(n, locale)));
  const [form, setForm] = useState<LegalForm>(initial);
  useDigitsFollowLocale(locale, legalInDigitsOf, setInitial, setForm);
  const [problems, setProblems] = useState<Problems>({});
  const [fieldErrors, setFieldErrors] = useState<Problems>({});
  const fieldTexts = wordedProblems(fieldErrors, t);
  const [pending, setPending] = useState<Pending | null>(null);
  const writable = useWritable(versions, contact);
  const norm = (f: LegalForm) =>
    JSON.stringify({
      versions: Object.fromEntries(legalTexts.map((text) => [text, asciiDigits(f.versions[text].trim())])),
      name: f.name.trim(),
      email: f.email.trim(),
    });
  const dirty = norm(form) !== norm(initial);
  const { saving, save } = useSaver(notice, setFieldErrors, (key) => (key === 'legal.versions' ? { min: 1, max: ADMIN_CONFIG_BOUNDS.legalVersionMax } : null));

  function change(next: LegalForm) {
    setForm(next);
    setProblems({});
    setFieldErrors({});
    notice.setNotice(null);
  }

  function submit() {
    const checked = legalCheck(form, storedVersions);
    setProblems(checked.problems);
    if (!checked.versions || !checked.contact) {
      notice.setNotice((t) => t('form.fixMarked'));
      return;
    }
    const entries = [
      ...(JSON.stringify(checked.versions) !== JSON.stringify(storedVersions) ? [{ item: versions, value: checked.versions, prefix: 'versions/' }] : []),
      ...(JSON.stringify(checked.contact) !== JSON.stringify(storedContact) ? [{ item: contact, value: checked.contact, prefix: 'contact/' }] : []),
    ];
    if (entries.length === 0) return;
    const raised = raisedTexts(storedVersions, checked.versions);
    if (raised.length > 0) {
      setPending({
        title: t('appConfig.legal.confirm.title'),
        body: t('appConfig.legal.confirm', {
          names: listOf(
            raised.map((text) => t(legalName[text])),
            locale,
          ),
        }),
        action: t('settings.save'),
        run: () => void save(entries).then(() => setPending(null)),
      });
    } else void save(entries);
  }

  return (
    <SettingsCard
      title={t('appConfig.legal.title')}
      writable={writable}
      dirty={dirty}
      saving={saving}
      notice={notice.notice}
      changed={latestChange([versions, contact])}
      onSubmit={submit}
      onDiscard={() => {
        setForm(initial);
        setProblems({});
        setFieldErrors({});
        notice.setNotice(null);
      }}
    >
      <fieldset className="@container grid gap-3">
        <legend className="mb-3 text-sm font-semibold">{t('appConfig.legal.versions')}</legend>
        {/* Keyed to the card's width, not the viewport's (beside the limits card it is half as wide): one under another until the three names fit on a line each. */}
        <div className="grid grid-cols-1 gap-4 @lg:grid-cols-3 @lg:gap-x-3 @lg:gap-y-2">
          {legalTexts.map((text) => {
            const field = `versions/${text}`;
            return (
              <Field key={text} className="@lg:row-span-3 @lg:grid-rows-subgrid @lg:[&>label]:self-end" id={`${id}-${text}`} label={t(legalLabel[text])} error={problemOf(problems, t, field) ?? problemOf(fieldErrors, t, field)}>
                {(control) => (
                  <Input
                    {...control}
                    {...numberInput}
                    className="w-32 tabular-nums @lg:w-full"
                    value={form.versions[text]}
                    onChange={(event) =>
                      change({
                        ...form,
                        versions: {
                          ...form.versions,
                          [text]: event.target.value,
                        },
                      })
                    }
                  />
                )}
              </Field>
            );
          })}
        </div>
      </fieldset>
      <fieldset className="grid gap-3">
        <legend className="mb-3 text-sm font-semibold">{t('appConfig.legal.contact')}</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id={`${id}-name`} label={t('appConfig.legal.contactName')} error={problemOf(problems, t, 'contact/name') ?? fieldTexts['contact/name']}>
            {(control) => <Input {...control} dir="auto" autoComplete="off" value={form.name} onChange={(event) => change({ ...form, name: event.target.value })} />}
          </Field>
          <Field id={`${id}-email`} label={t('appConfig.legal.contactEmail')} error={problemOf(problems, t, 'contact/email') ?? fieldTexts['contact/email']}>
            {(control) => <Input {...control} type="email" dir="ltr" autoComplete="off" value={form.email} onChange={(event) => change({ ...form, email: event.target.value })} />}
          </Field>
        </div>
      </fieldset>
      <ConfirmPending pending={pending} saving={saving} onClose={() => setPending(null)} />
    </SettingsCard>
  );
}

// ─── Data retention ───────────────────────────────────────────────────────

const retentionLabel: Readonly<Record<RetentionKey, MessageKey>> = {
  'retention.deleted_account_days': 'appConfig.retention.deletedAccounts',
  'retention.unmatched_messages_days': 'appConfig.retention.unmatched',
  'retention.message_requests_days': 'appConfig.retention.messageRequests',
  'retention.unsent_body_hours': 'appConfig.retention.unsentBody',
  'retention.report_evidence_days': 'appConfig.retention.reportEvidence',
};

export function RetentionCard({ items, ...notice }: { items: Items } & CardNotice) {
  const { t, locale } = useI18n();
  const { me } = useSession();
  const id = useId();
  const shown = retentionKeys.filter((key) => items[key] !== undefined);
  const may = (key: RetentionKey) => {
    const write = items[key]?.write ?? null;
    return write !== null && can(me, write);
  };
  const editable = shown.filter(may);
  const [initial, setInitial] = useState(() => Object.fromEntries(shown.map((key) => [key, formatPlain(items[key]!.value as number, locale)])) as Record<RetentionKey, string>);
  const [form, setForm] = useState(initial);
  useDigitsFollowLocale(locale, fieldsInDigitsOf, setInitial, setForm);
  const [problems, setProblems] = useState<Problems>({});
  const [pending, setPending] = useState<Pending | null>(null);
  const dirty = editable.some((key) => asciiDigits(form[key].trim()) !== asciiDigits(initial[key]));
  const { saving, save } = useSaver(notice, setProblems, (key) => ADMIN_CONFIG_BOUNDS.retention[key as RetentionKey] ?? null);

  function submit() {
    const found: Record<string, Problem> = {};
    const entries: { item: AdminConfigItem; value: number; prefix: string }[] = [];
    for (const key of editable) {
      if (asciiDigits(form[key].trim()) === asciiDigits(initial[key])) continue;
      const checked = retentionCheck(key, form[key]);
      if (checked.problem) found[key] = checked.problem;
      else
        entries.push({
          item: items[key]!,
          value: checked.value!,
          prefix: `${key}/`,
        });
    }
    setProblems(found);
    if (Object.keys(found).length > 0) {
      notice.setNotice((t) => t('form.fixMarked'));
      return;
    }
    if (entries.length === 0) return;
    // The privacy policy states these lengths: every change is confirmed.
    setPending({
      title: t('appConfig.retention.confirm.title'),
      body: t('appConfig.retention.confirm'),
      action: t('settings.save'),
      run: () => void save(entries).then(() => setPending(null)),
    });
  }

  return (
    <SettingsCard
      className="lg:col-span-2"
      title={t('appConfig.retention.title')}
      writable={editable.length > 0}
      dirty={dirty}
      saving={saving}
      notice={notice.notice}
      changed={latestChange(shown.map((key) => items[key]!))}
      onSubmit={submit}
      onDiscard={() => {
        setForm(initial);
        setProblems({});
        notice.setNotice(null);
      }}
    >
      <ul className="grid gap-x-8 gap-y-4 md:grid-cols-2">
        {shown.map((key) => {
          const { min, max } = ADMIN_CONFIG_BOUNDS.retention[key];
          const locked = !may(key);
          const error = problemOf(problems, t, key) ?? problemOf(problems, t, `${key}/`);
          const inputId = `${id}-${key}`;
          return (
            <li key={key} className="grid gap-2">
              <label htmlFor={inputId} className="flex items-center gap-2 text-sm font-medium">
                {t(retentionLabel[key])}
                {locked && items[key]?.write === null && (
                  <span title={t('settings.readOnly')} className="text-muted-foreground">
                    <Lock className="size-3.5" aria-hidden="true" />
                    <span className="sr-only">{t('settings.readOnly')}</span>
                  </span>
                )}
              </label>
              <div className="flex items-center gap-2">
                <Input
                  id={inputId}
                  {...numberInput}
                  disabled={locked}
                  aria-invalid={Boolean(error)}
                  aria-describedby={`${inputId}-hint`}
                  className="w-28 tabular-nums"
                  value={form[key]}
                  onChange={(event) => {
                    setForm({ ...form, [key]: event.target.value });
                    setProblems({});
                    notice.setNotice(null);
                  }}
                />
                <span className="text-sm text-muted-foreground">{t(retentionUnit(key) === 'hours' ? 'appConfig.unit.hours' : 'appConfig.unit.days')}</span>
              </div>
              <p id={`${inputId}-hint`} className={cn('text-xs', error ? 'text-sm text-destructive' : 'text-muted-foreground')}>
                {error ??
                  t('appConfig.range', {
                    min: formatPlain(min, locale),
                    max: formatPlain(max, locale),
                  })}
              </p>
            </li>
          );
        })}
      </ul>
      <ConfirmPending pending={pending} saving={saving} onClose={() => setPending(null)} />
    </SettingsCard>
  );
}
