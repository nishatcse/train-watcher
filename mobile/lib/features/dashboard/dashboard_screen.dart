import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/format.dart';
import '../../core/models.dart';
import '../../core/providers.dart';
import '../../notifications/alert_data.dart';
import '../../notifications/notification_service.dart';
import '../../notifications/push_service.dart';
import '../../widgets/common.dart';
import '../alert/alert_screen.dart';
import '../monitoring/monitoring_screen.dart';
import '../session/session_screen.dart';

class DashboardScreen extends ConsumerWidget {
  const DashboardScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final status = ref.watch(statusProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Train Watcher')),
      body: RefreshIndicator(
        onRefresh: () async {
          ref.invalidate(statusProvider);
          ref.invalidate(historyProvider);
          try {
            await ref.read(statusProvider.future);
          } catch (_) {}
        },
        child: AsyncView<AppStatus>(
          value: status,
          onRetry: () => ref.invalidate(statusProvider),
          data: (s) => ListView(padding: const EdgeInsets.all(16), children: [
            _SessionCard(s.session),
            const SizedBox(height: 12),
            _EngineCard(s),
            const SizedBox(height: 12),
            _ChannelsCard(s),
            const SizedBox(height: 12),
            const _UnseenAlert(),
            const _PermissionBanner(),
          ]),
        ),
      ),
    );
  }
}

class _SessionCard extends StatelessWidget {
  const _SessionCard(this.s);
  final SessionStatus s;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final (color, icon, label, detail) = switch (s.status) {
      'active' => (Colors.green, Icons.verified_user, 'Railway login active', 'Valid for about ${duration(s.secondsLeft ?? 0)}'),
      'expiring_soon' => (Colors.orange, Icons.timer, 'Login expires soon', 'About ${duration(s.secondsLeft ?? 0)} left. Log in again to keep watching.'),
      _ => (t.colorScheme.error, Icons.lock_clock, 'Railway login needed', 'Monitoring is paused until you log in.'),
    };
    return Card(
      color: color.withValues(alpha: 0.10),
      child: InkWell(
        borderRadius: BorderRadius.circular(16),
        onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const SessionScreen())),
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Row(children: [
            Icon(icon, color: color, size: 32),
            const SizedBox(width: 14),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(label, style: t.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700)),
                const SizedBox(height: 2),
                Text(detail),
              ]),
            ),
            if (s.status != 'active') FilledButton(onPressed: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const SessionScreen())), child: const Text('Log in')) else const Icon(Icons.chevron_right),
          ]),
        ),
      ),
    );
  }
}

class _EngineCard extends StatelessWidget {
  const _EngineCard(this.s);
  final AppStatus s;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final e = s.engine;
    final paused = e.skipReason != null;
    final limited = e.rateLimitedUntil != null;
    return Card(
      child: InkWell(
        borderRadius: BorderRadius.circular(16),
        onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const MonitoringScreen())),
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Icon(paused ? Icons.pause_circle : Icons.radar, color: paused ? Colors.orange : t.colorScheme.primary),
              const SizedBox(width: 10),
              Text(paused ? 'Monitoring paused' : 'Monitoring', style: t.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700)),
              const Spacer(),
              const Icon(Icons.chevron_right),
            ]),
            const SizedBox(height: 12),
            Wrap(spacing: 8, runSpacing: 8, children: [
              StatusChip('${s.active} of ${s.total} watching', icon: Icons.train),
              StatusChip(s.withSeats > 0 ? '${s.withSeats} with seats' : 'No seats yet', color: s.withSeats > 0 ? Colors.green : Colors.grey, icon: Icons.event_seat),
              StatusChip('Last scan ${ago(e.lastCycleAt)}', color: Colors.blueGrey, icon: Icons.schedule),
            ]),
            if (paused) Padding(padding: const EdgeInsets.only(top: 10), child: Text(_why(e.skipReason!), style: TextStyle(color: t.colorScheme.error))),
            if (limited) const Padding(padding: EdgeInsets.only(top: 10), child: Text('The booking site asked us to slow down; scanning resumes automatically.')),
            if (e.lastError != null) Padding(padding: const EdgeInsets.only(top: 10), child: Text('Last problem: ${e.lastError}', style: t.textTheme.bodySmall)),
          ]),
        ),
      ),
    );
  }

  String _why(String r) => switch (r) {
        'no_watchers' => 'Add a watcher to start monitoring.',
        'no_session' || 'expired' || 'session' => 'Log in to Railway to resume.',
        _ => r,
      };
}

class _ChannelsCard extends StatelessWidget {
  const _ChannelsCard(this.s);
  final AppStatus s;
  @override
  Widget build(BuildContext context) {
    Widget row(IconData i, String name, bool ok, String okText, String badText) => Padding(
          padding: const EdgeInsets.symmetric(vertical: 4),
          child: Row(children: [
            Icon(i, size: 20),
            const SizedBox(width: 10),
            Expanded(child: Text(name)),
            StatusChip(ok ? okText : badText, color: ok ? Colors.green : Colors.orange, icon: ok ? Icons.check_circle : Icons.warning_amber),
          ]),
        );
    final pushOk = s.pushConfigured && PushService.configured;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('Alert channels', style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700)),
          const SizedBox(height: 8),
          row(Icons.notifications_active, 'Phone alerts (push)', pushOk, 'Ready', s.pushConfigured ? 'Setting up' : 'Not set up'),
          row(Icons.send, 'Telegram', s.telegramConfigured, 'Ready', 'Not set up'),
        ]),
      ),
    );
  }
}

/// The newest seat alert nobody has acknowledged yet, so a missed ring is never lost.
class _UnseenAlert extends ConsumerWidget {
  const _UnseenAlert();
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final items = ref.watch(historyProvider).valueOrNull ?? const <AlertItem>[];
    final unseen = items.where((a) => a.isSeatAlert && a.kind == 'seat_available' && a.acknowledgedAt == null && DateTime.now().difference(a.createdAt).inHours < 12);
    if (unseen.isEmpty) return const SizedBox.shrink();
    final a = unseen.first;
    return Card(
      color: Colors.green.withValues(alpha: 0.14),
      child: ListTile(
        leading: const Icon(Icons.event_seat, color: Colors.green),
        title: Text('Seats were found ${ago(a.createdAt)}'),
        subtitle: Text('${a.payload['route'] ?? ''} · ${a.payload['trainName'] ?? ''}'),
        trailing: const Icon(Icons.chevron_right),
        onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => AlertScreen(data: AlertData.fromItem(a)))),
      ),
    );
  }
}

class _PermissionBanner extends ConsumerWidget {
  const _PermissionBanner();
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final enabled = ref.watch(notificationsEnabledProvider).valueOrNull ?? true;
    if (enabled) return const SizedBox.shrink();
    return Builder(
        builder: (c) {
          return Card(
            color: Theme.of(context).colorScheme.errorContainer,
            child: ListTile(
              leading: const Icon(Icons.notifications_off),
              title: const Text("Notifications are off"),
              subtitle: const Text("Alerts can't ring until you allow them."),
              trailing: FilledButton(
                onPressed: () async {
                  await NotificationService.requestNotificationPermission();
                  ref.invalidate(notificationsEnabledProvider);
                },
                child: const Text('Allow'),
              ),
            ),
          );
        },
      );
  }
}
