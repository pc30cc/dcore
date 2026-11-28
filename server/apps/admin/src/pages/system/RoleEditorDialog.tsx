import { isRestrictedPermission, type Permission } from '@app/shared';
import { Info, TriangleAlert } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import type { MessageKey } from '@/i18n/messages';
import { useI18n } from '@/i18n/useI18n';
import { useWording } from '@/i18n/useWording';
import { Worded } from '@/i18n/Worded';
import { permissionHint, permissionLabel, roleName } from '@/lib/admins';
import { asApiError } from '@/lib/http';
import { problemText } from '@/lib/problemText';
import { queryClient, queryKeys, type AdminRole } from '@/lib/queries';
import {
  ANALYST_ROLE,
  areaLabel,
  areaNote,
  areaSwitch,
  editorAreas,
  editorState,
  grantsChange,
  permissionBox,
  sameGrants,
  saveRolePermissions,
  storeRole,
  toGrants,
  withArea,
  withPermission,
  type BoxBlock,
  type EditorArea,
  type EditorState,
} from '@/lib/roles';
import { showToast } from '@/lib/toast';
import { cn } from '@/lib/utils';

const BLOCK_WORDS: Readonly<Record<Exclude<BoxBlock, 'area'>, MessageKey>> = {
  notHeld: 'roles.block.notHeld',
  ownerOnly: 'roles.block.ownerOnly',
  adminOnly: 'roles.block.adminOnly',
  dashboardsOnly: 'roles.block.dashboardsOnly',
};

/**
 * A role's permissions as boxes, area by area, each area with its "All of
 * this area" switch (`area.*`, which also covers what a later version adds
 * to it). A box the editor cannot change says why, once: beside its area
 * when the whole area is blocked for one reason, under the title for the
 * analyst (dashboards only), else under the box. Saving sends every grant
 * with the grants as read (`base`); a role changed meanwhile is read again
 * and shown with a notice. Taking anything away signs the role's admins out
 * (`holders`: how many; undefined while the count is not known). The title
 * and the footer stay in view while the areas scroll.
 */
