import type { UiTemplate } from '@app/shared';
import type { SwatchColors } from '@/lib/appearance';
import { cn } from '@/lib/utils';

/**
 * A template drawn in CSS with its own colours (`templateSwatches`): a
 * screen with a profile card, a tag in the accent and the main button. The
 * colours are the app's, not the panel's, so the preview looks the same in
 * the panel's light and dark themes.
 */
export function TemplateSwatch({ id, colors: c, label, className }: { id: UiTemplate; colors: SwatchColors; label: string; className?: string }) {
  return (
    <div
      role="img"
      aria-label={label}
      data-template={id}
      className={cn('relative grid h-36 overflow-hidden rounded-lg ring-1 ring-black/10 dark:ring-white/15', className)}
      style={{ background: c.canvas }}
    >
      <div aria-hidden="true" className="grid content-between gap-3 p-4">
        <div className="flex items-center gap-2">
          <span className="h-2 w-16 rounded-full" style={{ background: c.text }} />
          <span className="ms-auto size-2.5 rounded-full" style={{ background: c.accent }} />
        </div>
        <div className="flex items-center gap-3 rounded-md p-2.5" style={{ background: c.surface, boxShadow: `inset 0 0 0 1px ${c.line}` }}>
          <span className="size-8 shrink-0 rounded-full" style={{ background: c.muted }} />
          <span className="grid flex-1 gap-1.5">
            <span className="h-1.5 w-3/5 rounded-full" style={{ background: c.text }} />
            <span className="h-1.5 w-2/5 rounded-full" style={{ background: c.muted }} />
          </span>
          <span className="h-4 w-9 shrink-0 rounded-full" style={{ background: c.accent }} />
        </div>
        <div className="flex h-8 items-center justify-center rounded-full" style={{ background: c.button }}>
          <span className="h-1.5 w-14 rounded-full" style={{ background: c.onButton }} />
        </div>
      </div>
    </div>
  );
}

/** The same template as a small chip, for lists. */
export function TemplateChip({ id, colors: c }: { id: UiTemplate; colors: SwatchColors }) {
  return (
    <span
      aria-hidden="true"
      data-template={id}
      className="flex h-9 w-12 shrink-0 items-end justify-center overflow-hidden rounded-md p-1.5 ring-1 ring-black/10 dark:ring-white/15"
      style={{ background: c.canvas }}
    >
      <span className="h-2 w-full rounded-full" style={{ background: c.button }} />
    </span>
  );
}
