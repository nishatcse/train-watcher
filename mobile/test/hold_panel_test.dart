import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:train_watcher/features/holder/hold_panel.dart';
import 'package:train_watcher/features/holder/holder_remote.dart';

Widget _wrap(Widget child) => MaterialApp(
  home: Scaffold(body: SingleChildScrollView(child: child)),
);

HoldPanel _panel({
  List<String> held = const ['DHA-1', 'DHA-2'],
  double? left = 375,
  bool busy = false,
  DateTime? stopAt,
}) => HoldPanel(
  trainName: 'TURNA EXPRESS (741)',
  fromCity: 'Chattogram',
  toCity: 'Dhaka',
  journeyDate: '6 Nov 2026',
  seatClass: 'S_CHAIR',
  coach: 'DHA',
  wantedSeats: const ['DHA-1', 'DHA-2', 'DHA-7', 'DHA-8'],
  heldSeats: held,
  statusLabel: 'HOLDING',
  statusColor: Colors.green,
  secondsLeft: left,
  totalSeconds: 375,
  busy: busy,
  cycles: 2,
  stopAt: stopAt,
);

void main() {
  testWidgets('shows the train, route, date, class and coach', (tester) async {
    await tester.pumpWidget(_wrap(_panel()));
    expect(find.text('TURNA EXPRESS (741)'), findsOneWidget);
    expect(find.text('Chattogram  →  Dhaka'), findsOneWidget);
    expect(find.text('6 Nov 2026'), findsOneWidget);
    expect(find.text('S CHAIR'), findsOneWidget);
    expect(find.text('Coach DHA'), findsOneWidget);
    expect(find.text('HOLDING'), findsOneWidget);
  });

  testWidgets('every wanted seat is listed, with how many are held', (
    tester,
  ) async {
    await tester.pumpWidget(_wrap(_panel()));
    for (final s in ['DHA-1', 'DHA-2', 'DHA-7', 'DHA-8']) {
      expect(find.text(s), findsOneWidget);
    }
    expect(find.text('2 of 4 held'), findsOneWidget);
    expect(
      find.byIcon(Icons.check_circle),
      findsNWidgets(2),
      reason: 'two held seats are ticked',
    );
    expect(
      find.byIcon(Icons.hourglass_empty),
      findsNWidgets(2),
      reason: 'two are still being waited for',
    );
  });

  testWidgets('the countdown reads minutes and seconds, in the current cycle', (
    tester,
  ) async {
    await tester.pumpWidget(_wrap(_panel(left: 375)));
    expect(find.text('6:15'), findsOneWidget);
    expect(find.text('until release'), findsOneWidget);
    expect(
      find.text('Cycle 3'),
      findsOneWidget,
      reason: 'two cycles are done, so this is the third',
    );
  });

  testWidgets(
    'between holds the ring says what it is doing instead of a countdown',
    (tester) async {
      await tester.pumpWidget(
        _wrap(_panel(left: null, held: const [], busy: true)),
      );
      expect(find.text('Working…'), findsOneWidget);
      expect(find.text('until release'), findsNothing);
      expect(find.text('0 of 4 held'), findsOneWidget);
    },
  );

  testWidgets(
    'seats picked automatically are shown as held, and an empty hold says so',
    (tester) async {
      await tester.pumpWidget(
        _wrap(
          const HoldPanel(
            trainName: 'T',
            fromCity: 'A',
            toCity: 'B',
            journeyDate: '',
            seatClass: '',
            statusLabel: 'IDLE',
            statusColor: Colors.grey,
            autoSeatCount: 2,
          ),
        ),
      );
      expect(
        find.text('The first 2 free seat(s) will be picked.'),
        findsOneWidget,
      );
      await tester.pumpWidget(
        _wrap(
          const HoldPanel(
            trainName: 'T',
            fromCity: 'A',
            toCity: 'B',
            journeyDate: '',
            seatClass: '',
            statusLabel: 'HOLDING',
            statusColor: Colors.green,
            heldSeats: ['KA-3', 'KA-4'],
          ),
        ),
      );
      expect(find.text('KA-3'), findsOneWidget);
    },
  );

  testWidgets('shows when it ends and how long that is', (tester) async {
    await tester.pumpWidget(
      _wrap(
        _panel(
          stopAt: DateTime.now().add(const Duration(hours: 5, minutes: 30)),
        ),
      ),
    );
    expect(find.textContaining('Runs until'), findsOneWidget);
    expect(find.text('in 5h 29m'), findsOneWidget);
    await tester.pumpWidget(_wrap(_panel()));
    expect(find.text('Runs until you stop it'), findsOneWidget);
  });

  testWidgets(
    'a finished hold shows seats plainly and says the end time has passed',
    (tester) async {
      await tester.pumpWidget(
        _wrap(
          HoldPanel(
            trainName: 'T',
            fromCity: 'A',
            toCity: 'B',
            journeyDate: '',
            seatClass: '',
            statusLabel: 'FINISHED',
            statusColor: Colors.grey,
            wantedSeats: const ['KA-1', 'KA-2'],
            active: false,
            cycles: 3,
            stopAt: DateTime.now().subtract(const Duration(minutes: 5)),
          ),
        ),
      );
      expect(find.text('KA-1'), findsOneWidget);
      expect(
        find.byIcon(Icons.hourglass_empty),
        findsNothing,
        reason: 'not "waiting" once the hold is over',
      );
      expect(find.textContaining('of 2 held'), findsNothing);
      expect(find.text('3 cycles done'), findsOneWidget);
      expect(find.textContaining('Was set to run until'), findsOneWidget);
      expect(find.textContaining('in now'), findsNothing);
    },
  );

  testWidgets(
    'a hold that has not started yet says it is set to run until the end time',
    (tester) async {
      await tester.pumpWidget(
        _wrap(
          HoldPanel(
            trainName: 'T',
            fromCity: 'A',
            toCity: 'B',
            journeyDate: '',
            seatClass: '',
            statusLabel: 'IDLE',
            statusColor: Colors.grey,
            wantedSeats: const ['KA-1'],
            active: false,
            stopAt: DateTime.now().add(const Duration(days: 3)),
          ),
        ),
      );
      expect(find.textContaining('Set to run until'), findsOneWidget);
      expect(find.textContaining('Was set to'), findsNothing);
    },
  );

  testWidgets('says what the SITE confirmed, and warns when it did not', (
    tester,
  ) async {
    await tester.pumpWidget(
      _wrap(
        const HoldPanel(
          trainName: 'T',
          fromCity: 'A',
          toCity: 'B',
          journeyDate: '',
          seatClass: '',
          statusLabel: 'HOLDING',
          statusColor: Colors.green,
          heldSeats: ['KA-1'],
          verifiedText:
              'Confirmed by the site at 6:47 AM: these seats show as taken',
          verifiedOk: true,
        ),
      ),
    );
    expect(
      find.textContaining('Confirmed by the site at 6:47 AM'),
      findsOneWidget,
    );
    expect(find.byIcon(Icons.verified), findsOneWidget);
    await tester.pumpWidget(
      _wrap(
        const HoldPanel(
          trainName: 'T',
          fromCity: 'A',
          toCity: 'B',
          journeyDate: '',
          seatClass: '',
          statusLabel: 'HOLDING',
          statusColor: Colors.green,
          heldSeats: ['KA-1'],
          verifiedText: 'The site showed some seats as free',
          verifiedOk: false,
        ),
      ),
    );
    expect(find.byIcon(Icons.error_outline), findsOneWidget);
  });

  test('time helpers', () {
    expect(HoldPanel.mmss(375), '6:15');
    expect(HoldPanel.mmss(0.2), '0:01');
    expect(
      HoldPanel.until(DateTime(2026, 1, 3, 12), DateTime(2026, 1, 1, 9)),
      '2d 3h',
    );
    expect(
      HoldPanel.until(DateTime(2026, 1, 1, 9, 12), DateTime(2026, 1, 1, 9)),
      '12m',
    );
    expect(
      HoldPanel.until(DateTime(2026, 1, 1, 8), DateTime(2026, 1, 1, 9)),
      'now',
    );
    expect(
      HoldPanel.clock(DateTime(2026, 11, 6, 23, 31)),
      'Fri 6 Nov, 11:31 PM',
    );
  });

  test(
    'the hold window starts at the last "Held n/..." event, not at a failed attempt',
    () {
      final t = DateTime(2026, 1, 1, 10);
      expect(
        holdWindowStart([
          (at: t, message: 'Held 2/2 seat(s): KA-1, KA-2'),
          (
            at: t.subtract(const Duration(minutes: 6)),
            message: 'Held 2/2 seat(s)',
          ),
        ]),
        t,
      );
      expect(holdWindowStart([(at: t, message: 'Held 0/2 seat(s): ')]), isNull);
      expect(
        holdWindowStart([(at: t, message: 'NET reserve-seat -> 200')]),
        isNull,
      );
    },
  );
}
