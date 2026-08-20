import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design_system/design_system.dart';
import '../../../core/di/providers.dart';
import '../../../core/errors/api_failure.dart';
import '../../../core/localization/locale_controller.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/routing/app_routes.dart';
import '../application/subscription_purchase_coordinator.dart';

/// CLOSES A REAL GAP flagged in the full-project audit: the backend's
/// SubscriptionStatus (TRIALING/ACTIVE/PAST_DUE/CANCELED/EXPIRED) was
/// fully modeled since Sprint 8, but zero screen anywhere in this app
/// ever showed a subscription's status or let a parent act on it.
/// This screen is the first to do so, deliberately handling all five
/// states explicitly rather than a generic "subscribed / not
/// subscribed" binary.
class SubscriptionScreen extends ConsumerStatefulWidget {
  const SubscriptionScreen({super.key});

  @override
  ConsumerState<SubscriptionScreen> createState() => _SubscriptionScreenState();
}

class _SubscriptionScreenState extends ConsumerState<SubscriptionScreen> {
  List<dynamic>? _plans;
  Map<String, dynamic>? _subscriptionInfo;
  bool _isSubmitting = false;

  /// The B3 envelope for a genuinely failed CALL — rendered as the server's own
  /// Arabic sentence with its requestId, not as `e.toString()`. Distinct from
  /// [_purchaseFailure], which is a STORE outcome and never reached the server.
  ApiFailure? _failure;

