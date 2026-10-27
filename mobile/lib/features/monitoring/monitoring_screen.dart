import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/format.dart';
import '../../core/models.dart';
import '../../core/providers.dart';
import '../../widgets/common.dart';

/// "Is it actually working?" — every watcher's latest result and when the next scan runs.
class MonitoringScreen extends ConsumerStatefulWidget {
  const MonitoringScreen({super.key});
  @override
  ConsumerState<MonitoringScreen> createState() => _MonitoringScreenState();
}

class _MonitoringScreenState extends ConsumerState<MonitoringScreen> {
  Timer? _tick;

  @override
  void initState() {
    super.initState();
    _tick = Timer.periodic(const Duration(seconds: 1), (_) => mounted ? setState(() {}) : null);
  }

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final status = ref.watch(statusProvider);
    final watchers = ref.watch(watchersProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Monitoring')),
      body: AsyncView<AppStatus>(
        value: status,
        onRetry: () => ref.invalidate(statusProvider),
        data: (s) => ListView(padding: const EdgeInsets.all(16), children: [
          _EngineSummary(s.engine),
          const SizedBox(height: 8),
          const SectionTitle('Latest result per watcher'),
          ...(watchers.valueOrNull ?? const <Watcher>[]).map((w) => _Row(w, s.engine)),
        ]),
      ),
    );
  }
}

class _EngineSummary extends StatelessWidget {
  const _EngineSummary(this.e);
  final EngineStatus e;
  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final next = e.nextCycleAt?.difference(DateTime.now()).inSeconds;
    final stale = e.lastCycleAt != null && DateTime.now().difference(e.lastCycleAt!).inSeconds > e.cycleSeconds * 4 + 30;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Icon(e.skipReason != null ? Icons.pause_circle : Icons.sync, color: t.colorScheme.primary),
            const SizedBox(width: 10),
            Text(e.skipReason != null ? 'Paused' : e.cycleRunning ? 'Scanning now…' : next != null && next > 0 ? 'Next scan in ${next}s' : 'Scanning soon', style: t.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700)),
          ]),
          const SizedBox(height: 10),
          Text('Scans every ${e.cycleSeconds}s · last scan ${ago(e.lastCycleAt)}${e.lastCycleMs != null ? ' (${e.lastCycleMs}ms, ${e.lastCycleTargets ?? 0} search${e.lastCycleTargets == 1 ? '' : 'es'})' : ''}'),
          if (stale) Padding(padding: const EdgeInsets.only(top: 8), child: Text('No recent scan. The server may be restarting or paused.', style: TextStyle(color: t.colorScheme.error))),
          if (e.rateLimitedUntil != null) const Padding(padding: EdgeInsets.only(top: 8), child: Text('The booking site asked us to slow down; scanning resumes automatically.')),
          if (e.lastError != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text('Last problem: ${e.lastError}', style: t.textTheme.bodySmall)),
        ]),
      ),
    );
  }
}

class _Row extends StatelessWidget {
  const _Row(this.w, this.e);
  final Watcher w;
  final EngineStatus e;
  @override
  Widget build(BuildContext context) {
    final seats = w.availableSeats ?? 0;
    return Card(
      child: ListTile(
        leading: Icon(seats > 0 ? Icons.event_seat : Icons.train, color: seats > 0 ? Colors.green : null),
        title: Text('${w.fromCity} → ${w.toCity}'),
        subtitle: Text('${w.trainName} · ${prettyDate(w.journeyDate)} · ${w.seatClass}\n${!w.enabled ? 'Paused' : statusLabel(w.lastCheckStatus)}${w.lastCheckedAt != null ? ' · ${ago(w.lastCheckedAt)}' : ''}'),
        isThreeLine: true,
        trailing: Text(!w.enabled ? '—' : w.availableSeats == null ? '…' : '$seats', style: Theme.of(context).textTheme.headlineSmall?.copyWith(color: seats > 0 ? Colors.green : null, fontWeight: FontWeight.w700)),
      ),
    );
  }
}
