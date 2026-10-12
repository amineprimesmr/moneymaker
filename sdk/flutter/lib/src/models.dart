// Typed mirrors of the native SDK models (sdk/ios/Sources/MoneyMaker/Models.swift,
// sdk/android/moneymaker/src/main/java/io/moneymaker/Models.kt).
// Dates travel over the channel as milliseconds since epoch (same as the API).

import 'package:flutter/foundation.dart';

DateTime? _date(Object? v) =>
    v is num ? DateTime.fromMillisecondsSinceEpoch(v.toInt(), isUtc: true) : null;

Map<String, String> _strMap(Object? v) => v is Map
    ? v.map((k, val) => MapEntry(k.toString(), val?.toString() ?? ''))
    : const {};

Map<String, Object?> _map(Object? v) =>
    v is Map ? v.map((k, val) => MapEntry(k.toString(), val)) : const {};

/// An entitlement granted to the customer (e.g. `premium`).
@immutable
class Entitlement {
  final String id;
  final bool active;
  final String productId;
  /// `app_store`, `play_store` or `stripe`.
  final String store;
  final DateTime? expiresAt;
  final bool willRenew;
  final bool isTrial;
  final bool billingIssue;
  /// Not exposed by the Android SDK (always null there).
  final DateTime? purchasedAt;

  const Entitlement({
    required this.id,
    required this.active,
    required this.productId,
    required this.store,
    this.expiresAt,
    required this.willRenew,
    required this.isTrial,
    required this.billingIssue,
    this.purchasedAt,
  });

  factory Entitlement.fromMap(Map<String, Object?> m) => Entitlement(
        id: m['id'] as String? ?? '',
        active: m['active'] == true,
        productId: m['productId'] as String? ?? '',
        store: m['store'] as String? ?? '',
        expiresAt: _date(m['expiresAt']),
        willRenew: m['willRenew'] == true,
        isTrial: m['isTrial'] == true,
        billingIssue: m['billingIssue'] == true,
        purchasedAt: _date(m['purchasedAt']),
      );

  @override
  String toString() => 'Entitlement($id, active: $active, product: $productId, expires: $expiresAt)';
}

/// A purchase known to the backend. Only populated on iOS (the Android SDK does not expose it).
@immutable
class PurchaseRecord {
  final String id;
  final String store;
  final String productId;
  final String type;
  final String status;
  final bool active;
  final DateTime? purchasedAt;
  final DateTime? expiresAt;
  final bool willRenew;
  final bool isTrial;
  final bool isSandbox;
  final bool billingIssue;

  const PurchaseRecord({
    required this.id,
    required this.store,
    required this.productId,
    required this.type,
    required this.status,
    required this.active,
    this.purchasedAt,
    this.expiresAt,
    required this.willRenew,
    required this.isTrial,
    required this.isSandbox,
    required this.billingIssue,
  });

  factory PurchaseRecord.fromMap(Map<String, Object?> m) => PurchaseRecord(
        id: m['id'] as String? ?? '',
        store: m['store'] as String? ?? '',
        productId: m['productId'] as String? ?? '',
        type: m['type'] as String? ?? '',
        status: m['status'] as String? ?? '',
        active: m['active'] == true,
        purchasedAt: _date(m['purchasedAt']),
        expiresAt: _date(m['expiresAt']),
        willRenew: m['willRenew'] == true,
        isTrial: m['isTrial'] == true,
        isSandbox: m['isSandbox'] == true,
        billingIssue: m['billingIssue'] == true,
      );
}

/// Customer state: entitlements, purchases and attributes.
@immutable
class CustomerInfo {
  final String appUserId;
  /// iOS only (deterministic StoreKit appAccountToken); null on Android.
  final String? accountToken;
  final Map<String, Entitlement> entitlements;
  final List<String> activeEntitlements;
  /// iOS only; empty on Android.
  final List<PurchaseRecord> purchases;
  final Map<String, String> attributes;
  /// iOS only; null on Android.
  final DateTime? requestedAt;

  const CustomerInfo({
    required this.appUserId,
    this.accountToken,
    required this.entitlements,
    required this.activeEntitlements,
    required this.purchases,
    required this.attributes,
    this.requestedAt,
  });

  factory CustomerInfo.fromMap(Map<String, Object?> m) {
    final ents = _map(m['entitlements']);
    return CustomerInfo(
      appUserId: m['appUserId'] as String? ?? '',
      accountToken: m['accountToken'] as String?,
      entitlements: ents.map((k, v) {
        final e = Map<String, Object?>.from(_map(v));
        e['id'] ??= k;
        return MapEntry(k, Entitlement.fromMap(e));
      }),
      activeEntitlements:
          (m['activeEntitlements'] as List?)?.map((e) => e.toString()).toList() ?? const [],
      purchases: (m['purchases'] as List?)
              ?.map((p) => PurchaseRecord.fromMap(_map(p)))
              .toList() ??
          const [],
      attributes: _strMap(m['attributes']),
      requestedAt: _date(m['requestedAt']),
    );
  }

