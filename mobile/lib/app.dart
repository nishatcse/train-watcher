import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'core/providers.dart';
import 'features/home/home_shell.dart';
import 'features/pairing/pairing_screen.dart';
import 'features/splash/splash_screen.dart';

final rootNavigatorKey = GlobalKey<NavigatorState>();

class TrainWatcherApp extends StatelessWidget {
  const TrainWatcherApp({super.key});

  @override
  Widget build(BuildContext context) {
    const seed = Color(0xFF0B6E4F);
    ThemeData theme(Brightness b) => ThemeData(
          useMaterial3: true,
          colorScheme: ColorScheme.fromSeed(seedColor: seed, brightness: b),
          appBarTheme: const AppBarTheme(centerTitle: false),
          cardTheme: CardThemeData(elevation: 0, shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16))),
        );
    return MaterialApp(
      title: 'Train Watcher',
      navigatorKey: rootNavigatorKey,
      debugShowCheckedModeBanner: false,
      theme: theme(Brightness.light),
      darkTheme: theme(Brightness.dark),
      themeMode: ThemeMode.system,
      home: const AuthGate(),
    );
  }
}

/// Splash while the stored credentials load, then pairing or the app itself.
/// Signing out (or a revoked device) flips this and returns to pairing.
class AuthGate extends ConsumerWidget {
  const AuthGate({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final auth = ref.watch(authProvider);
    return auth.when(
      loading: () => const SplashScreen(),
      error: (_, _) => const PairingScreen(),
      data: (a) => a.paired ? const HomeShell() : const PairingScreen(),
    );
  }
}
