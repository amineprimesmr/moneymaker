import { Platform } from 'expo-modules-core';
import Native from './MoneyMakerModule';
import type {
  ConfigureOptions,
  CustomerInfo,
  CustomerInfoListener,
  Offerings,
  Package,
  PurchaseOptions,
  PurchaseResult,
} from './types';

export * from './types';

export interface Subscription {
  remove(): void;
}

/**
 * MoneyMaker — subscriptions for App Store, Google Play and Stripe on your own backend.
 *
 * ```ts
 * MoneyMaker.configure({ apiKey: 'mm_pub_…', appUserId: user.id });
 * const offerings = await MoneyMaker.getOfferings();
 * const result = await MoneyMaker.purchasePackage(offerings.current!.packages[0]);
 * if (MoneyMaker.isEntitled('premium')) { … }
 * ```
 */
const MoneyMaker = {
  /** Default backend URL. */
  get defaultBaseUrl(): string {
    return Native.defaultBaseUrl;
  },

  /** Configures the shared instance. Call once, as early as possible. Later calls are ignored. */
  configure(options: ConfigureOptions): void {
    if (!options?.apiKey) throw new Error('MoneyMaker.configure: apiKey is required');
    Native.configure(options.apiKey, options.appUserId ?? null, options.baseUrl ?? null);
  },

  isConfigured(): boolean {
    return Native.isConfigured();
  },

  /** Current app user id (`$anon:…` when anonymous). */
  getAppUserId(): string {
    return Native.getAppUserId();
  },

  isAnonymous(): boolean {
    return Native.isAnonymous();
  },

  /** Identifies the user. Purchases made while anonymous are moved to this id. */
  logIn(appUserId: string): Promise<CustomerInfo> {
    return Native.logIn(appUserId);
  },

  /** Switches back to a fresh anonymous id. */
  logOut(): Promise<void> {
    return Native.logOut();
  },

  /** Returns cached info if fresher than 5 minutes, otherwise fetches it. */
  getCustomerInfo(): Promise<CustomerInfo> {
    return Native.getCustomerInfo();
  },

  /** Always fetches from the server. */
  refreshCustomerInfo(): Promise<CustomerInfo> {
    return Native.refreshCustomerInfo();
  },

  /** Last known customer info, synchronously (cached on disk, works offline). */
  getCachedCustomerInfo(): CustomerInfo | null {
    return Native.getCachedCustomerInfo();
  },

  /** Synchronous, cached check. Works offline with the last known state. */
  isEntitled(entitlement: string): boolean {
    return Native.isEntitled(entitlement);
  },

  /** Called on every entitlement change (purchase, renewal, refund, login…). */
  addCustomerInfoListener(listener: CustomerInfoListener): Subscription {
    return Native.addListener('onCustomerInfoUpdated', listener);
  },

  /** Sets custom attributes on the customer. `null` deletes a key. */
  setAttributes(attributes: Record<string, string | null>): Promise<void> {
    return Native.setAttributes(attributes);
  },

  /** Loads the paywall configured in the dashboard, with real store prices. */
  getOfferings(): Promise<Offerings> {
    return Native.getOfferings();
  },

  purchasePackage(pkg: Package, options: PurchaseOptions = {}): Promise<PurchaseResult> {
    return Native.purchasePackage(pkg.offeringId, pkg.id, options.offerToken ?? null);
  },

  /**
   * Buys a store product by id. On Android the product must belong to an offering
   * (Play product details are resolved through `getOfferings`).
   */
  purchaseProduct(productId: string, options: PurchaseOptions = {}): Promise<PurchaseResult> {
    return Native.purchaseProduct(productId, options.offerToken ?? null);
  },

  /** Re-syncs every purchase owned by the Apple ID / Google account ("Restore purchases" button). */
  restorePurchases(): Promise<CustomerInfo> {
    return Native.restorePurchases();
  },

  /**
   * iOS: silently posts current StoreKit entitlements (no password prompt), useful to migrate
   * existing subscribers. Android: re-posts owned Play purchases (also silent).
   */
  syncPurchases(): Promise<void> {
    return Native.syncPurchases();
  },

  /** iOS: system subscription management sheet. Android: Play Store subscriptions page. */
  showManageSubscriptions(): Promise<void> {
    return Native.showManageSubscriptions();
  },

  /** Convenience: active product ids (to hide already-owned items on a paywall). */
  activeProductIds(info: CustomerInfo): string[] {
    return Array.from(new Set(info.purchases.filter((p) => p.active).map((p) => p.productId)));
  },

  platform: Platform.OS,
};

/** Pure helper mirroring `CustomerInfo.isEntitled(_:)`. */
export function isEntitled(info: CustomerInfo | null | undefined, entitlement: string, now = Date.now()): boolean {
  const e = info?.entitlements?.[entitlement];
  if (!e || !e.active) return false;
  return e.expiresAt == null || e.expiresAt > now;
}

export { MoneyMaker };
export default MoneyMaker;
export { useCustomerInfo, useEntitlement } from './hooks';
