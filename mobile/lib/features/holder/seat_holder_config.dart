class SeatHolderConfig {
  /// Shorter cycles make the site block seat selection for an hour ("repeated attempts"), so they are refused.
  static const double minHoldSeconds = 60;

  const SeatHolderConfig({
    required this.fromCity,
    required this.toCity,
    required this.journeyDate,
    required this.trainName,
    this.seatClass = 'S_CHAIR',
    this.bogieName = '',
    this.seatNumbers = '',
    this.seatCount = 2,
    this.holdDurationSeconds = 375,
    this.stopAt,
  });

  final String fromCity;
  final String toCity;
  final String journeyDate;
  final String trainName;
  final String seatClass;
  final String bogieName;
  final String seatNumbers;
  final int seatCount;

  /// How long the seats are held before they are released and re-selected (375 s = 6 min 15 s).
  final double holdDurationSeconds;
  final DateTime? stopAt;

  /// Pre-fills the route, date and class from a booking-site search URL
  /// (`/booking/train/search?fromcity=..&tocity=..&doj=..&class=..`). Anything missing keeps its default.
  factory SeatHolderConfig.fromSearchUrl(String? url, {String trainName = ''}) {
    final q =
        (url == null ? null : Uri.tryParse(url))?.queryParameters ??
        const <String, String>{};
    return SeatHolderConfig(
      fromCity: q['fromcity'] ?? 'Mymensingh',
      toCity: q['tocity'] ?? 'Dhaka',
      journeyDate: q['doj'] ?? '',
      trainName: trainName,
      seatClass: q['class'] ?? 'S_CHAIR',
    );
  }

  /// For remembering the last entries between launches.
  Map<String, dynamic> toJson() => {
    'fromCity': fromCity,
    'toCity': toCity,
    'journeyDate': journeyDate,
    'trainName': trainName,
    'seatClass': seatClass,
    'bogieName': bogieName,
    'seatNumbers': seatNumbers,
    'seatCount': seatCount,
    'holdDurationSeconds': holdDurationSeconds,
    'stopAt': stopAt?.toIso8601String(),
  };

  factory SeatHolderConfig.fromJson(Map<String, dynamic> j) {
    final stop = DateTime.tryParse((j['stopAt'] ?? '').toString());
    return SeatHolderConfig(
      fromCity: (j['fromCity'] ?? '').toString(),
      toCity: (j['toCity'] ?? '').toString(),
      journeyDate: (j['journeyDate'] ?? '').toString(),
      trainName: (j['trainName'] ?? '').toString(),
      seatClass: (j['seatClass'] ?? 'S_CHAIR').toString(),
      bogieName: (j['bogieName'] ?? '').toString(),
      seatNumbers: (j['seatNumbers'] ?? '').toString(),
      seatCount: ((j['seatCount'] as num?)?.toInt() ?? 2).clamp(1, 4),
      holdDurationSeconds:
          ((j['holdDurationSeconds'] as num?)?.toDouble() ?? 375).clamp(
            minHoldSeconds,
            3600.0,
          ),
      // A stop time that has already passed would end the next run at once, so it is not restored.
      stopAt: stop != null && stop.isAfter(DateTime.now()) ? stop : null,
    );
  }

  String buildSearchUrl() {
    final query = Uri(
      queryParameters: {
        'fromcity': fromCity.trim(),
        'tocity': toCity.trim(),
        'doj': journeyDate.trim(),
        'class': seatClass.trim(),
      },
    ).query;
    return 'https://eticket.railway.gov.bd/booking/train/search?$query';
  }

  List<String> get targetSeatList {
    if (seatNumbers.trim().isEmpty) return const [];
    return seatNumbers
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .where((s) => s.isNotEmpty)
        .toList();
  }

  SeatHolderConfig copyWith({
    String? fromCity,
    String? toCity,
    String? journeyDate,
    String? trainName,
    String? seatClass,
    String? bogieName,
    String? seatNumbers,
    int? seatCount,
    double? holdDurationSeconds,
    DateTime? stopAt,
    bool clearStopAt = false,
  }) {
    return SeatHolderConfig(
      fromCity: fromCity ?? this.fromCity,
      toCity: toCity ?? this.toCity,
      journeyDate: journeyDate ?? this.journeyDate,
      trainName: trainName ?? this.trainName,
      seatClass: seatClass ?? this.seatClass,
      bogieName: bogieName ?? this.bogieName,
      seatNumbers: seatNumbers ?? this.seatNumbers,
      seatCount: seatCount ?? this.seatCount,
      holdDurationSeconds: holdDurationSeconds ?? this.holdDurationSeconds,
      stopAt: clearStopAt ? null : (stopAt ?? this.stopAt),
    );
  }
}
