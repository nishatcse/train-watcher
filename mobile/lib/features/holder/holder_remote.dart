/// A seat hold that runs on the server (the holder-worker service) instead of on this phone.
class RemoteHold {
  RemoteHold({
    required this.id,
    required this.status,
    required this.phase,
    required this.trainName,
    required this.route,
    required this.fromCity,
    required this.toCity,
    required this.journeyDate,
    required this.seatNumbers,
    required this.seatClass,
    required this.bogieName,
    required this.seatCount,
    required this.holdSeconds,
    required this.cycleCount,
    required this.heldSeats,
    required this.active,
    this.stopAt,
    this.blockedUntil,
    this.lastError,
    this.updatedAt,
  });

  final String id,
      status,
      trainName,
      route,
      journeyDate,
      seatNumbers,
      seatClass,
      bogieName;
  final String fromCity, toCity;
  final String? phase, lastError;
  final int seatCount, holdSeconds, cycleCount;
  final List<String> heldSeats;
  final bool active;
  final DateTime? stopAt, blockedUntil, updatedAt;

  factory RemoteHold.fromJson(Map<String, dynamic> j) => RemoteHold(
    id: j['id'] as String,
    status: j['status'] as String,
    phase: j['phase'] as String?,
    trainName: j['trainName'] as String,
    route: '${j['fromCity']} → ${j['toCity']}',
    fromCity: j['fromCity'] as String,
    toCity: j['toCity'] as String,
    seatClass: (j['seatClass'] ?? '') as String,
    bogieName: (j['bogieName'] ?? '') as String,
    journeyDate: j['journeyDate'] as String,
    seatNumbers: (j['seatNumbers'] ?? '') as String,
    seatCount: (j['seatCount'] as num).toInt(),
    holdSeconds: (j['holdSeconds'] as num).toInt(),
    cycleCount: (j['cycleCount'] as num).toInt(),
    heldSeats: ((j['heldSeats'] as List?) ?? const [])
        .map((e) => e.toString())
        .toList(),
    active: j['active'] == true,
    stopAt: _date(j['stopAt']),
    blockedUntil: _date(j['blockedUntil']),
    lastError: j['lastError'] as String?,
    updatedAt: _date(j['updatedAt']),
  );

  static DateTime? _date(Object? v) =>
      v == null ? null : DateTime.tryParse(v.toString())?.toLocal();

  List<String> get wantedSeats => seatNumbers
      .split(',')
      .map((e) => e.trim())
      .where((e) => e.isNotEmpty)
      .toList();

  /// What the worker is doing, in plain words.
  String get phaseLabel => switch (phase) {
    'loading' => 'Opening the booking site',
    'selecting' || 'reselecting' => 'Selecting seats',
    'holding' => 'Holding',
    'releasing' => 'Releasing seats',
    'blocked' => 'Paused: the site blocked seat selection',
    'offline' => 'Waiting for the internet',
    'waiting_login' => 'Waiting for a new Railway login',
    'refreshing' => 'Refreshing the page so the seats are released',
    _ => status == 'queued' ? 'Waiting for the worker to pick it up' : '',
  };
}

/// When the seats were last taken, read from the activity log: "Held 2/2 seat(s): ..." (not "Held 0/2").
DateTime? holdWindowStart(List<({DateTime at, String message})> events) {
  for (final e in events) {
    final m = RegExp(r'^Held (\d+)/').firstMatch(e.message);
    if (m != null) return int.parse(m.group(1)!) > 0 ? e.at : null;
  }
  return null;
}

class RemoteHoldView {
  RemoteHoldView(this.hold, this.events);
  final RemoteHold? hold;
  final List<({DateTime at, String message})> events;

  factory RemoteHoldView.fromJson(Map<String, dynamic> j) {
    final h = j['hold'];
    return RemoteHoldView(
      h == null
          ? null
          : RemoteHold.fromJson((h as Map).cast<String, dynamic>()),
      ((j['events'] as List?) ?? const [])
          .map(
            (e) => (
              at: DateTime.parse((e as Map)['at'].toString()).toLocal(),
              message: e['message'].toString(),
            ),
          )
          .toList(),
    );
  }
}
