import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/di/providers.dart';
import '../../../core/errors/api_failure.dart';
import '../../../core/localization/locale_controller.dart';
import '../../../core/theme/app_theme.dart';

/// How far the pairing watch has got. Named states rather than a pile of
/// booleans, because "waiting" and "gave up" and "never started" used to be
/// indistinguishable on this screen — it showed a code and then nothing,
/// forever, whatever actually happened on the child's phone.
enum PairingWatchPhase {
  /// No code has been issued yet.
  idle,

  /// A code is out and `GET /pairing/devices` is being polled for it.
  waiting,

  /// A device for this child appeared (or went ACTIVE). Polling stopped.
  connected,

  /// The code's whole lifetime elapsed with no device. Polling stopped.
  /// NOT an error state: an expired invite is an ordinary thing.
  gaveUp,

  /// The device list could not be read when the code was issued, so there
  /// is no honest "before" to compare against and no confirmation can be
  /// claimed. The code itself is still valid.
  cannotConfirm,
}

/// HOW FAR THE PAIRED DEVICE ITSELF HAS GOT, read from
/// `GET /pairing/device/:deviceId/status` and never guessed here.
///
/// The four values are the only four answers that change what this screen
/// offers a parent. They are derived from `pairingState` and
/// `activationStatus`, both of which are raw backend enums that are read,
/// mapped, and then dropped — no value from either ever reaches a string a
/// parent sees.
enum DeviceReadiness {
  /// The status route has not answered yet, or answered with something this
  /// build does not recognise. The action is still offered: the server is
  /// the authority on whether it is legal, and it refuses in Arabic.
  unknown,

  /// The device is registered but has not finished verifying and uploading
  /// its capabilities, so `PARENT_CONFIRMED` is not a legal transition yet.
  preparing,

  /// `CAPABILITIES_UPLOADED` — the one state from which
  /// `POST /pairing/activate` succeeds. This is the moment the parent's
  /// confirmation is the only thing missing.
  awaitingParent,

  /// `Device.status = ACTIVE`, as reported by the server. Set from nothing
  /// else, ever.
  active,
}

/// WHAT THIS SCREEN DID WRONG, AND WHAT IT DOES NOW.
///
/// It called `POST /pairing/invite`, printed the code, ran a countdown and
/// stopped. The parent was never told whether the child's device actually
/// paired — the single question the screen exists to answer — and had no
/// way to undo a code typed into the wrong phone.
///
/// It now polls `GET /pairing/devices` (a real route on
/// `PairingController`, already consumed by the dashboard — no new
/// endpoint was invented) every [pollInterval] and compares the result
/// against the snapshot taken *before* the invite was issued, so a device
/// the child already owned cannot be mistaken for a fresh pairing. The
/// watch stops the moment it succeeds, and stops for good once the code's
/// own lifetime plus [pollGrace] has elapsed.
///
/// THE DEADLINE IS THE BACKEND'S, NOT A GUESS. `invitation.service.ts`
/// sets `INVITATION_TTL_SECONDS = 10 * 60` and returns it as
/// `expiresInSeconds` on the invite response; that value drives both the
/// countdown and the polling deadline. [pollGrace] is added on top so a
/// child who types the code in its last second still gets confirmed —
/// registration takes a few seconds after redemption.
///
/// THE STEP THAT USED TO BE MISSING ENTIRELY. Until this change nothing in
/// this app called `POST /pairing/activate`, so a device that had paired,
/// verified and uploaded its capabilities sat at `PENDING_PAIRING` forever
/// — a family finished pairing and had no working product. Once the watch
/// finds the device, this screen reads
/// `GET /pairing/device/:deviceId/status`, and the moment the server says
/// the device is waiting on its parent it offers exactly one action:
/// confirm and activate it.
///
/// WHAT THE SCREEN WILL NOT DO. It never says "active" off the back of its
/// own successful call — after activating (or being refused) it re-reads
/// the server's status and renders that. A 409 is shown with the server's
/// own Arabic sentence, because the same 409 means BOTH «already done» and
/// «blocked on device risk» (see `PairingApi.activateDevice` for why those
/// are indistinguishable on the wire today) and this client is not entitled
/// to guess which. And it never sends `overrideRiskWarning`.
class AddChildScreen extends ConsumerStatefulWidget {
  const AddChildScreen({super.key});

  /// Five seconds: fast enough that a parent watching both phones sees the
  /// confirmation land, slow enough that a ten-minute window costs at most
  /// ~120 requests on a route that is a single indexed query per family.
  static const Duration pollInterval = Duration(seconds: 5);

