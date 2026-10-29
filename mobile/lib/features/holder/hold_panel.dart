import 'package:flutter/material.dart';

/// How one seat looks in the strip.
enum SeatState { held, waiting, idle }

/// The live picture of a seat hold, shared by the on-phone holder, the server holder and the dashboard:
/// which train, which coach, which seats are held right now, a countdown to the next release, and the end time.
class HoldPanel extends StatelessWidget {
  const HoldPanel({
    super.key,
    required this.trainName,
    required this.fromCity,
    required this.toCity,
    required this.journeyDate,
    required this.seatClass,
    required this.statusLabel,
    required this.statusColor,
    this.coach = '',
    this.wantedSeats = const [],
    this.heldSeats = const [],
    this.autoSeatCount = 0,
    this.detail = '',
    this.secondsLeft,
    this.totalSeconds,
    this.busy = false,
    this.cycles = 0,
    this.stopAt,
    this.warning,
    this.footer,
    this.compact = false,
    this.active = true,
    this.verifiedText,
    this.verifiedOk,
  });

  final String trainName,
      fromCity,
      toCity,
      journeyDate,
      seatClass,
      statusLabel,
      coach,
      detail;
  final Color statusColor;

  /// Seats the owner named. Each is shown as held or still waiting. Empty = picked automatically.
  final List<String> wantedSeats;
  final List<String> heldSeats;
  final int autoSeatCount;

  /// Time left in the current hold window, and the window length; null while not holding.
  final double? secondsLeft, totalSeconds;

  /// True while the worker is doing something between holds (selecting, releasing, loading).
  final bool busy;
  final int cycles;
  final DateTime? stopAt;
  final String? warning;
  final Widget? footer;
  final bool compact;

  /// False once the hold has finished or been stopped: seats are then shown plainly, not as "waiting".
  final bool active;

  /// What the site said about the held seats ("Verified on the site at 6:47 AM"), and whether that is good news.
  final String? verifiedText;
  final bool? verifiedOk;

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
  static const _days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  static String mmss(double seconds) {
    final t = seconds.ceil().clamp(0, 359999);
    return '${t ~/ 60}:${(t % 60).toString().padLeft(2, '0')}';
  }

  static String clock(DateTime d) {
    final h = d.hour % 12 == 0 ? 12 : d.hour % 12;
    return '${_days[d.weekday - 1]} ${d.day} ${_months[d.month - 1]}, $h:${d.minute.toString().padLeft(2, '0')} ${d.hour < 12 ? 'AM' : 'PM'}';
  }

  /// "3d 2h", "5h 12m", "12m" - how long until [end].
  static String until(DateTime end, [DateTime? now]) {
    final d = end.difference(now ?? DateTime.now());
    if (d.isNegative) return 'now';
    if (d.inDays >= 1) return '${d.inDays}d ${d.inHours % 24}h';
    if (d.inHours >= 1) return '${d.inHours}h ${d.inMinutes % 60}m';
    if (d.inMinutes >= 1) return '${d.inMinutes}m';
    return '${d.inSeconds}s';
  }