  /// Same rule as the native SDKs: active and not expired.
  bool isEntitled(String id) {
    final e = entitlements[id];
    if (e == null || !e.active) return false;
    final exp = e.expiresAt;
    return exp == null || exp.isAfter(DateTime.now());
  }

  /// Products the user owns right now (iOS only; empty on Android).
  Set<String> get activeProductIds =>
      purchases.where((p) => p.active).map((p) => p.productId).toSet();

  @override
  String toString() => 'CustomerInfo($appUserId, active: $activeEntitlements)';
}

/// Store product details resolved on device (StoreKit `Product` / Play `ProductDetails`).
@immutable
class StoreProduct {
  final String identifier;
  final String title;
  final String description;
  /// Localized, formatted price (`displayPrice` / `formattedPrice`).
  final String priceString;
  /// Numeric price, when available.
  final double? price;
  final String? currencyCode;
  /// ISO 8601 period (`P1M`, `P1Y`, `P1W`…), null for one-time products.
  final String? subscriptionPeriod;

  const StoreProduct({
    required this.identifier,
    required this.title,
    required this.description,
    required this.priceString,
    this.price,
    this.currencyCode,
    this.subscriptionPeriod,
  });

  factory StoreProduct.fromMap(Map<String, Object?> m) => StoreProduct(
        identifier: m['identifier'] as String? ?? '',
        title: m['title'] as String? ?? '',
        description: m['description'] as String? ?? '',
        priceString: m['priceString'] as String? ?? '',
        price: (m['price'] as num?)?.toDouble(),
        currencyCode: m['currencyCode'] as String?,
        subscriptionPeriod: m['subscriptionPeriod'] as String?,
      );
}

/// A package inside an offering (e.g. `monthly`), mapping one product per store.
@immutable
class Package {
  final String id;
  /// Store → product id (`app_store`, `play_store`, `stripe`).
  final Map<String, String> productIds;
  final Map<String, String> metadata;
  /// Null when the product could not be loaded from the current store.
  final StoreProduct? product;
  final bool hasFreeTrial;

  const Package({
    required this.id,
    required this.productIds,
    required this.metadata,
    this.product,
    required this.hasFreeTrial,
  });

  /// Localized price, or an empty string if the product is unavailable.
  String get localizedPrice => product?.priceString ?? '';
  String? get period => product?.subscriptionPeriod;

  factory Package.fromMap(Map<String, Object?> m) => Package(
        id: m['id'] as String? ?? '',
        productIds: _strMap(m['productIds']),
        metadata: _strMap(m['metadata']),
        product: m['product'] is Map ? StoreProduct.fromMap(_map(m['product'])) : null,
        hasFreeTrial: m['hasFreeTrial'] == true,
      );
}

@immutable
class Offering {
  final String id;
  final String? description;
  final List<Package> packages;

  const Offering({required this.id, this.description, required this.packages});

  Package? package(String id) {
    for (final p in packages) {
      if (p.id == id) return p;
    }
    return null;
  }

  factory Offering.fromMap(Map<String, Object?> m) => Offering(
        id: m['id'] as String? ?? '',
        description: m['description'] as String?,
        packages: (m['packages'] as List?)?.map((p) => Package.fromMap(_map(p))).toList() ?? const [],
      );
}

@immutable
class Offerings {
  final Offering? current;
  final Map<String, Offering> all;

  const Offerings({this.current, required this.all});

  Offering? operator [](String id) => all[id];

  factory Offerings.fromMap(Map<String, Object?> m) {
    final all = _map(m['all']).map((k, v) => MapEntry(k, Offering.fromMap(_map(v))));
    final cur = m['current'] as String?;
    return Offerings(current: cur == null ? null : all[cur], all: all);
  }
}

/// Outcome of a purchase. Use a `switch` on the sealed type.
sealed class PurchaseResult {
  const PurchaseResult();

  factory PurchaseResult.fromMap(Map<String, Object?> m) => switch (m['result']) {
        'success' => PurchaseSuccess(CustomerInfo.fromMap(_map(m['customerInfo']))),
        'userCancelled' => const PurchaseUserCancelled(),
        _ => const PurchasePending(),
      };
}

final class PurchaseSuccess extends PurchaseResult {
  final CustomerInfo customerInfo;
  const PurchaseSuccess(this.customerInfo);
}

final class PurchaseUserCancelled extends PurchaseResult {
  const PurchaseUserCancelled();
}

/// Awaiting approval (Ask to Buy, deferred payment…). The stream emits when it completes.
final class PurchasePending extends PurchaseResult {
  const PurchasePending();
}

/// Error thrown by every MoneyMaker call.
///
/// [code]: `not_configured`, `product_not_found`, `unverified_transaction`,
/// `network`, `no_activity`, or a server error code (e.g. `invalid_api_key`).
class MoneyMakerException implements Exception {
  final String code;
  final String message;
  /// HTTP status for server errors (iOS), otherwise null.
  final int? status;

  const MoneyMakerException(this.code, this.message, {this.status});

  @override
  String toString() => 'MoneyMakerException($code${status != null ? ' $status' : ''}): $message';
}