  /// Grace added to the invite's own expiry before giving up.
  static const Duration pollGrace = Duration(seconds: 60);

  @override
  ConsumerState<AddChildScreen> createState() => _AddChildScreenState();
}

class _AddChildScreenState extends ConsumerState<AddChildScreen> {
  List<dynamic>? _children;
  String? _selectedChildId;
  String? _code;
  int _secondsLeft = 0;
  int _totalSeconds = 1;
  Timer? _timer;
  bool _isGenerating = false;
  String? _errorMessage;

  // --- the pairing watch -------------------------------------------------
  Timer? _pollTimer;
  PairingWatchPhase _phase = PairingWatchPhase.idle;

  /// deviceId -> status, for the selected child only, as it stood the
  /// instant before the invite was issued. `null` means the snapshot could
  /// not be taken.
  Map<String, String>? _baseline;

  /// How long the watch may run in total, and how much of it has been
  /// spent. Counted in TICKS of [AddChildScreen.pollInterval] rather than
  /// against `DateTime.now()` on purpose: the wall clock and the timer are
  /// two different clocks, and only the timer's is deterministic (it is
  /// also the only one a widget test can advance).
  Duration? _watchLimit;
  Duration _watchElapsed = Duration.zero;

  String? _pairedDeviceId;
  bool _pairedDeviceIsActive = false;
  bool _isRevoking = false;
  bool _wasRevoked = false;

  // --- the activation step ------------------------------------------------

  /// The server's own answer about the paired device, never inferred.
  DeviceReadiness _readiness = DeviceReadiness.unknown;

  bool _isActivating = false;
  bool _isCheckingReadiness = false;

  /// The server's sentence about the last activation attempt — its
  /// `messageAr`, rendered verbatim. Kept apart from [_errorMessage]
  /// because a 409 here frequently means «this was already done», which is
  /// not a failure and must not be painted like one.
  String? _activationNotice;

  @override
  void initState() {
    super.initState();
    _loadChildren();
  }

  Future<void> _loadChildren() async {
    final children = await ref.read(dashboardApiProvider).getChildren();
    if (!mounted) return;
    setState(() {
      _children = children;
      _selectedChildId = children.isNotEmpty ? children.first['id'] as String : null;
    });
  }

  /// The devices already on file for [childId], keyed by id.
  ///
  /// Reuses `DashboardApi.getDevices()` rather than adding a second caller
  /// of `GET /pairing/devices` — same route, same client, same 401 refresh.
  Future<Map<String, String>> _devicesForChild(String childId) async {
    final devices = await ref.read(dashboardApiProvider).getDevices();
    final result = <String, String>{};
    for (final device in devices) {
      if (device is! Map) continue;
      if (device['childId'] != childId) continue;
      final id = device['id'];
      if (id is! String) continue;
      result[id] = device['status'] is String ? device['status'] as String : '';
    }
    return result;
  }

  Future<void> _generateCode() async {
    final childId = _selectedChildId;
    if (childId == null) return;

    _stopPolling();
    setState(() {
      _isGenerating = true;
      _errorMessage = null;
      _phase = PairingWatchPhase.idle;
      _pairedDeviceId = null;
      _pairedDeviceIsActive = false;
      _readiness = DeviceReadiness.unknown;
      _activationNotice = null;
      _wasRevoked = false;
      _baseline = null;
    });

    // BEFORE the invite, never after: a snapshot taken afterwards could
    // already contain the very device we are waiting for, and the watch
    // would then wait for something that had already happened.
    Map<String, String>? baseline;
    try {
      baseline = await _devicesForChild(childId);
    } catch (_) {
      // Not fatal, and NOT silently treated as "no devices" — an empty
      // baseline would report the child's existing phone as a brand-new
      // pairing. The code is still issued; the screen just says plainly
      // that it cannot confirm on its own.
      baseline = null;
    }
    if (!mounted) return;

    try {
      final result = await ref.read(pairingApiProvider).generateInviteCode(childId);
      if (!mounted) return;
      final expiresInSeconds = result['expiresInSeconds'] as int;
      setState(() {
        _code = result['code'] as String;
        _secondsLeft = expiresInSeconds;
        _totalSeconds = expiresInSeconds > 0 ? expiresInSeconds : 1;
        _baseline = baseline;
        _phase = baseline == null ? PairingWatchPhase.cannotConfirm : PairingWatchPhase.waiting;
      });
      _startCountdown();
      if (baseline != null) _startPolling(childId, expiresInSeconds);
    } catch (e) {
      setState(() => _errorMessage = _displayError(e));
    } finally {
      if (mounted) setState(() => _isGenerating = false);
    }
  }

