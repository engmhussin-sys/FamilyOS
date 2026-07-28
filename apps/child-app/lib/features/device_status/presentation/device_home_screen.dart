import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/di/providers.dart';
import '../../../plugins/permissions/domain/permission_status.dart';

/// Combines Sprint 4's three Flutter requirements ("Permission
/// onboarding," "Child status," "Device health") into ONE screen rather
/// than three separate ones — still within the standing
/// "onboarding/diagnostic screens only" constraint, since all three are
/// facets of the same "is this device correctly set up" question, not
/// three distinct product features.
class DeviceHomeScreen extends ConsumerStatefulWidget {
  const DeviceHomeScreen({super.key});

  @override
  ConsumerState<DeviceHomeScreen> createState() => _DeviceHomeScreenState();
}

class _DeviceHomeScreenState extends ConsumerState<DeviceHomeScreen> with WidgetsBindingObserver {
  List<PermissionStatus> _permissions = [];
  bool _isLoadingPermissions = true;
  bool _isSyncingCapabilities = false;
  String? _syncMessage;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _refreshPermissions();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // Re-check permissions whenever the app resumes — the user likely
    // just came back from a Settings screen. Matches lifecycle ADR §8's
    // "re-check every cycle, don't assume a one-time grant holds" principle.
    if (state == AppLifecycleState.resumed) {
      _refreshPermissions();
    }
  }

  Future<void> _refreshPermissions() async {
    setState(() => _isLoadingPermissions = true);
    final service = ref.read(permissionStatusServiceProvider);
    final results = await service.checkAll();
    if (mounted) {
      setState(() {
        _permissions = results;
        _isLoadingPermissions = false;
      });
    }
  }

  Future<void> _syncCapabilities() async {
    setState(() {
      _isSyncingCapabilities = true;
      _syncMessage = null;
    });
    try {
      await ref.read(capabilityReportingServiceProvider).reportNow();
      if (mounted) setState(() => _syncMessage = 'Synced ✅');
    } catch (_) {
      if (mounted) setState(() => _syncMessage = 'Sync failed — will retry on next heartbeat.');
    } finally {
      if (mounted) setState(() => _isSyncingCapabilities = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Device Status')),
      body: RefreshIndicator(
        onRefresh: _refreshPermissions,
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            const Text(
              '✅ Device paired. Heartbeat running.',
              style: TextStyle(fontWeight: FontWeight.bold),
            ),
            const SizedBox(height: 16),
            const Text('Permissions', style: TextStyle(fontWeight: FontWeight.bold)),
            const SizedBox(height: 8),
            if (_isLoadingPermissions)
              const Center(child: CircularProgressIndicator())
            else
              ..._permissions.map(_buildPermissionTile),
            const SizedBox(height: 24),
            const Text('Capabilities', style: TextStyle(fontWeight: FontWeight.bold)),
            const SizedBox(height: 8),
            ElevatedButton(
              onPressed: _isSyncingCapabilities ? null : _syncCapabilities,
              child: _isSyncingCapabilities
                  ? const SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Text('Sync Capabilities Now'),
            ),
            if (_syncMessage != null) ...[
              const SizedBox(height: 8),
              Text(_syncMessage!),
            ],
          ],
        ),
      ),
    );
  }

  Widget _buildPermissionTile(PermissionStatus status) {
    return ListTile(
      leading: Icon(
        status.isGranted ? Icons.check_circle : Icons.warning_amber_rounded,
        color: status.isGranted ? Colors.green : Colors.orange,
      ),
      title: Text(status.label),
      trailing: status.isGranted
          ? null
          : TextButton(
              onPressed: () async {
                await ref.read(permissionStatusServiceProvider).requestPermission(status.kind);
              },
              child: const Text('Fix'),
            ),
    );
  }
}
