import type { ComponentProps } from 'react';
import { Input } from '@/components/ui/input';
import { normalizeCode } from '@/lib/signIn';
import { cn } from '@/lib/utils';

/**
 * The 6-digit code of an authenticator app: one field (the platform fills it
 * from the keyboard's suggestion or a password manager), digits only, Persian
 * digits read as ASCII, left to right in every language.
 */
export function CodeInput({
  value,
  onValueChange,
  className,
  ...props
}: Omit<ComponentProps<'input'>, 'onChange' | 'value'> & { value: string; onValueChange: (code: string) => void }) {
  return (
    <Input
      dir="ltr"
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern="[0-9]{6}"
      spellCheck={false}
      value={value}
      onChange={(event) => onValueChange(normalizeCode(event.target.value))}
      className={cn('h-12 text-center font-mono text-2xl tracking-[0.5em] md:text-2xl', className)}
      {...props}
    />
  );
}
