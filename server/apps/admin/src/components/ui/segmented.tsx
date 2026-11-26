import { useRef, type KeyboardEvent } from 'react';
import { useI18n } from '@/i18n/useI18n';
import { cn } from '@/lib/utils';

/**
 * A choice of a few words as a segmented control: one radio group, one tab
 * stop (the chosen option), the arrow keys move the choice (left and right
 * follow the page's direction), Home and End go to the first and the last.
 */
export function Segmented<V extends string>({
  label,
  value,
  options,
  text,
  onChange,
  className,
}: {
  label: string;
  value: V;
  options: readonly V[];
  text: (option: V) => string;
  onChange: (value: V) => void;
  className?: string;
}) {
  const { dir } = useI18n();
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const current = Math.max(0, options.indexOf(value));

  function choose(index: number) {
    const option = options[index];
    if (option === undefined) return;
    onChange(option);
    buttons.current[index]?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const last = options.length - 1;
    const forward = dir === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
    const back = dir === 'rtl' ? 'ArrowRight' : 'ArrowLeft';
    let next: number | null = null;
    if (event.key === forward || event.key === 'ArrowDown') next = current === last ? 0 : current + 1;
    else if (event.key === back || event.key === 'ArrowUp') next = current === 0 ? last : current - 1;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = last;
    if (next === null) return;
    event.preventDefault();
    choose(next);
  }

  return (
    <div role="radiogroup" aria-label={label} className={cn('grid auto-cols-fr grid-flow-col gap-1 rounded-lg bg-muted p-1', className)}>
      {options.map((option, index) => (
        <button
          key={option}
          ref={(element) => {
            buttons.current[index] = element;
          }}
          type="button"
          role="radio"
          aria-checked={value === option}
          tabIndex={index === current ? 0 : -1}
          onClick={() => onChange(option)}
          onKeyDown={onKeyDown}
          className={cn(
            'rounded-md px-2 py-1.5 text-sm font-medium text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
            value === option && 'bg-background text-foreground shadow-sm',
          )}
        >
          {text(option)}
        </button>
      ))}
    </div>
  );
}
