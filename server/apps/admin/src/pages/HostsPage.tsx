import type { OriginsAdminView } from '@app/shared';
import { Globe, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useId, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { useI18n } from '@/i18n/useI18n';
import type { MessageKey } from '@/i18n/messages';
import { ApiError, apiRequest } from '@/lib/api';
import { checkForm, formOf, hostsFields, problemsOf, requestOf, type FieldProblem, type HostsField, type HostsForm } from '@/lib/hosts';
import { onSessionChange } from '@/lib/session';
import { cn } from '@/lib/utils';

const FIELD_LABEL: Record<HostsField, MessageKey> = {
  api: 'hosts.role.api',
  realtime: 'hosts.role.realtime',
  rtc: 'hosts.role.rtc',
  cdn: 'hosts.role.cdn',
  web: 'hosts.role.web',
  bootstrap: 'hosts.role.bootstrap',
};

type Load = { state: 'loading' } | { state: 'ready'; view: OriginsAdminView } | { state: 'failed'; error: ApiError };

function asApiError(error: unknown): ApiError {
  return error instanceof ApiError ? error : new ApiError(0, 'unexpected', error instanceof Error ? error.message : String(error));
}

/**
 * The hosts apps are sent to (the signed origins document): the API,
 * realtime, call signalling, the CDN and the website, in order of
 * preference, and where the published copies are. A save raises the
 * document's version; apps pick it up without an update.
 */
export function HostsPage() {
  const { t, locale } = useI18n();
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [form, setForm] = useState<HostsForm | null>(null);
  const [problems, setProblems] = useState<FieldProblem[]>([]);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'saved' | 'error'; text: string } | null>(null);
  const baseId = useId();

  // State changes only in the request's callbacks (never synchronously in the effect below).
  const refresh = useCallback(
    (signal?: AbortSignal): Promise<void> =>
      apiRequest<OriginsAdminView>('/v1/admin/origins', { signal }).then(
        (view) => {
          setLoad({ state: 'ready', view });
          setForm(formOf(view));
          setProblems([]);
        },
        (error: unknown) => {
          if (error instanceof DOMException && error.name === 'AbortError') return;
          setLoad({ state: 'failed', error: asApiError(error) });
        },
      ),
    [],
  );

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    const off = onSessionChange(() => void refresh());
    return () => {
      controller.abort();
      off();
    };
  }, [refresh]);

  const date = (iso: string) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));

  async function save() {
    if (!form || load.state !== 'ready') return;
    const found = checkForm(form);
    setProblems(found);
    setNotice(null);
    if (found.length > 0) return;
    setSaving(true);
    try {
      const view = await apiRequest<OriginsAdminView>('/v1/admin/origins', { method: 'PUT', body: requestOf(form, load.view.version) });
      setLoad({ state: 'ready', view });
      setForm(formOf(view));
      setNotice({ kind: 'saved', text: t('hosts.saved', { version: view.version }) });
    } catch (error) {
      const failure = asApiError(error);
      if (failure.code === 'field_invalid') setProblems(problemsOf(failure.errors));
      setNotice({ kind: 'error', text: failure.code === 'conflict' ? t('hosts.conflict') : failure.message });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto grid max-w-4xl gap-6">
      <h1 className="flex items-center gap-3 text-2xl font-semibold tracking-tight">
        <Globe className="size-6 text-primary" aria-hidden="true" />
        {t('nav.hosts')}
      </h1>
      <p className="text-sm text-muted-foreground">{t('hosts.intro')}</p>

      {load.state === 'loading' && <p className="text-sm text-muted-foreground">{t('hosts.loading')}</p>}

      {load.state === 'failed' && (
        <Alert variant={load.error.status === 401 ? 'default' : 'destructive'}>
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>{load.error.status === 401 ? t('hosts.signIn.title') : t('hosts.loadFailed')}</AlertTitle>
          <AlertDescription>{load.error.status === 401 ? t('hosts.signIn.body') : load.error.message}</AlertDescription>
        </Alert>
      )}

      {load.state === 'ready' && form && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>{t('hosts.status.title')}</CardTitle>
              <CardDescription>{load.view.saved ? t('hosts.status.saved', { version: load.view.version }) : t('hosts.status.defaults')}</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 text-sm">
              {load.view.document ? (
                <p>{t('hosts.status.document', { version: load.view.document.version, issued: date(load.view.document.issuedAt), expires: date(load.view.document.expiresAt) })}</p>
              ) : (
                <Alert variant="warning">
                  <TriangleAlert aria-hidden="true" />
                  <AlertDescription>{t('hosts.status.noKey')}</AlertDescription>
                </Alert>
              )}
              {load.view.signing.configured && (
                <p className="break-all">
                  {t('hosts.status.key', { kid: load.view.signing.kid ?? '' })} <code dir="ltr">{load.view.signing.publicKey}</code>
                </p>
              )}
              {load.view.signing.trusted === false && (
                <Alert variant="destructive">
                  <TriangleAlert aria-hidden="true" />
                  <AlertDescription>{t('hosts.status.untrusted')}</AlertDescription>
                </Alert>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('hosts.form.title')}</CardTitle>
              <CardDescription>{t('hosts.form.help')}</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-5">
              {hostsFields.map((field) => {
                const id = `${baseId}-${field}`;
                const own = problems.filter((problem) => problem.field === field);
                return (
                  <div key={field} className="grid gap-2">
                    <Label htmlFor={id}>{t(FIELD_LABEL[field])}</Label>
                    <textarea
                      id={id}
                      dir="ltr"
                      rows={field === 'api' || field === 'bootstrap' ? 3 : 2}
                      spellCheck={false}
                      aria-invalid={own.length > 0}
                      aria-describedby={own.length > 0 ? `${id}-problems` : undefined}
                      value={form.lines[field]}
                      onChange={(event) => setForm({ ...form, lines: { ...form.lines, [field]: event.target.value } })}
                      className={cn(
                        'w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm shadow-xs outline-none dark:bg-input/30',
                        'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
                        'aria-invalid:border-destructive',
                      )}
                    />
                    {own.length > 0 && (
                      <ul id={`${id}-problems`} className="grid gap-1 text-sm text-destructive">
                        {own.map((problem, index) => (
                          <li key={index}>{problem.line ? t('hosts.form.entry', { entry: problem.line, message: problem.message }) : problem.message}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })}
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={form.allowIpHosts} onChange={(event) => setForm({ ...form, allowIpHosts: event.target.checked })} />
                {t('hosts.form.allowIp')}
              </label>
              {notice && (
                <Alert variant={notice.kind === 'saved' ? 'default' : 'destructive'}>
                  <AlertDescription>{notice.text}</AlertDescription>
                </Alert>
              )}
            </CardContent>
            <CardFooter className="flex flex-wrap gap-3">
              <Button onClick={() => void save()} disabled={saving}>
                {saving ? t('hosts.form.saving') : t('hosts.form.save')}
              </Button>
              <Button
                variant="outline"
                disabled={saving}
                onClick={() => setForm(formOf({ hosts: load.view.defaults.hosts, bootstrap: load.view.defaults.bootstrap, allowIpHosts: false }))}
              >
                {t('hosts.form.defaults')}
              </Button>
            </CardFooter>
          </Card>
        </>
      )}
    </div>
  );
}
