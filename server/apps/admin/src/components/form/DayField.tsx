import { useEffect, useId, useRef, useState } from 'react';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/i18n/useI18n';
import { fullDay, gregorianPanel, todayDay } from '@/lib/format';
import { formatJalaliDay, parseJalaliDay } from '@/lib/jalali';

/**
 * A day in the panel's calendar, kept as the Gregorian ISO day
 * (`YYYY-MM-DD`) the API and the panel's filters use.
 *
 * In a Gregorian language (English, Turkish) it is the browser's date
 * picker. In Persian it is a text field for the Solar Hijri day, typed as
 * year/month/day in Persian or Latin digits («۱۴۰۵/۰۹/۰۶»), because the
 * browser's picker is Gregorian only, in the browser's own language; the
 * day it reads shows below it in full, weekday included, and a typing that
 * is not a day says how to write one. Such a typing, or a day out of range,
 * is the field's custom validity too, so a form that validates refuses to
 * submit it, as it does a browser date field: text that is not a day never
 * reads as no day at all.
 */
export interface DayFieldProps {
  id: string;
  /** `YYYY-MM-DD`, or '' for none. */
  value: string;
  onChange: (value: string) => void;
  /** Earliest and latest days (`YYYY-MM-DD`). */
  min?: string | undefined;
  max?: string | undefined;
  'aria-invalid'?: boolean;
  'aria-describedby'?: string | undefined;
  disabled?: boolean;
}

export function DayField(props: DayFieldProps) {
  const { locale } = useI18n();
  // Remounted on a switch between the calendars, so each starts from the value.
  return gregorianPanel(locale) ? <GregorianDay key="gregorian" {...props} /> : <SolarDay key="solar" {...props} />;
}

function GregorianDay({ id, value, onChange, min, max, disabled, ...aria }: DayFieldProps) {
  return <Input {...aria} id={id} type="date" dir="ltr" value={value} min={min || undefined} max={max || undefined} disabled={disabled} onChange={(event) => onChange(event.target.value)} />;
}

function SolarDay({ id, value, onChange, min, max, disabled, ...aria }: DayFieldProps) {
  const { t, locale } = useI18n();
  const noteId = useId();
  // The text as typed, and the day it was read as (to follow a value set from outside: a preset, a clear).
  const [typed, setTyped] = useState(() => ({ text: formatJalaliDay(value), value }));
  const [left, setLeft] = useState(false);
  if (typed.value !== value) setTyped({ text: formatJalaliDay(value), value });

  const day = typed.text.trim() === '' ? '' : parseJalaliDay(typed.text);
  const example = formatJalaliDay(todayDay());
  let problem: string | null = null;
  if (day === null) problem = t('form.day.invalid', { example });
  else if (day !== '' && min && day < min) problem = t('form.day.beforeMin', { day: formatJalaliDay(min) });
  else if (day !== '' && max && day > max) problem = t('form.day.afterMax', { day: formatJalaliDay(max) });
  let note: { text: string; problem: boolean } | null = null;
  // Half-typed text is said to be wrong only once the field is left (or a submit found it).
  if (problem !== null) note = day === null && !left ? null : { text: problem, problem: true };
  else if (day !== null && day !== '') note = { text: fullDay(day, locale), problem: false };

  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.setCustomValidity(problem ?? ''), [problem]);

  function change(text: string) {
    const read = text.trim() === '' ? '' : parseJalaliDay(text);
    const next = read ?? '';
    setTyped({ text, value: next });
    if (next !== value) onChange(next);
  }

  const describedBy = [aria['aria-describedby'], note ? noteId : undefined].filter(Boolean).join(' ') || undefined;
  return (
    <div className="grid gap-1">
      <Input
        ref={input}
        id={id}
        dir="ltr"
        inputMode="numeric"
        autoComplete="off"
        className="text-end"
        placeholder={example}
        value={typed.text}
        disabled={disabled}
        aria-invalid={Boolean(aria['aria-invalid']) || Boolean(note?.problem)}
        aria-describedby={describedBy}
        onChange={(event) => change(event.target.value)}
        onBlur={() => setLeft(true)}
        onInvalid={() => setLeft(true)}
      />
      {note && (
        <p id={noteId} className={note.problem ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>
          {note.text}
        </p>
      )}
    </div>
  );
}
