import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:webview_flutter/webview_flutter.dart';
import 'package:webview_flutter_android/webview_flutter_android.dart';

import 'hold_guard.dart';
import 'hold_panel.dart';
import 'seat_automation_js.dart';
import 'seat_holder_config.dart';
import 'seat_holder_controller.dart';
import 'server_hold_screen.dart';

class SeatHolderScreen extends ConsumerStatefulWidget {
  const SeatHolderScreen({super.key, this.initialConfig, this.resume = false});
  final SeatHolderConfig? initialConfig;

  /// The app was restarted while a hold was active (killed, swiped away, rebooted): carry on by itself.
  final bool resume;

  @override
  ConsumerState<SeatHolderScreen> createState() => _SeatHolderScreenState();
}

class _SeatHolderScreenState extends ConsumerState<SeatHolderScreen> {
  late final WebViewController _controller;
  int _progress = 0;
  bool _configExpanded = true;

  static const _prefsKey = 'seat_holder_config';
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

  /// The site's date format, e.g. 07-Nov-2026.
  static String _fmtDate(DateTime d) =>
      '${d.day.toString().padLeft(2, '0')}-${_months[d.month - 1]}-${d.year}';

  static DateTime? _parseDate(String text) {
    final p = text.trim().split('-');
    if (p.length != 3) return null;
    final m = _months.indexWhere((x) => x.toLowerCase() == p[1].toLowerCase());
    final d = int.tryParse(p[0]);
    final y = int.tryParse(p[2]);
    return (m < 0 || d == null || y == null) ? null : DateTime(y, m + 1, d);
  }

  static String _fmtStop(DateTime d) {
    final h = d.hour % 12 == 0 ? 12 : d.hour % 12;
    return '${d.day} ${_months[d.month - 1]} ${d.year}, $h:${d.minute.toString().padLeft(2, '0')} ${d.hour < 12 ? 'AM' : 'PM'}';
  }

  late final TextEditingController _trainController;
  late final TextEditingController _dateController;
  late final TextEditingController _fromController;
  late final TextEditingController _toController;
  late final TextEditingController _classController;
  late final TextEditingController _bogieController;
  late final TextEditingController _seatNumbersController;
  late final TextEditingController _durationController;

  @override
  void initState() {
    super.initState();

    final cfg =
        widget.initialConfig ??
        const SeatHolderConfig(
          fromCity: 'Chattogram',
          toCity: 'Dhaka',
          journeyDate: '07-Nov-2026',
          trainName: 'TURNA EXPRESS (741)',
          seatClass: 'S_CHAIR',
          seatCount: 2,
          holdDurationSeconds: 375,
        );

    _trainController = TextEditingController(text: cfg.trainName);
    _dateController = TextEditingController(text: cfg.journeyDate);
    _fromController = TextEditingController(text: cfg.fromCity);
    _toController = TextEditingController(text: cfg.toCity);
    _classController = TextEditingController(text: cfg.seatClass);
    _bogieController = TextEditingController(text: cfg.bogieName);
    _seatNumbersController = TextEditingController(text: cfg.seatNumbers);
    _durationController = TextEditingController(
      text: cfg.holdDurationSeconds.toString(),
    );

    _controller = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..addJavaScriptChannel(
        SeatAutomationJs.bridgeChannelName,
        onMessageReceived: (message) {
          ref
              .read(seatHolderProvider.notifier)
              .handleBridgeMessage(message.message);
        },
      )
      ..setNavigationDelegate(
        NavigationDelegate(
          onProgress: (p) {
            if (mounted) setState(() => _progress = p);
          },
          onPageFinished: (_) {
            _controller.runJavaScript(SeatAutomationJs.initBridge());
          },
        ),
      )
      ..loadRequest(Uri.parse(cfg.buildSearchUrl()));

    // chrome://inspect can attach to the page in debug builds, to check the automation's selectors.
    if (kDebugMode && _controller.platform is AndroidWebViewController) {
      AndroidWebViewController.enableDebugging(true);
    }

    WidgetsBinding.instance.addPostFrameCallback((_) {
      ref.read(seatHolderProvider.notifier)
        ..updateConfig(cfg)
        ..attachWebViewController(_controller);
      HoldGuard.listen();
      HoldGuard.inPip.addListener(_onPip);
      HoldGuard.mode().then((m) {
        // "Background" is no longer offered: a hidden page is slowed down by Android and releases lag.
        if (m == HoldGuard.modeFree) {
          m = HoldGuard.modePip;
          HoldGuard.setMode(m);
        }
        if (mounted) setState(() => _mode = m);
      });
      if (widget.resume) {
        _resumeHold();
      } else {
        if (widget.initialConfig == null) _loadSaved();
        _checkPermissions();
      }
    });
  }

