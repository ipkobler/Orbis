# Heartbeat monitoring (liveness) — spec

**Story:** As an operator, I want authenticated heartbeat monitoring so stalled or disconnected agents are detected
before work silently fails.

**Forge revision:** define registration/identity, clock/TTL policy, liveness transitions, metrics and alert ownership.
Alerts consume liveness transitions; they never infer liveness on their own.

Code: `liveness.js` (state machine), `heartbeat.js` (identity and request checks), `alerts.js` (alert dispatch),
wired up in `server.js`. Reference sender: `tools/heartbeat.mjs`. Tests: `test/*.test.js` (`npm test`).

---

## 1. Two signals, one state machine

| Signal | Who sends it | What it proves |
|---|---|---|
| **Push heartbeat** | the agent side (a sender next to the agent's runtime), `POST /api/heartbeat`, signed | the agent's process is alive and, if it reports `progress`, still making progress |
| **Gateway probe** | the orb server, every `PROBE_INTERVAL_S` (default 30 s), through the OpenClaw gateway (`agents.list`) | the gateway is up and still lists the agent |

Both feed **one** liveness engine (`liveness.js`). It is the only place that decides an agent's state. Everything
else (the orb UI, alerts, metrics) reads the engine's state and its transition events.

An agent with no heartbeat key registered is **probe-only**: it can be HEALTHY, DOWN or UNKNOWN, exactly like the
orb behaved before this feature. Registering a key switches it to **push + probe**.

## 2. Registration and identity

- **Register:** signed-in operator, Settings → Heartbeat monitoring → *Create key* (or `POST /api/heartbeat/keys`
  `{ agent }`). The server makes a random 256-bit secret and an 8-hex key id (`kid`) bound to that one agent id.
- The secret is shown **once**, as a single token: `obk_<kid>_<secret>`. The server stores it in
  `state/heartbeat-keys.json` (file mode 600). It is never returned again or logged.
- **Identity is the key, not the body:** a request is accepted only if its `kid` is known **and** the body's `agent`
  equals the agent the key was issued to. A key for Forge can never report for Ledger.
- **Rotate:** *Rotate* issues a new key; the previous key keeps working for `KEY_OVERLAP_S` (10 min) so the sender can
  be updated without a gap, then it is removed.
- **Revoke:** *Revoke* deletes every key for the agent at once. The agent returns to probe-only (no alert: revoking is
  an operator action, not a failure).

### Request format

```
POST /api/heartbeat
Authorization: OrbHMAC kid=<kid>, sig=<base64url HMAC-SHA256(secret, raw body bytes)>
Content-Type: application/json

{ "agent": "forge", "ts": 1793070000000, "nonce": "<16-64 hex>", "status": "idle|busy", "progress": 42, "boot": "<id>" }
```

| Check | Failure | Status |
|---|---|---|
| body ≤ 2 KB, valid JSON, fields well-formed | `bad_request` | 400 |
| `kid` known (and not past its rotation overlap) | `unknown_key` | 401 |
| signature matches (constant-time compare) | `bad_signature` | 401 |
| `agent` in body = key's agent | `wrong_agent` | 403 |
| `|server wall clock − ts| ≤ MAX_SKEW_S` (60 s) | `clock_skew` | 401 |
| `nonce` not seen in the last `2 × MAX_SKEW_S` | `replay` | 409 |
| at most one accepted beat per agent per `MIN_GAP_S` (2 s) | `too_fast` | 429 |

Accepted: `200 { ok, state, interval }` (the server tells the sender the expected interval). The endpoint sits
**outside** the sign-in gate; the HMAC is its authentication. Rejections are counted by reason in metrics and never
change liveness state (an attacker can't mark an agent healthy or unhealthy).

## 3. Clock and TTL policy

- **Liveness timing uses only the server's monotonic clock** (`performance.now()`), so wall-clock changes on the server
  (NTP steps, DST, manual changes) can't age or refresh heartbeats.
- **The sender's `ts` is used only for replay protection** (the ±60 s window above). Its offset from the server is
  recorded as `orb_heartbeat_clock_skew_seconds` so drifting clocks are visible before they start failing.
- With heartbeat interval **I** = `HEARTBEAT_INTERVAL_S` (default 30 s):

| Name | Value (default) | Meaning |
|---|---|---|
| `LATE_AFTER` | 1.5 × I (45 s) | one beat missed: HEALTHY → LATE |
| `MISSED_AFTER` | 3 × I (90 s) | three beats missed: LATE → STALLED or DOWN |
| `STALL_AFTER_S` | 300 s | reported `status: busy` with no change in `progress` for this long → STALLED |
| `PROBE_FAILS` | 2 | consecutive failed probes before the probe counts as failing (one blip doesn't count) |
| `STARTUP_GRACE` | 3 × I (90 s) | after the orb server starts, no agent can be judged LATE/STALLED/DOWN on push data |

The engine re-evaluates every `TICK_S` (5 s), and immediately after every accepted beat and probe. Worst-case
detection: a dead agent reaches STALLED/DOWN within `MISSED_AFTER + TICK_S` (95 s at defaults).

## 4. Liveness states and transitions

```
                beat ok + probe ok
   UNKNOWN ───────────────────────────► HEALTHY ◄──────────────────────────┐
      │                                  │   ▲                              │ beat ok + probe ok
      │ grace over, no beats             │   │ beat ok + probe ok           │ (automatic recovery)
      ▼                                  ▼   │                              │
   (as below)            no beat for 1.5×I   LATE ── no beat for 3×I ──► STALLED (probe ok)
                                                     └───────────────────► DOWN    (probe failing)
   beat ok but probe failing ──► DEGRADED            busy, no progress for STALL_AFTER ──► STALLED
```

| State | Push + probe agent | Probe-only agent | Orb UI | Can you talk to it? |
|---|---|---|---|---|
| **UNKNOWN** | no data yet (startup grace, or newly registered) | no probe result yet | grey "Checking" | yes |
| **HEALTHY** | beat within 1.5×I, probe OK, progressing | probe OK | "Online" | yes |
| **LATE** | last beat 1.5×I – 3×I ago | — | amber "Late" | yes |
| **DEGRADED** | beats arriving, probe failing | — | amber "Degraded" | yes (may fail) |
| **STALLED** | no beat for 3×I but gateway still lists it, **or** busy with no progress for `STALL_AFTER_S` | — | red "Stalled" | no (greyed) |
| **DOWN** | no beat for 3×I and probe failing | probe failed `PROBE_FAILS` times | red "Offline" | no (greyed) |

Rules, evaluated in this order (first match wins), for a push + probe agent:

1. startup grace and never seen → UNKNOWN
2. busy, `progress` unchanged for ≥ `STALL_AFTER_S` → STALLED (`no_progress`)
3. beat age ≥ `MISSED_AFTER` → DOWN if the probe is failing, else STALLED (`missed_heartbeats`)
4. beat age ≥ `LATE_AFTER` → LATE
5. probe failing → DEGRADED
6. otherwise → HEALTHY

Probe-only: probe failing → DOWN; probe OK → HEALTHY; no result → UNKNOWN.

Every change of state is a **transition** `{ id, agent, from, to, reason, at, ageSeconds }` with a strictly
increasing `id`. Recovery is just a transition back to HEALTHY; it needs nothing from the operator.

## 5. Alert ownership

- **The alerts module (`alerts.js`) is the only producer of alerts, and its only input is the engine's transition
  stream.** It never looks at heartbeat ages, probes or timers itself.
- Which transitions alert:

| Transition | Alert |
|---|---|
| any → STALLED, any → DOWN | `critical` "K.I.R.K. stalled / offline" |
| any → DEGRADED | `warning` |
| STALLED / DOWN / DEGRADED → HEALTHY | `resolved` "K.I.R.K. recovered" |
| → LATE, UNKNOWN → anything, LATE → HEALTHY | none (state still shown in the UI and metrics) |

- **Once per transition:** each alert carries `key = transition id`. The dispatcher records the highest transition id
  it has alerted (`alertedThrough`, persisted), so a transition is alerted exactly once even across restarts. Webhook
  deliveries carry `Idempotency-Key: orb-transition-<id>` and are retried up to 3 times with backoff; receivers that
  honour the key see it once.
- **Owner:** every alert names its owner, `HEARTBEAT_ALERT_OWNER` (default `operator`), and the agent.
- **Sinks:** the orb UI (alert list in `/api/agents`, shown once per alert per device), the server log, and optionally
  `HEARTBEAT_WEBHOOK_URL` (for example an n8n webhook that posts to Slack).

## 6. Metrics

`GET /metrics` (Prometheus text). Signed-in session, or `Authorization: Bearer <METRICS_TOKEN>` if set.

| Metric | Labels | |
|---|---|---|
| `orb_liveness_state` | agent, state | 1 for the current state, 0 otherwise |
| `orb_liveness_heartbeat_age_seconds` | agent | seconds since the last accepted beat (push agents) |
| `orb_liveness_transitions_total` | agent, from, to | |
| `orb_heartbeats_accepted_total` | agent | |
| `orb_heartbeats_rejected_total` | reason | `bad_signature`, `clock_skew`, `replay`, … |
| `orb_heartbeat_clock_skew_seconds` | agent | server wall clock − sender `ts` on the last accepted beat |
| `orb_probe_ok` | agent | 1 if the last probe listed the agent |
| `orb_probe_latency_ms` | | last gateway probe |
| `orb_alerts_total` | severity, sink, result | |

`GET /api/liveness` (signed-in) returns the same as JSON plus the last 50 transitions and alerts.

## 7. Persistence and restarts

`state/liveness.json` keeps each agent's state, the next transition id and `alertedThrough`. On restart, states are
restored as they were (an agent that was DOWN stays DOWN, with no repeat alert), and push timing restarts with the
startup grace, so a restart can't by itself raise alerts. If an agent comes back while the server was down, the first
evaluation after its next beat produces a normal, single `resolved` alert.

## 8. Running senders

`tools/heartbeat.mjs` is the reference sender (no dependencies). It signs each beat, follows the interval the orb
returns, adds a little jitter, and stops if its key is revoked.

```
HEARTBEAT_TOKEN=obk_… AGENT=forge ORB_URL=http://kira-orb:8080 node tools/heartbeat.mjs          # keep sending
HEARTBEAT_TOKEN=obk_… AGENT=forge ORB_URL=http://kira-orb:8080 node tools/heartbeat.mjs --once   # one beat, exit code
```

From outside the Docker network use `ORB_URL=https://orb.bigsixtech.tech` (the heartbeat endpoint doesn't need the
sign-in cookie; the key is its authentication).

**What a heartbeat proves depends on where the sender runs.** Run it in the same process tree or machine as the
agent's work, so that if the work dies, the beats stop. To catch a *stalled* agent (alive but stuck), whatever runs the
agent's tasks writes `{"status":"busy","progress":N}` to a file and the sender reports it via `STATUS_FILE`; if
`progress` doesn't move for `STALL_AFTER_S` while busy, the agent goes STALLED. A sender that runs on its own, apart
from the agent, only proves the sender is alive; in that case rely on the gateway probe for connectivity.

## 9. Acceptance criteria → tests (`test/liveness.test.js`, `test/heartbeat.test.js`)

| Criterion | Test |
|---|---|
| Healthy agents remain healthy | beats every I for 30 min with jitter up to ±40 % of I → never leaves HEALTHY, zero alerts |
| Missed heartbeats move through documented states within the window | beats stop: LATE between 1.5×I and 1.5×I+tick, then STALLED (probe OK) or DOWN (probe failing) by 3×I+tick |
| Alerts fire once per transition | re-evaluating, repeated ticks, a restart from persisted state → still exactly one alert per transition |
| Recovery is automatic and observable | beats resume → HEALTHY on the first beat, one `resolved` alert, transition and metrics updated |
| Identity and clock handling are safe | wrong key, wrong agent, bad signature, skew > 60 s, replayed nonce, too fast → rejected, counted, state unchanged; server wall-clock jump → no effect on liveness |
| Stall detection | busy with constant progress for 300 s → STALLED; progress moves → HEALTHY |
| Probe blips | one failed probe → no change; two → DEGRADED/DOWN |