  /// The REASON, not a message and not a key. A parent reading
  /// "PurchaseFailure(channelUnconfigured)" learns nothing; the localised
  /// sentence tells them whether to wait, to contact support, or to update the
  /// app. [_failure] is still used for genuinely unexpected failures.
  ///
  /// Holding the enum rather than a key string is deliberate: the four `t('...')`
  /// calls in `_purchaseMessage` are then LITERALS, which is what
  /// `scripts/verify_l10n_parity.py` can actually check. A key assembled at
  /// runtime is invisible to it, so a typo would ship as an untranslated string
  /// on the one screen that handles money.
  PurchaseFailureReason? _purchaseFailure;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _failure = null);
    try {
      final api = ref.read(billingApiProvider);
      final results = await Future.wait([api.getPlans(), api.getSubscription()]);
      if (mounted) {
        setState(() {
          _plans = results[0] as List<dynamic>;
          _subscriptionInfo = results[1] as Map<String, dynamic>;
        });
      }
    } catch (e) {
      if (mounted) setState(() => _failure = ApiFailure.from(e));
    }
  }

  /// PHASE G — THE `MANUAL` LITERAL IS GONE.
  ///
  /// WHAT THIS USED TO DO: `billingApi.subscribe(planTier, 'MANUAL')`. `MANUAL`
  /// is the payment adapter that always succeeds, so this button granted the
  /// household any tier it named, for free, and the server had no way to tell
  /// the difference. The old comment described it as a placeholder until a
  /// market's gateway was chosen; the shape of the call was the problem, not the
  /// value in it.
  ///
  /// WHAT IT DOES NOW: asks `SubscriptionPurchaseCoordinator`, which asks the
  /// SERVER which channel sells this tier in this market and routes to the store
  /// path (token only, server verifies against Play) or the direct path (the
  /// server's own gateway for the market). This screen chooses nothing.
  ///
  /// AND WHEN NOTHING IS CONFIGURED IT SAYS SO. Every `PurchaseFailureReason`
  /// gets its own translated message, because "we do not know which market you
  /// are in", "no price is set for this plan yet" and "this build cannot talk to
  /// the store" are three different facts and a parent deserves to be told
  /// which. None of them silently grants anything.
  Future<void> _subscribe(String planTier) async {
    setState(() {
      _isSubmitting = true;
      _failure = null;
      _purchaseFailure = null;
    });
    try {
      await ref.read(subscriptionPurchaseCoordinatorProvider).purchase(planTier: planTier);
      await _load();
    } on PurchaseFailure catch (failure) {
      if (mounted) {
        setState(() => _purchaseFailure = failure.reason);
      }
    } catch (e) {
      if (mounted) setState(() => _failure = ApiFailure.from(e));
    } finally {
      if (mounted) setState(() => _isSubmitting = false);
    }
  }

  /// Every branch is a LITERAL key, so the l10n verifier can see all four.
  String _purchaseMessage(
    String Function(String, {int? count, Map<String, Object>? options}) t,
    PurchaseFailureReason reason,
  ) {
    switch (reason) {
      case PurchaseFailureReason.marketUnknown:
        return t('subscription.purchaseMarketUnknown');
      case PurchaseFailureReason.channelUnconfigured:
        return t('subscription.purchaseNotConfigured');
      case PurchaseFailureReason.storeUnavailable:
        return t('subscription.purchaseStoreUnavailable');
      case PurchaseFailureReason.failed:
        return t('subscription.purchaseFailed');
    }
  }

  /// THE TIER, AS A PARENT SHOULD READ IT — or not at all.
  ///
  /// `subscription.planTier` is a raw backend enum (`FREE` / `BASIC` /
  /// `PREMIUM` / `FAMILY` / `ENTERPRISE`). It used to be interpolated
  /// straight into `subscription.activeBody`, so an Arabic-locale parent on
  /// the paid plan read «أنت مشترك في خطة PREMIUM» — a Latin-letter database
  /// value in the middle of an Arabic sentence, on the screen that handles
  /// money.
  ///
  /// Guarded with `has` rather than translated unconditionally, because
  /// `translate` answers a missing key with the key itself: an unrecognised
  /// tier would otherwise read «خطة planTier.WHATEVER», which is the same bug
  /// wearing a prefix. Returns null when there is nothing safe to show, and
  /// the caller then picks a sentence that does not name a tier at all.
  String? _planLabel(LocaleController locale) {
    final subscription = _subscriptionInfo?['subscription'] as Map<String, dynamic>?;
    final tier = subscription?['planTier'] as String?;
    if (tier == null || tier.isEmpty) return null;
    return locale.has('planTier.$tier') ? locale.t('planTier.$tier') : null;
  }

  Future<void> _cancel() async {
    setState(() => _isSubmitting = true);
    try {
      await ref.read(billingApiProvider).cancel();
      await _load();
    } catch (e) {
      if (mounted) setState(() => _failure = ApiFailure.from(e));
    } finally {
      if (mounted) setState(() => _isSubmitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    ref.watch(localeControllerProvider);
    final locale = ref.watch(localeControllerProvider.notifier);
    final t = locale.t;

    return Scaffold(
      appBar: AppBar(title: Text(t('subscription.title'))),
      body: _failure != null
          ? Center(
              child: SingleChildScrollView(
                child: DsErrorState(
                  failure: _failure!,
                  title: t('common.error'),
                  retryLabel: t('common.retry'),
                  requestIdLabel: t('common.requestId'),
                  arabic: locale.isRtl,
                  onRetry: _load,
                ),
              ),
            )
          : (_plans == null || _subscriptionInfo == null)
              ? const DsSkeletonList(rows: 3)
              : RefreshIndicator(
                  onRefresh: _load,
                  child: ListView(
                    padding: const EdgeInsets.all(DsSpace.lg),
                    children: [
                      _StatusBanner(
                        info: _subscriptionInfo!,
                        t: t,
                        planLabel: _planLabel(locale),
                      ),
                      const SizedBox(height: DsSpace.lg),
                      // Shown INSTEAD of nothing happening. The previous code
                      // could not reach this state because it always succeeded.
                      if (_purchaseFailure != null) ...[
                        Container(
                          padding: const EdgeInsets.all(DsSpace.lg),
                          decoration: BoxDecoration(
                            color: AppTheme.amber500.withOpacity(0.10),
                            borderRadius: BorderRadius.circular(DsRadius.card),
                          ),
                          child: Row(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              const Icon(Icons.info_outline_rounded, color: AppTheme.amber500),
                              const SizedBox(width: DsSpace.md),
                              Expanded(child: Text(_purchaseMessage(t, _purchaseFailure!))),
                            ],
                          ),
                        ),
                        const SizedBox(height: DsSpace.lg),
                      ],
                      Text(t('subscription.availablePlans'), style: Theme.of(context).textTheme.titleLarge),
                      const SizedBox(height: DsSpace.md),
                      ..._plans!.map((p) => _PlanCard(
                            plan: p as Map<String, dynamic>,
                            currentTier: (_subscriptionInfo!['subscription'] as Map<String, dynamic>?)?['planTier'] as String?,
                            isSubmitting: _isSubmitting,
                            onSubscribe: () => _subscribe(p['tier'] as String),
                            t: t,
                          )),
                      const SizedBox(height: DsSpace.lg),
                      OutlinedButton.icon(
                        onPressed: () => Navigator.of(context).pushNamed(AppRoutes.billingHistory),
                        icon: const Icon(Icons.receipt_long_rounded),
                        label: Text(t('subscription.viewHistory')),
                      ),
                      const SizedBox(height: DsSpace.md),
                      OutlinedButton.icon(
                        onPressed: () => Navigator.of(context).pushNamed(AppRoutes.redeemCode),
                        icon: const Icon(Icons.confirmation_number_outlined),
                        label: Text(t('redeemCode.entryPoint')),
                      ),
                      const SizedBox(height: DsSpace.md),
                      if ((_subscriptionInfo!['subscription'] as Map<String, dynamic>?)?['status'] == 'ACTIVE')
                        OutlinedButton(
                          onPressed: _isSubmitting ? null : _cancel,
                          style: OutlinedButton.styleFrom(foregroundColor: AppTheme.brick500),
                          child: Text(t('subscription.cancel')),
                        ),
                    ],
                  ),
                ),
    );
  }
}

