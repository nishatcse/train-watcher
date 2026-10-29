import 'dart:convert';

// JavaScript snippets for DOM automation inside Bangladesh Railway's Angular single page app.
// The site signs every reserve-seat / release-seat request itself (Turnstile token + action token),
// so these scripts only click what a person would click, then report back over SeatHolderBridge.
//
// The class names below (.single-seat-class, .book-now-btn, .btn-seat, .seat-selected, #select-bogie)
// have not been checked against the live seat grid, which sits behind login + Turnstile. Every script
// reports what it found (or failed to find) through the bridge so the HUD log shows a mismatch.
class SeatAutomationJs {
  static const String bridgeChannelName = 'SeatHolderBridge';

  /// Defines window._postToFlutter and the shared DOM helpers. Safe to run on every page load.
  static String initBridge() =>
      '''
(function() {
  if (window._seatHolderBridgeInstalled) return 'already_installed';
  window._seatHolderBridgeInstalled = true;

  window._postToFlutter = function(type, payload) {
    try {
      if (window.$bridgeChannelName && window.$bridgeChannelName.postMessage) {
        window.$bridgeChannelName.postMessage(JSON.stringify({ type: type, payload: payload || {} }));
      }
    } catch (e) {}
  };

  // Track the seat API calls. Every reserve/release is recorded with its seat and final HTTP status and is
  // counted while in flight, so the automation waits for the site's own answer instead of guessing from the
  // seat colour. Only the seat number is read from a request body (never the tokens); responses are logged.
  window._shNet = { inflight: 0, calls: [], count: 0 };
  (function() {
    var watched = /reserve-seat|release-seat|seat-layout/;
    var counted = /reserve-seat|release-seat/;
    var open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {
      this._shMethod = method;
      this._shUrl = String(url);
      return open.apply(this, arguments);
    };
    var send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function(body) {
      var xhr = this, started = Date.now(), url = xhr._shUrl || '';
      if (watched.test(url)) {
        var rec = null;
        if (counted.test(url)) {
          var seat = '';
          try { seat = String(JSON.parse(body).extras.seat_number || '').toUpperCase(); } catch (e) {}
          rec = { n: ++window._shNet.count, kind: /reserve/.test(url) ? 'reserve' : 'release', seat: seat, status: null, ok: false };
          window._shNet.calls.push(rec);
          if (window._shNet.calls.length > 200) window._shNet.calls.shift();
          window._shNet.inflight++;
        }
        xhr.addEventListener('loadend', function() {
          var text = '';
          try { text = (xhr.responseText || '').slice(0, 320); } catch (e) {}
          if (rec) {
            rec.status = xhr.status;
            // A release answered 422 means the site already dropped the hold: the seat is free either way.
            rec.ok = (xhr.status >= 200 && xhr.status < 300) || (rec.kind === 'release' && xhr.status === 422);
            window._shNet.inflight--;
          }
          window._postToFlutter('net', {
            method: xhr._shMethod, url: url.split('?')[0].split('/').slice(-2).join('/'), seat: rec ? rec.seat : '',
            status: xhr.status, ms: Date.now() - started, body: text
          });
        });
      }
      return send.apply(this, arguments);
    };
  })();

  window._sh = {
    sleep: function(ms) { return new Promise(function(r) { setTimeout(r, ms); }); },
    seatName: function(el) {
      return (el.getAttribute('title') || el.getAttribute('aria-label') || el.innerText || '').trim().toUpperCase();
    },
    grid: function() { return Array.from(document.querySelectorAll('.btn-seat')); },
    selected: function() {
      return window._sh.grid().filter(function(s) { return s.classList.contains('seat-selected'); });
    },
    // Clicks one seat and waits for the site's answer. The page ignores clicks while one of its own requests
    // is still running (a slow release can take 10 s), so a click that starts no request within 2.5 s is
    // repeated. Returns the finished call {ok, status}, 'already' when the seat was already in the wanted state,
    // or null when nothing happened.
    act: async function(name, kind) {
      var sh = window._sh, net = window._shNet;
      for (var attempt = 0; attempt < 3; attempt++) {
        var el = sh.grid().find(function(s) { return sh.seatName(s) === name; });
        if (!el) return null;
        var isSelected = el.classList.contains('seat-selected');
        if ((kind === 'reserve') === isSelected) return 'already';
        var from = net.count;
        el.click();
        var started = await sh.waitFor(function() { return net.count > from; }, 2500);
        if (!started) continue;
        await sh.waitFor(function() { return net.inflight === 0; }, 40000);
        var done = net.calls.filter(function(c) { return c.n > from && c.kind === kind; });
        return done.length ? done[done.length - 1] : null;
      }
      return null;
    },
    waitFor: async function(pred, ms) {
      var end = Date.now() + ms;
      while (Date.now() < end) {
        if (pred()) return true;
        await window._sh.sleep(100);
      }
      return pred();
    }
  };
  return 'installed';
})();
''';

