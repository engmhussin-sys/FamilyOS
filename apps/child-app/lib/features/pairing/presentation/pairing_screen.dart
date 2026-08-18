import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/di/providers.dart';
import '../../../core/errors/api_failure.dart';
import '../../../core/localization/locale_controller.dart';
import '../../../core/theme/kid_theme.dart';
import '../../../core/widgets/sparky_mascot.dart';

/// DESIGN PASS (Sprint 7 — onboarding review): this was the ONE
/// screen in the entire Child App still on Flutter's bare default
/// styling — the theme's colors/fonts apply globally, but the actual
/// layout, tone, and icon work here never got the same design pass
/// MyGrowthScreen and RewardsScreen already received. Found by
/// tracing the full onboarding flow for logical gaps; this is a
/// visual-consistency gap of the same kind, on the very first screen
/// this app ever shows.
///
/// ERROR PASS: `on ApiException catch (e) { _errorMessage = e.message }` is
/// gone. It put the transport's own English — «The request returned an
/// invalid status code of 502» — in a coral box next to Sparky, on the first
/// screen this app ever shows, in front of a child who reads Arabic.
///
/// THE SENTENCE ON THIS SCREEN IS THE CLIENT'S, AND THAT IS DELIBERATE.
/// Everywhere else in this app the server's Arabic is carried through
/// verbatim because those sentences ARE the product (CONTEXT §3 principle 7).
/// `/pairing/accept` is the one endpoint with nothing to carry: a wrong or
/// expired code is a bare `UnauthorizedException`, so B3's per-status
/// fallback answers «انتهت جلستك. سجّل الدخول مرة أخرى للمتابعة.» — correct
/// for an expired session, and meaningless to a seven-year-old who has never
/// logged in and has no session. `ApiFailure.withClientSentence` swaps in a
/// reviewed line and keeps the server's own text on `diagnostic`, which no
/// widget reads.
///
/// WHICH LINE IS CHOSEN IS A FACT ABOUT THE FAILURE, NEVER A GUESS.
/// «الكود ده مش شغّال» is a statement about what the child typed and may only
/// be shown when the SERVER refused the code (`isServerRefusal`, minus the
/// throttle — a child retyping a code read aloud to them will hit
/// `/pairing/accept`'s limit with a perfectly good one). Everything else —
/// no connection, a timeout, a 502, a `PlatformException` from one OEM's
/// Keystore — gets a line that opens «مش منك», which says out loud that this
/// is not the child's fault. Neither line contains "wrong", "failed", or
/// blames the reader.
class PairingScreen extends ConsumerStatefulWidget {
  const PairingScreen({super.key, required this.onPaired});

  final VoidCallback onPaired;

  @override
  ConsumerState<PairingScreen> createState() => _PairingScreenState();
}

class _PairingScreenState extends ConsumerState<PairingScreen> {
  final _codeController = TextEditingController();
  bool _isSubmitting = false;

  /// The B3 envelope, not `e.message`. Its `diagnostic` still holds the
  /// original transport text; nothing on this screen reads that field.
  ApiFailure? _failure;

  @override
  void dispose() {
    _codeController.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    setState(() {
      _isSubmitting = true;
      _failure = null;
    });

    try {
      await ref
          .read(childPairingRepositoryProvider)
          .registerWithCode(_codeController.text.trim());
      widget.onPaired();
    } catch (error) {
      // The repository throws `ApiFailure`, and `ApiFailure.from` is
      // idempotent on one, so this also covers anything thrown above it.
      if (mounted) setState(() => _failure = ApiFailure.from(error));
    } finally {
      if (mounted) setState(() => _isSubmitting = false);
    }
  }

  /// TRUE only when the SERVER looked at this code and said no — the one
  /// case in which a sentence about what the child typed is a fact rather
  /// than a guess.
  ///
  /// The throttle is excluded: `/pairing/accept` is rate limited, and a
  /// child carefully retyping a code someone read out to them is exactly who
  /// trips it. Telling them the code is wrong at that moment would send them
  /// back to a grown-up for a replacement they do not need.
  bool _codeWasRefused(ApiFailure failure) =>
      failure.isServerRefusal && !failure.isRateLimited;

