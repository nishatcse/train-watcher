import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:wakelock_plus/wakelock_plus.dart';
import 'package:webview_flutter/webview_flutter.dart';

import '../../core/providers.dart';
import 'hold_guard.dart';
import 'seat_automation_js.dart';
import 'seat_holder_config.dart';

enum SeatHolderStatus {
  idle,
  loadingPage,
  navigatingToSeats,
  selecting,
  holding,
  unselecting,
  reselecting,
  offline,
  limited,
  completed,
  error,
}

class SeatHolderState {
  const SeatHolderState({
    required this.config,
    this.status = SeatHolderStatus.idle,
    this.cycleCount = 0,
    this.heldSeats = const [],
    this.secondsRemaining = 0.0,
    this.logs = const [],
    this.errorMessage,
    this.isLoopRunning = false,
    this.offline = false,
  });

  final SeatHolderConfig config;
  final SeatHolderStatus status;
  final int cycleCount;
  final List<String> heldSeats;
  final double secondsRemaining;
  final List<String> logs;
  final String? errorMessage;
  final bool isLoopRunning;

  /// No route to the booking site right now.
  final bool offline;

  SeatHolderState copyWith({
    SeatHolderConfig? config,
    SeatHolderStatus? status,
    int? cycleCount,
    List<String>? heldSeats,
    double? secondsRemaining,
    List<String>? logs,
    String? errorMessage,
    bool clearError = false,
    bool? isLoopRunning,
    bool? offline,
  }) {
    return SeatHolderState(
      config: config ?? this.config,
      status: status ?? this.status,
      cycleCount: cycleCount ?? this.cycleCount,
      heldSeats: heldSeats ?? this.heldSeats,
      secondsRemaining: secondsRemaining ?? this.secondsRemaining,
      logs: logs ?? this.logs,
      errorMessage: clearError ? null : (errorMessage ?? this.errorMessage),
      isLoopRunning: isLoopRunning ?? this.isLoopRunning,
      offline: offline ?? this.offline,
    );
  }
}

/// Drives select -> hold -> release -> select ... through the booking site open in the WebView.
///
/// The rule that matters: seats are only selected again after the site has ANSWERED every release request
/// (not merely after a click), otherwise the seat still counts as held by the previous round and shows up
/// as booked. Every step waits for the page's own confirmation (via SeatHolderBridge) instead of a fixed sleep.
class SeatHolderController extends StateNotifier<SeatHolderState> {
  SeatHolderController({this.onAlert})
    : super(
        const SeatHolderState(
          config: SeatHolderConfig(
            fromCity: 'Chattogram',
            toCity: 'Dhaka',
            journeyDate: '',
            trainName: '',
          ),
        ),
      );

  /// Tells the owner (push + Telegram, through the backend). Set by the provider; null in tests.
  final Future<void> Function(String title, String body)? onAlert;

  /// A release that has not finished within this long makes the page refresh (a reload also frees the seats).
  static const _releaseDeadline = Duration(seconds: 40);

  /// Seats given up on for the rest of this hold, and how many selects in a row failed per seat.
  final Set<String> _dropped = {};
  final Map<String, int> _selectFailures = {};

  List<String> get _targets =>
      state.config.targetSeatList.where((s) => !_dropped.contains(s)).toList();

  /// Pause between two clicks (and between a confirmed release and the next select): long enough for the
  /// page to process each click, short enough that all seats are taken or freed as fast as possible.
  static const _gap = Duration(milliseconds: 250);

  /// Host used to tell "no internet" from "site slow".
  static const _siteHost = 'eticket.railway.gov.bd';

  WebViewController? _webView;
  final Map<String, Completer<Map<String, dynamic>>> _waiters = {};
  Future<void>? _loop;
  bool _stopRequested = false;
  DateTime? _rateLimitedUntil;
  bool _probing = false;

  /// Lives in the app's files dir (not the cache) so it survives reinstalls. Read with
  /// `adb shell run-as <pkg> cat files/seat_holder.log`.
  static final _logFile = File(
    '${Directory.systemTemp.parent.path}/files/seat_holder.log',
  );

  @visibleForTesting
  DateTime? get blockedUntil => _rateLimitedUntil;

