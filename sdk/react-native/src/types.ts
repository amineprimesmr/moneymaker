/** Store a purchase or entitlement comes from. */
export type Store = 'app_store' | 'play_store' | 'stripe' | 'promotional' | (string & {});

/** Mirrors `Entitlement` (iOS Models.swift / Android Models.kt). Dates are Unix epoch milliseconds. */
export interface Entitlement {
  id: string;
  active: boolean;
  productId: string;
  store: Store;
  expiresAt: number | null;
  willRenew: boolean;
  isTrial: boolean;
  billingIssue: boolean;
  purchasedAt: number | null;
}

/** Mirrors `PurchaseRecord` (iOS). Dates are Unix epoch milliseconds. */
export interface PurchaseRecord {
  id: string;
  store: Store;
  productId: string;
  type: string;
  status: string;
  active: boolean;
  purchasedAt: number | null;
  expiresAt: number | null;
  willRenew: boolean;
  isTrial: boolean;
  isSandbox: boolean;
  billingIssue: boolean;
}

/** Mirrors `CustomerInfo`. Same shape on iOS and Android (Android forwards the raw server JSON). */
export interface CustomerInfo {
  appUserId: string;
  /** Deterministic UUID passed to StoreKit as `appAccountToken`. */
  accountToken: string;
  entitlements: Record<string, Entitlement>;
  activeEntitlements: string[];
  purchases: PurchaseRecord[];
  attributes: Record<string, string>;
  /** When the server produced this snapshot (epoch ms). */
  requestedAt: number;
}

/** Store product resolved on device (StoreKit `Product` / Play `ProductDetails`). */
export interface StoreProduct {
  identifier: string;
  title: string;
  description: string;
  /** Price in the store currency, e.g. 9.99. */
  price: number;
  /** Localized, formatted price, e.g. "9,99 €". */
  priceString: string;
  currencyCode: string;
  type: 'subscription' | 'non_consumable' | 'consumable' | 'non_renewing' | 'unknown';
  /** ISO 8601 billing period ("P1W", "P1M", "P1Y") for subscriptions, otherwise null. */
  subscriptionPeriod: string | null;
  hasFreeTrial: boolean;
}

/** Mirrors `Package`. */
export interface Package {
  id: string;
  /** Offering this package belongs to (used to resolve the native object on purchase). */
  offeringId: string;
  /** Product id per store: `{ app_store, play_store, stripe }`. */
  productIds: Partial<Record<Store, string>>;
  metadata: Record<string, string>;
  /** Null when the product could not be loaded from the store on this device. */
  product: StoreProduct | null;
  /** Same as `product?.priceString ?? ''` (iOS `localizedPrice`, Android `formattedPrice`). */
  localizedPrice: string;
  hasFreeTrial: boolean;
}

/** Mirrors `Offering`. */
export interface Offering {
  id: string;
  description: string | null;
  packages: Package[];
}

/** Mirrors `Offerings`. */
export interface Offerings {
  current: Offering | null;
  all: Record<string, Offering>;
}

/** Mirrors `PurchaseResult` (`.success(info) | .userCancelled | .pending`). */
export type PurchaseResult =
  | { status: 'success'; customerInfo: CustomerInfo }
  | { status: 'userCancelled' }
  | { status: 'pending' };

export interface ConfigureOptions {
  /** Public SDK key (`mm_pub_…`). */
  apiKey: string;
  /** Your own user id. Omit to start anonymous (`$anon:…`), then call `logIn` later. */
  appUserId?: string;
  /** Defaults to https://usemoneymaker.com/v1 */
  baseUrl?: string;
}

export interface PurchaseOptions {
  /** Android only: subscription offer token (defaults to the first offer of the product). */
  offerToken?: string;
}

/**
 * Error codes thrown by the SDK (`error.code`):
 * `not_configured`, `product_not_found`, `unverified_transaction`, `network`,
 * `no_activity`, `billing_<n>` (Play Billing response code), or the server error code
 * (e.g. `invalid_api_key`) for HTTP errors.
 */
export type MoneyMakerErrorCode =
  | 'not_configured'
  | 'product_not_found'
  | 'unverified_transaction'
  | 'network'
  | 'no_activity'
  | (string & {});

export type CustomerInfoListener = (info: CustomerInfo) => void;