  void _startCountdown() {
    _timer?.cancel();
    _timer = Timer.periodic(const Duration(seconds: 1), (timer) {
      if (_secondsLeft <= 0) {
        timer.cancel();
        return;
      }
      setState(() => _secondsLeft--);
    });
  }

  void _startPolling(String childId, int expiresInSeconds) {
    _pollTimer?.cancel();
    _watchElapsed = Duration.zero;
    _watchLimit = Duration(seconds: expiresInSeconds) + AddChildScreen.pollGrace;
    _pollTimer = Timer.periodic(AddChildScreen.pollInterval, (_) => _poll(childId));
  }

  /// Stops the watch. Safe to call twice, safe to call after dispose.
  void _stopPolling() {
    _pollTimer?.cancel();
    _pollTimer = null;
    _watchLimit = null;
  }

  /// THE WATCH HAS TWO PHASES AND ONE TIMER.
  ///
  /// Before a device is found it polls `GET /pairing/devices`. After one is
  /// found it polls that device's own status instead, until the server says
  /// the device is either waiting on its parent or already active — because
  /// "a device appeared" and "a device is ready to be confirmed" are seconds
  /// apart in real life and a parent should not have to guess which they are
  /// looking at. One timer, one deadline, one `dispose`.
  Future<void> _poll(String childId) async {
    _watchElapsed += AddChildScreen.pollInterval;
    final limit = _watchLimit;
    if (limit != null && _watchElapsed > limit) {
      _stopPolling();
      // Only the FIRST phase can give up: once a device has been found, the
      // invite's lifetime is spent and irrelevant, and reporting "no device
      // connected" over a device that plainly did would be a lie.
      if (mounted && _pairedDeviceId == null) {
        setState(() => _phase = PairingWatchPhase.gaveUp);
      }
      return;
    }

    final pairedDeviceId = _pairedDeviceId;
    if (pairedDeviceId != null) {
      await _refreshReadiness(pairedDeviceId, stopWatchWhenSettled: true);
      return;
    }

    final Map<String, String> current;
    try {
      current = await _devicesForChild(childId);
    } catch (_) {
      // One failed poll is a blip, not an answer. The deadline above is
      // what ends the watch, so a flaky network cannot turn into a false
      // "not connected".
      return;
    }
    if (!mounted) return;

    final baseline = _baseline ?? const <String, String>{};
    for (final entry in current.entries) {
      final wasKnown = baseline.containsKey(entry.key);
      final becameActive = entry.value == 'ACTIVE' && baseline[entry.key] != 'ACTIVE';
      if (!wasKnown || becameActive) {
        setState(() {
          _phase = PairingWatchPhase.connected;
          _pairedDeviceId = entry.key;
          _pairedDeviceIsActive = entry.value == 'ACTIVE';
          _readiness =
              entry.value == 'ACTIVE' ? DeviceReadiness.active : DeviceReadiness.unknown;
        });
        // The watch does not stop here any more: it switches to this
        // device's own status, so the activation action can appear on its
        // own as soon as the device is ready for it.
        if (entry.value == 'ACTIVE') {
          _stopPolling();
        } else {
          await _refreshReadiness(entry.key, stopWatchWhenSettled: true);
        }
        return;
      }
    }
  }

  /// Maps the status route's raw enums onto [DeviceReadiness]. The strings
  /// below are wire values, compared and discarded — none of them is ever
  /// shown to a parent.
  static DeviceReadiness _readinessOf(Map<String, dynamic> status) {
    if (status['activationStatus'] == 'ACTIVATED') return DeviceReadiness.active;
    final pairingState = status['pairingState'];
    if (pairingState == 'CAPABILITIES_UPLOADED') return DeviceReadiness.awaitingParent;
    if (pairingState is String && pairingState.isNotEmpty) return DeviceReadiness.preparing;
    return DeviceReadiness.unknown;
  }