  void attachWebViewController(WebViewController controller) =>
      _webView = controller;

  void updateConfig(SeatHolderConfig newConfig) =>
      _set((s) => s.copyWith(config: newConfig));

  /// Applies a state change unless the provider was already disposed (the loop outlives the screen briefly).
  void _set(SeatHolderState Function(SeatHolderState s) change) {
    if (mounted) state = change(state);
  }

  void _addLog(String msg) {
    final n = DateTime.now();
    String two(int v) => v.toString().padLeft(2, '0');
    final line = '[${two(n.hour)}:${two(n.minute)}:${two(n.second)}] $msg';
    _set((s) => s.copyWith(logs: [line, ...s.logs.take(99)]));
    if (kDebugMode) debugPrint('[SeatHolder] $line');
    try {
      _logFile.parent.createSync(recursive: true);
      _logFile.writeAsStringSync(
        '${n.toIso8601String()} $msg\n',
        mode: FileMode.append,
      );
    } catch (_) {
      // the on-screen log still has it
    }
  }

  /// Keeps the log file from growing without bound over many days of holding.
  void _rotateLog() {
    try {
      if (_logFile.existsSync() && _logFile.lengthSync() > 2 * 1024 * 1024) {
        _logFile.renameSync('${_logFile.path}.old');
      }
    } catch (_) {}
  }

  static const _blockedKey = 'seat_holder_blocked_until';
  static const _months = [
    'january',
    'february',
    'march',
    'april',
    'may',
    'june',
    'july',
    'august',
    'september',
    'october',
    'november',
    'december',
  ];

  /// The site blocks seat selection for an hour on "repeated attempts" and says until when:
  /// "...temporarily disabled due to repeated attempts. Please try again after 29 October 2026 at 01:31 AM".
  /// Sending anything before then only extends the block, so every action waits for that time.
  void _noteSiteBlock(String body) {
    if (!body.contains('temporarily disabled')) return;
    final m = RegExp(
      r'after (\d{1,2}) (\w+) (\d{4}) at (\d{1,2}):(\d{2}) (AM|PM)',
      caseSensitive: false,
    ).firstMatch(body);
    var until = DateTime.now().add(const Duration(hours: 1));
    if (m != null) {
      final month = _months.indexOf(m.group(2)!.toLowerCase()) + 1;
      final hour =
          int.parse(m.group(4)!) % 12 +
          (m.group(6)!.toUpperCase() == 'PM' ? 12 : 0);
      if (month > 0) {
        until = DateTime(
          int.parse(m.group(3)!),
          month,
          int.parse(m.group(1)!),
          hour,
          int.parse(m.group(5)!),
        );
      }
    }
    until = until.add(const Duration(minutes: 1));
    final current = _rateLimitedUntil;
    if (current != null && !until.isAfter(current)) return;
    final first = current == null || current.isBefore(DateTime.now());
    _rateLimitedUntil = until;
    _saveBlock(until);
    _addLog(
      'SITE BLOCK: seat selection is disabled by the site. Sending nothing until ${_clock(until)}.',
    );
    if (first) {
      HoldGuard.attention(
        'Site blocked seat selection',
        'Too many select/release attempts. The holder is paused until ${_clock(until)} and then carries on by itself.',
      );
    }
  }

  /// Remembered across restarts: a revived app must not poke the site again before the block ends.
  Future<void> _saveBlock(DateTime until) async {
    try {
      await (await SharedPreferences.getInstance()).setString(
        _blockedKey,
        until.toIso8601String(),
      );
    } catch (_) {}
  }

  /// The block belongs to one railway account. After a login (possibly as someone else) it no longer applies.
  static Future<void> forgetSavedBlock() async {
    try {
      await (await SharedPreferences.getInstance()).remove(_blockedKey);
    } catch (_) {}
  }

  /// Owner's "clear": drops the wait now (e.g. after switching to another account). If the new account is
  /// blocked too, the first select answers with the block again and it is re-learned.
  void clearSiteBlock() {
    _rateLimitedUntil = null;
    forgetSavedBlock();
    _addLog('Site-block wait cleared by the owner.');
  }

