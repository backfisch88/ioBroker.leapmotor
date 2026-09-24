# ioBroker.leapmotor

## What this is

An open-source ioBroker adapter for Leapmotor electric vehicles (T03, B10, B05, C10).
Reads vehicle status from the Leapmotor cloud API, sends remote commands (lock,
climate, charging, sunshade, etc.), detects trips, tracks charging costs, and
ships a custom React admin dashboard (not the generic ioBroker jsonConfig UI).

- Repo: github.com/backfisch88/ioBroker.leapmotor
- Owner/maintainer: Henrik Schönhofen (GitHub: backfisch88)
- Primary test vehicle: a T03 nicknamed "Knöpsel" (VIN redact before sharing logs/dumps publicly)
- Runtime: Raspberry Pi via SSH, ioBroker with Redis-based admin file storage
- Published: npm + ioBroker Latest/Stable repos, current release ~0.6.8 (many
  fixes committed to main since, pending a version bump)

## Repo layout

```
main.js                    Adapter backend (single file, ~2000+ lines)
lib/leapmotor-client.js    Cloud API client (auth, crypto, commands)
lib/leapmotor-crypto.js    Request signing
admin/                     BUILT admin assets (tab.js, tab.html, i18n/*.json) - generated, don't hand-edit
admin/jsonConfig.json      The 4 fields still in native instance config (email, password, PIN, cloud API language)
admin-tab/                 React admin dashboard SOURCE
  src/App.jsx              Tab shell, routing between tabs
  src/components/          One file per tab + shared pieces (see below)
  src/i18n/translations.js THE REAL i18n source for the dashboard (see gotcha below)
io-package.json            Adapter manifest, native config schema, object definitions
```

### admin-tab/src/components/

- `DashboardTab.jsx` — live status, climate controls, sliders
- `ConsumptionTab.jsx` — weekly consumption chart, charging cost summary (home/public split)
- `TripsTab.jsx` — trip history, GPS route maps (Leaflet), merge/undo, CSV/PDF export (`ExportPanel.jsx`)
- `DiagnosticsTab.jsx` — connection status, vehicle info, battery health (SoH)
- `SettingsTab.jsx` — everything configurable: polling, notifications, Prepare-to-Drive/Work,
  home location (map + address search), electricity prices, data retention. This is the
  biggest, most-edited file in the project.
- `DatapointsTab.jsx` — raw datapoint browser, grouped by category (last tab, least used)

## Deploy workflow

Working directory on the Pi: `/home/pi/github/ioBroker.leapmotor/`
Live adapter path: `/opt/iobroker/node_modules/iobroker.leapmotor/`

