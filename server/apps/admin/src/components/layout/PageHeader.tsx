import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

/** A page's title, what it is for, and its main actions. */
export function PageHeader({ icon: Icon, title, description, actions, eyebrow }: { icon?: LucideIcon; title: ReactNode; description?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode }) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="grid min-w-0 gap-1.5">
        {eyebrow && <div className="text-sm text-muted-foreground">{eyebrow}</div>}
        <h1 className="flex items-center gap-3 text-2xl font-semibold tracking-tight">
          {Icon && <Icon className="size-6 shrink-0 text-primary" aria-hidden="true" />}
          <span className="min-w-0 truncate">{title}</span>
        </h1>
        {description && <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
