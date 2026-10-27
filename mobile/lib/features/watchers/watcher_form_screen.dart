import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../core/api_client.dart';
import '../../core/format.dart';
import '../../core/models.dart';
import '../../core/providers.dart';
import '../../widgets/common.dart';
import '../session/session_screen.dart';

/// Create or edit a watcher. Trains and stations come from the booking site's own
/// catalog, and the stops offered for a train are fetched live, so only journeys that
/// really exist can be picked.
class WatcherFormScreen extends ConsumerStatefulWidget {
  const WatcherFormScreen({super.key, this.existing});
  final Watcher? existing;
  @override
  ConsumerState<WatcherFormScreen> createState() => _WatcherFormScreenState();
}

class _WatcherFormScreenState extends ConsumerState<WatcherFormScreen> {
  String? _train, _from, _to, _class;
  DateTime? _date;
  StationsInfo? _stations;
  bool _loadingStations = false, _verifying = false, _saving = false;
  String? _stationsError;
  VerifyResult? _verify;
  late final String _idemKey = 'w-${DateTime.now().microsecondsSinceEpoch}';

  bool get _editing => widget.existing != null;

  @override
  void initState() {
    super.initState();
    final w = widget.existing;
    if (w != null) {
      _train = w.trainName;
      _from = w.fromCity;
      _to = w.toCity;
      _class = w.seatClass;
      _date = parseIso(w.journeyDate);
      WidgetsBinding.instance.addPostFrameCallback((_) => _loadStations());
    }
  }

  Future<void> _loadStations() async {
    if (_train == null || _date == null) return;
    setState(() {
      _loadingStations = true;
      _stationsError = null;
    });
    try {
      final info = await ref.read(apiProvider).stations(_train!, isoOf(_date!));
      if (!mounted) return;
      setState(() {
        _stations = info;
        // A previously picked station that this train does not serve is dropped.
        if (_from != null && !info.stations.contains(_from)) _from = null;
        if (_to != null && !info.stations.contains(_to)) _to = null;
      });
    } catch (e) {
      if (mounted) {
        setState(() {
          _stations = null;
          _stationsError = friendlyError(e);
        });
      }
    } finally {
      if (mounted) setState(() => _loadingStations = false);
    }
  }

  List<String> _fromOptions(CatalogData c) =>
      _stations?.stations ?? c.cities.where((x) => x.canDepart).map((x) => x.name).toList();

  List<String> _toOptions(CatalogData c) {
    final s = _stations?.stations;
    if (s != null && _from != null && s.contains(_from)) return s.sublist(s.indexOf(_from!) + 1); // a train only sells forward
    return c.cities.map((x) => x.name).where((n) => n != _from).toList();
  }

  String? _weekdayWarning() {
    final days = _stations?.days;
    if (days == null || days.isEmpty || _date == null) return null;
    final d = DateFormat('E').format(_date!);
    return days.contains(d) ? null : 'This train does not run on ${DateFormat('EEEE').format(_date!)}s.';
  }

  Map<String, dynamic> _body() => {
        'fromCity': _from,
        'toCity': _to,
        'journeyDate': isoOf(_date!),
        'trainName': _train,
        'seatClass': _class,
      };

  bool get _complete => _train != null && _from != null && _to != null && _class != null && _date != null;

  Future<void> _check() async {
    setState(() {
      _verifying = true;
      _verify = null;
    });
    try {
      final r = await ref.read(apiProvider).verify(_body());
      if (mounted) setState(() => _verify = r);
    } on ApiException catch (e) {
      if (!mounted) return;
      if (e.needsRailwayLogin) {
        snack(context, 'Log in to Railway first to check live availability.', error: true);
      } else {
        snack(context, e.message, error: true);
      }
    } finally {
      if (mounted) setState(() => _verifying = false);
    }
  }

