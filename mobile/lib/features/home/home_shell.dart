import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app.dart';
import '../../core/api_client.dart';
import '../../core/providers.dart';
import '../../notifications/alert_data.dart';
import '../../notifications/notification_service.dart';
import '../../notifications/push_service.dart';
import '../alert/alert_screen.dart';
import '../dashboard/dashboard_screen.dart';
import '../error/error_screen.dart';
import '../history/history_screen.dart';
import '../session/session_screen.dart';
import '../settings/settings_screen.dart';
import '../watchers/watchers_screen.dart';

class HomeShell extends ConsumerStatefulWidget {
  const HomeShell({super.key});
  @override
  ConsumerState<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends ConsumerState<HomeShell> with WidgetsBindingObserver {
  int _index = 0;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    pendingTap.addListener(_onTap);
    foregroundAlert.addListener(_onForegroundAlert);
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      await _ensureNotificationPermission();
      await PushService.register(ref.read(apiProvider));
      _onTap(); // a tap that cold-started the app
    });
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    pendingTap.removeListener(_onTap);
    foregroundAlert.removeListener(_onForegroundAlert);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      ref.invalidate(statusProvider);
      ref.invalidate(watchersProvider);
      ref.invalidate(notificationsEnabledProvider);
    }
  }

  Future<void> _ensureNotificationPermission() async {
    if (await NotificationService.notificationsEnabled()) return;
    if (!mounted) return;
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        icon: const Icon(Icons.notifications_active),
        title: const Text('Allow alerts'),
        content: const Text('Seat alerts only work if this app may show notifications. Without it, nothing can ring when a seat opens.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Not now')),
          FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Allow')),
        ],
      ),
    );
    if (ok == true) {
      await NotificationService.requestNotificationPermission();
      await NotificationService.requestFullScreenPermission();
    }
  }

  void _onTap() {
    final tap = pendingTap.value;
    if (tap == null) return;
    pendingTap.value = null;
    final nav = rootNavigatorKey.currentState;
    if (nav == null) return;
    final type = tap.data['type']?.toString() ?? '';
    if (tap.data['action'] == 'open_login' || type.startsWith('session_')) {
      nav.push(MaterialPageRoute(builder: (_) => const SessionScreen()));
    } else {
      nav.push(MaterialPageRoute(builder: (_) => AlertScreen(data: AlertData.fromMap(tap.data), autoBook: tap.actionId == 'book')));
    }
  }

  void _onForegroundAlert() {
    final m = foregroundAlert.value;
    if (m == null) return;
    foregroundAlert.value = null;
    rootNavigatorKey.currentState?.push(MaterialPageRoute(builder: (_) => AlertScreen(data: AlertData.fromMap(m))));
  }

  @override
  Widget build(BuildContext context) {
    // A revoked or unknown device token means this phone must pair again.
    ref.listen(statusProvider, (_, next) {
      final e = next.error;
      if (e is ApiException && e.isUnauthorized) {
        ref.read(authProvider.notifier).signOut(notice: 'This phone was unpaired on the server. Pair it again with a new code to keep getting alerts.');
      }
    });

    // Nothing has ever loaded and the server can't be reached: say what to check, don't show empty tabs.
    final status = ref.watch(statusProvider);
    final err = status.error;
    if (!status.hasValue && err is ApiException && err.isOffline) {
      return ErrorScreen(
        title: "Can't reach your server",
        message: err.message,
        steps: const [
          'Check this phone has internet (Wi-Fi or mobile data).',
          'If it does, the server may be restarting. Wait a minute and try again.',
          'Seat monitoring keeps running in the cloud either way; you just can\'t see it from here yet.',
        ],
        onPrimary: () => ref.invalidate(statusProvider),
        secondaryLabel: 'Pair with a different server',
        onSecondary: () => ref.read(authProvider.notifier).signOut(),
      );
    }

    const pages = [DashboardScreen(), WatchersScreen(), HistoryScreen(), SettingsScreen()];
    return Scaffold(
      body: IndexedStack(index: _index, children: pages),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _index,
        onDestinationSelected: (i) => setState(() => _index = i),
        destinations: const [
          NavigationDestination(icon: Icon(Icons.dashboard_outlined), selectedIcon: Icon(Icons.dashboard), label: 'Home'),
          NavigationDestination(icon: Icon(Icons.train_outlined), selectedIcon: Icon(Icons.train), label: 'Watchers'),
          NavigationDestination(icon: Icon(Icons.history), label: 'History'),
          NavigationDestination(icon: Icon(Icons.settings_outlined), selectedIcon: Icon(Icons.settings), label: 'Settings'),
        ],
      ),
    );
  }
}