  Future<void> _loadBlock() async {
    try {
      final raw = (await SharedPreferences.getInstance()).getString(
        _blockedKey,
      );
      final until = raw == null ? null : DateTime.tryParse(raw);
      if (until != null &&
          until.isAfter(DateTime.now()) &&
          (_rateLimitedUntil == null || until.isAfter(_rateLimitedUntil!))) {
        _rateLimitedUntil = until;
        _addLog(
          'The site had blocked seat selection until ${_clock(until)}; waiting for that before any select.',
        );
      }
    } catch (_) {}
  }

  static String _clock(DateTime d) {
    final h = d.hour % 12 == 0 ? 12 : d.hour % 12;
    return '$h:${d.minute.toString().padLeft(2, '0')} ${d.hour < 12 ? 'AM' : 'PM'}';
  }

  /// If the site has blocked seat selection, sleep until the block ends (or Stop / the end time comes first).
  /// Returns true when it had to wait.
  Future<bool> _waitOutBlock() async {
    final until = _rateLimitedUntil;
    if (until == null || !DateTime.now().isBefore(until)) return false;
    final previous = state.status;
    _set((s) => s.copyWith(status: SeatHolderStatus.limited));
    HoldGuard.status('Paused by the site until ${_clock(until)}');
    while (_running &&
        !_pastStopTime &&
        DateTime.now().isBefore(_rateLimitedUntil ?? until)) {
      await Future.delayed(const Duration(seconds: 1));
    }
    if (_running) _set((s) => s.copyWith(status: previous));
    return true;
  }

  /// Callbacks from in-page JavaScript via window.SeatHolderBridge.
  void handleBridgeMessage(String rawJson) {
    try {
      final decoded = jsonDecode(rawJson) as Map<String, dynamic>;
      final type = decoded['type'] as String? ?? '';
      final payload =
          (decoded['payload'] as Map?)?.cast<String, dynamic>() ??
          <String, dynamic>{};

      switch (type) {
        case 'clicked_book_now':
          _addLog(
            'Clicked Book Now for ${payload['train']} (${payload['seatClass']}).',
          );
        case 'seat_layout_disabled':
          _addLog('Book Now is disabled: ${payload['message']}');
        case 'coach_selected':
          _addLog('Coach: ${payload['coach']}');
        case 'seats_selected':
          _addLog(
            'Held ${_seatList(payload).length}/${payload['wanted']} seat(s): ${_seatList(payload).join(', ')}'
            '${_failedText(payload)}',
          );
        case 'seats_unselected':
          _addLog(
            'Released ${_seatList(payload).length}/${payload['wanted']} seat(s): ${_seatList(payload).join(', ')}'
            '${_failedText(payload)}',
          );
        case 'net':
          final status = payload['status'];
          _addLog(
            'NET ${payload['method']} ${payload['url']} ${payload['seat'] ?? ''} -> $status in ${payload['ms']}ms ${payload['body']}',
          );
          if (status == 429) {
            _rateLimitedUntil = DateTime.now().add(const Duration(seconds: 60));
            _addLog(
              'Rate limited by the site (429). Pausing all actions for 60s.',
            );
          }
          _noteSiteBlock('${payload['body'] ?? ''}');
        case 'error':
          _addLog('Page error in ${payload['stage']}: ${payload['message']}');
      }
      _waiters.remove(type)?.complete(payload);
    } catch (e) {
      _addLog('Bridge parse error: $e');
    }
  }

  List<String> _seatList(Map<String, dynamic> payload) =>
      (payload['seats'] as List?)?.map((e) => e.toString()).toList() ??
      const [];

  String _failedText(Map<String, dynamic> payload) {
    final failed = (payload['failed'] as List?) ?? const [];
    final taken = (payload['unavailable'] as List?) ?? const [];
    final parts = [
      if (failed.isNotEmpty)
        'failed: ${failed.map((f) => '${(f as Map)['seat']}=${f['status']}').join(', ')}',
      if (taken.isNotEmpty) 'not available: ${taken.join(', ')}',
    ];
    return parts.isEmpty ? '' : ' | ${parts.join(' | ')}';
  }

