import 'package:flutter/material.dart';

/// Full-screen state for failures the owner can't fix by tapping around:
/// unreachable server, a revoked phone, a lost pairing.
class ErrorScreen extends StatelessWidget {
  const ErrorScreen({super.key, required this.title, required this.message, this.steps = const [], this.primaryLabel = 'Try again', this.onPrimary, this.secondaryLabel, this.onSecondary});
  final String title, message, primaryLabel;
  final String? secondaryLabel;
  final List<String> steps;
  final VoidCallback? onPrimary, onSecondary;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(28),
          child: Column(mainAxisAlignment: MainAxisAlignment.center, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Icon(Icons.error_outline, size: 64, color: t.colorScheme.error),
            const SizedBox(height: 16),
            Text(title, textAlign: TextAlign.center, style: t.textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w700)),
            const SizedBox(height: 8),
            Text(message, textAlign: TextAlign.center),
            if (steps.isNotEmpty) ...[
              const SizedBox(height: 16),
              Card(child: Padding(padding: const EdgeInsets.all(14), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [for (var i = 0; i < steps.length; i++) Padding(padding: const EdgeInsets.symmetric(vertical: 3), child: Text('${i + 1}. ${steps[i]}'))]))),
            ],
            const SizedBox(height: 24),
            if (onPrimary != null) FilledButton(onPressed: onPrimary, style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(52)), child: Text(primaryLabel)),
            if (secondaryLabel != null) TextButton(onPressed: onSecondary, child: Text(secondaryLabel!)),
          ]),
        ),
      ),
    );
  }
}
