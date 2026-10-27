import 'package:android_intent_plus/android_intent.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/models.dart';
import '../../core/providers.dart';
import '../../notifications/notification_service.dart';
import '../../notifications/push_service.dart';
import '../../widgets/common.dart';
import 'telegram_settings_screen.dart';

const _package = 'com.afridi.train_watcher';

class SettingsScreen extends ConsumerStatefulWidget {
  const SettingsScreen({super.key});
  @override
  ConsumerState<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends ConsumerState<SettingsScreen> {
  int? _cycle;
  String? _cycleError;
  bool _testing = false;

  Future<void> _patch(Map<String, dynamic> body, {bool cycle = false}) async {
    try {
      await ref.read(apiProvider).patchSettings(body);
      ref.invalidate(settingsProvider);
      ref.invalidate(statusProvider);
      if (cycle) setState(() => _cycleError = null);
    } on ApiException catch (e) {
      // The server explains why a value is refused (e.g. too fast for the booking site).
      if (cycle) {
        setState(() => _cycleError = e.message);
      } else if (mounted) {
        snack(context, e.message, error: true);
      }
      ref.invalidate(settingsProvider);
    }
  }

  Future<void> _serverTest() async {
    setState(() => _testing = true);
    try {
      final r = await ref.read(apiProvider).testAlert('both');
      if (!mounted) return;
      final summary = r.map((c) => '${c.channel == 'fcm' ? 'Phone' : 'Telegram'}: ${c.status}${c.error != null ? ' (${c.error})' : ''}').join('\n');
      await showDialog<void>(context: context, builder: (c) => AlertDialog(title: const Text('Test result'), content: Text(r.isEmpty ? 'No channel is set up.' : summary), actions: [TextButton(onPressed: () => Navigator.pop(c), child: const Text('OK'))]));
    } catch (e) {
      if (mounted) snack(context, friendlyError(e), error: true);
    } finally {
      if (mounted) setState(() => _testing = false);
    }
  }

  void _settings(String action, {String? data}) => AndroidIntent(action: action, data: data).launch();

  @override
  Widget build(BuildContext context) {
    final settings = ref.watch(settingsProvider);
    final auth = ref.watch(authProvider).valueOrNull;
    return Scaffold(
      appBar: AppBar(title: const Text('Settings')),
      body: AsyncView<AppSettings>(
        value: settings,
        onRetry: () => ref.invalidate(settingsProvider),
        data: (s) {
          final cycle = _cycle ?? s.scanCycleSeconds;
          return ListView(children: [
            const SectionTitle('Scanning'),
            ListTile(
              title: const Text('Check every'),
              subtitle: Text(_cycleError ?? 'Minimum ${s.minScanCycleSeconds}s. The booking site publishes no limit and blocks clients that go too fast, so faster is not safer.', style: TextStyle(color: _cycleError != null ? Theme.of(context).colorScheme.error : null)),
              trailing: Row(mainAxisSize: MainAxisSize.min, children: [
                IconButton(icon: const Icon(Icons.remove_circle_outline), onPressed: () => _setCycle(cycle - 5)),
                SizedBox(width: 44, child: Text('${cycle}s', textAlign: TextAlign.center, style: const TextStyle(fontWeight: FontWeight.w700))),
                IconButton(icon: const Icon(Icons.add_circle_outline), onPressed: () => _setCycle(cycle + 5)),
              ]),
            ),
            const SectionTitle('Alert channels'),
            SwitchListTile(
              secondary: const Icon(Icons.notifications_active),
              title: const Text('Phone alerts (push)'),
              subtitle: Text(!s.pushConfigured ? 'Not set up on the server yet' : !PushService.configured ? 'This build has no Firebase config' : 'Rings this phone'),
              value: s.fcmEnabled,
              onChanged: (v) => _patch({'fcmEnabled': v}),
            ),
            ListTile(
              leading: const Icon(Icons.send),
              title: const Text('Telegram'),
              subtitle: Text(s.telegramConfigured ? (s.telegramEnabled ? 'On' : 'Off') : 'Not set up on the server'),
              trailing: const Icon(Icons.chevron_right),
              onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const TelegramSettingsScreen())),
            ),
            ListTile(
              leading: _testing ? const SizedBox(width: 24, height: 24, child: CircularProgressIndicator(strokeWidth: 2)) : const Icon(Icons.campaign),
              title: const Text('Send a test alert'),
              subtitle: const Text('Goes through the real pipeline: server → push + Telegram.'),
              onTap: _testing ? null : _serverTest,
            ),
            ListTile(
              leading: const Icon(Icons.volume_up),
              title: const Text('Test the ringtone on this phone'),
              subtitle: const Text('Works without the server. Checks sound, volume and lock-screen behaviour.'),
              onTap: NotificationService.showLocalTest,
            ),
            ListTile(
              leading: const Icon(Icons.screen_lock_portrait),
              title: const Text('Test the lock-screen alert'),
              subtitle: const Text('Rings 10 seconds after you tap. Lock your phone straight away to see how it looks when locked.'),
              onTap: () {
                snack(context, 'Lock your phone now. The alert fires in 10 seconds.');
                Future.delayed(const Duration(seconds: 10), NotificationService.showLocalTest);
              },
            ),
            const SectionTitle('Make alerts reliable on this phone'),
            Builder(builder: (c) {
              final on = ref.watch(notificationsEnabledProvider).valueOrNull ?? true;
              return ListTile(
                leading: Icon(on ? Icons.notifications : Icons.notifications_off, color: on ? Colors.green : Colors.red),
                title: const Text('Notifications'),
                subtitle: Text(on ? 'Allowed' : 'Off. Alerts cannot ring.'),
                trailing: on ? null : FilledButton(onPressed: () async { await NotificationService.requestNotificationPermission(); ref.invalidate(notificationsEnabledProvider); }, child: const Text('Allow')),
              );
            }),
            ListTile(
              leading: const Icon(Icons.phone_android),
              title: const Text('Show over the lock screen'),
              subtitle: const Text('Android 14+ asks you to allow full-screen alerts. Otherwise a banner is used.'),
              onTap: NotificationService.requestFullScreenPermission,
            ),
            ListTile(
              leading: const Icon(Icons.battery_saver),
              title: const Text('Battery: don\'t restrict this app'),
              subtitle: const Text('Phones kill background apps to save power, which can delay alerts.'),
              onTap: () => _settings('android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS'),
            ),
            ListTile(
              leading: const Icon(Icons.settings_applications),
              title: const Text('App settings'),
              subtitle: const Text('Xiaomi / Redmi: turn on Autostart, "Display pop-up windows while running in the background" and "Show on Lock screen".'),
              onTap: () => _settings('android.settings.APPLICATION_DETAILS_SETTINGS', data: 'package:$_package'),
            ),
            const SectionTitle('This phone'),
            ListTile(leading: const Icon(Icons.dns), title: const Text('Server'), subtitle: Text(auth?.baseUrl ?? '')),
            ListTile(
              leading: Icon(Icons.link_off, color: Theme.of(context).colorScheme.error),
              title: Text('Unpair this phone', style: TextStyle(color: Theme.of(context).colorScheme.error)),
              subtitle: const Text('Stops alerts to this phone. Your watchers stay on the server.'),
              onTap: () async {
                if (await confirm(context, title: 'Unpair this phone?', message: 'You will need a new pairing code to connect again.', action: 'Unpair')) {
                  await ref.read(authProvider.notifier).signOut(remote: true);
                }
              },
            ),
            const SizedBox(height: 24),
            const Center(child: Text('Train Watcher 1.0 · read-only alerts · you book manually', style: TextStyle(fontSize: 12))),
            const SizedBox(height: 24),
          ]);
        },
      ),
    );
  }

  void _setCycle(int v) {
    setState(() => _cycle = v);
    _patch({'scanCycleSeconds': v}, cycle: true).then((_) {
      if (_cycleError != null) setState(() => _cycle = null); // snap back to the server's value
    });
  }
}