  /// Snapshot of the page, read with runJavaScriptReturningResult.
  static const String readPageState = '''
(function() {
  try {
    var grid = Array.from(document.querySelectorAll('.btn-seat'));
    return JSON.stringify({
      trips: document.querySelectorAll('app-single-trip').length,
      // The site's login page (session lapsed after ~12 h): a password field or a login/auth route.
      login: !!document.querySelector('input[type=password]') || /login|signin|auth/i.test(location.pathname),
      inGrid: grid.length > 0,
      available: grid.filter(function(s) { return s.classList.contains('seat-available'); }).length,
      selected: grid.filter(function(s) { return s.classList.contains('seat-selected'); })
        .map(function(s) { return (s.getAttribute('title') || s.getAttribute('aria-label') || s.innerText || '').trim().toUpperCase(); })
    });
  } catch (e) {
    return JSON.stringify({ trips: 0, inGrid: false, available: 0, selected: [], error: String(e) });
  }
})();
''';

  /// Clicks "Book Now" for the wanted train and class on the trip list.
  static String openSeatLayout({
    required String trainName,
    required String seatClass,
  }) {
    // "BHRAMMAPUTRA EXPRESS (744)" -> match on "744"; otherwise on the whole name.
    final m = RegExp(r'\((\d+)\)').firstMatch(trainName);
    final key = (m != null ? m.group(1)! : trainName.trim()).toUpperCase();
    final cls = seatClass.trim().toUpperCase();

    return '''
(function() {
  try {
    var trainKey = ${jsonEncode(key)};
    var wantedClass = ${jsonEncode(cls)};
    var cards = Array.from(document.querySelectorAll('app-single-trip'));
    if (cards.length === 0) {
      window._postToFlutter('error', { stage: 'openSeatLayout', message: 'No train cards on the page yet.' });
      return;
    }
    var card = cards.find(function(c) { return (c.innerText || '').toUpperCase().indexOf(trainKey) !== -1; });
    if (!card) {
      window._postToFlutter('error', { stage: 'openSeatLayout', message: 'Train ' + trainKey + ' is not in the list (' + cards.length + ' trains shown).' });
      return;
    }

    var btn = null;
    var rows = Array.from(card.querySelectorAll('.single-seat-class'));
    for (var i = 0; i < rows.length && !btn; i++) {
      var nameEl = rows[i].querySelector('.seat-class-name');
      var name = nameEl ? (nameEl.innerText || '').trim().toUpperCase() : (rows[i].innerText || '').toUpperCase();
      if (name.indexOf(wantedClass) === -1) continue;
      btn = rows[i].querySelector('.book-now-btn, button');
      if (!btn) {
        // The site drops the Book Now button entirely when a class has no seats left.
        var left = rows[i].querySelector('.all-seats');
        window._postToFlutter('seat_layout_disabled', { message: wantedClass + ' on ' + trainKey + ' has ' + (left ? left.innerText.trim() : '0') + ' seats, so there is nothing to hold.' });
        return;
      }
    }
    if (!btn) {
      // Class names differ from what we expect: find a "Book Now" button whose surrounding block names the class.
      var all = Array.from(card.querySelectorAll('button, a')).filter(function(b) { return /book\\s*now/i.test(b.innerText || ''); });
      btn = all.find(function(b) {
        var el = b;
        for (var up = 0; up < 5 && el && el !== card; up++, el = el.parentElement) {
          if ((el.innerText || '').toUpperCase().indexOf(wantedClass) !== -1) return true;
        }
        return false;
      }) || null;
      if (!btn) {
        window._postToFlutter('error', { stage: 'openSeatLayout', message: 'No Book Now button for class ' + wantedClass + ' (' + all.length + ' Book Now buttons on the card).' });
        return;
      }
    }
    if (btn.disabled || btn.classList.contains('disabled')) {
      window._postToFlutter('seat_layout_disabled', { message: 'Book Now is disabled (no seats in ' + wantedClass + ').' });
      return;
    }
    btn.click();
    window._postToFlutter('clicked_book_now', { train: trainKey, seatClass: wantedClass });
  } catch (e) {
    window._postToFlutter('error', { stage: 'openSeatLayout', message: String(e) });
  }
})();
''';
  }

  /// Picks the wanted coach in the bogie dropdown.
  static String selectCoach(String coachName) {
    return '''
(function() {
  try {
    var wanted = ${jsonEncode(coachName.trim().toUpperCase())};
    var select = document.querySelector('#select-bogie');
    if (!select) {
      window._postToFlutter('coach_selected', { coach: '(no coach dropdown on this page)' });
      return;
    }
    for (var i = 0; i < select.options.length; i++) {
      var text = (select.options[i].text || select.options[i].label || '').toUpperCase();
      if (text.indexOf(wanted) !== -1) {
        select.value = select.options[i].value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        window._postToFlutter('coach_selected', { coach: text.trim() });
        return;
      }
    }
    window._postToFlutter('error', { stage: 'selectCoach', message: 'Coach ' + wanted + ' is not in the dropdown.' });
  } catch (e) {
    window._postToFlutter('error', { stage: 'selectCoach', message: String(e) });
  }
})();
''';
  }