  /// Reads the server's answer for [deviceId]. A failed read is NOT an
  /// answer: the previous readiness stands, exactly as one failed device
  /// poll does not mean "not connected".
  Future<void> _refreshReadiness(
    String deviceId, {
    bool stopWatchWhenSettled = false,
  }) async {
    final Map<String, dynamic> status;
    try {
      status = await ref.read(pairingApiProvider).getDeviceStatus(deviceId);
    } catch (_) {
      return;
    }
    if (!mounted) return;

    final readiness = _readinessOf(status);
    setState(() {
      _readiness = readiness;
      _pairedDeviceIsActive = readiness == DeviceReadiness.active;
    });

    // Nothing left for the watch to discover: either the parent's action is
    // now possible, or the device is already active.
    if (stopWatchWhenSettled &&
        (readiness == DeviceReadiness.active ||
            readiness == DeviceReadiness.awaitingParent)) {
      _stopPolling();
    }
  }

  /// The manual «check again», for the case where the automatic watch has
  /// already spent its deadline while the device was still preparing.
  Future<void> _checkReadinessNow() async {
    final deviceId = _pairedDeviceId;
    if (deviceId == null) return;
    setState(() => _isCheckingReadiness = true);
    await _refreshReadiness(deviceId);
    if (mounted) setState(() => _isCheckingReadiness = false);
  }

  /// `POST /pairing/activate`, and then — always — the server's own status.
  ///
  /// The second read is the whole point. A 200 is not this screen's licence
  /// to announce an active device, and a 409 is not proof that nothing
  /// happened: the backend's own contract is that «already activated» and
  /// «blocked on risk» are the same 409 with the same Arabic. So the call's
  /// outcome is rendered as the server worded it, and the STATE is whatever
  /// the server says it is a moment later.
  Future<void> _activatePairedDevice() async {
    final deviceId = _pairedDeviceId;
    if (deviceId == null) return;

    // The parent has taken over from the watch.
    _stopPolling();
    setState(() {
      _isActivating = true;
      _errorMessage = null;
      _activationNotice = null;
    });

    String? notice;
    try {
      await ref.read(pairingApiProvider).activateDevice(deviceId);
    } catch (error) {
      notice = _displayError(error);
    }
    if (!mounted) return;

    await _refreshReadiness(deviceId);
    if (!mounted) return;
    setState(() {
      _isActivating = false;
      _activationNotice = notice;
    });
  }

  /// The server's Arabic sentence when there is one, its English when there
  /// is not, and the raw error only for something that never reached the
  /// server at all. `ApiFailure` already encodes that order.
  String _displayError(Object error) {
    return ApiFailure.from(error)
        .displayFor(arabic: ref.read(localeControllerProvider.notifier).isRtl);
  }

