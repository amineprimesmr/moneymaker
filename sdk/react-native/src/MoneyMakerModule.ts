import { NativeModule, requireNativeModule } from 'expo-modules-core';
import type { CustomerInfo, Offerings, PurchaseResult } from './types';

type Events = {
  onCustomerInfoUpdated(info: CustomerInfo): void;
};

declare class MoneyMakerNativeModule extends NativeModule<Events> {
  readonly defaultBaseUrl: string;
  configure(apiKey: string, appUserId: string | null, baseUrl: string | null): void;
  isConfigured(): boolean;
  getAppUserId(): string;
  isAnonymous(): boolean;
  logIn(appUserId: string): Promise<CustomerInfo>;
  logOut(): Promise<void>;
  isEntitled(entitlement: string): boolean;
  getCachedCustomerInfo(): CustomerInfo | null;
  getCustomerInfo(): Promise<CustomerInfo>;
  refreshCustomerInfo(): Promise<CustomerInfo>;
  setAttributes(attributes: Record<string, string | null>): Promise<void>;
  getOfferings(): Promise<Offerings>;
  purchasePackage(offeringId: string, packageId: string, offerToken: string | null): Promise<PurchaseResult>;
  purchaseProduct(productId: string, offerToken: string | null): Promise<PurchaseResult>;
  restorePurchases(): Promise<CustomerInfo>;
  syncPurchases(): Promise<void>;
  showManageSubscriptions(): Promise<void>;
}

export default requireNativeModule<MoneyMakerNativeModule>('MoneyMaker');
