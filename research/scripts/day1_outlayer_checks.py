"""Phase 0 checks of OutLayer on testnet over HTTPS (PLAN.md 13), using the pb-ol-probe program (risk/probe).

Usage: python3 -I research/scripts/day1_outlayer_checks.py <check> [--out FILE] [--ns 500,1000 (calls only)]

Checks (each writes research/data/day1_outlayer_<check>.json unless --out is given):
  smoke   one `hello` run with env names, plus the run's attestation record
  hello   20 sequential `hello` runs: success count, latency, cost, any 408/500/503
  lock    5 concurrent lock attempts on one fresh key, 3 rounds: set_if_absent, then set_if_equals
          after a release; persistence is read back by a later run; keys are deleted at the end
  prices  3 `prices` runs: per-source HTTP status and latency from inside OutLayer
  calls   `calls` with n = 10, 30, 60, 100, 150, 200, stopping after the first n that fails
  big     `big` outputs of 256, 900, 1024, 2048 and 4096 bytes, checked byte for byte
  limits  the limits a run is given for a few X-Compute-Limit values, with and without a body
          `resource_limits`

The payment key is read from .env (OUTLAYER_PAYMENT_KEY) inside this process. It is sent only as the
X-Payment-Key header to the testnet API and is never printed or saved: every record is scrubbed of it
before it is written. Testnet only.
"""
import datetime
import json
import os
import re
import statistics
import sys
import threading
import time
import urllib.error
import urllib.request

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
API = "https://testnet-api.outlayer.ai"
OWNER, PROJECT = "pbf-keeper.testnet", "pb-probe"
# The published build (research/data/day1_outlayer_publish.json). Every call pins it.
VERSION_KEY = "3f89e6441848ad7d323e37888d3fa560d636577d95ace635b7f984f3fa4de466"
# The first build, c6ea51a6db131c84a2360535a7be458ab5334a5980758384330b22110080238b, ran hello, lock,
# prices and calls (same code for those modes); it could not make a `big` output under 329 bytes.
COMPUTE_LIMIT = 10_000   # USD micro-units per call: $0.01, the API's default, said out loud
UA = "pb-research/0.1"
PAD = "0123456789abcdefghijklmnopqrstuvwxyz"
KEY_FORMAT = re.compile(r"^[a-z0-9._-]+:\d+:[0-9a-f]{64}$")


def load_key():
    """OUTLAYER_PAYMENT_KEY from the repo's .env, parsed here so that no shell ever holds it."""
    value = None
    with open(os.path.join(REPO, ".env")) as f:
        for line in f:
            line = line.strip()
            if line.startswith("OUTLAYER_PAYMENT_KEY="):
                value = line.split("=", 1)[1].strip().strip('"').strip("'")
    if not value or not KEY_FORMAT.match(value):
        raise SystemExit("OUTLAYER_PAYMENT_KEY is missing from .env or is not owner:nonce:<64 hex>")
    owner, nonce, _ = value.split(":")
    if owner != OWNER:
        raise SystemExit("OUTLAYER_PAYMENT_KEY belongs to another account than " + OWNER)
    return value, owner, int(nonce)


KEY, KEY_OWNER, KEY_NONCE = load_key()
SECRET = KEY.split(":")[2]


def scrub(obj):
    """The record with the key's secret replaced, wherever it might appear."""
    text = json.dumps(obj)
    return json.loads(text.replace(SECRET, "<redacted>")) if SECRET in text else obj


def now_ms():
    return int(time.time() * 1000)