  /// Registers interest in a bridge event. Call before the JS that causes it, then await the result.
  Future<Map<String, dynamic>> _expect(String type, Duration timeout) {
    final c = Completer<Map<String, dynamic>>();
    _waiters[type] = c;
    return c.future.timeout(
      timeout,
      onTimeout: () {
        _waiters.remove(type);
        return <String, dynamic>{'timeout': true};
      },
    );
  }

  Future<Map<String, dynamic>> _readPage() async {
    final raw = (await _webView!.runJavaScriptReturningResult(
      SeatAutomationJs.readPageState,
    )).toString();
    // Android returns the JS string JSON-quoted, so it can take two decodes.
    var v = jsonDecode(raw);
    if (v is String) v = jsonDecode(v);
    return (v as Map).cast<String, dynamic>();
  }

  Future<Map<String, dynamic>?> _readPageOrNull() async {
    try {
      return await _readPage();
    } catch (_) {
      return null;
    }
  }

  Future<bool> _pollPage(
    bool Function(Map<String, dynamic> page) ready,
    Duration timeout,
  ) async {
    final end = DateTime.now().add(timeout);
    while (_running && DateTime.now().isBefore(end)) {
      final page = await _readPageOrNull();
      if (page != null && ready(page)) return true;
      await Future.delayed(const Duration(milliseconds: 500));
    }
    return false;
  }

  bool get _running => mounted && !_stopRequested;

  bool get _pastStopTime {
    final stopAt = state.config.stopAt;
    return stopAt != null && !DateTime.now().isBefore(stopAt);
  }

  // ---------------------------------------------------------------------------------------------- internet

  Future<bool> _online() async {
    try {
      final r = await InternetAddress.lookup(
        _siteHost,
      ).timeout(const Duration(seconds: 4));
      return r.isNotEmpty;
    } catch (_) {
      return false;
    }
  }

  /// Blocks until the booking site can be reached. Nothing is clicked while offline: a select or release sent
  /// into a dead connection fails half-way and leaves the page showing a state the server never reached.
  /// Returns false if the loop was stopped (or [limit] ran out) before the connection came back.
  Future<bool> _waitOnline({Duration? limit, bool ignoreStop = false}) async {
    if (await _online()) {
      if (state.offline) _set((s) => s.copyWith(offline: false));
      return true;
    }
    final since = DateTime.now();
    final previous = state.status;
    _addLog(
      'Internet is down. Waiting for it to come back before touching the seats.',
    );
    _set((s) => s.copyWith(offline: true, status: SeatHolderStatus.offline));
    var warned = false;
    while ((ignoreStop || _running) && mounted) {
      if (await _online()) {
        final secs = DateTime.now().difference(since).inSeconds;
        _addLog('Internet is back after ${secs}s.');
        _set((s) => s.copyWith(offline: false, status: previous));
        return true;
      }
      final down = DateTime.now().difference(since);
      if (limit != null && down > limit) return false;
      if (!warned && down > const Duration(minutes: 2)) {
        warned = true;
        HoldGuard.attention(
          'No internet',
          'The seat holder has been offline for over 2 minutes. It will carry on when the connection returns.',
        );
      }
      await Future.delayed(const Duration(seconds: 3));
    }
    return false;
  }

  /// Watches the connection during the long hold without blocking the countdown.
  Future<void> _probeDuringHold() async {
    if (_probing) return;
    _probing = true;
    try {
      final ok = await _online();
      if (ok == state.offline) {
        _addLog(
          ok
              ? 'Internet is back (seats are still counted as held until the timer ends).'
              : 'Internet dropped while holding.',
        );
        _set((s) => s.copyWith(offline: !ok));
      }
    } finally {
      _probing = false;
    }
  }

  // ------------------------------------------------------------------------------------------------- loop