  /// Clicks the wanted seats, one at a time, then waits until the page marks them selected. Posts
  /// seats_selected with only the seats that really got held.
  ///
  /// [targetSeats] are the seats the owner asked for by name: only those are tried. Without them,
  /// [preferredSeats] (what was held last cycle) are taken first if still free, and the rest of
  /// [maxCount] is filled with the first available seats, so a seat lost to someone else is replaced.
  static String selectSeats({
    required List<String> targetSeats,
    List<String> preferredSeats = const [],
    required int maxCount,
  }) {
    return '''
(async function() {
  try {
    var sh = window._sh;
    var targets = ${jsonEncode(targetSeats.map((s) => s.trim().toUpperCase()).toList())};
    var preferred = ${jsonEncode(preferredSeats.map((s) => s.trim().toUpperCase()).toList())};
    var maxCount = ${maxCount.clamp(1, 4)};
    var grid = sh.grid();
    if (grid.length === 0) {
      window._postToFlutter('error', { stage: 'selectSeats', message: 'Seat grid is not on the page.' });
      window._postToFlutter('seats_selected', { seats: [], wanted: 0 });
      return;
    }

    var picks = [];
    var unavailable = [];
    if (targets.length > 0) {
      targets.forEach(function(t) {
        var el = grid.find(function(s) { return sh.seatName(s) === t; });
        // A seat the page shows as taken is not clicked (and not waited for): it is reported instead.
        if (el && (el.classList.contains('seat-available') || el.classList.contains('seat-selected'))) picks.push(el);
        else unavailable.push(t);
      });
    } else {
      // Seats already selected count toward the limit and are kept.
      picks = grid.filter(function(s) { return s.classList.contains('seat-selected'); });
      var free = function(s) { return s.classList.contains('seat-available') && picks.indexOf(s) === -1; };
      preferred.forEach(function(name) {
        var el = grid.find(function(s) { return sh.seatName(s) === name; });
        if (el && picks.length < maxCount && free(el)) picks.push(el);
      });
      grid.forEach(function(s) {
        if (picks.length < maxCount && free(s)) picks.push(s);
      });
    }
    picks = picks.slice(0, 4);
    if (picks.length === 0) {
      window._postToFlutter('seats_selected', { seats: [], wanted: 0, failed: [], unavailable: unavailable });
      return;
    }

    // Angular may re-render the buttons after a click, so everything below goes by seat name, not element.
    // One seat at a time: click, wait for the site's answer, then the next (no fixed delay in between).
    var names = picks.map(sh.seatName);
    var failed = [];
    var accepted = [];
    for (var i = 0; i < names.length; i++) {
      var r = await sh.act(names[i], 'reserve');
      if (r === 'already' || (r && r.ok)) accepted.push(names[i]);
      else failed.push({ seat: names[i], status: r ? r.status : 'no-request' });
    }
    var heldNames = function() { return sh.selected().map(sh.seatName); };
    await sh.waitFor(function() {
      var now = heldNames();
      return accepted.every(function(n) { return now.indexOf(n) !== -1; });
    }, 3000);
    var now = heldNames();
    // Held = accepted by the server AND shown as selected on the page.
    var held = accepted.filter(function(n) { return now.indexOf(n) !== -1; });
    window._postToFlutter('seats_selected', { seats: held, wanted: names.length, failed: failed, unavailable: unavailable });
  } catch (e) {
    window._postToFlutter('error', { stage: 'selectSeats', message: String(e) });
    window._postToFlutter('seats_selected', { seats: [], wanted: 0 });
  }
})();
''';
  }

  /// Releases every selected seat (limited to [heldSeats] when given), one at a time and as fast as the site
  /// answers, then reports only the seats the site confirmed free (and the page shows as free).
  static String unselectSeats(List<String> heldSeats) {
    return '''
(async function() {
  try {
    var sh = window._sh;
    var only = ${jsonEncode(heldSeats.map((s) => s.trim().toUpperCase()).toList())};
    var names = sh.selected().map(sh.seatName).filter(function(n) { return only.length === 0 || only.indexOf(n) !== -1; });
    var failed = [];
    var accepted = [];
    for (var i = 0; i < names.length; i++) {
      var r = await sh.act(names[i], 'release');
      if (r === 'already' || (r && r.ok)) accepted.push(names[i]);
      else failed.push({ seat: names[i], status: r ? r.status : 'no-request' });
    }
    var heldNames = function() { return sh.selected().map(sh.seatName); };
    await sh.waitFor(function() {
      var now = heldNames();
      return accepted.every(function(n) { return now.indexOf(n) === -1; });
    }, 3000);
    var now = heldNames();
    var released = accepted.filter(function(n) { return now.indexOf(n) === -1; });
    window._postToFlutter('seats_unselected', { seats: released, wanted: names.length, failed: failed });
  } catch (e) {
    window._postToFlutter('error', { stage: 'unselectSeats', message: String(e) });
    window._postToFlutter('seats_unselected', { seats: [], wanted: -1, failed: [] });
  }
})();
''';
  }
}