  void _fill(SeatHolderConfig c) {
    _trainController.text = c.trainName;
    _dateController.text = c.journeyDate;
    _fromController.text = c.fromCity;
    _toController.text = c.toCity;
    _classController.text = c.seatClass;
    _bogieController.text = c.bogieName;
    _seatNumbersController.text = c.seatNumbers;
    _durationController.text = c.holdDurationSeconds.toString();
  }

  /// Brings back what was typed last time, so a long setup is not retyped on every launch.
  String _mode = HoldGuard.modePip;
  bool _inPip = false;
  final _webKey = GlobalKey();

  void _onPip() {
    if (mounted) setState(() => _inPip = HoldGuard.inPip.value);
  }

  bool _needsBattery = false;
  bool _needsOverlay = false;

  Future<void> _checkPermissions() async {
    final p = await HoldGuard.permissions();
    if (!mounted) return;
    setState(() {
      _needsBattery = !p.battery;
      _needsOverlay = !p.overlay;
    });
  }

  /// Restarts the saved hold after the app came back from being killed. Gives up (and tells the guard) when
  /// the saved end time has already passed, rather than holding with no end.
  Future<void> _resumeHold() async {
    try {
      final raw = (await SharedPreferences.getInstance()).getString(_prefsKey);
      final json = raw == null
          ? null
          : (jsonDecode(raw) as Map).cast<String, dynamic>();
      final stop = DateTime.tryParse((json?['stopAt'] ?? '').toString());
      if (json == null || (stop != null && !stop.isAfter(DateTime.now()))) {
        await HoldGuard.stop();
        return;
      }
      final saved = SeatHolderConfig.fromJson(json);
      _fill(saved);
      final notifier = ref.read(seatHolderProvider.notifier)
        ..updateConfig(saved);
      await notifier.startHolding(resumed: true);
    } catch (_) {
      await HoldGuard.stop();
    }
  }

  Future<void> _loadSaved() async {
    try {
      final raw = (await SharedPreferences.getInstance()).getString(_prefsKey);
      if (raw == null || !mounted) return;
      final saved = SeatHolderConfig.fromJson(
        (jsonDecode(raw) as Map).cast<String, dynamic>(),
      );
      _fill(saved);
      ref.read(seatHolderProvider.notifier).updateConfig(saved);
    } catch (_) {
      // nothing saved or unreadable: keep the defaults
    }
  }

  Future<void> _save(SeatHolderConfig c) async {
    try {
      await (await SharedPreferences.getInstance()).setString(
        _prefsKey,
        jsonEncode(c.toJson()),
      );
    } catch (_) {}
  }

  Future<void> _pickDate() async {
    final now = DateTime.now();
    final initial = _parseDate(_dateController.text) ?? now;
    final picked = await showDatePicker(
      context: context,
      initialDate: initial.isBefore(now) ? now : initial,
      firstDate: now,
      lastDate: now.add(const Duration(days: 120)),
    );
    if (picked == null) return;
    _dateController.text = _fmtDate(picked);
    _syncConfigFromInputs();
  }

  @override
  void dispose() {
    HoldGuard.inPip.removeListener(_onPip);
    _trainController.dispose();
    _dateController.dispose();
    _fromController.dispose();
    _toController.dispose();
    _classController.dispose();
    _bogieController.dispose();
    _seatNumbersController.dispose();
    _durationController.dispose();
    super.dispose();
  }