  List<(String, SeatState)> get _seats {
    final held = heldSeats.map((s) => s.toUpperCase()).toList();
    final out = <(String, SeatState)>[];
    for (final w in wantedSeats.map((s) => s.toUpperCase())) {
      out.add((
        w,
        held.contains(w)
            ? SeatState.held
            : (active ? SeatState.waiting : SeatState.idle),
      ));
    }
    for (final h in held) {
      if (!wantedSeats.map((s) => s.toUpperCase()).contains(h)) {
        out.add((h, SeatState.held));
      }
    }
    return out;
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final seats = _seats;
    final heldCount = seats.where((s) => s.$2 == SeatState.held).length;
    final total = wantedSeats.isNotEmpty
        ? wantedSeats.length
        : (autoSeatCount > 0 ? autoSeatCount : seats.length);

    return Card(
      clipBehavior: Clip.antiAlias,
      margin: EdgeInsets.zero,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 400),
        decoration: BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
            colors: [
              statusColor.withValues(alpha: 0.16),
              t.colorScheme.surfaceContainerLow,
            ],
          ),
        ),
        padding: EdgeInsets.all(compact ? 14 : 18),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _header(t),
            const SizedBox(height: 10),
            _chips(t),
            if (!compact) ...[
              const SizedBox(height: 18),
              Center(child: _ring(t)),
            ] else if (secondsLeft != null) ...[
              const SizedBox(height: 10),
              _inlineCountdown(t),
            ],
            const SizedBox(height: 16),
            _seatStrip(t, seats, heldCount, total),
            if (verifiedText != null) ...[
              const SizedBox(height: 10),
              Row(
                children: [
                  Icon(
                    verifiedOk == true
                        ? Icons.verified
                        : (verifiedOk == false
                              ? Icons.error_outline
                              : Icons.help_outline),
                    size: 17,
                    color: verifiedOk == true
                        ? Colors.green.shade400
                        : (verifiedOk == false
                              ? t.colorScheme.error
                              : t.colorScheme.onSurfaceVariant),
                  ),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      verifiedText!,
                      style: TextStyle(
                        fontSize: 12.5,
                        fontWeight: FontWeight.w600,
                        color: verifiedOk == true
                            ? Colors.green.shade300
                            : (verifiedOk == false
                                  ? t.colorScheme.error
                                  : null),
                      ),
                    ),
                  ),
                ],
              ),
            ],
            if (detail.isNotEmpty) ...[
              const SizedBox(height: 10),
              Row(
                children: [
                  Icon(
                    Icons.info_outline,
                    size: 16,
                    color: t.colorScheme.onSurfaceVariant,
                  ),
                  const SizedBox(width: 6),
                  Expanded(child: Text(detail, style: t.textTheme.bodySmall)),
                ],
              ),
            ],
            if (warning != null) ...[
              const SizedBox(height: 8),
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(
                    Icons.warning_amber_rounded,
                    size: 18,
                    color: t.colorScheme.error,
                  ),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      warning!,
                      style: TextStyle(
                        color: t.colorScheme.error,
                        fontSize: 12,
                      ),
                    ),
                  ),
                ],
              ),
            ],
            const Divider(height: 24),
            _footerRow(t),
            if (footer != null) ...[const SizedBox(height: 12), footer!],
          ],
        ),
      ),
    );
  }

  Widget _header(ThemeData t) => Row(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Container(
        padding: const EdgeInsets.all(10),
        decoration: BoxDecoration(
          color: statusColor.withValues(alpha: 0.18),
          borderRadius: BorderRadius.circular(14),
        ),
        child: Icon(Icons.train, color: statusColor, size: compact ? 22 : 26),
      ),
      const SizedBox(width: 12),
      Expanded(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              trainName.isEmpty ? 'No train chosen' : trainName,
              style: t.textTheme.titleMedium?.copyWith(
                fontWeight: FontWeight.w800,
              ),
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
            ),
            const SizedBox(height: 2),
            Text(
              '$fromCity  →  $toCity',
              style: t.textTheme.bodyMedium,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
            ),
          ],
        ),
      ),
      const SizedBox(width: 8),
      _pill(),
    ],
  );

  Widget _pill() => AnimatedContainer(
    duration: const Duration(milliseconds: 300),
    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
    decoration: BoxDecoration(
      color: statusColor.withValues(alpha: 0.18),
      borderRadius: BorderRadius.circular(20),
      border: Border.all(color: statusColor, width: 1.4),
    ),
    child: Text(
      statusLabel,
      style: TextStyle(
        color: statusColor,
        fontWeight: FontWeight.w800,
        fontSize: 11,
        letterSpacing: 0.3,
      ),
    ),
  );

  Widget _chips(ThemeData t) {
    Widget chip(IconData icon, String text) => Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      decoration: BoxDecoration(
        color: t.colorScheme.surfaceContainerHighest.withValues(alpha: 0.6),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 15, color: t.colorScheme.onSurfaceVariant),
          const SizedBox(width: 5),
          Text(
            text,
            style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600),
          ),
        ],
      ),
    );
    return Wrap(
      spacing: 8,
      runSpacing: 8,
      children: [
        if (journeyDate.isNotEmpty) chip(Icons.calendar_month, journeyDate),
        if (seatClass.isNotEmpty)
          chip(
            Icons.airline_seat_recline_normal,
            seatClass.replaceAll('_', ' '),
          ),
        if (coach.isNotEmpty)
          chip(Icons.view_carousel_outlined, 'Coach $coach'),
      ],
    );
  }

  /// The big circular countdown: time to the next release while holding, a spinner while busy, a calm ring when idle.
  Widget _ring(ThemeData t) {
    final holding =
        secondsLeft != null && totalSeconds != null && totalSeconds! > 0;
    final value = holding
        ? (secondsLeft! / totalSeconds!).clamp(0.0, 1.0)
        : 0.0;
    return SizedBox(
      width: 172,
      height: 172,
      child: Stack(
        alignment: Alignment.center,
        children: [
          SizedBox.expand(
            child: CircularProgressIndicator(
              value: holding ? value : (busy ? null : 0),
              strokeWidth: 11,
              strokeCap: StrokeCap.round,
              backgroundColor: statusColor.withValues(alpha: 0.14),
              valueColor: AlwaysStoppedAnimation<Color>(statusColor),
            ),
          ),
          Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (holding) ...[
                Text(
                  mmss(secondsLeft!),
                  style: t.textTheme.displaySmall?.copyWith(
                    fontWeight: FontWeight.w800,
                    fontFeatures: const [FontFeature.tabularFigures()],
                  ),
                ),
                Text(
                  'until release',
                  style: t.textTheme.labelMedium?.copyWith(
                    color: t.colorScheme.onSurfaceVariant,
                  ),
                ),
              ] else ...[
                Icon(_idleIcon, size: 40, color: statusColor),
                const SizedBox(height: 4),
                Text(
                  busy ? 'Working…' : (active ? 'Waiting' : 'Not holding'),
                  style: t.textTheme.labelLarge,
                ),
              ],
              const SizedBox(height: 6),
              Text(
                holding
                    ? 'Cycle ${cycles + 1}'
                    : (cycles > 0
                          ? '$cycles cycle${cycles == 1 ? '' : 's'} done'
                          : ''),
                style: t.textTheme.labelMedium?.copyWith(
                  fontWeight: FontWeight.w700,
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  IconData get _idleIcon => busy
      ? Icons.sync
      : (statusColor == Colors.grey
            ? Icons.pause_circle_outline
            : Icons.hourglass_bottom);

  Widget _inlineCountdown(ThemeData t) {
    final value = totalSeconds == null || totalSeconds! <= 0
        ? 0.0
        : (secondsLeft! / totalSeconds!).clamp(0.0, 1.0);
    return Row(
      children: [
        Text(
          mmss(secondsLeft!),
          style: t.textTheme.titleLarge?.copyWith(
            fontWeight: FontWeight.w800,
            fontFeatures: const [FontFeature.tabularFigures()],
          ),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: ClipRRect(
            borderRadius: BorderRadius.circular(6),
            child: LinearProgressIndicator(
              value: value,
              minHeight: 8,
              color: statusColor,
              backgroundColor: statusColor.withValues(alpha: 0.14),
            ),
          ),
        ),
      ],
    );
  }

  Widget _seatStrip(
    ThemeData t,
    List<(String, SeatState)> seats,
    int heldCount,
    int total,
  ) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Text(
              'Seats',
              style: t.textTheme.titleSmall?.copyWith(
                fontWeight: FontWeight.w800,
              ),
            ),
            const Spacer(),
            if (total > 0 && active)
              Text(
                '$heldCount of $total held',
                style: TextStyle(
                  fontWeight: FontWeight.w700,
                  color: heldCount == total && total > 0
                      ? Colors.green.shade400
                      : t.colorScheme.onSurfaceVariant,
                ),
              ),
          ],
        ),
        const SizedBox(height: 8),
        if (seats.isEmpty)
          Text(
            autoSeatCount > 0
                ? 'The first $autoSeatCount free seat(s) will be picked.'
                : 'No seats held yet.',
            style: t.textTheme.bodySmall,
          )
        else
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              for (final s in seats) SeatChip(name: s.$1, state: s.$2),
            ],
          ),
      ],
    );
  }

  Widget _footerRow(ThemeData t) {
    final ended = stopAt != null && !stopAt!.isAfter(DateTime.now());
    final text = stopAt == null
        ? 'Runs until you stop it'
        : (ended
              ? 'Was set to run until ${clock(stopAt!)}'
              : (active
                    ? 'Runs until ${clock(stopAt!)}'
                    : 'Set to run until ${clock(stopAt!)}'));
    return Row(
      children: [
        Icon(
          stopAt == null ? Icons.all_inclusive : Icons.flag_outlined,
          size: 18,
          color: t.colorScheme.primary,
        ),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            text,
            style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13),
          ),
        ),
        if (stopAt != null && active && !ended)
          Text(
            'in ${until(stopAt!)}',
            style: TextStyle(
              color: t.colorScheme.onSurfaceVariant,
              fontSize: 12,
            ),
          ),
      ],
    );
  }
}

