import '../core/models.dart';

/// Everything the alert screen needs, whether it came from a push, a tapped
/// notification, or the history list.
class AlertData {
  AlertData({
    required this.alertId,
    required this.title,
    required this.body,
    required this.url,
    required this.route,
    required this.trainName,
    required this.seatClass,
    required this.journeyDate,
    required this.seats,
    required this.isTest,
  });

  final String alertId, title, body, route, trainName, seatClass, journeyDate;
  final String? url;
  /// Total available seats (online + counter), all bookable on the website.
  final int seats;
  final bool isTest;

  factory AlertData.fromMap(Map<String, dynamic> m) => AlertData(
        alertId: (m['alertId'] ?? m['notificationId'] ?? '').toString(),
        title: (m['title'] ?? 'Railway Seat Available').toString(),
        body: (m['body'] ?? '').toString(),
        url: (m['url'] as String?)?.isEmpty ?? true ? null : m['url'].toString(),
        route: (m['route'] ?? '').toString(),
        trainName: (m['trainName'] ?? '').toString(),
        seatClass: (m['seatClass'] ?? '').toString(),
        journeyDate: (m['journeyDate'] ?? '').toString(),
        seats: int.tryParse((m['seats'] ?? '0').toString()) ?? 0,
        isTest: m['type'] == 'test',
      );

  factory AlertData.fromItem(AlertItem a) => AlertData.fromMap({
        ...a.payload,
        'alertId': a.alertId,
        'title': a.title,
        'body': a.body,
        'type': a.kind,
      });
}