**Backend-only change** (main.js, lib/*.js):
```bash
cp main.js /opt/iobroker/node_modules/iobroker.leapmotor/main.js
iobroker restart leapmotor --allow-root
```

**Frontend change** (anything in admin-tab/src/ or admin/):
```bash
cd admin-tab && npm run build && cd ..
cp -r admin/. /opt/iobroker/node_modules/iobroker.leapmotor/admin/
iobroker upload leapmotor --allow-root
iobroker restart leapmotor --allow-root
```

**`iobroker upload` is mandatory, not optional, for anything touching `admin/`.**
The admin webserver serves files from Redis, not the filesystem — `cp` alone
silently does nothing from the browser's perspective. This has caused hours
of "why isn't my change showing up" confusion multiple times. Verify with:
```bash
redis-cli get "cfg.f.leapmotor.admin\$%\$tab.js\$%\$meta"
```
and check the `size` field matches your freshly-built file.

**New npm dependency added** (e.g. leaflet, jspdf): run `npm install` in the
relevant package (`admin-tab/` for frontend deps, repo root for backend deps
like `suncalc`, `axios`) — both locally to build and copy `node_modules/<pkg>`
to the live path, or reinstall there directly.

## The i18n gotcha (read this before touching any UI text)

There are TWO i18n systems in this repo and they are NOT connected:

1. `admin/i18n/*.json` (11 languages) — used ONLY by the classic ioBroker
   jsonConfig instance-settings dialog (the 4-field native config: email,
   password, PIN, cloud API language).
2. `admin-tab/src/i18n/translations.js` — used by EVERYTHING in the custom
   React dashboard (`I18n.t('...')` calls in any component). This is a
   hand-rolled JS object keyed by English text, loaded via
   `I18n.extendTranslations()` in `main.jsx`, bundled into `tab.js` at build
   time.

**A missing key in translations.js falls back to showing the English key
literally — it does NOT throw, so gaps are silent and easy to miss.**

Workflow for adding/changing any UI-facing string in the dashboard:
1. Add the English key + all 11 translations to `admin/i18n/*.json` (kept as
   the canonical source-of-truth store, one file per language, flat key→value).
2. Regenerate `translations.js` from those JSON files (drop any translation
   that's identical to its English key — no point storing it, falls back
   naturally). A `zh-cn` block existed as empty/missing once and silently
   killed ALL translations via `extendTranslations` — always verify all 11
   language blocks are present and non-empty after regenerating.
3. `npm run build` in admin-tab/, then the full frontend deploy above.

To find every key actually used in the dashboard:
```bash
grep -roE "I18n\.t\(\s*'[^']*'" admin-tab/src/*.jsx admin-tab/src/components/*.jsx \
  | sed -E "s/.*'([^']*)'/\1/" | sort -u
```
Watch for **dynamic keys** (`I18n.t(someVariable)`) — e.g. `DatapointsTab.jsx`
groups datapoints under category names like `I18n.t(groupName)` where
`groupName` is `'Battery'`, `'Charging'`, etc. These won't show up in a
literal-string grep and were missed entirely once (whole category headers
silently untranslated for a long time).

## Backend architecture notes (main.js)

Single adapter class, no build step. Style is intentionally compact/minified
(no space after commas/operators in many places) — this is a deliberate
choice by the maintainer, not something to "clean up." Repochecker flags
~4000 formatting violations against ioBroker's prettier defaults; this is a
known, accepted tradeoff (see io-package.json / repochecker notes), not a bug
to fix.

Key subsystems:

- **Polling**: adaptive interval, `config.polling_interval_parked_sec`
  (default 60) vs `config.polling_interval_driving_sec` (default 15), decided
  by `isMoving`/ignition state each cycle via `scheduleNextPoll()`.
- **Trip detection** (`updateTripDetection`): a trip only ends once ignition
  is confirmed off (not just speed=0) after a grace period. Tracks
  `_tripStates[vin]` across polls: start position, min/max outdoor temp,
  a running trapezoidal power integration (`driveKwh`/`regenKwh` from
  battery voltage×current) for a rough regen estimate, and route buffering
  for GPS breadcrumb trails (opt-in, `config.route_recording_enabled`).
- **Trip energy**: official per-trip energy breakdown comes from the cloud's
  `getEnergyBreakdown` (driving/AC/other kWh), anchored to the vehicle's own
  "Ready-on" timestamp window (`computeEnergyQueryBeginMs`) — NOT the poll
  timestamp. Often not available immediately (`energyPending: true`), resolved
  later via a retry queue (`_pendingEnergyTrips`, `resolvePendingTripEnergy`).
- **Trip merge**: `cmd.trips_merge` (write a trip's startTimeMs) combines it
  with the immediately preceding trip — for real trips split by a false stop
  detection. `cmd.trips_merge_undo` reverts the LAST merge only (one-slot,
  in-memory, lost on restart). Also merges GPS routes (careful: the merged
  trip keeps the earlier trip's startTimeMs, so route dict key handling has
  an easy off-by-one trap — see git history for a bug where the merged
  route got deleted immediately after being set, because the "delete old
  keys" step ran after the merge key was already written to the same key).
- **Battery SoH estimate** (`recordSohSample`): deliberately uses OFFICIAL
  cloud per-trip energy vs. SoC-used, NOT the adapter's own charging-cost kWh
  estimate — the latter is itself derived from the configured nominal battery
  capacity, so using it to "verify" capacity would be circular and always
  report ~100%. Median of last 30 samples, trips under 5% SoC delta are
  skipped as too noisy (1%-granularity SoC rounding dominates otherwise).
- **Charging cost split** (`updateChargingCost`): classifies each session as
  home/public/unknown via haversine distance to `config.home_latitude/longitude`
  within `config.home_radius_m`. Home uses the dynamic price state if
  configured (`config.energy_price_state_id`, e.g. a Tibber/aWATTar adapter)
  else the manual `config.energy_price_eur_kwh`. Public ALWAYS uses the
  separate manual `config.energy_price_public_eur_kwh` — deliberately never
  the dynamic state, since that reflects the user's home tariff, not a
  charge-point operator's rate.
- **Prepare-to-Drive / Prepare-to-Work**: share one core decision function
  `applyClimatePrep(vin, s, prefix)` where `prefix` is `'prepare_to_drive'`
  or `'prepare_to_work'`, each with independent config (temp thresholds,
  target temp, fan speed, sunshade behavior). Prepare-to-Drive triggers on
  an ignition-on EDGE with guards against false positives (see gotchas
  below); Prepare-to-Work triggers explicitly via `cmd.prepare_to_work`
  (write true) for external scheduling (a shift-schedule script, calendar
  automation, etc.) with no edge/lock/cooldown gating — it's an intentional
  trigger, trust the caller.
- **Weather** (`fetchWeatherTemp`): NOT the vehicle's own outdoorTemp sensor
  — some models don't report it (confirmed absent on B10), and it reads
  wherever the car is physically sitting (e.g. an underground garage), not
  real outside conditions. Uses Open-Meteo's free forecast API instead, no
  key needed. Single shared cache, 30min freshness, and on ANY fetch error
  falls back to the last known-good value rather than returning nothing —
  a stale temperature beats no temperature for a heat/cool/vent decision.
- **Notifications** (`sendNotification` → `deliverNotification`): adapter-
  agnostic via `sendTo`. Special-cased for `email` (subject+text+to payload)
  and `telegrammenu2` (native `notify` command with `area`+`type` — `type`
  of `warn`/`error` bypasses telegrammenu2's own message bundling and
  delivers immediately, `info` gets batched; `area` must already be an
  approved area in the user's telegrammenu2 config, defaults to the vehicle
  name). Everything else (Telegram plain, WhatsApp, etc.) gets a generic
  `{text, chatId}` or bare text payload.
- **Data retention**: trip history and GPS route history are pruned
  separately (routes are much heavier per-trip), by age in days
  (`config.trip_history_retention_days` / `route_history_retention_days`,
  0 = keep forever), each with a hard count-based safety cap regardless
  (`TRIP_HISTORY_HARD_CAP` / `ROUTE_HISTORY_HARD_CAP`) so "keep forever"
  can't grow a single ioBroker state truly unbounded.

## Known vehicle-behavior gotchas (hard-won, don't re-litigate)

- **Sunshade requires the vehicle to be woken by a physical door open** —
  confirmed on two independent real-world test sessions. Locked, unlocked,
  ignition-on, climate-on, and even a remote trunk-open command all leave it
  non-functional; only a genuine physical door open (then it keeps working
  even after the door closes again) wakes whatever subsystem the sunshade
  motor sits on. No remote command can substitute. This lines up with the
  "Ready-on" energy-anchor finding above — likely the same underlying
  vehicle wake state.
- **The vehicle auto-relocks itself once it starts driving**, even with the
  driver still inside. This broke the original Prepare-to-Drive trigger
  logic: after a long idle period (car asleep, infrequent polling), the
  first poll after getting in can land well into the drive already, by
  which point `driverDoorLockStatus` has already flipped back to `true`.
  Gate on movement (`speed>0` or a driving `gearStatus`) as a fallback
  signal, not lock state alone, or you'll silently skip real drives.
- **Any remote command can itself cause a transient ignition-on reading** as
  the vehicle wakes to execute it — this is NOT a real "someone got in"
  event. `executeCommand` timestamps every command sent
  (`_lastCommandSentAt[vin]`); Prepare-to-Drive ignores an ignition edge
  within 2 minutes of ANY command (its own or an external script's, e.g. the
  user's own shift-schedule script sending a climate command re-triggered
  this exact bug once).
- Some models (B10 confirmed) don't report `outdoorTemp` at all in the raw
  status — always have a fallback (see Weather above), never assume it's
  present.
- Sunshade is heat/cold **insulation**, not glare/sun protection — closing
  it matters for both hot AND cold days, not just sunny ones. In the dark,
  the default is to just open it (no solar gain to block either way) EXCEPT
  when heating for cold protection, where the configured position is kept
  regardless of daylight (heat loss through the glass roof is a real thing
  at night too).

## Frontend gotchas

- **`{condition && <JSX>}` renders a literal "0"** if `condition` evaluates
  to the number `0` rather than `false` — happened with a merge-undo flag
  defaulting to `0`. Always coerce to boolean explicitly (`!!condition`)
  when the truthy value could be a number that's sometimes legitimately 0.
- **Leaflet's default marker icon shows as a broken "?"** under Vite — the
  bundler doesn't automatically serve `leaflet/dist/images/*.png`. Fix:
  explicitly import the three marker images and override
  `L.Icon.Default.mergeOptions()` before any `L.marker()` call (done once in
  `SettingsTab.jsx` for the home-location map).
- **Open-Meteo's geocoding API only resolves place/city names, not full
  street addresses** — confirmed it never matches "street + house number,
  city" combos. Switched the home-location address search to Nominatim
  (OpenStreetMap), which does handle full addresses, still free/no API key.
- When adding a prop to a shared component (e.g. `base` for the vehicle's
  VIN path), check EVERY place that component is instantiated — a
  `SettingsTab` test button once silently wrote to the wrong ioBroker path
  (`adapter.cmd.X` instead of `adapter.VIN.cmd.X`) because `App.jsx` wasn't
  passing `base` down at all.
- Verifying "fixed" isn't enough after a failed deploy — `git apply` is
  atomic: if ANY file in a multi-file patch fails to apply, NOTHING in the
  patch applies, even files that would have succeeded alone. A partial
  patch failure silently reverts everything, including unrelated fixes
  bundled in the same patch.

## Tech stack

- Backend: Node.js, `axios` (HTTP + Open-Meteo weather/elevation/geocoding-adjacent
  calls), `suncalc` (sunrise/sunset, no API), `adm-zip`
- Frontend: React 18 (pinned — `@iobroker/adapter-react-v5@8.3.3` only
  declares React 18 peer support; a React 19/MUI v6-note: MUI itself IS on
  v6.5 already, migration already done for that piece), MUI v6, Vite build,
  `recharts` (consumption chart), `leaflet` (route/home-location maps),
  `jspdf` + `jspdf-autotable` (PDF trip-log export, lazy-loaded via dynamic
  `import()` so it doesn't bloat the main bundle)
- No test suite currently exercises the admin-tab UI; verification is
  manual (screenshot round-trips) — budget for that when estimating a UI change

## Working style / communication

- The maintainer often dictates messages by voice — expect informal,
  run-on phrasing; short replies like "ok"/"klappt" mean success, don't ask
  for more detail than given.
- Prefers concise, low-ceremony responses (a "caveman"/terse communication
  style was explicitly requested in the Claude.ai chat context this file
  was written from — carry that preference forward if it still fits).
- Always deliver code changes as a downloadable patch/zip/file WITH the
  exact deploy commands in the same message — never just one or the other.
- Reference files by bare filename in commands (no `~/Downloads/` prefix
  assumed) — the user typically has the file already in the working directory.
- VINs must be redacted before any log/dump goes into a public GitHub issue
  or commit.
- Temporary diagnostic logging added purely for live debugging (not a real
  fix) should stay local — don't commit/push it.
