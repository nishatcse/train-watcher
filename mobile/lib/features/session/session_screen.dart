import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/format.dart';
import '../../core/models.dart';
import '../../core/providers.dart';
import '../../widgets/common.dart';
import 'railway_login_screen.dart';

class SessionScreen extends ConsumerWidget {
  const SessionScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final status = ref.watch(statusProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Railway login')),
      body: AsyncView<AppStatus>(
        value: status,
        onRetry: () => ref.invalidate(statusProvider),
        data: (s) => ListView(padding: const EdgeInsets.all(16), children: [
          _Header(s.session),
          const SizedBox(height: 8),
          FilledButton.icon(
            onPressed: () async {
              await Navigator.push(context, MaterialPageRoute(builder: (_) => const RailwayLoginScreen()));
              ref.invalidate(statusProvider);
            },
            icon: const Icon(Icons.login),
            label: Text(s.session.status == 'active' ? 'Log in again' : 'Log in to Railway'),
            style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(54)),
          ),
          const SizedBox(height: 12),
          const Card(
            child: Padding(
              padding: EdgeInsets.all(16),
              child: Text(
                'Why do I have to log in?\n\n'
                'The booking site signs you out about every 12 hours and asks you to prove you are a person, '
                'so a login by you is needed roughly twice a day. The app warns you 30 minutes and 5 minutes '
                'before it runs out, and monitoring resumes the moment you finish.',
              ),
            ),
          ),
          const SectionTitle('Details'),
          Card(
            child: Column(children: [
              ListTile(title: const Text('Expires'), trailing: Text(s.session.expiresAt == null ? '—' : clock(s.session.expiresAt!))),
              ListTile(title: const Text('Last login'), trailing: Text(s.session.lastReloginAt == null ? 'never' : ago(s.session.lastReloginAt))),
              ListTile(title: const Text('Stations & trains list'), trailing: Text(s.session.catalogCachedAt == null ? 'not loaded' : 'updated ${ago(s.session.catalogCachedAt)}')),
              ListTile(title: const Text('Automatic renewal'), trailing: Text(s.session.hasRefreshToken ? 'available' : 'not available')),
            ]),
          ),
          const SectionTitle('Login not working here?'),
          Card(
            child: ListTile(
              leading: const Icon(Icons.content_paste),
              title: const Text('Paste a session instead'),
              subtitle: const Text('For when the site\'s check won\'t complete inside the app. Log in on a computer with the watcher project (npm run relogin) and paste the session value.'),
              onTap: () => _paste(context, ref),
            ),
          ),
        ]),
      ),
    );
  }

  Future<void> _paste(BuildContext context, WidgetRef ref) async {
    final ctl = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: const Text('Paste session'),
        content: TextField(controller: ctl, maxLines: 6, decoration: const InputDecoration(hintText: 'RAILWAY_SESSION_COOKIES value', border: OutlineInputBorder())),
        actions: [TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancel')), FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Send'))],
      ),
    );
    if (ok != true || !context.mounted) return;
    try {
      var text = ctl.text.trim();
      if (!text.startsWith('{')) text = utf8.decode(base64.decode(base64.normalize(text)));
      final blob = (jsonDecode(text) as Map).cast<String, dynamic>();
      await ref.read(apiProvider).postSession(blob);
      ref.invalidate(statusProvider);
      ref.invalidate(catalogProvider);
      if (context.mounted) snack(context, 'Session accepted. Monitoring resumes.');
    } catch (e) {
      if (context.mounted) snack(context, e is FormatException ? "That doesn't look like a session value." : friendlyError(e), error: true);
    }
  }
}

class _Header extends StatelessWidget {
  const _Header(this.s);
  final SessionStatus s;
  @override
  Widget build(BuildContext context) {
    final (color, icon, text) = switch (s.status) {
      'active' => (Colors.green, Icons.verified_user, 'Logged in · about ${duration(s.secondsLeft ?? 0)} left'),
      'expiring_soon' => (Colors.orange, Icons.timer, 'Expires in about ${duration(s.secondsLeft ?? 0)}'),
      _ => (Theme.of(context).colorScheme.error, Icons.lock_clock, 'Login needed. Monitoring is paused'),
    };
    return Card(
      color: color.withValues(alpha: 0.12),
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Row(children: [Icon(icon, color: color, size: 36), const SizedBox(width: 14), Expanded(child: Text(text, style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700)))]),
      ),
    );
  }
}
