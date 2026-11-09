import type { ReactNode } from 'react';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

/**
 * A labelled form control with its hint and its problem. The control gets
 * `id`, `aria-invalid` and `aria-describedby` from the render prop, so a
 * screen reader reads the hint and the problem with it.
 */
export function Field({
  id,
  label,
  hint,
  error,
  className,
  optional,
  children,
}: {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: string | undefined;
  className?: string;
  /** Shown next to the label ("optional"). */
  optional?: string;
  children: (control: { id: string; 'aria-invalid': boolean; 'aria-describedby': string | undefined }) => ReactNode;
}) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={cn('grid content-start gap-2', className)}>
      <Label htmlFor={id}>
        {label}
        {optional && <span className="text-xs font-normal text-muted-foreground">{optional}</span>}
      </Label>
      {children({ id, 'aria-invalid': Boolean(error), 'aria-describedby': describedBy })}
      {error && (
        <p id={errorId} className="text-sm text-destructive">
          {error}
        </p>
      )}
      {hint && !error && (
        <p id={hintId} className="text-xs leading-relaxed text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  );
}