/// One seat, drawn like a small seat tile: green with a tick when held, outlined while it is still being waited for.
class SeatChip extends StatelessWidget {
  const SeatChip({super.key, required this.name, required this.state});
  final String name;
  final SeatState state;

  @override
  Widget build(BuildContext context) {
    final held = state == SeatState.held;
    final idle = state == SeatState.idle;
    final base = held ? Colors.green : Theme.of(context).colorScheme.outline;
    return AnimatedContainer(
      duration: const Duration(milliseconds: 350),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
      decoration: BoxDecoration(
        color: held ? Colors.green.withValues(alpha: 0.18) : Colors.transparent,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(
          color: base.withValues(alpha: held ? 0.9 : 0.5),
          width: held ? 1.6 : 1.2,
        ),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(
            Icons.event_seat,
            size: 18,
            color: held ? Colors.green.shade400 : base,
          ),
          const SizedBox(width: 6),
          Text(
            name,
            style: TextStyle(
              fontWeight: FontWeight.w800,
              fontSize: 14,
              color: held ? Colors.green.shade300 : null,
            ),
          ),
          if (!idle) ...[
            const SizedBox(width: 4),
            Icon(
              held ? Icons.check_circle : Icons.hourglass_empty,
              size: 15,
              color: held ? Colors.green.shade400 : base,
            ),
          ],
        ],
      ),
    );
  }
}
