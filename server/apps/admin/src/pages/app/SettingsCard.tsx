import type { AdminRef } from '@app/shared';
import { Lock, Save, TriangleAlert } from 'lucide-react';
import type { FormEvent, ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import type { Wording } from '@/i18n/translate';
import { useI18n } from '@/i18n/useI18n';
import { Worded } from '@/i18n/Worded';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * One card of a settings page: its own small form (Save and Discard in the
 * footer, off until something changed), who changed it last, and the
 * refusal of its last save (read aloud). A card the admin may not change
 * says so in its title and has no buttons.
 */
export function SettingsCard({
  title,
  titleId,
  badges,
  writable,
  dirty,
  saving,
  notice,
  changed,
  onSubmit,
  onDiscard,
  className,
  children,
}: {
  title: string;
  titleId?: string;
  badges?: ReactNode;
  writable: boolean;
  dirty: boolean;
  saving: boolean;
  notice: Wording | null;
  changed: { updatedAt: string | null; updatedBy: AdminRef | null } | null;
  onSubmit: () => void;
  onDiscard: () => void;
  className?: string;
  children: ReactNode;
}) {
  const { t, locale } = useI18n();
  const when = changed?.updatedAt ? formatDateTime(changed.updatedAt, locale) : null;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (writable && dirty && !saving) onSubmit();
  }

  return (
    <Card className={cn('gap-5', className)}>
      <form onSubmit={submit} noValidate className="contents">
        <CardHeader className="flex flex-wrap items-center gap-2">
          <CardTitle id={titleId} className="text-base">
            {title}
          </CardTitle>
          {badges}
          {!writable && (
            <Badge variant="muted">
              <Lock aria-hidden="true" />
              {t('settings.readOnlyBadge')}
            </Badge>
          )}
        </CardHeader>
        <CardContent>
          <fieldset disabled={!writable || saving} className="grid min-w-0 gap-5">
            {children}
          </fieldset>
        </CardContent>
        <CardFooter className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t pt-4">
          <div className="min-w-0 flex-1 text-xs text-muted-foreground" aria-live="polite">
            {notice ? (
              <span className="flex items-start gap-2 text-sm text-destructive">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <Worded text={notice} />
              </span>
            ) : (
              when &&
              (changed?.updatedBy ? (
                <Worded
                  text={(t) =>
                    t('settings.changedBy', {
                      time: when,
                      name: changed.updatedBy?.displayName ?? '',
                    })
                  }
                />
              ) : (
                t('settings.changedAt', { time: when })
              ))
            )}
          </div>
          {writable && (
            <div className="ms-auto flex gap-2">
              <Button type="button" variant="ghost" size="sm" disabled={!dirty || saving} onClick={onDiscard}>
                {t('form.discard')}
              </Button>
              <Button type="submit" size="sm" disabled={!dirty || saving}>
                <Save aria-hidden="true" />
                {saving ? t('common.saving') : t('settings.save')}
              </Button>
            </div>
          )}
        </CardFooter>
      </form>
    </Card>
  );
}
