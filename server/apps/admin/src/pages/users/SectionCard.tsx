import type { ReactNode } from 'react';

/** A titled block of a person's page, with its actions beside the title. */
export function SectionCard({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="grid gap-4 rounded-xl border bg-card p-4 text-card-foreground shadow-xs sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold">{title}</h2>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}
