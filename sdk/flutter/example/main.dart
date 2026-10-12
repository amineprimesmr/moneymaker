import 'package:flutter/material.dart';
import 'package:moneymaker_flutter/moneymaker_flutter.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await MoneyMaker.configure('mm_pub_xxxxxxxx'); // anonymous until logIn
  runApp(const MaterialApp(home: Paywall()));
}

class Paywall extends StatefulWidget {
  const Paywall({super.key});
  @override
  State<Paywall> createState() => _PaywallState();
}

class _PaywallState extends State<Paywall> {
  Offering? _offering;

  @override
  void initState() {
    super.initState();
    MoneyMaker.getOfferings().then((o) => setState(() => _offering = o.current));
  }

  Future<void> _buy(Package p) async {
    try {
      switch (await MoneyMaker.purchasePackage(p)) {
        case PurchaseSuccess(:final customerInfo):
          if (customerInfo.isEntitled('premium') && mounted) Navigator.of(context).maybePop();
        case PurchaseUserCancelled():
          break;
        case PurchasePending():
          break; // customerInfoStream will emit once approved
      }
    } on MoneyMakerException catch (e) {
      debugPrint('Purchase failed: $e');
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Premium')),
        body: StreamBuilder<CustomerInfo>(
          stream: MoneyMaker.customerInfoStream,
          builder: (context, snap) {
            if (snap.data?.isEntitled('premium') ?? false) {
              return const Center(child: Text('You are premium'));
            }
            return ListView(children: [
              for (final p in _offering?.packages ?? const <Package>[])
                ListTile(
                  title: Text(p.product?.title ?? p.id),
                  subtitle: Text(p.hasFreeTrial ? 'Free trial' : p.localizedPrice),
                  onTap: () => _buy(p),
                ),
              TextButton(onPressed: MoneyMaker.restorePurchases, child: const Text('Restore purchases')),
            ]);
          },
        ),
      );
}