  Future<void> startHolding({bool resumed = false}) async {
    if (_webView == null) {
      _addLog('WebView is not ready yet.');
      return;
    }
    if (state.isLoopRunning) return;
    _stopRequested = false;
    _dropped.clear();
    _selectFailures.clear();

    final cfg = state.config;
    if (cfg.trainName.trim().isEmpty) {
      _addLog('Enter a train name (e.g. TURNA EXPRESS (741)) first.');
      return;
    }
    if (cfg.stopAt != null && DateTime.now().isAfter(cfg.stopAt!)) {
      _addLog('Stop time ${cfg.stopAt} has already passed.');
      return;
    }

    _set(
      (s) => s.copyWith(
        isLoopRunning: true,
        status: SeatHolderStatus.loadingPage,
        cycleCount: 0,
        heldSeats: const [],
        offline: false,
        clearError: true,
      ),
    );
    _rotateLog();
    _addLog(
      resumed
          ? '=== session resumed after the app was restarted ==='
          : '=== session start ===',
    );
    _addLog(jsonEncode(cfg.toJson()));
    _addLog(
      'Starting: ${cfg.trainName}, ${cfg.seatClass}, hold ${cfg.holdDurationSeconds}s per cycle.',
    );
    await _loadBlock();
    await WakelockPlus.enable();
    await HoldGuard.start(stopAt: cfg.stopAt);

    _loop = _run();
    await _loop;
  }

  Future<void> _run() async {
    try {
      if (!await _openSeatGrid()) {
        if (_running) {
          _fail(
            'Could not reach the seat layout. Check the log, or open it by hand in the page below and press Start again.',
          );
        }
        return;
      }

      var first = true;
      while (_running) {
        if (_pastStopTime) {
          _addLog('Scheduled stop time reached.');
          _set((s) => s.copyWith(status: SeatHolderStatus.completed));
          break;
        }
        if (await _waitOutBlock()) continue;

        _set(
          (s) => s.copyWith(
            status: first
                ? SeatHolderStatus.selecting
                : SeatHolderStatus.reselecting,
          ),
        );
        final held = await _acquire();
        if (held.isEmpty) {
          if (_running && _pastStopTime) {
            _addLog('Scheduled stop time reached.');
            _set((s) => s.copyWith(status: SeatHolderStatus.completed));
          }
          break;
        }
        first = false;
        _set((s) => s.copyWith(heldSeats: held));
        HoldGuard.status(
          'Holding ${held.join(', ')} · cycle ${state.cycleCount + 1}',
        );

        await _hold();
        if (!_running) break;

        // The next select must not start until the site has confirmed this release.
        _set((s) => s.copyWith(status: SeatHolderStatus.unselecting));
        if (!await _releaseAll()) break;
        _set(
          (s) => s.copyWith(heldSeats: const [], cycleCount: s.cycleCount + 1),
        );
        await _sleep(_gap);
      }
    } catch (e) {
      _fail('Holding loop crashed: $e');
    } finally {
      await _finish();
    }
  }

  /// Gets the WebView to the seat grid for the configured train; true once seats are on screen.
  Future<bool> _openSeatGrid() async {
    final wv = _webView!;
    final cfg = state.config;
    if (!await _waitOnline()) return false;

    // Always start from the configured search: the page may still show an earlier route, date or train.
    _addLog('Loading ${cfg.buildSearchUrl()}');
    await wv.loadRequest(Uri.parse(cfg.buildSearchUrl()));
    // The old page can still answer for a moment before the new one commits.
    await Future.delayed(const Duration(seconds: 3));

    // The trip list is rendered by Angular after the page "finishes", so poll for it.
    final listed = await _pollPage(
      (p) => p['inGrid'] == true || (p['trips'] as int? ?? 0) > 0,
      const Duration(seconds: 40),
    );
    if (!listed) {
      if (await _loggedOut()) return false;
      _addLog('Trip list never appeared (slow site, or Cloudflare check?).');
      return false;
    }
    await wv.runJavaScript(SeatAutomationJs.initBridge());

    if ((await _readPage())['inGrid'] != true) {
      _set((s) => s.copyWith(status: SeatHolderStatus.navigatingToSeats));
      await wv.runJavaScript(
        SeatAutomationJs.openSeatLayout(
          trainName: cfg.trainName,
          seatClass: cfg.seatClass,
        ),
      );
      final inGrid = await _pollPage(
        (p) => p['inGrid'] == true,
        const Duration(seconds: 20),
      );
      if (!inGrid) return false;
    }

    if (cfg.bogieName.trim().isNotEmpty) {
      await wv.runJavaScript(SeatAutomationJs.selectCoach(cfg.bogieName));
      await Future.delayed(const Duration(seconds: 1));
    }
    return true;
  }

