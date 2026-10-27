DateTime? _dt(dynamic v) => v == null ? null : DateTime.tryParse(v as String)?.toLocal();
int? _int(dynamic v) => v == null ? null : (v as num).toInt();

class Watcher {
  Watcher({
    required this.id,
    required this.fromCity,
    required this.toCity,
    required this.journeyDate,
    required this.trainName,
    required this.seatClass,
    required this.enabled,
    this.lastCheckStatus,
    this.lastCheckedAt,
    this.lastError,
    this.warnings = const [],
    this.availableSeats,
    this.onlineSeats,
    this.counterSeats,
    this.totalFare,
  });

  final String id, fromCity, toCity, journeyDate, trainName, seatClass;
  final bool enabled;
  final String? lastCheckStatus, lastError;
  final DateTime? lastCheckedAt;
  final List<String> warnings;
  /// online + counter. This is the number that counts as "available".
  final int? availableSeats, onlineSeats, counterSeats;
  final num? totalFare;

  factory Watcher.fromJson(Map<String, dynamic> j) => Watcher(
        id: j['id'] as String,
        fromCity: j['fromCity'] as String,
        toCity: j['toCity'] as String,
        journeyDate: j['journeyDate'] as String,
        trainName: j['trainName'] as String,
        seatClass: j['seatClass'] as String,
        enabled: j['enabled'] as bool,
        lastCheckStatus: j['lastCheckStatus'] as String?,
        lastCheckedAt: _dt(j['lastCheckedAt']),
        lastError: j['lastError'] as String?,
        warnings: ((j['warnings'] as List?) ?? const []).map((e) => e.toString()).toList(),
        availableSeats: _int(j['availableSeats']),
        onlineSeats: _int(j['onlineSeats']),
        counterSeats: _int(j['counterSeats']),
        totalFare: j['totalFare'] as num?,
      );
}

class SaveResult {
  SaveResult(this.watcher, this.warnings);
  final Watcher watcher;
  final List<String> warnings;
  factory SaveResult.fromJson(Map<String, dynamic> j) => SaveResult(
        Watcher.fromJson(j['watcher'] as Map<String, dynamic>),
        ((j['warnings'] as List?) ?? const []).map((e) => e.toString()).toList(),
      );
}

class VerifyResult {
  VerifyResult({required this.status, required this.trainListed, required this.classOffered, required this.availableSeats, required this.onlineSeats, required this.counterSeats, required this.trainsOnThisSearch});
  final String status;
  final bool trainListed, classOffered;
  final int availableSeats, onlineSeats, counterSeats;
  final List<String> trainsOnThisSearch;
  factory VerifyResult.fromJson(Map<String, dynamic> j) => VerifyResult(
        status: j['status'] as String,
        trainListed: j['trainListed'] as bool,
        classOffered: j['classOffered'] as bool,
        availableSeats: _int(j['availableSeats']) ?? 0,
        onlineSeats: _int(j['onlineSeats']) ?? 0,
        counterSeats: _int(j['counterSeats']) ?? 0,
        trainsOnThisSearch: ((j['trainsOnThisSearch'] as List?) ?? const []).map((e) => e.toString()).toList(),
      );
}

class SessionStatus {
  SessionStatus({required this.status, this.expiresAt, this.secondsLeft, this.hasRefreshToken = false, this.lastReloginAt, this.catalogCachedAt});
  final String status; // active | expiring_soon | expired_awaiting_relogin
  final DateTime? expiresAt, lastReloginAt, catalogCachedAt;
  final int? secondsLeft;
  final bool hasRefreshToken;

  bool get needsLogin => status == 'expired_awaiting_relogin';

  factory SessionStatus.fromJson(Map<String, dynamic> j) => SessionStatus(
        status: j['status'] as String,
        expiresAt: _dt(j['expiresAt']),
        secondsLeft: _int(j['secondsLeft']),
        hasRefreshToken: (j['hasRefreshToken'] as bool?) ?? false,
        lastReloginAt: _dt(j['lastReloginAt']),
        catalogCachedAt: _dt(j['catalogCachedAt']),
      );
}

class EngineStatus {
  EngineStatus({this.cycleRunning = false, this.nextCycleAt, this.skipReason, this.lastCycleAt, this.lastCycleMs, this.lastCycleTargets, this.lastCycleFailed, this.lastError, this.rateLimitedUntil, this.cycleSeconds = 15});
  final bool cycleRunning;
  final DateTime? nextCycleAt, lastCycleAt, rateLimitedUntil;
  final String? skipReason, lastError;
  final int? lastCycleMs, lastCycleTargets, lastCycleFailed;
  final int cycleSeconds;

  factory EngineStatus.fromJson(Map<String, dynamic> j) => EngineStatus(
        cycleRunning: (j['cycleRunning'] as bool?) ?? false,
        nextCycleAt: _dt(j['nextCycleAt']),
        skipReason: j['skipReason'] as String?,
        lastCycleAt: _dt(j['lastCycleAt']),
        lastCycleMs: _int(j['lastCycleMs']),
        lastCycleTargets: _int(j['lastCycleTargets']),
        lastCycleFailed: _int(j['lastCycleFailed']),
        lastError: j['lastError'] as String?,
        rateLimitedUntil: _dt(j['rateLimitedUntil']),
        cycleSeconds: _int(j['cycleSeconds']) ?? 15,
      );
}

