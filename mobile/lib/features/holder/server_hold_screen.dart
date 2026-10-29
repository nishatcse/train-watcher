import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../core/providers.dart';
import '../../widgets/common.dart';
import 'holder_remote.dart';
import 'remote_hold_ui.dart';
import 'seat_holder_config.dart';

/// Runs the seat hold on the server instead of this phone: the app only sends the settings and shows what the
/// worker is doing. The phone can be locked, closed or offline; Stop here releases the seats.
class ServerHoldScreen extends ConsumerStatefulWidget {
  const ServerHoldScreen({super.key});
  @override
  ConsumerState<ServerHoldScreen> createState() => _ServerHoldScreenState();
}

class _ServerHoldScreenState extends ConsumerState<ServerHoldScreen> {
  static const _prefsKey =
      'seat_holder_config'; // shared with the on-phone holder, so the form is already filled
  static const _months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];

  final _from = TextEditingController();
  final _to = TextEditingController();
  final _train = TextEditingController();
  final _date = TextEditingController();
  final _class = TextEditingController(text: 'S_CHAIR');
  final _bogie = TextEditingController();
  final _seats = TextEditingController();
  final _hold = TextEditingController(text: '375');
  int _count = 2;
  DateTime? _stopAt;

  RemoteHoldView? _view;
  Object? _error;
  bool _busy = false;
  Timer? _poll;

  @override
  void initState() {
    super.initState();
    _loadSaved();
    _refresh();
    _poll = Timer.periodic(const Duration(seconds: 4), (_) => _refresh());
  }

  @override
  void dispose() {
    _poll?.cancel();
    for (final c in [
      _from,
      _to,
      _train,
      _date,
      _class,
      _bogie,
      _seats,
      _hold,
    ]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _loadSaved() async {
    try {
      final raw = (await SharedPreferences.getInstance()).getString(_prefsKey);
      if (raw == null || !mounted) return;
      final c = SeatHolderConfig.fromJson(
        (jsonDecode(raw) as Map).cast<String, dynamic>(),
      );
      setState(() {
        _from.text = c.fromCity;
        _to.text = c.toCity;
        _train.text = c.trainName;
        _date.text = c.journeyDate;
        _class.text = c.seatClass;
        _bogie.text = c.bogieName;
        _seats.text = c.seatNumbers;
        _hold.text = c.holdDurationSeconds.round().toString();
        _count = c.seatCount;
        _stopAt = c.stopAt;
      });
    } catch (_) {}
  }

  Future<void> _refresh() async {
    try {
      final j = await ref.read(apiProvider).currentHold();
      if (!mounted) return;
      setState(() {
        _view = RemoteHoldView.fromJson(j);
        _error = null;
      });
    } catch (e) {
      if (mounted) setState(() => _error = e);
    }
  }

  /// "07-Nov-2026" -> "2026-11-07"; null when it is not a date.
  String? _isoDate(String site) {
    final p = site.trim().split('-');
    if (p.length != 3) return null;
    final m = _months.indexWhere((x) => x.toLowerCase() == p[1].toLowerCase());
    final d = int.tryParse(p[0]);
    final y = int.tryParse(p[2]);
    if (m < 0 || d == null || y == null) return null;
    return '${y.toString().padLeft(4, '0')}-${(m + 1).toString().padLeft(2, '0')}-${d.toString().padLeft(2, '0')}';
  }

  String _fmtDate(DateTime d) =>
      '${d.day.toString().padLeft(2, '0')}-${_months[d.month - 1]}-${d.year}';

  String _fmtTime(DateTime d) {
    final h = d.hour % 12 == 0 ? 12 : d.hour % 12;
    return '${d.day} ${_months[d.month - 1]} ${d.year}, $h:${d.minute.toString().padLeft(2, '0')} ${d.hour < 12 ? 'AM' : 'PM'}';
  }

  Future<void> _pickDate() async {
    final now = DateTime.now();
    final p = await showDatePicker(
      context: context,
      initialDate: now,
      firstDate: now,
      lastDate: now.add(const Duration(days: 120)),
    );
    if (p != null) setState(() => _date.text = _fmtDate(p));
  }

  Future<void> _pickStop() async {
    final now = DateTime.now();
    final d = await showDatePicker(
      context: context,
      initialDate: now,
      firstDate: now,
      lastDate: now.add(const Duration(days: 120)),
    );
    if (d == null || !mounted) return;
    final t = await showTimePicker(
      context: context,
      initialTime: TimeOfDay.fromDateTime(now.add(const Duration(hours: 1))),
    );
    if (t == null) return;
    setState(
      () => _stopAt = DateTime(d.year, d.month, d.day, t.hour, t.minute),
    );
  }

  Future<void> _start() async {
    final iso = _isoDate(_date.text);
    if (iso == null) {
      snack(context, 'Pick the journey date (e.g. 07-Nov-2026).');
      return;
    }
    setState(() => _busy = true);
    try {
      await ref.read(apiProvider).startHold({
        'fromCity': _from.text.trim(),
        'toCity': _to.text.trim(),
        'trainName': _train.text.trim(),
        'journeyDate': iso,
        'seatClass': _class.text.trim(),
        'bogieName': _bogie.text.trim(),
        'seatNumbers': _seats.text.trim(),
        'seatCount': _count,
        'holdSeconds': double.tryParse(_hold.text.trim())?.round() ?? 375,
        'stopAt': _stopAt?.toUtc().toIso8601String(),
      });
      await _refresh();
    } catch (e) {
      if (mounted) snack(context, friendlyError(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _stop(String id) async {
    setState(() => _busy = true);
    try {
      await ref.read(apiProvider).stopHold(id);
      await _refresh();
    } catch (e) {
      if (mounted) snack(context, friendlyError(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final hold = _view?.hold;
    final active = hold?.active ?? false;

    return Scaffold(
      appBar: AppBar(title: const Text('Seat Holder on the server')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Text(
            'Runs on the server, so this phone can be locked or closed. Stop here to release the seats.',
            style: t.textTheme.bodySmall,
          ),
          const SizedBox(height: 12),
          if (_error != null && _view == null)
            ErrorPanel(error: _error!, onRetry: _refresh),
          if (hold != null) _statusCard(hold),
          if (_view != null && _view!.events.isNotEmpty) _eventsCard(),
          const SizedBox(height: 8),
          if (!active) ..._form(t),
        ],
      ),
    );
  }

  Widget _statusCard(RemoteHold h) => RemoteHoldPanel(
    view: _view!,
    footer: h.active
        ? SizedBox(
            width: double.infinity,
            child: FilledButton.icon(
              style: FilledButton.styleFrom(
                backgroundColor: Colors.red.shade700,
                padding: const EdgeInsets.symmetric(vertical: 14),
              ),
              onPressed: _busy || h.status == 'stopping'
                  ? null
                  : () => _stop(h.id),
              icon: const Icon(Icons.stop),
              label: Text(
                h.status == 'stopping'
                    ? 'Releasing the seats…'
                    : 'Stop and release seats',
              ),
            ),
          )
        : null,
  );

  Widget _eventsCard() {
    final events = _view!.events;
    return Card(
      child: ExpansionTile(
        title: const Text('Activity log'),
        subtitle: Text(
          events.first.message,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: const TextStyle(fontSize: 12),
        ),
        children: [
          SizedBox(
            height: 260,
            child: ListView.builder(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
              itemCount: events.length,
              itemBuilder: (_, i) {
                final e = events[i];
                final hh = e.at.hour.toString().padLeft(2, '0');
                final mm = e.at.minute.toString().padLeft(2, '0');
                final ss = e.at.second.toString().padLeft(2, '0');
                return Padding(
                  padding: const EdgeInsets.symmetric(vertical: 2),
                  child: Text(
                    '[$hh:$mm:$ss] ${e.message}',
                    style: const TextStyle(
                      fontFamily: 'monospace',
                      fontSize: 11,
                    ),
                  ),
                );
              },
            ),
          ),
        ],
      ),
    );
  }

  List<Widget> _form(ThemeData t) => [
    const SizedBox(height: 8),
    Text('New hold', style: t.textTheme.titleMedium),
    Row(
      children: [
        Expanded(
          child: TextField(
            controller: _from,
            decoration: const InputDecoration(labelText: 'From'),
          ),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: TextField(
            controller: _to,
            decoration: const InputDecoration(labelText: 'To'),
          ),
        ),
      ],
    ),
    Row(
      children: [
        Expanded(
          child: TextField(
            controller: _train,
            decoration: const InputDecoration(
              labelText: 'Train (e.g. TURNA EXPRESS (741))',
            ),
          ),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: TextField(
            controller: _date,
            decoration: InputDecoration(
              labelText: 'Date',
              suffixIcon: IconButton(
                icon: const Icon(Icons.calendar_month),
                onPressed: _pickDate,
              ),
            ),
          ),
        ),
      ],
    ),
    Row(
      children: [
        Expanded(
          child: TextField(
            controller: _bogie,
            decoration: const InputDecoration(labelText: 'Bogie (optional)'),
          ),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: TextField(
            controller: _seats,
            decoration: const InputDecoration(labelText: 'Seats (KA-1,KA-2)'),
          ),
        ),
      ],
    ),
    Row(
      children: [
        Expanded(
          child: TextField(
            controller: _class,
            decoration: const InputDecoration(labelText: 'Class'),
          ),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: TextField(
            controller: _hold,
            keyboardType: TextInputType.number,
            decoration: const InputDecoration(
              labelText: 'Hold (seconds)',
              helperText: '375 = 6 min 15 s, minimum 60',
            ),
          ),
        ),
      ],
    ),
    Row(
      children: [
        const Text('Seats if none named: '),
        DropdownButton<int>(
          value: _count,
          items: [
            1,
            2,
            3,
            4,
          ].map((c) => DropdownMenuItem(value: c, child: Text('$c'))).toList(),
          onChanged: (v) => setState(() => _count = v ?? 2),
        ),
      ],
    ),
    Row(
      children: [
        Expanded(
          child: Text(
            _stopAt == null
                ? 'No end time: runs until you stop it'
                : 'Runs until ${_fmtTime(_stopAt!)}',
          ),
        ),
        TextButton.icon(
          onPressed: _pickStop,
          icon: const Icon(Icons.schedule),
          label: Text(_stopAt == null ? 'Set end' : 'Change'),
        ),
        if (_stopAt != null)
          IconButton(
            onPressed: () => setState(() => _stopAt = null),
            icon: const Icon(Icons.clear),
          ),
      ],
    ),
    const SizedBox(height: 8),
    FilledButton.icon(
      style: FilledButton.styleFrom(backgroundColor: Colors.green.shade700),
      onPressed: _busy ? null : _start,
      icon: const Icon(Icons.cloud_upload),
      label: const Text('Start on the server'),
    ),
  ];
}