  /// The login lasts about 12 hours. When it lapses the site shows its login page and nothing here can go on.
  Future<bool> _loggedOut() async {
    final page = await _readPageOrNull();
    if (page?['login'] != true) return false;
    _fail(
      'The Railway login has expired. Log in again in the app, then press Start.',
    );
    _stopRequested = true;
    return true;
  }

  /// Selects the wanted seats, retrying (with back-off) until at least one is held, the stop time passes or
  /// Stop is pressed. Returns the seats now held; empty means nothing was acquired.
  Future<List<String>> _acquire() async {
    var failures = 0;
    while (_running) {
      if (_pastStopTime) return const [];
      if (await _waitOutBlock()) continue;
      if (!await _waitOnline()) return const [];

      final picked = await _selectSeats();
      final held = picked.seats;
      if (!_running) return held;

      // A seat that was clicked but not accepted: refresh the page and try once more; a second failure drops it.
      for (final n in held) {
        _selectFailures.remove(n);
      }
      if (picked.failed.isNotEmpty) {
        final drop = picked.failed
            .where((n) => (_selectFailures[n] ?? 0) >= 1)
            .toList();
        for (final n in picked.failed) {
          _selectFailures[n] = (_selectFailures[n] ?? 0) + 1;
        }
        if (drop.isNotEmpty) {
          await _dropSeats(
            drop,
            'could not be selected even after refreshing the page',
          );
          for (final n in drop) {
            _selectFailures.remove(n);
          }
          if (!_running) return const [];
          if (held.isNotEmpty) return held;
          continue;
        }
        _addLog(
          '${picked.failed.join(', ')} could not be selected. Refreshing the page and trying again.',
        );
        _set((s) => s.copyWith(status: SeatHolderStatus.loadingPage));
        await _openSeatGrid();
        if (held.isNotEmpty) return held;
        await _sleep(const Duration(seconds: 5));
        continue;
      }
      if (held.isNotEmpty) return held;

      failures++;
      // Keep going until the stop time or Stop, but back off so a taken seat or a dead session
      // is not hammered with requests.
      final wait = Duration(
        seconds: failures < 3 ? 2 : (failures < 6 ? 10 : 30),
      );
      _addLog(
        'No seat held (attempt $failures). Retrying in ${wait.inSeconds}s...',
      );
      if (failures == 8) {
        HoldGuard.attention(
          'Seat holder cannot get seats',
          'No seat could be held for several minutes. Check the app.',
        );
      }
      // Normally just try again on the same page. Reload only if the seat grid is gone, or as a last resort
      // after many misses (a page left open for hours can go stale).
      final onGrid = (await _readPageOrNull())?['inGrid'] == true;
      if (!onGrid || failures % 12 == 0) {
        _set((s) => s.copyWith(status: SeatHolderStatus.loadingPage));
        if (!await _openSeatGrid()) {
          if (!_running) return const [];
          _addLog('Could not reopen the seat layout; will keep trying.');
        }
      }
      await _sleep(wait);
    }
    return const [];
  }

  Future<({List<String> seats, List<String> failed})> _selectSeats() async {
    final cfg = state.config;
    final reply = _expect(
      'seats_selected',
      _gap * cfg.seatCount + const Duration(seconds: 60),
    );
    await _webView!.runJavaScript(
      SeatAutomationJs.selectSeats(
        targetSeats: _targets,
        preferredSeats: state.heldSeats,
        maxCount: cfg.seatCount,
      ),
    );
    final payload = await reply;
    if (payload['timeout'] == true) {
      _addLog('Timed out waiting for the seat selection to be confirmed.');
      return (seats: const <String>[], failed: const <String>[]);
    }
    final failed = ((payload['failed'] as List?) ?? const [])
        .map((f) => (f as Map)['seat']?.toString() ?? '')
        .where((n) => n.isNotEmpty)
        .toList();
    return (seats: _seatList(payload), failed: failed);
  }