def http(method, url, body=None, headers=None, timeout=200):
    """(status, parsed body or text, wall ms). Status 0 means no HTTP answer at all."""
    h = {"User-Agent": UA, "Accept": "application/json"}
    h.update(headers or {})
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        h["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=h, method=method)
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            status, raw = r.status, r.read().decode(errors="replace")
    except urllib.error.HTTPError as e:
        status, raw = e.code, e.read().decode(errors="replace")
    except Exception as e:   # timeouts, resets, DNS: recorded, not raised
        return 0, f"{type(e).__name__}: {e}", round((time.perf_counter() - t0) * 1000)
    wall = round((time.perf_counter() - t0) * 1000)
    try:
        return status, json.loads(raw), wall
    except ValueError:
        return status, raw[:500], wall


def call(inp, is_async=False, compute_limit=COMPUTE_LIMIT, timeout=200, extra_body=None):
    """One HTTPS run of the probe. Returns a flat record of what came back."""
    headers = {"X-Payment-Key": KEY, "X-Compute-Limit": str(compute_limit)}
    body = {"input": inp, "async": is_async, "version_key": VERSION_KEY, **(extra_body or {})}
    sent = now_ms()
    status, resp, wall = http("POST", f"{API}/call/{OWNER}/{PROJECT}", body, headers, timeout)
    rec = {"input": inp, "sent_ms": sent, "http": status, "wall_ms": wall}
    if isinstance(resp, dict):
        for k in ("call_id", "status", "output", "error", "compute_cost", "instructions", "time_ms",
                  "attestation_url", "poll_url", "reason"):
            if k in resp:
                rec[k] = resp[k]
        extra = {k: v for k, v in resp.items() if k not in rec}
        if extra:
            rec["other_fields"] = extra
    else:
        rec["body"] = resp
    return rec


def poll(rec, every=2.0, limit_s=300):
    """Wait for an async run to settle; the final record keeps the submit timings."""
    if rec.get("http") != 200 or not rec.get("call_id"):
        return rec
    t0 = time.time()
    while time.time() - t0 < limit_s:
        time.sleep(every)
        status, resp, _ = http("GET", f"{API}/calls/{rec['call_id']}", headers={"X-Payment-Key": KEY})
        if status == 200 and isinstance(resp, dict) and resp.get("status") != "pending":
            for k in ("status", "output", "error", "compute_cost", "instructions", "time_ms", "attestation_url"):
                if k in resp:
                    rec[k] = resp[k]
            rec["settled_after_s"] = round(time.time() - t0, 1)
            return rec
        if status not in (200, 503):
            rec["poll_error"] = {"http": status, "body": resp}
            return rec
    rec["poll_error"] = "still pending after %d s" % limit_s
    return rec


def balance():
    status, resp, _ = http("GET", f"{API}/public/payment-keys/{KEY_OWNER}/{KEY_NONCE}/balance")
    return resp if status == 200 else {"http": status, "body": resp}


def usd(micro):
    try:
        return int(micro) / 1e6
    except (TypeError, ValueError):
        return None


def pct(values, q):
    v = sorted(values)
    return v[min(len(v) - 1, int(round(q * (len(v) - 1))))] if v else None


def meta(check, **extra):
    return {"check": check, "date_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
            "api": API, "project": f"{OWNER}/{PROJECT}", "version_key": VERSION_KEY,
            "compute_limit_micro_usd": COMPUTE_LIMIT, **extra}


# ------------------------------------------------------------------------------------------- checks

def check_smoke():
    rec = call({"mode": "hello", "env_names": True, "echo": "smoke"})
    att = None
    if rec.get("attestation_url"):   # answered as a path on the API host
        url = rec["attestation_url"]
        status, resp, _ = http("GET", API + url if url.startswith("/") else url)
        att = {"http": status, "body": resp}
    return {"meta": meta("smoke"), "run": rec, "attestation": att}


def check_hello(runs=20):
    before = balance()
    recs = []
    for i in range(runs):
        rec = call({"mode": "hello", "echo": f"hello-{i}"})
        recs.append(rec)
        out = rec.get("output") or {}
        print(f"  hello {i:2d}: http {rec['http']} {rec.get('status')} wall {rec['wall_ms']} ms, "
              f"time_ms {rec.get('time_ms')}, cost {rec.get('compute_cost')}, ok={out.get('ok')}", flush=True)
    ok = [r for r in recs if r["http"] == 200 and r.get("status") == "completed" and (r.get("output") or {}).get("ok")]
    walls = [r["wall_ms"] for r in recs if r["http"] == 200]
    times = [r["time_ms"] for r in ok if r.get("time_ms") is not None]
    costs = [usd(r.get("compute_cost")) for r in recs if usd(r.get("compute_cost")) is not None]
    summary = {
        "runs": runs, "succeeded": len(ok),
        "http_statuses": {str(s): sum(1 for r in recs if r["http"] == s) for s in sorted({r["http"] for r in recs})},
        "wall_ms": {"min": min(walls, default=None), "p50": pct(walls, .5), "p90": pct(walls, .9),
                    "max": max(walls, default=None), "mean": round(statistics.mean(walls)) if walls else None},
        "time_ms": {"min": min(times, default=None), "p50": pct(times, .5), "max": max(times, default=None)},
        "compute_cost_usd": {"total": round(sum(costs), 6), "per_run": sorted(set(costs))},
        "instructions": sorted({r.get("instructions") for r in ok}),
    }
    return {"meta": meta("hello"), "summary": summary, "balance_before": before, "balance_after": balance(), "runs": recs}


def concurrent(inputs, start_delay_ms=4000):
    """Send every input at once (threads released together), each told to act at the same moment."""
    start_at = now_ms() + start_delay_ms
    barrier = threading.Barrier(len(inputs))
    out = [None] * len(inputs)

    def worker(i, inp):
        inp = dict(inp, start_at_ms=start_at)
        barrier.wait()
        out[i] = call(inp)

    threads = [threading.Thread(target=worker, args=(i, inp)) for i, inp in enumerate(inputs)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    return start_at, out


def overlap(recs):
    """How many runs' storage operations overlapped in time (by the workers' own clocks)."""
    spans = []
    for r in recs:
        o = r.get("output") or {}
        if o.get("t_op_ms") is not None:
            spans.append((o["t_op_ms"], o["t_op_ms"] + o.get("op_ms", 0)))
    best = 0
    for a in spans:
        best = max(best, sum(1 for b in spans if b[0] <= a[1] and a[0] <= b[1]))
    return {"spans": len(spans), "max_overlapping": best,
            "first_op_ms": min((s[0] for s in spans), default=None), "last_op_ms": max((s[0] for s in spans), default=None)}


def lock_round(key, op, width, tag, extra=None):
    inputs = [dict({"mode": "lock", "op": op, "key": key, "holder": f"{tag}-t{i}"}, **(extra or {})) for i in range(width)]
    start_at, recs = concurrent(inputs)
    outs = [r.get("output") or {} for r in recs]
    winners = [o.get("holder") for o in outs if o.get("won") is True]
    errors = [{"holder": inp["holder"], "http": r["http"], "status": r.get("status"), "error": r.get("error"),
               "output": r.get("output"), "body": r.get("body")}
              for inp, r in zip(inputs, recs) if not (r["http"] == 200 and (r.get("output") or {}).get("ok"))]
    finals = sorted({str(o.get("value_after")) for o in outs if o.get("ok")})
    print(f"  {op:8s} {key}: winners {winners}, errors {len(errors)}, values_after {finals}, "
          f"{overlap(recs)}", flush=True)
    return {"key": key, "op": op, "width": width, "start_at_ms": start_at, "winners": winners,
            "exactly_one_winner": len(winners) == 1, "errors": errors, "values_after": finals,
            "overlap": overlap(recs), "runs": recs}


def check_lock(rounds=3, width=5):
    before = balance()
    tag = "r" + str(now_ms())
    results = []
    for n in range(rounds):
        key = f"pbtest:lock:{tag}:{n}"
        r = {"round": n, "key": key}
        # 1. Five runs race to create the lock (set_if_absent on a key nobody has written).
        r["take"] = lock_round(key, "take", width, f"{tag}-{n}-a")
        # 2. A later run reads it back: does the winner's value persist to the next run?
        r["peek_after_take"] = call({"mode": "lock", "op": "peek", "key": key})
        winner = (r["take"]["winners"] or [None])[0]
        # 3. A loser cannot release it; the winner can (set_if_equals from its holder id to "free").
        r["release_by_loser"] = call({"mode": "lock", "op": "release", "key": key, "holder": f"{tag}-{n}-a-loser"})
        r["release_by_winner"] = call({"mode": "lock", "op": "release", "key": key, "holder": winner or "none"})
        # 4. Five runs race to take the released lock with set_if_equals("free" -> holder).
        r["take_eq"] = lock_round(key, "take_eq", width, f"{tag}-{n}-b")
        r["peek_after_take_eq"] = call({"mode": "lock", "op": "peek", "key": key})
        results.append(r)
    cleanup = call({"mode": "lock", "op": "cleanup", "key": "pbtest:cleanup", "prefix": f"pbtest:lock:{tag}"})
    after_cleanup = call({"mode": "lock", "op": "peek", "key": f"pbtest:lock:{tag}:0"})
    summary = {
        "rounds": rounds, "width": width,
        "take_exactly_one": [x["take"]["exactly_one_winner"] for x in results],
        "take_eq_exactly_one": [x["take_eq"]["exactly_one_winner"] for x in results],
        "take_max_overlapping_ops": [x["take"]["overlap"]["max_overlapping"] for x in results],
        "take_eq_max_overlapping_ops": [x["take_eq"]["overlap"]["max_overlapping"] for x in results],
        "persisted_to_next_run": [(x["peek_after_take"].get("output") or {}).get("value_after") in x["take"]["winners"]
                                  for x in results],
        "loser_release_refused": [(x["release_by_loser"].get("output") or {}).get("released") is False for x in results],
        "winner_release_ok": [(x["release_by_winner"].get("output") or {}).get("released") is True for x in results],
        "cleanup": cleanup.get("output"),
        "after_cleanup_value": (after_cleanup.get("output") or {}).get("value_after", "n/a"),
    }
    return {"meta": meta("lock", tag=tag), "summary": summary, "balance_before": before, "balance_after": balance(),
            "rounds": results, "cleanup_run": cleanup, "after_cleanup_run": after_cleanup}


def check_prices(runs=3):
    recs = []
    for i in range(runs):
        rec = call({"mode": "prices"}, compute_limit=20_000)
        recs.append(rec)
        srcs = (rec.get("output") or {}).get("sources") or []
        print(f"  prices {i}: http {rec['http']} {rec.get('status')} time_ms {rec.get('time_ms')} "
              f"instr {rec.get('instructions')} cost {rec.get('compute_cost')}", flush=True)
        for s in srcs:
            print(f"     {s.get('src'):20s} {s.get('status')} {s.get('ms')} ms {s.get('bytes', '')} B "
                  f"px={s.get('px')} {s.get('snip') or s.get('err') or ''}", flush=True)
        time.sleep(2)
    per = {}
    for rec in recs:
        for s in (rec.get("output") or {}).get("sources") or []:
            p = per.setdefault(s["src"], {"statuses": [], "ms": [], "px": []})
            p["statuses"].append(s.get("status"))
            p["ms"].append(s.get("ms"))
            p["px"].append(s.get("px"))
    for p in per.values():
        p["ms_median"] = statistics.median(p["ms"]) if p["ms"] else None
    return {"meta": meta("prices", compute_limit_micro_usd=20_000), "per_source": per, "runs": recs}


def check_calls(ns=(10, 30, 60, 100, 150, 200), limit=20_000):
    recs = []
    for n in ns:
        rec = poll(call({"mode": "calls", "n": n}, is_async=True, compute_limit=limit))
        recs.append(rec)
        o = rec.get("output") or {}
        print(f"  calls n={n}: http {rec['http']} {rec.get('status')} made {o.get('made')} ok {o.get('succeeded')} "
              f"first_error {o.get('first_error')!r} at {o.get('first_error_at')}, ms_total {o.get('ms_total')}, "
              f"time_ms {rec.get('time_ms')}, instr {rec.get('instructions')}, cost {rec.get('compute_cost')}, "
              f"error {rec.get('error')!r}", flush=True)
        if not (rec.get("status") == "completed" and o.get("succeeded") == n):
            break
    summary = [{"n": r["input"]["n"], "status": r.get("status"), "made": (r.get("output") or {}).get("made"),
                "succeeded": (r.get("output") or {}).get("succeeded"),
                "first_error": (r.get("output") or {}).get("first_error"),
                "first_error_at": (r.get("output") or {}).get("first_error_at"),
                "ms_total": (r.get("output") or {}).get("ms_total"), "time_ms": r.get("time_ms"),
                "instructions": r.get("instructions"), "compute_cost_usd": usd(r.get("compute_cost")),
                "error": r.get("error")} for r in recs]
    return {"meta": meta("calls", compute_limit_micro_usd=limit), "summary": summary, "runs": recs}


def check_big(sizes=(256, 900, 1024, 2048, 4096)):
    recs = []
    for size in sizes:
        rec = call({"mode": "big", "bytes": size})
        o = rec.get("output")
        verdict = {"size": size, "http": rec["http"], "status": rec.get("status")}
        if isinstance(o, dict):
            compact = json.dumps(o, separators=(",", ":"))
            pad = o.get("pad", "")
            verdict.update({
                "compact_len": len(compact),
                "exact_size": len(compact) == size,
                "pad_len": len(pad),
                "pad_intact": pad == "".join(PAD[i % len(PAD)] for i in range(len(pad))),
                "fields": sorted(o.keys()),
            })
        rec["check"] = verdict
        recs.append(rec)
        print(f"  big {size}: {verdict}", flush=True)
    return {"meta": meta("big"), "summary": [r["check"] for r in recs], "runs": recs}


def check_limits():
    """What a run is given: the limits the run sees for two X-Compute-Limit values, and whether a body
    `resource_limits` (listed in research/outlayer.md, absent from the OpenAPI spec) changes them."""
    keys = ("max_instructions", "max_seconds", "max_memory_mb")
    cases = [("limit 10000, no body limits", 10_000, None),
             ("limit 10000, body resource_limits 1B / 64 MB / 20 s", 10_000,
              {"resource_limits": {"max_instructions": 1_000_000_000, "max_memory_mb": 64, "max_execution_seconds": 20}}),
             ("limit 5000, no body limits", 5_000, None),
             ("limit 2000, no body limits", 2_000, None)]
    recs = []
    for label, limit, extra in cases:
        rec = call({"mode": "hello"}, compute_limit=limit, extra_body=extra)
        rec["case"] = label
        recs.append(rec)
        o = rec.get("output") or {}
        print(f"  {label}: http {rec['http']} {rec.get('status')} {({k: o.get(k) for k in keys})} "
              f"cost {rec.get('compute_cost')} {rec.get('reason') or rec.get('error') or ''}", flush=True)
    summary = [{"case": r["case"], "http": r["http"], "status": r.get("status"), "reason": r.get("reason"),
                **{k: (r.get("output") or {}).get(k) for k in keys}} for r in recs]
    return {"meta": meta("limits"), "summary": summary, "runs": recs}


CHECKS = {"smoke": check_smoke, "hello": check_hello, "lock": check_lock, "prices": check_prices,
          "calls": check_calls, "big": check_big, "limits": check_limits}


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in CHECKS:
        raise SystemExit(__doc__)
    check = sys.argv[1]
    out = os.path.join(REPO, "research", "data", f"day1_outlayer_{check}.json")
    if "--out" in sys.argv:
        out = sys.argv[sys.argv.index("--out") + 1]
    kwargs = {}
    if check == "calls" and "--ns" in sys.argv:   # e.g. --ns 500,1000 to look past 200
        kwargs["ns"] = tuple(int(x) for x in sys.argv[sys.argv.index("--ns") + 1].split(","))
    print(f"{check}: {OWNER}/{PROJECT} version {VERSION_KEY[:12]}... on {API}", flush=True)
    result = scrub(CHECKS[check](**kwargs))
    with open(out, "w") as f:
        json.dump(result, f, indent=1)
        f.write("\n")
    if "summary" in result:
        print(json.dumps(result["summary"], indent=1))
    print("wrote", os.path.relpath(out, REPO))


if __name__ == "__main__":
    main()