  Future<void> _revokePairedDevice() async {
    final deviceId = _pairedDeviceId;
    if (deviceId == null) return;

    setState(() {
      _isRevoking = true;
      _errorMessage = null;
    });
    try {
      await ref.read(pairingApiProvider).revokeDevice(deviceId);
      if (!mounted) return;
      setState(() {
        _wasRevoked = true;
        _pairedDeviceId = null;
      });
    } catch (e) {
      // The server's own sentence, including the 409 the pairing state
      // machine raises while a device is ACTIVATED but has not yet sent a
      // heartbeat. Better a real refusal than a fake success.
      if (mounted) setState(() => _errorMessage = _displayError(e));
    } finally {
      if (mounted) setState(() => _isRevoking = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    ref.watch(localeControllerProvider);
    final t = ref.watch(localeControllerProvider.notifier).t;

    return Scaffold(
      appBar: AppBar(title: Text(t('pairing.addChildTitle'))),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(24),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (_children == null)
              const Center(child: CircularProgressIndicator())
            else if (_children!.isEmpty)
              Center(
                child: Padding(
                  padding: const EdgeInsets.all(24),
                  child: Column(
                    children: [
                      Icon(Icons.child_care_rounded, size: 48, color: AppTheme.guardian950.withOpacity(0.3)),
                      const SizedBox(height: 12),
                      Text(t('pairing.noChildrenYet'), textAlign: TextAlign.center),
                    ],
                  ),
                ),
              )
            else ...[
              DropdownButtonFormField<String>(
                value: _selectedChildId,
                decoration: InputDecoration(labelText: t('pairing.selectChild'), prefixIcon: const Icon(Icons.child_care_rounded)),
                items: _children!
                    .map((c) => DropdownMenuItem(value: c['id'] as String, child: Text(c['firstName'] as String)))
                    .toList(),
                onChanged: (value) => setState(() => _selectedChildId = value),
              ),
              const SizedBox(height: 24),
              if (_code == null || _secondsLeft <= 0)
                FilledButton.icon(
                  onPressed: _isGenerating ? null : _generateCode,
                  icon: _isGenerating ? null : const Icon(Icons.qr_code_2_rounded),
                  label: _isGenerating
                      ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                      : Text(t('pairing.generateCode')),
                )
              else
                Container(
                  padding: const EdgeInsets.all(28),
                  decoration: BoxDecoration(
                    gradient: LinearGradient(
                      begin: Alignment.topLeft,
                      end: Alignment.bottomRight,
                      colors: [AppTheme.guardian950, AppTheme.guardian950.withOpacity(0.85)],
                    ),
                    borderRadius: BorderRadius.circular(20),
                  ),
                  child: Column(
                    children: [
                      Text(
                        _code!,
                        style: Theme.of(context).textTheme.displaySmall?.copyWith(color: Colors.white, letterSpacing: 6, fontWeight: FontWeight.w700),
                      ),
                      const SizedBox(height: 16),
                      ClipRRect(
                        borderRadius: BorderRadius.circular(4),
                        child: LinearProgressIndicator(
                          value: _secondsLeft / _totalSeconds,
                          minHeight: 6,
                          backgroundColor: Colors.white.withOpacity(0.15),
                          valueColor: const AlwaysStoppedAnimation(AppTheme.amber500),
                        ),
                      ),
                      const SizedBox(height: 10),
                      Text(
                        '${t('pairing.validFor')} ${_secondsLeft ~/ 60}:${(_secondsLeft % 60).toString().padLeft(2, '0')}',
                        style: Theme.of(context).textTheme.bodyMedium?.copyWith(color: Colors.white70),
                      ),
                    ],
                  ),
                ),
              ..._buildWatchSection(context, t),
              if (_errorMessage != null) ...[
                const SizedBox(height: 16),
                Container(
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(color: AppTheme.brick500.withOpacity(0.08), borderRadius: BorderRadius.circular(10)),
                  child: Row(
                    children: [
                      const Icon(Icons.error_outline_rounded, color: AppTheme.brick500, size: 18),
                      const SizedBox(width: 8),
                      Expanded(child: Text(_errorMessage!, style: const TextStyle(color: AppTheme.brick500))),
                    ],
                  ),
                ),
              ],
            ],
          ],
        ),
      ),
    );
  }

  /// The one thing this screen never used to say: what happened next.
  List<Widget> _buildWatchSection(
    BuildContext context,
    String Function(String, {int? count, Map<String, Object>? options}) t,
  ) {
    if (_wasRevoked) {
      return [
        const SizedBox(height: 16),
        _Banner(
          icon: Icons.link_off_rounded,
          color: AppTheme.brick500,
          title: t('pairing.revokedTitle'),
          body: t('pairing.revokedBody'),
        ),
      ];
    }

    switch (_phase) {
      case PairingWatchPhase.idle:
        return const [];

      case PairingWatchPhase.waiting:
        return [
          const SizedBox(height: 16),
          _Banner(
            icon: Icons.hourglass_bottom_rounded,
            color: AppTheme.guardian950,
            title: t('pairing.waitingTitle'),
            body: t('pairing.waitingBody'),
            leading: const SizedBox(
              width: 18,
              height: 18,
              child: CircularProgressIndicator(strokeWidth: 2),
            ),
          ),
        ];

      case PairingWatchPhase.connected:
        return [
          const SizedBox(height: 16),
          _Banner(
            icon: Icons.check_circle_rounded,
            color: AppTheme.sage500,
            title: t('pairing.connectedTitle'),
            // The device is linked; it is reported as ACTIVE only when the
            // backend's own status route says so — never off the back of
            // this screen's own activation call returning 200.
            body: _pairedDeviceIsActive ? t('pairing.connectedActiveBody') : t('pairing.connectedPendingBody'),
          ),
          if (_pairedDeviceId != null && !_pairedDeviceIsActive)
            ..._buildActivationSection(context, t),
          if (_activationNotice != null) ...[
            const SizedBox(height: 12),
            _Banner(
              icon: Icons.info_outline_rounded,
              color: AppTheme.amber500,
              title: t('pairing.activationNoticeTitle'),
              // THE SERVER'S OWN SENTENCE, VERBATIM. It has already been
              // written for this situation («هذا الإجراء تمّ بالفعل، أو لم
              // يعد متاحًا الآن»); rewording it here would replace a
              // reviewed sentence with an unreviewed one.
              body: _activationNotice!,
            ),
          ],
          if (_pairedDeviceId != null) ...[
            const SizedBox(height: 12),
            OutlinedButton.icon(
              onPressed: _isRevoking ? null : () => _confirmRevoke(context, t),
              icon: _isRevoking ? null : const Icon(Icons.link_off_rounded),
              label: _isRevoking
                  ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                  : Text(t('pairing.revokeAction')),
            ),
            const SizedBox(height: 4),
            Text(t('pairing.revokeHint'), style: Theme.of(context).textTheme.bodySmall),
          ],
        ];

      case PairingWatchPhase.gaveUp:
        return [
          const SizedBox(height: 16),
          _Banner(
            icon: Icons.schedule_rounded,
            color: AppTheme.amber500,
            title: t('pairing.notYetTitle'),
            // Non-punitive on purpose: nobody did anything wrong, the code
            // simply has a life span. The real one, from the backend.
            body: t('pairing.notYetBody', options: {'minutes': _totalSeconds ~/ 60}),
          ),
        ];

      case PairingWatchPhase.cannotConfirm:
        return [
          const SizedBox(height: 16),
          _Banner(
            icon: Icons.info_outline_rounded,
            color: AppTheme.amber500,
            title: t('pairing.cannotConfirmTitle'),
            body: t('pairing.cannotConfirmBody'),
          ),
        ];
    }
  }

  /// The one action that turns a paired device into a working one.
  ///
  /// Offered when the server says the device is waiting on its parent, and
  /// also when the status could not be read at all — the server is the
  /// authority on whether the transition is legal and refuses in Arabic, so
  /// an unreadable status must not become a dead end. While the device is
  /// still preparing itself there is nothing for a parent to confirm yet,
  /// so the screen says so and offers a re-check instead of a button that
  /// would only earn a 409.
  List<Widget> _buildActivationSection(
    BuildContext context,
    String Function(String, {int? count, Map<String, Object>? options}) t,
  ) {
    if (_readiness == DeviceReadiness.preparing) {
      return [
        const SizedBox(height: 12),
        Text(t('pairing.activatePreparingBody'), style: Theme.of(context).textTheme.bodySmall),
        const SizedBox(height: 8),
        OutlinedButton.icon(
          onPressed: _isCheckingReadiness ? null : _checkReadinessNow,
          icon: _isCheckingReadiness ? null : const Icon(Icons.refresh_rounded),
          label: _isCheckingReadiness
              ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
              : Text(t('pairing.checkAgainAction')),
        ),
      ];
    }

    return [
      const SizedBox(height: 12),
      FilledButton.icon(
        onPressed: _isActivating ? null : _activatePairedDevice,
        icon: _isActivating ? null : const Icon(Icons.verified_user_rounded),
        label: _isActivating
            ? const SizedBox(
                width: 18,
                height: 18,
                child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
              )
            : Text(t('pairing.activateAction')),
      ),
      const SizedBox(height: 4),
      Text(t('pairing.activateHint'), style: Theme.of(context).textTheme.bodySmall),
    ];
  }

  Future<void> _confirmRevoke(
    BuildContext context,
    String Function(String, {int? count, Map<String, Object>? options}) t,
  ) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text(t('pairing.revokeConfirmTitle')),
        content: Text(t('pairing.revokeConfirmBody')),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: Text(t('common.cancel')),
          ),
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: Text(t('pairing.revokeAction')),
          ),
        ],
      ),
    );
    if (confirmed == true) await _revokePairedDevice();
  }

  @override
  void dispose() {
    // BOTH timers. A `Timer.periodic` that outlives its State calls
    // `setState` on a defunct element, which is an assertion in debug and a
    // silent leak in release — and `flutter_test` fails the test outright
    // on a pending timer, which is the point.
    _timer?.cancel();
    _pollTimer?.cancel();
    super.dispose();
  }
}

/// A small titled notice. Local to this screen because it exists only to
/// keep the four watch states visually identical to each other.
class _Banner extends StatelessWidget {
  const _Banner({
    required this.icon,
    required this.color,
    required this.title,
    required this.body,
    this.leading,
  });

  final IconData icon;
  final Color color;
  final String title;
  final String body;
  final Widget? leading;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: color.withOpacity(0.08),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          leading ?? Icon(icon, color: color, size: 20),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: Theme.of(context).textTheme.titleSmall?.copyWith(color: color, fontWeight: FontWeight.w700),
                ),
                const SizedBox(height: 4),
                Text(body, style: Theme.of(context).textTheme.bodySmall),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
