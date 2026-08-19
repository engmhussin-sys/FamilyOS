import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design_system/design_system.dart';
import '../../../core/localization/locale_controller.dart';
import '../domain/screen_time_policy.dart';

/// ONE ROW WIDGET FOR ONE GRANT, and the only one.
///
/// There were two, on two tabs of the same app, drawing the same
/// `screen_time_reward_grant` row: `_GrantCard` in `child_rewards_screen.dart`
/// and `_GrantRow` in `screen_time_overview_screen.dart`. They disagreed about
/// how to decide whether a grant was live, they each held their own copy of the
/// same 16-character timestamp cut — the second one's comment said outright
/// that it was copying the first — and their two «{{count}} دقيقة إضافية» keys
/// held identical Arabic under different names. A parent could read one grant
/// twice and be told two things about it.
///
/// It exists BECAUSE an achievement was verified, it expires on its own, and it
/// never edited the base policy — which is why the caption says «تنتهي» and not
/// «تم تعديل الحد».
///
/// THE STANDING IS HANDED IN, NEVER COMPUTED HERE. See [GrantStanding]: this
/// widget has no clock and no opinion about expiry.
///
/// [revokeLabel] arrives RESOLVED rather than as a key, for the reason
/// `ChildPicker` gives: `scripts/verify_l10n_parity.py` verifies LITERAL
/// `t('…')` call sites, so a key that only ever appeared as a constructor
/// argument would stop being checked. The row's own words — the minutes, the
/// expiry and the three standings — are this file's, and are looked up here.
class ScreenTimeGrantRow extends ConsumerWidget {
  const ScreenTimeGrantRow({
    super.key,
    required this.grant,
    required this.standing,
    this.busy = false,
    this.onRevoke,
    this.revokeLabel,
  });

  final ScreenTimeGrant grant;
  final GrantStanding standing;

  /// A revoke already in flight for THIS grant. The control stays visible and
  /// goes inert, so the row does not change shape under the finger.
  final bool busy;

  /// Absent on a screen that only reports (the screen-time overview). Present
  /// on the one that can act (the child's rewards page).
  final VoidCallback? onRevoke;

  /// Required in practice whenever [onRevoke] is given; a button with no words
  /// is not offered.
  final String? revokeLabel;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    ref.watch(localeControllerProvider);
    final t = ref.watch(localeControllerProvider.notifier).t;
    final active = standing == GrantStanding.active;
    final label = revokeLabel;

    return DsCard(
      accent: active ? DsColor.stateSuccess : DsColor.stateMuted,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  t('screenTime.bonusMinutes', options: {'count': grant.minutes}),
                  style: DsText.cardTitle(context),
                ),
              ),
              // NO BADGE when the standing is unknown: the read that decides it
              // failed, and «فعّالة» or «منتهية» would both be a claim the
              // screen cannot back.
              if (standing != GrantStanding.unknown)
                DsBadge(
                  label: standing == GrantStanding.revoked
                      ? t('screenTime.grantRevoked')
                      : active
                          ? t('screenTime.grantActive')
                          : t('screenTime.grantExpired'),
                  color: active ? DsColor.stateSuccess : DsColor.stateMuted,
                  icon: active ? Icons.star_rounded : null,
                ),
            ],
          ),
          if (grant.expiresAt != null) ...[
            DsSpace.gapXs,
            Text(
              t('screenTime.grantExpiresAt',
                  options: {'date': shortStamp(grant.expiresAt!)}),
              style: DsText.caption(context),
            ),
          ],
          // Offered while the grant is live AND while its standing is unknown:
          // withdrawing is the parent's decision, and a failed read must not
          // take the control away.
          if (onRevoke != null &&
              label != null &&
              standing != GrantStanding.revoked &&
              standing != GrantStanding.ended) ...[
            DsSpace.gapMd,
            DsSecondaryButton(
              label: label,
              icon: Icons.remove_circle_outline_rounded,
              danger: true,
              onPressed: busy ? null : onRevoke,
            ),
          ],
        ],
      ),
    );
  }
}

/// `yyyy-MM-dd HH:mm` in the phone's own timezone. ONE function: both screens
/// used to carry their own copy of this cut, so a change to one silently made
/// the same grant read differently on the other. Not localised on purpose — a
/// timestamp is a number, and this app ships no date formatter.
String shortStamp(DateTime value) => value.toLocal().toString().substring(0, 16);
