import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/format.dart';
import '../../core/models.dart';
import '../../core/providers.dart';
import '../../notifications/alert_data.dart';
import '../../widgets/common.dart';
import '../alert/alert_screen.dart';

class HistoryScreen extends ConsumerWidget {
  const HistoryScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final items = ref.watch(historyProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Alert history')),
      body: AsyncView<List<AlertItem>>(
        value: items,
        onRetry: () => ref.invalidate(historyProvider),
        data: (list) {
          if (list.isEmpty) {
            return const Center(child: Padding(padding: EdgeInsets.all(32), child: Text('No alerts yet. When a watched train has seats, it shows up here with how each channel delivered.', textAlign: TextAlign.center)));
          }
          return RefreshIndicator(
            onRefresh: () async {
              ref.invalidate(historyProvider);
              try {
                await ref.read(historyProvider.future);
              } catch (_) {}
            },
            child: ListView.separated(
              padding: const EdgeInsets.all(12),
              itemCount: list.length,
              separatorBuilder: (_, _) => const SizedBox(height: 4),
              itemBuilder: (c, i) => _Tile(list[i]),
            ),
          );
        },
      ),
    );
  }
}

class _Tile extends StatelessWidget {
  const _Tile(this.a);
  final AlertItem a;

  @override
  Widget build(BuildContext context) {
    final seat = a.isSeatAlert;
    return Card(
      child: ListTile(
        leading: Icon(seat ? Icons.event_seat : Icons.lock_clock, color: seat ? Colors.green : Colors.orange),
        title: Text(a.kind == 'test' ? 'Test alert' : a.title, style: const TextStyle(fontWeight: FontWeight.w700)),
        subtitle: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          if (seat) Text('${a.payload['route'] ?? ''} · ${a.payload['trainName'] ?? ''}'),
          Text(clock(a.createdAt) + (a.acknowledgedAt != null ? ' · seen' : '')),
          const SizedBox(height: 6),
          Wrap(spacing: 6, runSpacing: 4, children: a.channels.map(_chip).toList()),
        ]),
        isThreeLine: true,
        trailing: seat && a.url != null ? const Icon(Icons.chevron_right) : null,
        onTap: seat ? () => Navigator.push(context, MaterialPageRoute(builder: (_) => AlertScreen(data: AlertData.fromItem(a)))) : null,
      ),
    );
  }

  Widget _chip(ChannelResult c) {
    final name = c.channel == 'fcm' ? 'Phone' : 'Telegram';
    return switch (c.status) {
      'sent' => StatusChip('$name sent', color: Colors.green, icon: Icons.check),
      'failed' => StatusChip('$name failed', color: Colors.red, icon: Icons.close),
      _ => StatusChip('$name sending…', color: Colors.orange, icon: Icons.hourglass_empty),
    };
  }
}
