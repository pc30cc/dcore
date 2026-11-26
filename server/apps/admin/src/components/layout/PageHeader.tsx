import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

/** A page's title, what it is for, a line of facts under the title (`meta`, before the actions on a phone), and its main actions. */
export function PageHeader({
  icon: Icon,
  title,
  description,
  meta,
  actions,
  eyebrow,
}: {
  icon?: LucideIcon;
  title: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  eyebrow?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="grid min-w-0 gap-1.5">
        {eyebrow && <div className="text-sm text-muted-foreground">{eyebrow}</div>}
        <h1 className="flex items-center gap-3 text-2xl font-semibold tracking-tight">
          {Icon && <Icon className="size-6 shrink-0 text-primary" aria-hidden="true" />}
          <span className="min-w-0 truncate">{title}</span>
        </h1>
        {description && <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">{description}</p>}
        {meta && <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">{meta}</div>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
