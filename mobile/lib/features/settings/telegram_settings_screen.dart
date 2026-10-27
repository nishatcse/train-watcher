import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/models.dart';
import '../../core/providers.dart';
import '../../widgets/common.dart';

/// The bot token and chat id are server secrets; they are deliberately not editable
/// from the phone.
class TelegramSettingsScreen extends ConsumerStatefulWidget {
  const TelegramSettingsScreen({super.key});
  @override
  ConsumerState<TelegramSettingsScreen> createState() => _TelegramSettingsScreenState();
}

class _TelegramSettingsScreenState extends ConsumerState<TelegramSettingsScreen> {
  bool _sending = false;
  String? _result;
  bool _ok = false;

  Future<void> _test() async {
    setState(() {
      _sending = true;
      _result = null;
    });
    try {
      final r = await ref.read(apiProvider).testAlert('telegram');
      final c = r.isEmpty ? null : r.first;
      setState(() {
        _ok = c?.status == 'sent';
        _result = c == null ? 'Telegram is not set up on the server.' : c.status == 'sent' ? 'Sent. Check your Telegram chat.' : 'Failed after ${c.attempts} tries: ${c.error ?? 'unknown error'}';
      });
    } catch (e) {
      setState(() {
        _ok = false;
        _result = friendlyError(e);
      });
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final settings = ref.watch(settingsProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Telegram')),
      body: AsyncView<AppSettings>(
        value: settings,
        onRetry: () => ref.invalidate(settingsProvider),
        data: (s) => ListView(padding: const EdgeInsets.all(16), children: [
          Card(
            child: ListTile(
              leading: Icon(s.telegramConfigured ? Icons.check_circle : Icons.warning_amber, color: s.telegramConfigured ? Colors.green : Colors.orange),
              title: Text(s.telegramConfigured ? 'Bot connected' : 'Not set up'),
              subtitle: Text(s.telegramConfigured ? 'The server has a bot token and chat id.' : 'Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID on the server.'),
            ),
          ),
          SwitchListTile(
            title: const Text('Send alerts to Telegram'),
            subtitle: const Text('Works independently of phone alerts, so you still hear about seats if one channel is down.'),
            value: s.telegramEnabled,
            onChanged: s.telegramConfigured
                ? (v) async {
                    try {
                      await ref.read(apiProvider).patchSettings({'telegramEnabled': v});
                      ref.invalidate(settingsProvider);
                    } catch (e) {
                      if (context.mounted) snack(context, friendlyError(e), error: true);
                    }
                  }
                : null,
          ),
          const SizedBox(height: 8),
          FilledButton.icon(
            onPressed: s.telegramConfigured && !_sending ? _test : null,
            icon: _sending ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)) : const Icon(Icons.send),
            label: const Text('Send a test message'),
            style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(52)),
          ),
          if (_result != null) Padding(padding: const EdgeInsets.only(top: 12), child: Text(_result!, style: TextStyle(color: _ok ? Colors.green.shade700 : Theme.of(context).colorScheme.error))),
        ]),
      ),
    );
  }
}
