import type { AppStore, WalletItem } from '@app/shared';
import type { MessageKey } from '@/i18n/messages';
import type { BillingPeriod } from '@/lib/products';

export const storeText: Readonly<Record<AppStore, MessageKey>> = { play: 'store.play', bazaar: 'store.bazaar' };

export const periodText: Readonly<Record<BillingPeriod, MessageKey>> = {
  P1W: 'period.P1W',
  P1M: 'period.P1M',
  P3M: 'period.P3M',
  P6M: 'period.P6M',
  P12M: 'period.P12M',
};

export const itemText: Readonly<Record<WalletItem, MessageKey>> = {
  superlike: 'item.superlike',
  boost: 'item.boost',
  spotlight: 'item.spotlight',
  dm: 'item.dm',
};
