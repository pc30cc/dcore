import * as AlertDialogPrimitive from '@radix-ui/react-alert-dialog';
import type { ReactNode } from 'react';
import { useI18n } from '@/i18n/useI18n';
import { cn } from '@/lib/utils';
import { buttonVariants } from './button';

/**
 * A question before an action that is hard to take back (archive, disable,
 * reset). The action button names the action; Escape and the cancel button
 * leave everything as it was.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  onConfirm,
  destructive = false,
  busy = false,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  destructive?: boolean;
  busy?: boolean;
  children?: ReactNode;
}) {
  const { t, dir } = useI18n();
  return (
    <AlertDialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialogPrimitive.Portal>
        <AlertDialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <AlertDialogPrimitive.Content
          dir={dir}
          className={cn(
            'fixed top-1/2 left-1/2 z-50 grid w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl border bg-background p-6 shadow-lg',
            'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
          )}
        >
          <div className="flex flex-col gap-2 text-start">
            <AlertDialogPrimitive.Title className="text-lg font-semibold">{title}</AlertDialogPrimitive.Title>
            <AlertDialogPrimitive.Description asChild>
              <div className="grid gap-2 text-sm text-muted-foreground">{description}</div>
            </AlertDialogPrimitive.Description>
          </div>
          {children}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <AlertDialogPrimitive.Cancel className={buttonVariants({ variant: 'outline' })} disabled={busy}>
              {t('common.cancel')}
            </AlertDialogPrimitive.Cancel>
            <AlertDialogPrimitive.Action
              className={buttonVariants({ variant: destructive ? 'destructive' : 'default' })}
              disabled={busy}
              onClick={(event) => {
                // The caller closes the dialog when the action is done (it may fail and stay open).
                event.preventDefault();
                onConfirm();
              }}
            >
              {confirmLabel}
            </AlertDialogPrimitive.Action>
          </div>
        </AlertDialogPrimitive.Content>
      </AlertDialogPrimitive.Portal>
    </AlertDialogPrimitive.Root>
  );
}