export function RoleEditorDialog({ role, grants, holders, onClose }: { role: AdminRole; grants: readonly string[]; holders: number | undefined; onClose: () => void }) {
  const { t, locale } = useI18n();
  const [base, setBase] = useState<readonly string[]>(role.grants);
  const [state, setState] = useState<EditorState>(() => editorState(role.grants));
  const [notice, setNotice] = useWording();
  const [changed, setChanged] = useState(false);
  const [saving, setSaving] = useState(false);
  const name = roleName(role, role.key, locale, t);
  const next = toGrants(state);
  const dirty = !sameGrants(next, base);
  const diff = grantsChange(base, next);

  function update(nextState: EditorState) {
    setState(nextState);
    setNotice(null);
    setChanged(false);
  }

  async function reload() {
    await queryClient.invalidateQueries({ queryKey: queryKeys.roles });
    const fresh = queryClient.getQueryData<{ items: AdminRole[] }>(queryKeys.roles)?.items.find((item) => item.key === role.key);
    if (fresh) {
      setBase(fresh.grants);
      setState(editorState(fresh.grants));
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!dirty || saving) return;
    setSaving(true);
    setNotice(null);
    setChanged(false);
    try {
      const result = await saveRolePermissions(role.key, next, base);
      storeRole(result.role);
      const signedOut = result.signedOut.admins;
      // A failed side here is the holders' sign-out (their deny markers): said in red, before anything else.
      if (result.sideEffects === 'failed' && diff.removed.length > 0) showToast((t) => t('roles.saved.signOutLate'), 'error', 6_000);
      else if (result.sideEffects === 'failed') showToast((t) => t('common.sideEffectsLate'));
      else if (!result.announced) showToast((t) => t('roles.saved.late'));
      else if (signedOut > 0) showToast((t) => t('roles.saved.signedOut', { count: signedOut }));
      else showToast((t) => t('common.saved'));
      onClose();
    } catch (error) {
      const failure = asApiError(error);
      if (failure.code === 'conflict' && failure.reason === 'role_changed') {
        await reload();
        setChanged(true);
      } else setNotice((t, lang) => problemText(failure, t, lang));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent wide className="flex flex-col gap-4 overflow-hidden pb-0 sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t('roles.edit.title', { role: name })}</DialogTitle>
          {role.key === ANALYST_ROLE && (
            <p id={ANALYST_NOTE_ID} className="text-sm text-muted-foreground">
              {t('roles.block.dashboardsOnly')}
            </p>
          )}
        </DialogHeader>
        <form className="flex min-h-0 flex-1 flex-col" noValidate onSubmit={(event) => void save(event)}>
          <div className="-mx-6 min-h-0 flex-1 overflow-y-auto border-t px-6 py-4">
            <fieldset disabled={saving} className="grid min-w-0 gap-3">
              {editorAreas().map((area) => (
                <AreaBlock key={area.area} area={area} role={role.key} grants={grants} state={state} onChange={update} />
              ))}
            </fieldset>
          </div>
          <div className="-mx-6 grid gap-3 border-t bg-background px-6 py-4">
            <div aria-live="polite" className="grid gap-2 empty:hidden">
              {changed && (
                <p className="flex items-start gap-2 text-sm">
                  <Info className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
                  {t('roles.error.changed')}
                </p>
              )}
              {notice && (
                <p className="flex items-start gap-2 text-sm text-destructive">
                  <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                  <Worded text={notice} />
                </p>
              )}
              {dirty && diff.removed.length > 0 && holders !== 0 && (
                <p className="flex items-start gap-2 text-sm text-amber-700 dark:text-amber-300">
                  <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                  {holders === undefined ? t('roles.signOutAny') : t('roles.signOut', { count: holders })}
                </p>
              )}
            </div>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
              <span className="text-xs text-muted-foreground">{dirty ? t('roles.diff', { added: diff.added.length, removed: diff.removed.length }) : t('form.noChanges')}</span>
              <div className="flex flex-col-reverse gap-2 sm:flex-row">
                <Button type="button" variant="outline" disabled={saving} onClick={onClose}>
                  {t('common.cancel')}
                </Button>
                <Button type="submit" disabled={!dirty || saving}>
                  {saving ? t('common.saving') : t('form.save')}
                </Button>
              </div>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const NONE: ReadonlySet<BoxBlock> = new Set();
/** The analyst's note under the title (one editor is open at a time). */
const ANALYST_NOTE_ID = 'role-editor-dashboards-only';

function BlockNote({ block, hide = NONE }: { block: BoxBlock | null; hide?: ReadonlySet<BoxBlock> }) {
  const { t } = useI18n();
  if (!block || block === 'area' || hide.has(block)) return null;
  return <span className="text-xs text-muted-foreground">{t(BLOCK_WORDS[block])}</span>;
}

function AreaBlock({ area, role, grants, state, onChange }: { area: EditorArea; role: string; grants: readonly string[]; state: EditorState; onChange: (state: EditorState) => void }) {
  const { t } = useI18n();
  const id = useId();
  const areaName = areaLabel(area.area, t);
  const all = area.wildcard ? areaSwitch(state, role, grants, area.area) : null;
  // A general reason is said once, beside the area's name (the analyst's, dashboards only, under the title); the greyed boxes point to it.
  const analyst = role === ANALYST_ROLE;
  const reason = areaNote(state, role, grants, area);
  const note = reason === 'dashboardsOnly' && analyst ? null : reason;
  const hide = new Set<BoxBlock>(['notHeld', 'dashboardsOnly']);
  const noteId = note ? `${id}-note` : analyst ? ANALYST_NOTE_ID : undefined;
  return (
    <section aria-labelledby={`${id}-title`} className="grid gap-3 rounded-lg border p-3 sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <span className="flex flex-wrap items-baseline gap-x-2">
          <h3 id={`${id}-title`} className="text-sm font-semibold">
            {areaName}
          </h3>
          {note && (
            <span id={`${id}-note`} className="text-xs text-muted-foreground">
              {t(BLOCK_WORDS[note])}
            </span>
          )}
        </span>
        {all && (
          <span className="flex items-center gap-2">
            <BlockNote block={all.block} hide={hide} />
            <label htmlFor={`${id}-all`} className={cn('text-xs', all.disabled && 'text-muted-foreground')}>
              {t('roles.area.all')}
            </label>
            <Switch
              id={`${id}-all`}
              checked={all.checked}
              disabled={all.disabled}
              aria-describedby={[`${id}-title`, ...(all.block && hide.has(all.block) && noteId ? [noteId] : [])].join(' ')}
              onCheckedChange={(on) => onChange(withArea(state, area.area, on))}
            />
          </span>
        )}
      </div>
      <ul className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
        {area.permissions.map((permission) => (
          <PermissionBox key={permission} permission={permission} role={role} grants={grants} state={state} hide={hide} noteId={noteId} onChange={onChange} />
        ))}
      </ul>
    </section>
  );
}

function PermissionBox({
  permission,
  role,
  grants,
  state,
  hide,
  noteId,
  onChange,
}: {
  permission: Permission;
  role: string;
  grants: readonly string[];
  state: EditorState;
  hide: ReadonlySet<BoxBlock>;
  /** The area's (or the title's) note a box blocked for a general reason points to. */
  noteId: string | undefined;
  onChange: (state: EditorState) => void;
}) {
  const { t } = useI18n();
  const box = permissionBox(state, role, grants, permission);
  const note = box.block && box.block !== 'area' && !hide.has(box.block) ? box.block : null;
  return (
    <li>
      <label className={cn('flex items-start gap-2.5 text-sm', box.disabled ? 'cursor-default' : 'cursor-pointer')}>
        <input
          type="checkbox"
          className="mt-0.5 size-4 shrink-0 accent-primary disabled:opacity-60"
          checked={box.checked}
          disabled={box.disabled}
          aria-describedby={box.block && hide.has(box.block) ? noteId : undefined}
          onChange={(event) => onChange(withPermission(state, permission, event.target.checked))}
        />
        <span className="grid min-w-0 gap-0.5">
          <span title={permissionHint(permission, t) ?? undefined} className={cn(box.disabled && !box.checked && 'text-muted-foreground')}>
            {permissionLabel(permission, t)}
          </span>
          {(isRestrictedPermission(permission) || note) && (
            <span className="flex flex-wrap items-center gap-1.5">
              {isRestrictedPermission(permission) && (
                <Badge variant="outline" className="px-1.5 py-0 text-[0.65rem]">
                  {t('permission.restricted')}
                </Badge>
              )}
              <BlockNote block={note} />
            </span>
          )}
        </span>
      </label>
    </li>
  );
}
