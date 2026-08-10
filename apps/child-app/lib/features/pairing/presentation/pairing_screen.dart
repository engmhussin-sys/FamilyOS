import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/di/providers.dart';
import '../../../core/network/api_client.dart';
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
class PairingScreen extends ConsumerStatefulWidget {
  const PairingScreen({super.key, required this.onPaired});

  final VoidCallback onPaired;

  @override
  ConsumerState<PairingScreen> createState() => _PairingScreenState();
}

class _PairingScreenState extends ConsumerState<PairingScreen> {
  final _codeController = TextEditingController();
  bool _isSubmitting = false;
  String? _errorMessage;

  @override
  void dispose() {
    _codeController.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    setState(() {
      _isSubmitting = true;
      _errorMessage = null;
    });

    try {
      final registrationService = ref.read(deviceRegistrationServiceProvider);
      await registrationService.registerWithCode(_codeController.text.trim());
      widget.onPaired();
    } on ApiException catch (e) {
      setState(() => _errorMessage = e.message);
    } catch (e) {
      setState(() => _errorMessage = "Something went wrong. Let's try again!");
    } finally {
      if (mounted) setState(() => _isSubmitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
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
                "Let's get set up!",
                style: Theme.of(context).textTheme.displaySmall,
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 8),
              Text(
                'Ask a grown-up for the code from their app, then type it in below.',
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
                  hintText: 'XXXX-XXXX',
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
              if (_errorMessage != null) ...[
                const SizedBox(height: 16),
                Container(
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(color: KidTheme.coral.withOpacity(0.12), borderRadius: BorderRadius.circular(14)),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      const Text('\u{1F914}', style: TextStyle(fontSize: 18)),
                      const SizedBox(width: 8),
                      Expanded(child: Text(_errorMessage!, style: const TextStyle(color: KidTheme.coral))),
                    ],
                  ),
                ),
              ],
              const SizedBox(height: 24),
              FilledButton(
                onPressed: _isSubmitting ? null : _submit,
                child: _isSubmitting
                    ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                    : const Text("Let's Go!"),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
