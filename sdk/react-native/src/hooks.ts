import { useEffect, useState } from 'react';
import MoneyMaker, { isEntitled } from './index';
import type { CustomerInfo } from './types';

/** Live customer info: starts from the cache, then updates on every change. */
export function useCustomerInfo(): CustomerInfo | null {
  const [info, setInfo] = useState<CustomerInfo | null>(() =>
    MoneyMaker.isConfigured() ? MoneyMaker.getCachedCustomerInfo() : null,
  );
  useEffect(() => {
    const sub = MoneyMaker.addCustomerInfoListener(setInfo);
    if (MoneyMaker.isConfigured()) MoneyMaker.getCustomerInfo().then(setInfo).catch(() => {});
    return () => sub.remove();
  }, []);
  return info;
}

/** `true` while the user has the entitlement. */
export function useEntitlement(entitlement: string): boolean {
  return isEntitled(useCustomerInfo(), entitlement);
}
