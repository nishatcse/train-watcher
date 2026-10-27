import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/providers.dart';
import '../../notifications/alert_data.dart';
import '../../notifications/keyguard.dart';
import '../../notifications/notification_service.dart';
import '../../widgets/common.dart';
import 'booking_browser_screen.dart';

/// The screen a seat alert opens. It can appear over the lock screen, but "Book now"
/// first asks the owner to unlock, so a locked phone never exposes the logged-in site.
class AlertScreen extends ConsumerStatefulWidget {
  const AlertScreen({super.key, required this.data, this.autoBook = false});
  final AlertData data;
  final bool autoBook;
  @override
  ConsumerState<AlertScreen> createState() => _AlertScreenState();
}

class _AlertScreenState extends ConsumerState<AlertScreen> {
  bool _lockedLaunch = false;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      _lockedLaunch = await Keyguard.isLocked();
      if (mounted) setState(() {});
      // Opening it while the phone is in use is enough to stop the ringing (the quiet copy stays in
      // the shade). Popped up over a LOCKED phone, nobody has seen it yet, so it keeps ringing until
      // they press Dismiss / Book now (or the two-minute cap).
      if (!_lockedLaunch) await NotificationService.stopRinging(widget.data.alertId);
      if (widget.autoBook && !_lockedLaunch) _book();
    });
  }

  void _ack() {
    final id = widget.data.alertId;
    if (id.isEmpty || id.startsWith('local-')) return;
    ref.read(apiProvider).ack(id).then((_) => ref.invalidate(historyProvider)).catchError((_) {});
  }

  Future<void> _dismiss() async {
    await NotificationService.clearAlert(widget.data.alertId);
    _ack();
    if (_lockedLaunch) {
      await Keyguard.finish();
    } else if (mounted) {
      Navigator.pop(context);
    }
  }

  Future<void> _book() async {
    final url = widget.data.url;
    if (url == null) {
      snack(context, 'No booking link in this alert.', error: true);
      return;
    }
    setState(() => _busy = true);
    try {
      if (await Keyguard.isLocked()) {
        final unlocked = await Keyguard.dismiss();
        if (!unlocked) {
          if (mounted) snack(context, 'Unlock your phone to open the booking site.');
          return;
        }
        _lockedLaunch = false;
      }
      await NotificationService.clearAlert(widget.data.alertId);
      _ack();
      if (!mounted) return;
      await Navigator.push(context, MaterialPageRoute(builder: (_) => BookingBrowserScreen(url: url)));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _openInChrome() async {
    final url = widget.data.url;
    if (url == null) return;
    if (!await launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication) && mounted) {
      snack(context, "Couldn't open a browser.", error: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final d = widget.data;
    final t = Theme.of(context);
    final green = Colors.green.shade700;
    return PopScope(
      canPop: !_lockedLaunch,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop && _lockedLaunch) Keyguard.finish();
      },
      child: Scaffold(
        backgroundColor: green,
        body: SafeArea(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              const Spacer(),
              const Icon(Icons.event_seat, size: 72, color: Colors.white),
              const SizedBox(height: 12),
              Text(d.isTest ? 'TEST ALERT' : 'Seats available!', textAlign: TextAlign.center, style: t.textTheme.headlineLarge?.copyWith(color: Colors.white, fontWeight: FontWeight.w800)),
              const SizedBox(height: 20),
              Card(
                child: Padding(
                  padding: const EdgeInsets.all(20),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(d.route, style: t.textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w700)),
                    const SizedBox(height: 4),
                    Text(d.trainName, style: t.textTheme.titleMedium),
                    const Divider(height: 28),
                    _line(Icons.event, d.journeyDate),
                    _line(Icons.airline_seat_recline_normal, d.seatClass),
                    _line(Icons.confirmation_number, '${d.seats} seat${d.seats == 1 ? '' : 's'} available'),
                  ]),
                ),
              ),
              if (_lockedLaunch)
                const Padding(padding: EdgeInsets.only(top: 12), child: Text('Phone is locked. You will be asked to unlock before booking.', textAlign: TextAlign.center, style: TextStyle(color: Colors.white))),
              const Spacer(),
              FilledButton.icon(
                onPressed: _busy ? null : _book,
                icon: const Icon(Icons.open_in_new),
                label: Text(_lockedLaunch ? 'Unlock & book now' : 'Book now'),
                style: FilledButton.styleFrom(backgroundColor: Colors.white, foregroundColor: green, minimumSize: const Size.fromHeight(60), textStyle: const TextStyle(fontSize: 18, fontWeight: FontWeight.w800)),
              ),
              const SizedBox(height: 10),
              Row(children: [
                Expanded(child: OutlinedButton(onPressed: _dismiss, style: OutlinedButton.styleFrom(foregroundColor: Colors.white, side: const BorderSide(color: Colors.white70), minimumSize: const Size.fromHeight(48)), child: const Text('Dismiss'))),
                if (!_lockedLaunch) ...[
                  const SizedBox(width: 10),
                  Expanded(child: OutlinedButton(onPressed: _openInChrome, style: OutlinedButton.styleFrom(foregroundColor: Colors.white, side: const BorderSide(color: Colors.white70), minimumSize: const Size.fromHeight(48)), child: const Text('Open in Chrome'))),
                ],
              ]),
              const SizedBox(height: 8),
              const Text('You complete the purchase yourself on the official site.', textAlign: TextAlign.center, style: TextStyle(color: Colors.white70, fontSize: 12)),
            ]),
          ),
        ),
      ),
    );
  }

  Widget _line(IconData i, String text) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: Row(children: [Icon(i, size: 20), const SizedBox(width: 12), Expanded(child: Text(text, style: const TextStyle(fontSize: 16)))]),
      );
}
