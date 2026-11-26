import { Check } from 'lucide-react';
import { useEffect, useId, useRef } from 'react';
import { useI18n } from '@/i18n/useI18n';
import { formatNumber } from '@/lib/format';
import { cn } from '@/lib/utils';

export interface ReasonOption {
  value: string;
  label: string;
}

/** Controls whose own Enter (or typing) the shortcut leaves alone. */
const CONTROLS =
  'button, a[href], input, select, textarea, [contenteditable=""], [contenteditable="true"], [role="button"], [role="link"], [role="menuitem"], [role="checkbox"], [role="switch"], [role="tab"], [role="option"]';

/**
 * A radio list of reasons. While it is shown, the keys 1-9 choose the first
 * nine and move the focus to the one chosen (by the key's position, so any
 * keyboard layout works; the caps show the panel's digits). Enter confirms only from a reason or from no
 * control in particular: on a button, a link, a checkbox or a field it does
 * what that control does. Typing in a text field is left alone.
 */
export function ReasonPicker({
  label,
  options,
  value,
  onChange,
  onConfirm,
}: {
  label: string;
  options: readonly ReasonOption[];
  value: string;
  onChange: (value: string) => void;
  onConfirm?: (() => void) | undefined;
}) {
  const { locale } = useI18n();
  const name = useId();
  const group = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented) return;
      const target = event.target instanceof Element ? event.target : null;
      const inGroup = target !== null && group.current?.contains(target) === true;
      const control = inGroup ? null : (target?.closest(CONTROLS) ?? null);
      const typing = control !== null && (control.matches('textarea, select, [contenteditable]') || (control instanceof HTMLInputElement && control.type !== 'radio' && control.type !== 'checkbox'));
      if (typing) return;
      const digit = /^Digit([1-9])$/.exec(event.code);
      if (digit) {
        const index = Number(digit[1]) - 1;
        const option = options[index];
        if (option) {
          event.preventDefault();
          onChange(option.value);
          group.current?.querySelectorAll<HTMLInputElement>('input[type="radio"]')[index]?.focus();
        }
        return;
      }
      if (event.code === 'Enter' && !event.repeat && value && onConfirm && control === null) {
        event.preventDefault();
        onConfirm();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [options, value, onChange, onConfirm]);

  return (
    <fieldset className="grid gap-2">
      <legend className="mb-2 text-sm font-medium">{label}</legend>
      <div ref={group} role="radiogroup" aria-label={label} className="grid gap-1.5 sm:grid-cols-2">
        {options.map((option, index) => {
          const chosen = value === option.value;
          return (
            <label
              key={option.value}
              className={cn(
                'flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors',
                'has-focus-visible:ring-[3px] has-focus-visible:ring-ring/50',
                chosen ? 'border-primary bg-primary/10 font-medium text-foreground' : 'hover:bg-muted/60',
              )}
            >
              <input type="radio" name={name} value={option.value} checked={chosen} onChange={() => onChange(option.value)} className="sr-only" />
              {index < 9 && <kbd className={cn('rounded border px-1 text-xs font-normal', chosen ? 'border-primary bg-primary text-primary-foreground' : 'text-muted-foreground')}>{formatNumber(index + 1, locale)}</kbd>}
              <span className="min-w-0 flex-1">{option.label}</span>
              {chosen && <Check className="size-4 shrink-0 text-primary" aria-hidden="true" />}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