  void _syncConfigFromInputs() {
    final current = ref.read(seatHolderProvider).config;
    final updated = current.copyWith(
      trainName: _trainController.text.trim(),
      journeyDate: _dateController.text.trim(),
      fromCity: _fromController.text.trim(),
      toCity: _toController.text.trim(),
      seatClass: _classController.text.trim().toUpperCase(),
      bogieName: _bogieController.text.trim(),
      seatNumbers: _seatNumbersController.text.trim(),
      holdDurationSeconds:
          (double.tryParse(_durationController.text.trim()) ?? 375).clamp(
            SeatHolderConfig.minHoldSeconds,
            3600.0,
          ),
    );
    ref.read(seatHolderProvider.notifier).updateConfig(updated);
  }

  Future<void> _pickStopTime() async {
    final now = DateTime.now();
    final pickedDate = await showDatePicker(
      context: context,
      initialDate: now,
      firstDate: now,
      lastDate: now.add(const Duration(days: 120)),
    );
    if (pickedDate == null || !mounted) return;

    final pickedTime = await showTimePicker(
      context: context,
      initialTime: TimeOfDay.fromDateTime(now.add(const Duration(hours: 1))),
    );
    if (pickedTime == null || !mounted) return;

    final stopDateTime = DateTime(
      pickedDate.year,
      pickedDate.month,
      pickedDate.day,
      pickedTime.hour,
      pickedTime.minute,
    );

    final current = ref.read(seatHolderProvider).config;
    ref
        .read(seatHolderProvider.notifier)
        .updateConfig(current.copyWith(stopAt: stopDateTime));
  }

