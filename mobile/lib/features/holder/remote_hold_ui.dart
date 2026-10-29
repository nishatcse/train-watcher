import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/format.dart';
import '../../core/providers.dart';
import 'hold_panel.dart';
import 'holder_remote.dart';

/// The server's hold (if any), refreshed every few seconds while something is watching it.
final remoteHoldProvider = FutureProvider.autoDispose<RemoteHoldView>((
  ref,
) async {
  final timer = Timer(const Duration(seconds: 5), ref.invalidateSelf);
  ref.onDispose(timer.cancel);
  return RemoteHoldView.fromJson(await ref.watch(apiProvider).currentHold());
});

/// A server hold drawn with [HoldPanel]. Counts the hold window down locally every second.
class RemoteHoldPanel extends StatefulWidget {
  const RemoteHoldPanel({
    super.key,
    required this.view,
    this.footer,
    this.compact = false,
  });
  final RemoteHoldView view;
  final Widget? footer;
  final bool compact;

  /// Status words and colour for a hold.
  static (String, Color) status(RemoteHold h, ThemeData t) {
    if (h.status == 'running') {
      return switch (h.phase) {
        'holding' => ('HOLDING', Colors.green),
        'blocked' => ('SITE LIMIT', Colors.red),
        'offline' => ('NO INTERNET', Colors.deepOrange),
        'waiting_login' => ('LOGIN NEEDED', Colors.orange),
        'refreshing' => ('REFRESHING', Colors.orange),
        'recovering' => ('RECOVERING', Colors.orange),
        _ => ('WORKING', Colors.blue),
      };
    }
    return switch (h.status) {
      'queued' => ('QUEUED', Colors.orange),
      'stopping' => ('STOPPING', Colors.orange),
      'failed' => ('FAILED', t.colorScheme.error),
      'finished' => ('FINISHED', Colors.grey),
      _ => ('STOPPED', Colors.grey),
    };
  }

  @override
  State<RemoteHoldPanel> createState() => _RemoteHoldPanelState();
}

class _RemoteHoldPanelState extends State<RemoteHoldPanel> {
  Timer? _tick;

  @override
  void initState() {
    super.initState();
    _tick = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted && (widget.view.hold?.active ?? false)) setState(() {});
    });
  }

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }

  /// Time left in the current hold window, counted down from the moment the worker took the seats.
  double? _secondsLeft(RemoteHold h) {
    if (h.phase != 'holding') return null;
    final start = holdWindowStart(widget.view.events);
    if (start == null) return null;
    final left =
        h.holdSeconds -
        DateTime.now().difference(start).inMilliseconds / 1000.0;
    return left.clamp(0.0, h.holdSeconds.toDouble());
  }

  String _hm(DateTime d) {
    final h = d.hour % 12 == 0 ? 12 : d.hour % 12;
    return '$h:${d.minute.toString().padLeft(2, '0')} ${d.hour < 12 ? 'AM' : 'PM'}';
  }

  /// Said only while the app claims the seats are held: the SITE's own reply to the reservation, with its time.
  String? _verifiedText(RemoteHold h) {
    if (h.phase != 'holding') return null;
    final at = holdWindowStart(widget.view.events);
    if (at == null) return null;
    return 'The site confirmed the reservation at ${_hm(at)} (it replied OK for every seat)';
  }

  bool? _verifiedOk(RemoteHold h) =>
      h.phase == 'holding' && holdWindowStart(widget.view.events) != null
      ? true
      : null;

  @override
  Widget build(BuildContext context) {
    final h = widget.view.hold;
    if (h == null) return const SizedBox.shrink();
    final (label, color) = RemoteHoldPanel.status(h, Theme.of(context));
    final blocked =
        h.blockedUntil != null && h.blockedUntil!.isAfter(DateTime.now());
    return HoldPanel(
      compact: widget.compact,
      active: h.active,
      trainName: h.trainName,
      fromCity: h.fromCity,
      toCity: h.toCity,
      journeyDate: prettyDate(h.journeyDate),
      seatClass: h.seatClass,
      coach: h.bogieName,
      wantedSeats: h.wantedSeats,
      heldSeats: h.heldSeats,
      autoSeatCount: h.seatCount,
      statusLabel: label,
      statusColor: color,
      detail: h.phaseLabel,
      secondsLeft: _secondsLeft(h),
      totalSeconds: h.holdSeconds.toDouble(),
      busy:
          h.active &&
          !{'holding', 'blocked', 'offline', 'waiting_login'}.contains(h.phase),
      verifiedText: _verifiedText(h),
      verifiedOk: _verifiedOk(h),
      cycles: h.cycleCount,
      stopAt: h.stopAt,
      warning: blocked
          ? 'The site blocked seat selection until ${HoldPanel.clock(h.blockedUntil!)}. The holder carries on by itself after that.'
          : h.lastError,
      footer: widget.footer,
    );
  }
}
