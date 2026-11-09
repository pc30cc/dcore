import type { AdminMe } from '@app/shared';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useI18n } from '@/i18n/useI18n';
import { asApiError } from '@/lib/http';
import { clearPendingSignIn, type PendingSignIn } from '@/lib/signIn';
import { signInProblem } from './authErrors';

/**
 * The code step of both sign-in paths (a code, or the first code of a new
 * authenticator): sends the code once it has 6 digits, opens the panel when
 * it is right, and goes back to the password step when the ticket is over
 * (expired, used, or the account locked).
 */
export function useCodeStep(ticket: PendingSignIn, submitCode: (mfaToken: string, code: string) => Promise<AdminMe>) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function submit(value = code) {
    if (busy) return;
    if (value.length !== 6) {
      setProblem(t('login.error.codeLength'));
      return;
    }
    if (ticket.expiresAtMs <= Date.now()) {
      clearPendingSignIn();
      await navigate('/login', { replace: true, state: { notice: 'ticket', from: ticket.returnTo } });
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      await submitCode(ticket.mfaToken, value);
      clearPendingSignIn();
      await navigate(ticket.returnTo, { replace: true });
    } catch (error) {
      const failure = asApiError(error);
      if (failure.code === 'unauthorized' || failure.code === 'otp_locked') {
        // The ticket is over (expired, used, or the account locked): back to the password step, which says why.
        clearPendingSignIn();
        await navigate('/login', { replace: true, state: { notice: failure.code === 'otp_locked' ? 'locked' : 'ticket', from: ticket.returnTo } });
        return;
      }
      const found = signInProblem(failure, 'code');
      setProblem(t(found.key, found.values));
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  function change(value: string) {
    setCode(value);
    if (problem) setProblem(null);
    if (value.length === 6 && code.length !== 6) void submit(value);
  }

  return { code, change, submit, busy, problem };
}