  /// WHY THIS IS NOT `KidErrorState`, WHICH THE REST OF THE APP USES.
  ///
  /// `KidErrorState` opens with a `SparkyMascot`, and this screen already has
  /// one — the compact variant would put a second Sparky directly under the
  /// first and add roughly 320 logical pixels to a Column that is centred,
  /// unscrollable, and already uses about 360 of the ~550 a small phone
  /// gives it. That is both a visual redesign of the app's first screen and
  /// a RenderFlex overflow on any short device.
  ///
  /// So the box keeps the exact shape it has always had, and the correctness
  /// fix is entirely in WHAT goes in it: [ApiFailure.displayFor] of a failure
  /// this screen worded itself, rather than `e.message`. Everything the
  /// shared widget would have given — the conversion, the classification, the
  /// preserved `diagnostic` — comes from [ApiFailure], which is the part that
  /// matters here.
  ///
  /// Each key is resolved by its own call with the key written out, rather
  /// than by passing a conditional expression to the lookup —
  /// `scripts/verify_l10n_parity.py` only recognises the written-out form,
  /// and a key it cannot see is a key that can go missing from one locale
  /// without anything failing.
  Widget _errorCard(
    ApiFailure failure,
    String Function(String, {int? count, Map<String, Object>? options}) t,
    bool isRtl,
  ) {
    final sentence = _codeWasRefused(failure)
        ? t('pairing.codeNotAccepted')
        : t('pairing.cannotReach');
    // Through `ApiFailure` rather than straight to a `Text`, so the sentence
    // on screen and the sentence in a log come from one object — and so the
    // server's own text stays reachable on `diagnostic` and nowhere else.
    final worded = failure.withClientSentence(sentence);

    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: KidTheme.coral.withOpacity(0.12),
        borderRadius: BorderRadius.circular(14),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Text('\u{1F914}', style: TextStyle(fontSize: 18)),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              worded.displayFor(arabic: isRtl),
              style: const TextStyle(color: KidTheme.coral),
            ),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    ref.watch(localeControllerProvider); // registers rebuild dependency — see LocaleController's own docstring
    final localeController = ref.watch(localeControllerProvider.notifier);
    final t = localeController.t;

    return Directionality(
      textDirection: localeController.isRtl ? TextDirection.rtl : TextDirection.ltr,
      child: Scaffold(
        body: SafeArea(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                const Center(child: SparkyMascot(mood: SparkyMood.happy, size: 88)),
                const SizedBox(height: 20),
                Text(
                  t('pairing.title'),
                  style: Theme.of(context).textTheme.displaySmall,
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: 8),
                Text(
                  t('pairing.instruction'),
                  style: Theme.of(context).textTheme.bodyLarge,
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: 28),
                TextField(
                  controller: _codeController,
                  textAlign: TextAlign.center,
                  textCapitalization: TextCapitalization.characters,
                  enabled: !_isSubmitting,
                  style: Theme.of(context).textTheme.headlineMedium?.copyWith(letterSpacing: 4),
                  decoration: InputDecoration(
                    labelText: t('pairing.codeLabel'),
                    hintText: t('pairing.codeHint'),
                    filled: true,
                    fillColor: Colors.white,
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(16),
                      borderSide: BorderSide(color: KidTheme.skyBlue.withOpacity(0.3)),
                    ),
                    focusedBorder: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(16),
                      borderSide: const BorderSide(color: KidTheme.skyBlue, width: 2),
                    ),
                  ),
                ),
                if (_failure != null) ...[
                  const SizedBox(height: 16),
                  _errorCard(_failure!, t, localeController.isRtl),
                ],
                const SizedBox(height: 24),
                FilledButton(
                  onPressed: _isSubmitting ? null : _submit,
                  child: _isSubmitting
                      ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                      : Text(t('pairing.submit')),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
