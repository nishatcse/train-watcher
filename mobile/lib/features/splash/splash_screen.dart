import 'package:flutter/material.dart';

class SplashScreen extends StatelessWidget {
  const SplashScreen({super.key});
  @override
  Widget build(BuildContext context) {
    final c = Theme.of(context).colorScheme;
    return Scaffold(
      backgroundColor: c.primary,
      body: Center(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Icon(Icons.train, size: 72, color: c.onPrimary),
          const SizedBox(height: 16),
          Text('Train Watcher', style: Theme.of(context).textTheme.headlineMedium?.copyWith(color: c.onPrimary, fontWeight: FontWeight.w700)),
          const SizedBox(height: 24),
          SizedBox(width: 24, height: 24, child: CircularProgressIndicator(strokeWidth: 2.5, color: c.onPrimary)),
        ]),
      ),
    );
  }
}