  void _showLogsBottomSheet() {
    showModalBottomSheet(
      context: context,
      builder: (context) {
        return Consumer(
          builder: (context, ref, _) {
            final logs = ref.watch(seatHolderProvider.select((s) => s.logs));
            return Container(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      const Text(
                        'Holding Activity Logs',
                        style: TextStyle(
                          fontSize: 18,
                          fontWeight: FontWeight.bold,
                        ),
                      ),
                      IconButton(
                        onPressed: () => Navigator.pop(context),
                        icon: const Icon(Icons.close),
                      ),
                    ],
                  ),
                  const Divider(),
                  Expanded(
                    child: logs.isEmpty
                        ? const Center(child: Text('No logs recorded yet.'))
                        : ListView.builder(
                            itemCount: logs.length,
                            itemBuilder: (context, i) => Padding(
                              padding: const EdgeInsets.symmetric(vertical: 2),
                              child: Text(
                                logs[i],
                                style: const TextStyle(
                                  fontFamily: 'monospace',
                                  fontSize: 12,
                                ),
                              ),
                            ),
                          ),
                  ),
                ],
              ),
            );
          },
        );
      },
    );
  }

  static String _mmss(double seconds) {
    final t = seconds.ceil();
    return '${t ~/ 60}:${(t % 60).toString().padLeft(2, '0')}';
  }

  @override
  Widget build(BuildContext context) {
    final holderState = ref.watch(seatHolderProvider);
    final theme = Theme.of(context);
    final running = holderState.isLoopRunning;

    final (statusColor, statusLabel) = switch (holderState.status) {
      SeatHolderStatus.holding => (
        Colors.green,
        'HOLDING ${_mmss(holderState.secondsRemaining)}',
      ),
      SeatHolderStatus.selecting => (Colors.blue, 'SELECTING SEATS'),
      SeatHolderStatus.unselecting => (Colors.orange, 'UNSELECTING'),
      SeatHolderStatus.reselecting => (Colors.teal, 'RE-SELECTING'),
      SeatHolderStatus.navigatingToSeats => (Colors.purple, 'OPENING LAYOUT'),
      SeatHolderStatus.loadingPage => (Colors.indigo, 'LOADING SEARCH'),
      SeatHolderStatus.error => (theme.colorScheme.error, 'ERROR'),
      SeatHolderStatus.completed => (Colors.grey, 'FINISHED'),
      SeatHolderStatus.offline => (Colors.deepOrange, 'NO INTERNET - WAITING'),
      SeatHolderStatus.limited => (Colors.red, 'SITE LIMIT - PAUSED'),
      _ => (Colors.grey.shade600, 'IDLE'),
    };

    if (_inPip) {
      // The small floating window: just the essentials, and the page kept alive (a hidden page is throttled).
      return Scaffold(
        body: SafeArea(
          child: Column(
            children: [
              Padding(
                padding: const EdgeInsets.all(6),
                child: Column(
                  children: [
                    Text(
                      statusLabel,
                      textAlign: TextAlign.center,
                      style: TextStyle(
                        color: statusColor,
                        fontWeight: FontWeight.bold,
                        fontSize: 13,
                      ),
                    ),
                    Text(
                      'Cycles ${holderState.cycleCount}${holderState.heldSeats.isEmpty ? '' : ' · ${holderState.heldSeats.join(', ')}'}',
                      textAlign: TextAlign.center,
                      style: const TextStyle(fontSize: 11),
                    ),
                  ],
                ),
              ),
              Expanded(
                child: WebViewWidget(key: _webKey, controller: _controller),
              ),
            ],
          ),
        ),
      );
    }

    return PopScope(
      // Leaving while seats are held would strand them until the site's own timeout, so release first.
      canPop: !holderState.isLoopRunning,
      onPopInvokedWithResult: (didPop, _) async {
        if (didPop) return;
        final stop = await showDialog<bool>(
          context: context,
          builder: (ctx) => AlertDialog(
            title: const Text('Stop holding?'),
            content: const Text(
              'Leaving stops the seat holder and releases the seats. To keep it running, stay on this screen.',
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(ctx, false),
                child: const Text('Keep holding'),
              ),
              FilledButton(
                onPressed: () => Navigator.pop(ctx, true),
                child: const Text('Stop & leave'),
              ),
            ],
          ),
        );
        if (stop != true) return;
        await ref.read(seatHolderProvider.notifier).stopHolding();
        if (context.mounted) Navigator.pop(context);
      },
      child: Scaffold(
        appBar: AppBar(
          title: const Text('Seat Holder (Auto Loop)'),
          actions: [
            IconButton(
              icon: const Icon(Icons.cloud_upload_outlined),
              tooltip: 'Run on the server instead',
              onPressed: running
                  ? null
                  : () => Navigator.push(
                      context,
                      MaterialPageRoute(
                        builder: (_) => const ServerHoldScreen(),
                      ),
                    ),
            ),
            IconButton(
              icon: const Icon(Icons.list_alt),
              tooltip: 'View Logs',
              onPressed: _showLogsBottomSheet,
            ),
            IconButton(
              icon: const Icon(Icons.refresh),
              tooltip: 'Reload Site',
              onPressed: () => _controller.reload(),
            ),
          ],
          bottom: _progress < 100
              ? PreferredSize(
                  preferredSize: const Size.fromHeight(3),
                  child: LinearProgressIndicator(value: _progress / 100),
                )
              : null,
        ),
        body: Column(
          children: [
            Expanded(
              flex: 5,
              child: SingleChildScrollView(
                child: Column(
                  children: [
                    if (_needsBattery || _needsOverlay)
                      Card(
                        margin: const EdgeInsets.fromLTRB(12, 12, 12, 0),
                        color: theme.colorScheme.errorContainer,
                        child: Padding(
                          padding: const EdgeInsets.all(12),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                'To keep holding when the phone sleeps, or if the app is swiped away, allow:',
                                style: TextStyle(
                                  color: theme.colorScheme.onErrorContainer,
                                  fontWeight: FontWeight.w600,
                                ),
                              ),
                              Wrap(
                                spacing: 8,
                                children: [
                                  if (_needsBattery)
                                    TextButton(
                                      onPressed:
                                          HoldGuard.requestUnrestrictedBattery,
                                      child: const Text('Battery: no limits'),
                                    ),
                                  if (_needsOverlay)
                                    TextButton(
                                      onPressed: HoldGuard.requestOverlay,
                                      child: const Text(
                                        'Display over other apps',
                                      ),
                                    ),
                                  TextButton(
                                    onPressed: _checkPermissions,
                                    child: const Text('Done, check again'),
                                  ),
                                ],
                              ),
                            ],
                          ),
                        ),
                      ),
                    // Live picture of the hold: train, coach, seats held, countdown, end time
                    Padding(
                      padding: const EdgeInsets.all(12),
                      child: HoldPanel(
                        active: holderState.isLoopRunning,
                        trainName: holderState.config.trainName,
                        fromCity: holderState.config.fromCity,
                        toCity: holderState.config.toCity,
                        journeyDate: holderState.config.journeyDate,
                        seatClass: holderState.config.seatClass,
                        coach: holderState.config.bogieName,
                        wantedSeats: holderState.config.targetSeatList,
                        heldSeats: holderState.heldSeats,
                        autoSeatCount: holderState.config.seatCount,
                        statusLabel: statusLabel,
                        statusColor: statusColor,
                        secondsLeft:
                            holderState.status == SeatHolderStatus.holding
                            ? holderState.secondsRemaining
                            : null,
                        totalSeconds: holderState.config.holdDurationSeconds,
                        busy:
                            running &&
                            const {
                              SeatHolderStatus.selecting,
                              SeatHolderStatus.reselecting,
                              SeatHolderStatus.unselecting,
                              SeatHolderStatus.loadingPage,
                              SeatHolderStatus.navigatingToSeats,
                            }.contains(holderState.status),
                        cycles: holderState.cycleCount,
                        stopAt: holderState.config.stopAt,
                        detail: switch (holderState.status) {
                          SeatHolderStatus.offline =>
                            'No internet. Waiting for it to come back before touching the seats.',
                          SeatHolderStatus.limited =>
                            'The site blocked seat selection. Nothing is sent until the block ends.',
                          SeatHolderStatus.unselecting =>
                            'Releasing the seats; the next round starts as soon as the site confirms.',
                          _ => '',
                        },
                        warning: holderState.status == SeatHolderStatus.error
                            ? holderState.errorMessage
                            : null,
                        footer: Column(
                          children: [
                            if (holderState.status == SeatHolderStatus.limited)
                              Align(
                                alignment: Alignment.centerLeft,
                                child: TextButton(
                                  style: TextButton.styleFrom(
                                    padding: EdgeInsets.zero,
                                    minimumSize: const Size(0, 28),
                                  ),
                                  onPressed: ref
                                      .read(seatHolderProvider.notifier)
                                      .clearSiteBlock,
                                  child: const Text(
                                    'Clear this wait (switched account?)',
                                  ),
                                ),
                              ),
                            SizedBox(
                              width: double.infinity,
                              child: !holderState.isLoopRunning
                                  ? FilledButton.icon(
                                      style: FilledButton.styleFrom(
                                        backgroundColor: Colors.green.shade700,
                                        padding: const EdgeInsets.symmetric(
                                          vertical: 14,
                                        ),
                                      ),
                                      onPressed: () {
                                        _syncConfigFromInputs();
                                        // show what will really be used (the hold time has a 60 s floor)
                                        _durationController.text = ref
                                            .read(seatHolderProvider)
                                            .config
                                            .holdDurationSeconds
                                            .toString();
                                        _save(
                                          ref.read(seatHolderProvider).config,
                                        );
                                        ref
                                            .read(seatHolderProvider.notifier)
                                            .startHolding();
                                      },
                                      icon: const Icon(Icons.play_arrow),
                                      label: const Text('Start holding'),
                                    )
                                  : FilledButton.icon(
                                      style: FilledButton.styleFrom(
                                        backgroundColor: Colors.red.shade700,
                                        padding: const EdgeInsets.symmetric(
                                          vertical: 14,
                                        ),
                                      ),
                                      onPressed: () => ref
                                          .read(seatHolderProvider.notifier)
                                          .stopHolding(),
                                      icon: const Icon(Icons.stop),
                                      label: const Text(
                                        'Stop and release seats',
                                      ),
                                    ),
                            ),
                          ],
                        ),
                      ),
                    ),

                    // Collapsible Configuration Drawer/Tile
                    ConstrainedBox(
                      constraints: BoxConstraints(maxHeight: double.infinity),
                      child: SingleChildScrollView(
                        child: ExpansionTile(
                          initiallyExpanded: _configExpanded,
                          onExpansionChanged: (v) =>
                              setState(() => _configExpanded = v),
                          leading: const Icon(Icons.tune),
                          title: const Text(
                            'Holding Configuration & Timers',
                            style: TextStyle(fontWeight: FontWeight.w600),
                          ),
                          subtitle: Text(
                            'Interval: ${holderState.config.holdDurationSeconds}s | Seats: ${holderState.config.seatCount}',
                            style: const TextStyle(fontSize: 12),
                          ),
                          children: [
                            Padding(
                              padding: const EdgeInsets.symmetric(
                                horizontal: 16,
                                vertical: 8,
                              ),
                              child: Column(
                                children: [
                                  Row(
                                    children: [
                                      Expanded(
                                        child: TextField(
                                          enabled: !running,
                                          controller: _fromController,
                                          decoration: const InputDecoration(
                                            labelText: 'From',
                                            isDense: true,
                                          ),
                                          onChanged: (_) =>
                                              _syncConfigFromInputs(),
                                        ),
                                      ),
                                      const SizedBox(width: 8),
                                      Expanded(
                                        child: TextField(
                                          enabled: !running,
                                          controller: _toController,
                                          decoration: const InputDecoration(
                                            labelText: 'To',
                                            isDense: true,
                                          ),
                                          onChanged: (_) =>
                                              _syncConfigFromInputs(),
                                        ),
                                      ),
                                    ],
                                  ),
                                  const SizedBox(height: 8),
                                  Row(
                                    children: [
                                      Expanded(
                                        child: TextField(
                                          enabled: !running,
                                          controller: _trainController,
                                          decoration: const InputDecoration(
                                            labelText: 'Train Name',
                                            isDense: true,
                                          ),
                                          onChanged: (_) =>
                                              _syncConfigFromInputs(),
                                        ),
                                      ),
                                      const SizedBox(width: 8),
                                      Expanded(
                                        child: TextField(
                                          enabled: !running,
                                          controller: _dateController,
                                          decoration: InputDecoration(
                                            labelText:
                                                'Date (e.g. 31-Oct-2026)',
                                            isDense: true,
                                            suffixIcon: IconButton(
                                              icon: const Icon(
                                                Icons.calendar_month,
                                                size: 20,
                                              ),
                                              tooltip: 'Pick date',
                                              onPressed: running
                                                  ? null
                                                  : _pickDate,
                                            ),
                                          ),
                                          onChanged: (_) =>
                                              _syncConfigFromInputs(),
                                        ),
                                      ),
                                    ],
                                  ),
                                  const SizedBox(height: 8),
                                  Row(
                                    children: [
                                      Expanded(
                                        child: TextField(
                                          enabled: !running,
                                          controller: _bogieController,
                                          decoration: const InputDecoration(
                                            labelText: 'Bogie/Coach (optional)',
                                            isDense: true,
                                          ),
                                          onChanged: (_) =>
                                              _syncConfigFromInputs(),
                                        ),
                                      ),
                                      const SizedBox(width: 8),
                                      Expanded(
                                        child: TextField(
                                          enabled: !running,
                                          controller: _seatNumbersController,
                                          decoration: const InputDecoration(
                                            labelText: 'Seats (e.g. KA-5,KA-6)',
                                            isDense: true,
                                          ),
                                          onChanged: (_) =>
                                              _syncConfigFromInputs(),
                                        ),
                                      ),
                                    ],
                                  ),
                                  const SizedBox(height: 8),
                                  TextField(
                                    enabled: !running,
                                    controller: _classController,
                                    textCapitalization:
                                        TextCapitalization.characters,
                                    decoration: const InputDecoration(
                                      labelText:
                                          'Class (e.g. S_CHAIR, SNIGDHA)',
                                      isDense: true,
                                    ),
                                    onChanged: (_) => _syncConfigFromInputs(),
                                  ),
                                  const SizedBox(height: 8),
                                  Row(
                                    children: [
                                      Expanded(
                                        child: TextField(
                                          enabled: !running,
                                          controller: _durationController,
                                          keyboardType:
                                              const TextInputType.numberWithOptions(
                                                decimal: true,
                                              ),
                                          decoration: const InputDecoration(
                                            labelText: 'Hold time (seconds)',
                                            helperText:
                                                '375 s = 6 min 15 s (minimum 60 s: faster cycles get the account blocked by the site).',
                                            isDense: true,
                                          ),
                                          onChanged: (_) =>
                                              _syncConfigFromInputs(),
                                        ),
                                      ),
                                      const SizedBox(width: 12),
                                      DropdownButton<int>(
                                        value: holderState.config.seatCount,
                                        items: [1, 2, 3, 4]
                                            .map(
                                              (c) => DropdownMenuItem(
                                                value: c,
                                                child: Text(
                                                  '$c Seat${c > 1 ? "s" : ""}',
                                                ),
                                              ),
                                            )
                                            .toList(),
                                        onChanged: running
                                            ? null
                                            : (v) {
                                                if (v != null) {
                                                  final updated = holderState
                                                      .config
                                                      .copyWith(seatCount: v);
                                                  ref
                                                      .read(
                                                        seatHolderProvider
                                                            .notifier,
                                                      )
                                                      .updateConfig(updated);
                                                }
                                              },
                                      ),
                                    ],
                                  ),
                                  const SizedBox(height: 8),
                                  const Text(
                                    'When I leave this screen while holding:',
                                    style: TextStyle(fontSize: 12),
                                  ),
                                  SegmentedButton<String>(
                                    showSelectedIcon: false,
                                    segments: const [
                                      ButtonSegment(
                                        value: HoldGuard.modePip,
                                        label: Text('Small window'),
                                      ),
                                      ButtonSegment(
                                        value: HoldGuard.modeFront,
                                        label: Text('Stay in front'),
                                      ),
                                      ButtonSegment(
                                        value: HoldGuard.modeFree,
                                        label: Text('Background'),
                                      ),
                                    ],
                                    selected: {_mode},
                                    onSelectionChanged: (v) {
                                      setState(() => _mode = v.first);
                                      HoldGuard.setMode(v.first);
                                    },
                                  ),
                                  Text(switch (_mode) {
                                    HoldGuard.modePip =>
                                      'Shrinks to a floating window; you can use other apps.',
                                    _ => 'Always pulled back to full screen.',
                                  }, style: const TextStyle(fontSize: 11)),
                                  const SizedBox(height: 8),
                                  Text(
                                    holderState.config.stopAt != null
                                        ? 'Keeps holding until ${_fmtStop(holderState.config.stopAt!)}'
                                        : 'No end time: runs until you press Stop',
                                    style: const TextStyle(fontSize: 12),
                                  ),
                                  Wrap(
                                    children: [
                                      TextButton.icon(
                                        onPressed: _pickStopTime,
                                        icon: const Icon(
                                          Icons.schedule,
                                          size: 18,
                                        ),
                                        label: Text(
                                          holderState.config.stopAt == null
                                              ? 'Set end date & time'
                                              : 'Change end time',
                                        ),
                                      ),
                                      if (holderState.config.stopAt != null)
                                        TextButton.icon(
                                          icon: const Icon(
                                            Icons.clear,
                                            size: 18,
                                          ),
                                          label: const Text('Clear'),
                                          onPressed: () => ref
                                              .read(seatHolderProvider.notifier)
                                              .updateConfig(
                                                holderState.config.copyWith(
                                                  clearStopAt: true,
                                                ),
                                              ),
                                        ),
                                    ],
                                  ),
                                ],
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),

            // Embedded WebView view so the owner can still watch the real page
            Expanded(
              flex: 2,
              child: WebViewWidget(key: _webKey, controller: _controller),
            ),
          ],
        ),
      ),
    );
  }
}