  /// Releases every selected seat and returns true once that is settled. Clicking is tried for up to 40 s; if the
  /// site has not confirmed by then the page is refreshed (a page reload also frees the seats), the seats are checked
  /// again, and a seat that is STILL selected is refreshed once more after 5 s. A seat that survives that is dropped
  /// from this hold and the owner is told. [maxAttempts] bounds the effort when the loop is shutting down.
  Future<bool> _releaseAll({int? maxAttempts}) async {
    final deadline = DateTime.now().add(_releaseDeadline);
    var attempt = 0;
    var wasSelected = List<String>.of(state.heldSeats);
    while (maxAttempts != null || _running) {
      if (maxAttempts != null && attempt >= maxAttempts) {
        _addLog(
          'Could not confirm the release after $attempt attempts. The site frees the hold by itself when its timer runs out.',
        );
        return false;
      }
      if (maxAttempts == null &&
          attempt > 0 &&
          DateTime.now().isAfter(deadline)) {
        return _refreshRelease(wasSelected);
      }
      attempt++;
      if (!await _waitOnline(
        limit: maxAttempts != null ? const Duration(seconds: 20) : null,
        ignoreStop: maxAttempts != null,
      )) {
        return false;
      }

      final before = await _readPageOrNull();
      final beforeSelected = ((before?['selected'] as List?) ?? const [])
          .map((e) => e.toString())
          .toList();
      if (before != null &&
          before['inGrid'] == true &&
          beforeSelected.isEmpty) {
        return true; // nothing is selected on the page (the hold already lapsed): nothing to release
      }
      if (beforeSelected.isNotEmpty) wasSelected = beforeSelected;

      final wait = maxAttempts != null
          ? const Duration(seconds: 60)
          : deadline.difference(DateTime.now()) + const Duration(seconds: 10);
      final reply = _expect(
        'seats_unselected',
        wait.isNegative ? const Duration(seconds: 10) : wait,
      );
      try {
        await _webView!.runJavaScript(SeatAutomationJs.unselectSeats(const []));
      } catch (e) {
        _addLog('Release script failed: $e');
      }
      final payload = await reply;

      final failed = (payload['failed'] as List?) ?? const [];
      final released = _seatList(payload).length;
      final wanted = payload['wanted'];
      final after = await _readPageOrNull();
      final stillSelected = after == null
          ? -1
          : ((after['selected'] as List?) ?? const []).length;
      if (payload['timeout'] != true &&
          failed.isEmpty &&
          wanted is int &&
          wanted >= 0 &&
          released == wanted &&
          stillSelected == 0) {
        return true;
      }

      _addLog(
        'Release not confirmed (attempt $attempt): released $released/$wanted, still selected $stillSelected.',
      );
      if (maxAttempts != null) {
        await Future.delayed(const Duration(seconds: 3));
      } else {
        await _sleep(const Duration(seconds: 2));
      }
    }
    return false;
  }

  /// The 40 s are up: refresh the page and look at the seats; refresh again after 5 s if any is still selected.
  Future<bool> _refreshRelease(List<String> names) async {
    var stuck = <String>[];
    for (var round = 1; round <= 2 && _running; round++) {
      _addLog(
        'The release did not finish within ${_releaseDeadline.inSeconds} s. Refreshing the page ($round/2).',
      );
      _set((s) => s.copyWith(status: SeatHolderStatus.loadingPage));
      if (!await _openSeatGrid()) {
        await _sleep(const Duration(seconds: 5));
        continue;
      }
      final page = await _readPageOrNull();
      final selected = ((page?['selected'] as List?) ?? const [])
          .map((e) => e.toString())
          .toSet();
      stuck = names.where(selected.contains).toList();
      _addLog(
        'After the refresh: ${stuck.isEmpty ? 'no seat is still selected' : '${stuck.join(', ')} still selected'}.',
      );
      if (stuck.isEmpty) return true;
      if (round == 1) {
        _addLog(
          '${stuck.join(', ')} still selected. Waiting 5 s, then refreshing again.',
        );
        await _sleep(const Duration(seconds: 5));
      }
    }
    if (stuck.isNotEmpty) {
      await _dropSeats(stuck, 'stayed selected after two page refreshes');
    }
    return true;
  }

