import 'dart:async';

import 'package:flutter/services.dart';

import 'models.dart';

/// Entry point. All methods are static; call [configure] once at startup.
///
/// ```dart
/// await MoneyMaker.configure('mm_pub_…', appUserId: user.id);
/// if (await MoneyMaker.isEntitled('premium')) { … }
/// ```
abstract final class MoneyMaker {
  static const MethodChannel _channel = MethodChannel('io.moneymaker/methods');
  static const EventChannel _events = EventChannel('io.moneymaker/customer_info');

  static const String defaultBaseUrl = 'https://moneymaker-io.web.app/v1';

  static Stream<CustomerInfo>? _stream;

  /// Configures the shared instance. Calling it again is a no-op (same as native).
  static Future<void> configure(String apiKey, {String? appUserId, String? baseUrl}) =>
      _invoke<void>('configure', {
        'apiKey': apiKey,
        'appUserId': appUserId,
        'baseUrl': baseUrl ?? defaultBaseUrl,
      });

  static Future<bool> get isConfigured async => await _invoke<bool>('isConfigured') ?? false;

  /// Current app user id (`$anon:…` until [logIn]).
  static Future<String> get appUserId async => await _invoke<String>('appUserId') ?? '';

  static Future<bool> get isAnonymous async => (await appUserId).startsWith(r'$anon:');

  /// Identifies the user. Purchases made while anonymous are moved to this id.
  static Future<CustomerInfo> logIn(String appUserId) =>
      _customerInfo('logIn', {'appUserId': appUserId});

  /// Switches back to a fresh anonymous id.
  static Future<void> logOut() => _invoke<void>('logOut');

  /// Cached customer info when available, otherwise fetched from the backend.
  static Future<CustomerInfo> getCustomerInfo() => _customerInfo('getCustomerInfo');

  /// Always fetches from the backend.
  static Future<CustomerInfo> refreshCustomerInfo() => _customerInfo('refreshCustomerInfo');

  /// Uses the cached customer info (works offline). False if none is cached yet.
  static Future<bool> isEntitled(String entitlement) async =>
      await _invoke<bool>('isEntitled', {'entitlement': entitlement}) ?? false;

  /// Emits whenever entitlements change (purchase, renewal, refund, login…).
  /// The latest cached value is emitted first on subscription, if any.
  static Stream<CustomerInfo> get customerInfoStream => _stream ??= _events
      .receiveBroadcastStream()
      .map((e) => CustomerInfo.fromMap(Map<String, Object?>.from(e as Map)))
      .asBroadcastStream();

  /// Sets customer attributes. A `null` value deletes the attribute.
  static Future<void> setAttributes(Map<String, String?> attributes) =>
      _invoke<void>('setAttributes', {'attributes': attributes});

  /// Offerings configured in the dashboard, with store products resolved on device.
  static Future<Offerings> getOfferings() async =>
      Offerings.fromMap(await _map('getOfferings'));

  /// Purchases a package from [getOfferings].
  /// [offerToken]: Android only, picks a specific Play subscription offer.
  static Future<PurchaseResult> purchasePackage(Package package, {String? offerToken}) async =>
      PurchaseResult.fromMap(await _map('purchasePackage', {
        'packageId': package.id,
        'productIds': package.productIds,
        'offerToken': offerToken,
      }));

  /// Purchases a store product by id (App Store / Play product id).
  /// On Android the product must belong to an offering.
  static Future<PurchaseResult> purchaseProduct(String productId, {String? offerToken}) async =>
      PurchaseResult.fromMap(
          await _map('purchaseProduct', {'productId': productId, 'offerToken': offerToken}));

  /// Re-syncs every purchase the store account owns ("Restore purchases" button).
  static Future<CustomerInfo> restorePurchases() => _customerInfo('restorePurchases');

  /// iOS: silently posts current App Store entitlements (no prompt). No-op on Android,
  /// where the native SDK already syncs existing purchases at configure time.
  static Future<void> syncPurchases() => _invoke<void>('syncPurchases');

  /// Opens the system subscription management UI (App Store sheet / Play subscriptions page).
  static Future<void> showManageSubscriptions() => _invoke<void>('showManageSubscriptions');

  // ── Internals ─────────────────────────────────────────────────────────

  static Future<CustomerInfo> _customerInfo(String method, [Map<String, Object?>? args]) async =>
      CustomerInfo.fromMap(await _map(method, args));

  static Future<Map<String, Object?>> _map(String method, [Map<String, Object?>? args]) async {
    final r = await _invoke<Map<Object?, Object?>>(method, args);
    if (r == null) throw MoneyMakerException('invalid_response', '$method returned nothing');
    return r.map((k, v) => MapEntry(k.toString(), v));
  }

  static Future<T?> _invoke<T>(String method, [Map<String, Object?>? args]) async {
    try {
      return await _channel.invokeMethod<T>(method, args);
    } on PlatformException catch (e) {
      final d = e.details;
      throw MoneyMakerException(e.code, e.message ?? e.code,
          status: d is Map && d['status'] is int ? d['status'] as int : null);
    }
  }
}
