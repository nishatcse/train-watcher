import 'package:intl/intl.dart';

const _months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/// 2026-10-31 -> "31 Oct 2026"
String prettyDate(String iso) {
  final p = iso.split('-');
  if (p.length != 3) return iso;
  return '${int.parse(p[2])} ${_months[int.parse(p[1]) - 1]} ${p[0]}';
}

String isoOf(DateTime d) => DateFormat('yyyy-MM-dd').format(d);
DateTime parseIso(String iso) => DateTime.parse(iso);

String ago(DateTime? t) {
  if (t == null) return 'never';
  final s = DateTime.now().difference(t).inSeconds;
  if (s < 5) return 'just now';
  if (s < 60) return '${s}s ago';
  if (s < 3600) return '${s ~/ 60}m ago';
  if (s < 86400) return '${s ~/ 3600}h ago';
  return '${s ~/ 86400}d ago';
}

String duration(int seconds) {
  if (seconds <= 0) return '0m';
  final h = seconds ~/ 3600;
  final m = (seconds % 3600) ~/ 60;
  if (h > 0) return '${h}h ${m}m';
  if (m > 0) return '${m}m';
  return '${seconds}s';
}

String clock(DateTime t) => DateFormat('d MMM, h:mm a').format(t);

String statusLabel(String? s) => switch (s) {
      'ok' => 'Checked',
      'train_not_listed' => 'Train not on this search',
      'class_not_offered' => 'Class not offered',
      'not_open_yet' => 'Booking not open yet',
      'journey_passed' => 'Journey passed',
      'rate_limited' => 'Paused (rate limit)',
      'error' => 'Check failed',
      null => 'Waiting for first check',
      _ => s,
    };
