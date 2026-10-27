import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/format.dart';
import '../../core/models.dart';
import '../../core/providers.dart';
import '../../widgets/common.dart';
import 'watcher_form_screen.dart';

class WatchersScreen extends ConsumerWidget {
  const WatchersScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final watchers = ref.watch(watchersProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Watchers')),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const WatcherFormScreen())),
        icon: const Icon(Icons.add),
        label: const Text('Add watcher'),
      ),
      body: AsyncView<List<Watcher>>(
        value: watchers,
        onRetry: () => ref.invalidate(watchersProvider),
        data: (list) {
          if (list.isEmpty) {
            return const Center(
              child: Padding(
                padding: EdgeInsets.all(32),
                child: Column(mainAxisSize: MainAxisSize.min, children: [
                  Icon(Icons.train_outlined, size: 64),
                  SizedBox(height: 12),
                  Text('No watchers yet', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600)),
                  SizedBox(height: 6),
                  Text('Add a train and date. The cloud checks it around the clock and rings this phone when a seat opens.', textAlign: TextAlign.center),
                ]),
              ),
            );
          }
          return ListView.builder(
            padding: const EdgeInsets.fromLTRB(12, 8, 12, 96),
            itemCount: list.length,
            itemBuilder: (c, i) => _WatcherTile(list[i]),
          );
        },
      ),
    );
  }
}

class _WatcherTile extends ConsumerWidget {
  const _WatcherTile(this.w);
  final Watcher w;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = Theme.of(context);
    final seats = w.availableSeats ?? 0;
    final hasSeats = seats > 0;
    return Dismissible(
      key: ValueKey(w.id),
      direction: DismissDirection.endToStart,
      background: Container(
        alignment: Alignment.centerRight,
        padding: const EdgeInsets.only(right: 24),
        margin: const EdgeInsets.symmetric(vertical: 4),
        decoration: BoxDecoration(color: t.colorScheme.error, borderRadius: BorderRadius.circular(16)),
        child: Icon(Icons.delete, color: t.colorScheme.onError),
      ),
      confirmDismiss: (_) => confirm(context, title: 'Delete watcher?', message: '${w.fromCity} → ${w.toCity} on ${prettyDate(w.journeyDate)}', action: 'Delete'),
      onDismissed: (_) async {
        try {
          await ref.read(apiProvider).deleteWatcher(w.id);
        } catch (e) {
          if (context.mounted) snack(context, friendlyError(e), error: true);
        }
        ref.invalidate(watchersProvider);
      },
      child: Card(
        color: hasSeats ? Colors.green.withValues(alpha: 0.12) : null,
        margin: const EdgeInsets.symmetric(vertical: 4),
        child: InkWell(
          borderRadius: BorderRadius.circular(16),
          onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => WatcherFormScreen(existing: w))),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 8, 12),
            child: Row(children: [
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text('${w.fromCity} → ${w.toCity}', style: t.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700)),
                  const SizedBox(height: 2),
                  Text(w.trainName),
                  const SizedBox(height: 8),
                  Wrap(spacing: 6, runSpacing: 6, children: [
                    StatusChip(prettyDate(w.journeyDate), icon: Icons.event, color: t.colorScheme.primary),
                    StatusChip(w.seatClass, icon: Icons.airline_seat_recline_normal, color: Colors.indigo),
                    if (!w.enabled)
                      const StatusChip('Paused', color: Colors.grey, icon: Icons.pause)
                    else if (hasSeats)
                      StatusChip('$seats seat${seats == 1 ? '' : 's'} available', color: Colors.green, icon: Icons.event_seat)
                    else
                      StatusChip(statusLabel(w.lastCheckStatus), color: _statusColor(w.lastCheckStatus), icon: Icons.info_outline),
                  ]),
                  if (w.warnings.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 6), child: Text(w.warnings.first, style: TextStyle(color: Colors.orange.shade800, fontSize: 12))),
                  if (w.lastCheckedAt != null) Padding(padding: const EdgeInsets.only(top: 4), child: Text('Checked ${ago(w.lastCheckedAt)}', style: t.textTheme.bodySmall)),
                ]),
              ),
              Switch(
                value: w.enabled,
                onChanged: (v) async {
                  try {
                    await ref.read(apiProvider).updateWatcher(w.id, {'enabled': v});
                  } catch (e) {
                    if (context.mounted) snack(context, friendlyError(e), error: true);
                  }
                  ref.invalidate(watchersProvider);
                },
              ),
            ]),
          ),
        ),
      ),
    );
  }

  Color _statusColor(String? s) => switch (s) {
        'ok' => Colors.blueGrey,
        'error' || 'train_not_listed' || 'class_not_offered' => Colors.orange,
        _ => Colors.grey,
      };
}