  /// Gives up on seats for the rest of this hold, and tells the owner (push + Telegram).
  Future<void> _dropSeats(List<String> seats, String why) async {
    final named = seats.where(state.config.targetSeatList.contains).toList();
    // seats chosen automatically have no name to drop
    if (named.isEmpty) return;
    _dropped.addAll(named);
    final left = _targets;
    _addLog(
      'DROPPED ${named.join(', ')}: $why. Continuing with ${left.isEmpty ? 'no seats' : left.join(', ')}.',
    );
    await _alert(
      'Seat dropped from the hold',
      '${named.join(', ')} $why, so it was removed from this hold. Still holding for: ${left.isEmpty ? 'nothing' : left.join(', ')}.',
    );
    if (left.isEmpty) {
      await _alert(
        'Seat holder stopped',
        'Every seat was dropped, so there is nothing left to hold.',
      );
      _fail('Every seat was dropped, so there is nothing left to hold.');
      _stopRequested = true;
    }
  }

  Future<void> _alert(String title, String body) async {
    HoldGuard.attention(title, body);
    try {
      await onAlert?.call(title, body);
    } catch (e) {
      _addLog('Could not send the alert to the server: $e');
    }
  }

  /// Waits up to [d], returning early when the loop is stopped.
  Future<void> _sleep(Duration d) async {
    final end = DateTime.now().add(d);
    while (_running && DateTime.now().isBefore(end)) {
      await Future.delayed(const Duration(milliseconds: 200));
    }
  }

  /// Counts the hold window down from now. Returns early if the loop is stopped or the end time arrives.
  Future<void> _hold() async {
    final total = state.config.holdDurationSeconds;
    _set(
      (s) =>
          s.copyWith(status: SeatHolderStatus.holding, secondsRemaining: total),
    );
    final started = DateTime.now();
    var lastProbe = started;
    while (_running) {
      final left =
          total - DateTime.now().difference(started).inMilliseconds / 1000.0;
      if (left <= 0) break;
      // The end time can fall inside a long hold: stop waiting then, so the seats are released on time.
      if (_pastStopTime) break;
      if (DateTime.now().difference(lastProbe) > const Duration(seconds: 5)) {
        lastProbe = DateTime.now();
        unawaited(_probeDuringHold());
      }
      _set(
        (s) =>
            s.copyWith(secondsRemaining: double.parse(left.toStringAsFixed(1))),
      );
      await Future.delayed(const Duration(milliseconds: 250));
    }
    _set((s) => s.copyWith(secondsRemaining: 0));
  }

  void _fail(String message) {
    _addLog(message);
    _set(
      (s) => s.copyWith(status: SeatHolderStatus.error, errorMessage: message),
    );
    HoldGuard.attention('Seat holder stopped', message);
  }

  /// Runs once when the loop ends for any reason: release whatever is still held, keep error/completed status.
  Future<void> _finish() async {
    if (_webView != null && mounted) {
      try {
        await _releaseAll(maxAttempts: 4);
      } catch (_) {
        // page gone; the site frees the hold on its own after its timeout
      }
    }
    await WakelockPlus.disable();
    await HoldGuard.stop();
    _set(
      (s) => s.copyWith(
        isLoopRunning: false,
        heldSeats: const [],
        secondsRemaining: 0,
        offline: false,
        status:
            s.status == SeatHolderStatus.error ||
                s.status == SeatHolderStatus.completed
            ? s.status
            : SeatHolderStatus.idle,
      ),
    );
    _addLog('Stopped.');
  }

  /// Stops the loop and waits until the held seats have been released.
  Future<void> stopHolding() async {
    if (!state.isLoopRunning) return;
    _addLog('Stopping...');
    _stopRequested = true;
    await _loop;
  }

  @override
  void dispose() {
    _waiters.clear();
    // fire and forget: the screen is already gone, and a missing platform plugin must not throw here
    WakelockPlus.disable().catchError((_) {});
    super.dispose();
  }
}

final seatHolderProvider =
    StateNotifierProvider.autoDispose<SeatHolderController, SeatHolderState>(
      (ref) => SeatHolderController(
        onAlert: (title, body) => ref.read(apiProvider).holdAlert(title, body),
      ),
    );