  Future<void> _save() async {
    setState(() => _saving = true);
    try {
      final api = ref.read(apiProvider);
      final r = _editing ? await api.updateWatcher(widget.existing!.id, _body()) : await api.createWatcher(_body(), idempotencyKey: _idemKey);
      ref.invalidate(watchersProvider);
      ref.invalidate(statusProvider);
      if (!mounted) return;
      if (r.warnings.isNotEmpty) snack(context, r.warnings.first);
      Navigator.pop(context);
    } catch (e) {
      if (mounted) snack(context, friendlyError(e), error: true);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _delete() async {
    if (!await confirm(context, title: 'Delete watcher?', message: 'You will stop getting alerts for this journey.', action: 'Delete')) return;
    try {
      await ref.read(apiProvider).deleteWatcher(widget.existing!.id);
      ref.invalidate(watchersProvider);
      if (mounted) Navigator.pop(context);
    } catch (e) {
      if (mounted) snack(context, friendlyError(e), error: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final catalog = ref.watch(catalogProvider);
    return Scaffold(
      appBar: AppBar(
        title: Text(_editing ? 'Edit watcher' : 'New watcher'),
        actions: [if (_editing) IconButton(onPressed: _delete, icon: const Icon(Icons.delete_outline), tooltip: 'Delete')],
      ),
      body: AsyncView<CatalogData>(
        value: catalog,
        onRetry: () => ref.invalidate(catalogProvider),
        data: (c) => c.isEmpty ? _noCatalog() : _form(c),
      ),
    );
  }

  Widget _noCatalog() => Center(
        child: Padding(
          padding: const EdgeInsets.all(28),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            const Icon(Icons.lock_clock, size: 56),
            const SizedBox(height: 12),
            const Text('Log in to Railway first', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
            const SizedBox(height: 8),
            const Text('The station and train lists come from the booking site, which the app loads when you log in.', textAlign: TextAlign.center),
            const SizedBox(height: 16),
            FilledButton(
              onPressed: () async {
                await Navigator.push(context, MaterialPageRoute(builder: (_) => const SessionScreen()));
                ref.invalidate(catalogProvider);
              },
              child: const Text('Log in'),
            ),
          ]),
        ),
      );

  Widget _form(CatalogData c) {
    final t = Theme.of(context);
    final today = DateTime.now();
    final last = today.add(Duration(days: c.searchDayLimit ?? 10));
    final weekday = _weekdayWarning();

    Widget tile({required IconData icon, required String label, required String? value, required VoidCallback? onTap, String? hint}) => Card(
          child: ListTile(
            leading: Icon(icon),
            title: Text(label, style: t.textTheme.bodySmall),
            subtitle: Text(value ?? hint ?? 'Choose', style: t.textTheme.titleMedium?.copyWith(color: value == null ? t.colorScheme.outline : null)),
            trailing: const Icon(Icons.arrow_drop_down),
            onTap: onTap,
          ),
        );

    return ListView(padding: const EdgeInsets.all(16), children: [
      tile(
        icon: Icons.train,
        label: 'Train',
        value: _train,
        onTap: () async {
          final p = await showSearchPicker<TrainInfo>(context, title: 'Choose train', items: c.trains, label: (x) => x.name);
          if (p == null) return;
          setState(() {
            _train = p.name;
            _stations = null;
            _verify = null;
          });
          _loadStations();
        },
      ),
      tile(
        icon: Icons.event,
        label: 'Journey date',
        value: _date == null ? null : DateFormat('EEE, d MMM yyyy').format(_date!),
        hint: 'Booking opens ${c.searchDayLimit ?? 10} days ahead',
        onTap: () async {
          final d = await showDatePicker(context: context, initialDate: _date ?? today, firstDate: DateTime(today.year, today.month, today.day), lastDate: last);
          if (d == null) return;
          setState(() {
            _date = d;
            _stations = null;
            _verify = null;
          });
          _loadStations();
        },
      ),
      if (_loadingStations)
        const Padding(padding: EdgeInsets.symmetric(vertical: 8), child: LinearProgressIndicator())
      else if (_stationsError != null)
        Card(
          color: t.colorScheme.errorContainer,
          child: ListTile(
            leading: const Icon(Icons.info_outline),
            title: const Text("Couldn't load this train's stops"),
            subtitle: Text('$_stationsError\nShowing all stations instead; the check below will confirm the journey exists.'),
            trailing: TextButton(onPressed: _loadStations, child: const Text('Retry')),
          ),
        ),
      if (weekday != null) Card(color: Colors.orange.withValues(alpha: 0.15), child: ListTile(leading: const Icon(Icons.warning_amber, color: Colors.orange), title: Text(weekday))),
      tile(
        icon: Icons.trip_origin,
        label: 'From',
        value: _from,
        hint: _stations != null ? "Stops on this train" : 'Choose station',
        onTap: () async {
          final p = await showSearchPicker<String>(context, title: 'Departure station', items: _fromOptions(c), label: (x) => x);
          if (p != null) {
            setState(() {
              _from = p;
              if (_to == p) _to = null;
              _verify = null;
            });
          }
        },
      ),
      tile(
        icon: Icons.place,
        label: 'To',
        value: _to,
        hint: _stations != null && _from != null ? 'Stops after $_from' : 'Choose station',
        onTap: () async {
          final p = await showSearchPicker<String>(context, title: 'Destination station', items: _toOptions(c), label: (x) => x);
          if (p != null) {
            setState(() {
              _to = p;
              _verify = null;
            });
          }
        },
      ),
      tile(
        icon: Icons.airline_seat_recline_normal,
        label: 'Seat class',
        value: _class,
        onTap: () async {
          final p = await showSearchPicker<String>(context, title: 'Seat class', items: c.classes, label: (x) => x);
          if (p != null) {
            setState(() {
              _class = p;
              _verify = null;
            });
          }
        },
      ),
      const SizedBox(height: 8),
      OutlinedButton.icon(
        onPressed: _complete && !_verifying ? _check : null,
        icon: _verifying ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)) : const Icon(Icons.fact_check_outlined),
        label: const Text('Check this journey now'),
        style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(48)),
      ),
      if (_verify != null) _VerifyCard(_verify!),
      const SizedBox(height: 16),
      FilledButton.icon(
        onPressed: _complete && !_saving ? _save : null,
        icon: _saving ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)) : const Icon(Icons.save),
        label: Text(_editing ? 'Save changes' : 'Start watching'),
        style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(52)),
      ),
      const SizedBox(height: 24),
    ]);
  }
}

class _VerifyCard extends StatelessWidget {
  const _VerifyCard(this.r);
  final VerifyResult r;
  @override
  Widget build(BuildContext context) {
    final (color, icon, title) = !r.trainListed
        ? (Colors.orange, Icons.help_outline, "That train isn't on this search")
        : !r.classOffered
            ? (Colors.orange, Icons.help_outline, "This train doesn't offer that class here")
            : r.availableSeats > 0
                ? (Colors.green, Icons.event_seat, '${r.availableSeats} seat${r.availableSeats == 1 ? '' : 's'} available right now')
                : (Colors.blueGrey, Icons.check_circle_outline, 'Journey found, no seats right now');
    return Card(
      color: color.withValues(alpha: 0.12),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [Icon(icon, color: color), const SizedBox(width: 10), Expanded(child: Text(title, style: const TextStyle(fontWeight: FontWeight.w700)))]),
          if (!r.trainListed && r.trainsOnThisSearch.isNotEmpty)
            Padding(padding: const EdgeInsets.only(top: 8), child: Text('Trains on this route and date: ${r.trainsOnThisSearch.join(', ')}', style: Theme.of(context).textTheme.bodySmall)),
        ]),
      ),
    );
  }
}
