import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/di/providers.dart';
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
/// KNOWN GAP, DELIBERATELY NOT PAPERED OVER. Nothing in this app calls
/// `POST /pairing/activate`, so a freshly paired device sits at
/// `PENDING_PAIRING`. The confirmation below therefore says "connected",
/// and says "active" only when the device's own `status` is `ACTIVE`. It
/// does not claim an activation that has not happened.
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
      setState(() => _errorMessage = e.toString());
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

  Future<void> _poll(String childId) async {
    _watchElapsed += AddChildScreen.pollInterval;
    final limit = _watchLimit;
    if (limit != null && _watchElapsed > limit) {
      _stopPolling();
      if (mounted) setState(() => _phase = PairingWatchPhase.gaveUp);
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
        _stopPolling();
        setState(() {
          _phase = PairingWatchPhase.connected;
          _pairedDeviceId = entry.key;
          _pairedDeviceIsActive = entry.value == 'ACTIVE';
        });
        return;
      }
    }
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
      if (mounted) setState(() => _errorMessage = e.toString());
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
            // The device is linked; it is only reported as ACTIVE when the
            // backend says so, because nothing in this app activates it.
            body: _pairedDeviceIsActive ? t('pairing.connectedActiveBody') : t('pairing.connectedPendingBody'),
          ),
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