class AppStatus {
  AppStatus({required this.engine, required this.session, required this.total, required this.active, required this.withSeats, required this.telegramConfigured, required this.pushConfigured, required this.pairedDevices});
  final EngineStatus engine;
  final SessionStatus session;
  final int total, active, withSeats, pairedDevices;
  final bool telegramConfigured, pushConfigured;

  factory AppStatus.fromJson(Map<String, dynamic> j) {
    final w = j['watchers'] as Map<String, dynamic>;
    final c = j['channels'] as Map<String, dynamic>;
    return AppStatus(
      engine: EngineStatus.fromJson(j['engine'] as Map<String, dynamic>),
      session: SessionStatus.fromJson(j['session'] as Map<String, dynamic>),
      total: _int(w['total']) ?? 0,
      active: _int(w['active']) ?? 0,
      withSeats: _int(w['withSeats']) ?? 0,
      telegramConfigured: (c['telegram'] as bool?) ?? false,
      pushConfigured: (c['fcm'] as bool?) ?? false,
      pairedDevices: _int(c['pairedDevices']) ?? 0,
    );
  }
}

class City {
  City(this.name, this.canDepart, this.top);
  final String name;
  final bool canDepart, top;
}

class TrainInfo {
  TrainInfo(this.model, this.name);
  final String model, name;
}

class CatalogData {
  CatalogData({required this.cities, required this.trains, required this.classes, this.searchDayLimit, this.stale = true, this.cachedAt});
  final List<City> cities;
  final List<TrainInfo> trains;
  final List<String> classes;
  final int? searchDayLimit;
  final bool stale;
  final DateTime? cachedAt;

  bool get isEmpty => cities.isEmpty || trains.isEmpty;

  factory CatalogData.fromJson(Map<String, dynamic> j) => CatalogData(
        cities: ((j['cities'] as List?) ?? const [])
            .map((e) => City(e['name'] as String, (e['canDepart'] as bool?) ?? true, (e['top'] as bool?) ?? false))
            .toList(),
        trains: ((j['trains'] as List?) ?? const []).map((e) => TrainInfo(e['model'].toString(), e['name'] as String)).toList(),
        classes: ((j['classes'] as List?) ?? const []).map((e) => e.toString()).toList(),
        searchDayLimit: _int(j['searchDayLimit']),
        stale: (j['stale'] as bool?) ?? true,
        cachedAt: _dt(j['cachedAt']),
      );
}

class StationsInfo {
  StationsInfo(this.stations, this.days);
  final List<String> stations, days;
  factory StationsInfo.fromJson(Map<String, dynamic> j) => StationsInfo(
        ((j['stations'] as List?) ?? const []).map((e) => e.toString()).toList(),
        ((j['days'] as List?) ?? const []).map((e) => e.toString()).toList(),
      );
}

class ChannelResult {
  ChannelResult({required this.channel, required this.status, this.attempts = 0, this.error});
  final String channel, status;
  final int attempts;
  final String? error;
  factory ChannelResult.fromJson(Map<String, dynamic> j) => ChannelResult(
        channel: j['channel'] as String,
        status: (j['status'] ?? j['delivery_status']) as String,
        attempts: _int(j['attempts']) ?? 0,
        error: (j['error'] ?? j['lastError']) as String?,
      );
}

class AlertItem {
  AlertItem({required this.alertId, required this.kind, required this.title, required this.body, required this.payload, required this.createdAt, this.acknowledgedAt, this.channels = const []});
  final String alertId, kind, title, body;
  final Map<String, dynamic> payload;
  final DateTime createdAt;
  final DateTime? acknowledgedAt;
  final List<ChannelResult> channels;

  bool get isSeatAlert => kind == 'seat_available' || kind == 'test';
  String? get url => payload['url'] as String?;

  factory AlertItem.fromJson(Map<String, dynamic> j) => AlertItem(
        alertId: j['alertId'] as String,
        kind: j['kind'] as String,
        title: j['title'] as String,
        body: j['body'] as String,
        payload: ((j['payload'] as Map?) ?? const {}).cast<String, dynamic>(),
        createdAt: _dt(j['createdAt']) ?? DateTime.now(),
        acknowledgedAt: _dt(j['acknowledgedAt']),
        channels: ((j['channels'] as List?) ?? const []).map((e) => ChannelResult.fromJson(e as Map<String, dynamic>)).toList(),
      );
}

class AppSettings {
  AppSettings({required this.scanCycleSeconds, required this.scanConcurrency, required this.telegramEnabled, required this.fcmEnabled, required this.minScanCycleSeconds, required this.telegramConfigured, required this.pushConfigured});
  final int scanCycleSeconds, scanConcurrency, minScanCycleSeconds;
  final bool telegramEnabled, fcmEnabled, telegramConfigured, pushConfigured;

  factory AppSettings.fromJson(Map<String, dynamic> j) => AppSettings(
        scanCycleSeconds: _int(j['scanCycleSeconds']) ?? 15,
        scanConcurrency: _int(j['scanConcurrency']) ?? 2,
        minScanCycleSeconds: _int(j['minScanCycleSeconds']) ?? 10,
        telegramEnabled: (j['telegramEnabled'] as bool?) ?? true,
        fcmEnabled: (j['fcmEnabled'] as bool?) ?? true,
        telegramConfigured: (j['telegramConfigured'] as bool?) ?? false,
        pushConfigured: (j['pushConfigured'] as bool?) ?? false,
      );
}