class _StatusBanner extends StatelessWidget {
  const _StatusBanner({required this.info, required this.t, this.planLabel});

  final Map<String, dynamic> info;
  final String Function(String, {int? count, Map<String, Object>? options}) t;

  /// The tier already resolved to a readable label, or null when this build
  /// has no label for what the server sent. Resolved by the caller because
  /// only it holds the `LocaleController` needed to ask `has`.
  final String? planLabel;

  @override
  Widget build(BuildContext context) {
    final subscription = info['subscription'] as Map<String, dynamic>?;
    final isInTrial = info['isInTrial'] as bool? ?? false;
    final trialDaysRemaining = info['trialDaysRemaining'] as int?;
    final status = subscription?['status'] as String?;

    // Explicit handling for every real status this app's own backend
    // can return — no fallback binary "subscribed/not" that would
    // silently misrepresent PAST_DUE as if it were healthy ACTIVE.
    //
    // THIS LIST WENT STALE AND THAT WAS THE BUG. It was written against the
    // five statuses that existed in Sprint 8; PHASE D added PENDING,
    // GRACE_PERIOD and REFUNDED, and all three fell into the final `else`
    // and rendered «ابدأ الآن — اختر خطة للبدء.». For GRACE_PERIOD that was
    // not merely vague but false: `entitlement.service.ts` counts it as
    // entitlement-bearing alongside TRIALING and ACTIVE, so a household with
    // full paid access was being told it had no subscription and invited to
    // buy one it already had.
    //
    // TRIALING as a STATUS is handled too. `isInTrial` above is computed
    // separately by `TrialManager`, so a row still marked TRIALING after the
    // trial window closed reached the `else` as well; it reads as inactive,
    // which is what it is.
    late final Color color;
    late final IconData icon;
    late final String title;
    late final String body;

    if (isInTrial) {
      color = AppTheme.amber500;
      icon = Icons.hourglass_top_rounded;
      title = t('subscription.trialTitle');
      body = t('subscription.trialBody', options: {'days': trialDaysRemaining ?? 0});
    } else if (status == 'ACTIVE') {
      color = AppTheme.sage500;
      icon = Icons.check_circle_rounded;
      title = t('subscription.activeTitle');
      // Names the tier only when there is a real label for it. Saying less is
      // correct; printing the enum is not.
      body = planLabel == null
          ? t('subscription.activeBodyNoPlan')
          : t('subscription.activeBody', options: {'plan': planLabel!});
    } else if (status == 'PAST_DUE') {
      color = AppTheme.brick500;
      icon = Icons.warning_rounded;
      title = t('subscription.pastDueTitle');
      body = t('subscription.pastDueBody');
    } else if (status == 'GRACE_PERIOD') {
      // Amber, not brick: the household still has everything it paid for.
      // The action is real but the tone is not an alarm.
      color = AppTheme.amber500;
      icon = Icons.shield_outlined;
      title = t('subscription.graceTitle');
      body = t('subscription.graceBody');
    } else if (status == 'PENDING') {
      // Fawry's unavoidable state: a payment reference exists and the money
      // has not arrived. Not entitlement-bearing, and not a failure either.
      color = AppTheme.amber500;
      icon = Icons.schedule_rounded;
      title = t('subscription.pendingTitle');
      body = t('subscription.pendingBody');
    } else if (status == 'REFUNDED') {
      // Terminal and distinct from CANCELED: the money went back, so access
      // ended immediately rather than at the end of the period.
      color = AppTheme.guardian950;
      icon = Icons.receipt_long_rounded;
      title = t('subscription.refundedTitle');
      body = t('subscription.refundedBody');
    } else if (status == 'CANCELED' || status == 'EXPIRED' || status == 'TRIALING') {
      color = AppTheme.guardian950;
      icon = Icons.info_outline_rounded;
      title = t('subscription.inactiveTitle');
      body = t('subscription.inactiveBody');
    } else {
      color = AppTheme.guardian950;
      icon = Icons.info_outline_rounded;
      title = t('subscription.noneTitle');
      body = t('subscription.noneBody');
    }

    return Container(
      padding: const EdgeInsets.all(DsSpace.lg),
      decoration: BoxDecoration(color: color.withOpacity(0.10), borderRadius: BorderRadius.circular(DsRadius.card)),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, color: color, size: 28),
          const SizedBox(width: DsSpace.md),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: Theme.of(context).textTheme.titleMedium?.copyWith(color: color)),
                const SizedBox(height: DsSpace.xs),
                Text(body, style: Theme.of(context).textTheme.bodyMedium),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _PlanCard extends StatelessWidget {
  const _PlanCard({
    required this.plan,
    required this.currentTier,
    required this.isSubmitting,
    required this.onSubscribe,
    required this.t,
  });

  final Map<String, dynamic> plan;
  final String? currentTier;
  final bool isSubmitting;
  final VoidCallback onSubscribe;
  final String Function(String, {int? count, Map<String, Object>? options}) t;

  @override
  Widget build(BuildContext context) {
    final tier = plan['tier'] as String;
    final isCurrent = tier == currentTier;
    final priceCents = plan['priceCents'] as int;
    final currency = plan['currency'] as String;
    final features = (plan['features'] as List<dynamic>?) ?? [];

    return Card(
      margin: const EdgeInsets.only(bottom: DsSpace.md),
      child: Padding(
        padding: const EdgeInsets.all(DsSpace.lg),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(child: Text(plan['name'] as String, style: Theme.of(context).textTheme.titleMedium)),
                Text(
                  priceCents == 0 ? t('subscription.free') : '${(priceCents / 100).toStringAsFixed(2)} $currency',
                  style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700),
                ),
              ],
            ),
            if (features.isNotEmpty) ...[
              const SizedBox(height: DsSpace.sm),
              ...features.map((f) => Padding(
                    padding: const EdgeInsets.only(top: DsSpace.xs),
                    child: Row(
                      children: [
                        const Icon(Icons.check_rounded, size: 16, color: AppTheme.sage500),
                        const SizedBox(width: DsSpace.xs),
                        Expanded(child: Text('$f', style: Theme.of(context).textTheme.bodyMedium)),
                      ],
                    ),
                  )),
            ],
            const SizedBox(height: DsSpace.md),
            if (isCurrent)
              Container(
                width: double.infinity,
                padding: const EdgeInsets.symmetric(vertical: DsSpace.sm),
                decoration: BoxDecoration(color: AppTheme.sage500.withOpacity(0.14), borderRadius: BorderRadius.circular(DsRadius.control)),
                child: Text(t('subscription.currentPlan'), textAlign: TextAlign.center, style: const TextStyle(color: AppTheme.sage500, fontWeight: FontWeight.w600)),
              )
            else
              FilledButton(
                onPressed: isSubmitting ? null : onSubscribe,
                child: Text(t('subscription.choosePlan')),
              ),
          ],
        ),
      ),
    );
  }
}
