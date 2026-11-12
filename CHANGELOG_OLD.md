# Older Changelog

## 0.7.2 (2026-09-24)
- New: notification for new vehicle inbox messages
- Fix: outdoor temperature falls back to Open-Meteo when the vehicle value is stale
- Fix: help text of the Cloud API Language field

## 0.7.0 (2026-09-24)
- New: trip merge undo, elevation gain, min/max outdoor temperature and regen estimate per trip
- New: CSV and PDF export for a date range, configurable trip and route retention
- New: Prepare-to-Drive / Prepare-to-Work (auto climate, sunshade automation)
- New: outdoor temperature from Open-Meteo
- New: estimated battery health (SoH)
- New: home/public charging cost split by distance to a home location
- New: notifications (trip done, charge done, OTA update, window open, Prepare-to-Drive/Work)
- New: B11 (internal C10 code) handled
- New (untested): start/stop charging, unlock charging connector, healthy-charging mode, fuel heater, send navigation destination
- Fix: trip route lost on merge
- Fix: Prepare-to-Drive missed drive starts and misfired on remote commands
- Fix: charging current counted as regen
- Fix: mirrored GPS position west of Greenwich
- Fix: window commands scaled per model (B05/B10/C10: 0-10)
- Fix: stuck "charging" status, T03 window-open flags
- Fix: steering wheel/seat heating payload format
- Fix: trip stuck "in progress" after adapter restart
- Fix: `cmd.charge_limit_set` now synced with the vehicle's real limit
- Fix: crash on token expiry during `cmd.refresh`
- Fix: battery color threshold (yellow at 20%), Leaflet marker, "0" rendering
- Changed: faster trip end detection (locked + ignition off, lock/unlock cycle)
- Changed: debug log for every remote command
- Changed: Datapoints tab moved to the end, full i18n for 11 languages

## 0.6.8 (2026-09-19)
- Fix: re-login after token expiry uses a fresh device identity
- Fix: remote pre-conditioning no longer detected as trip start
- Fix: trip end time uses the vehicle's own timestamp

## 0.6.7 (2026-09-18)
- Fix: re-login on "TOKEN_NOT_AVAILABLE"
- Fix: trip ends only after ignition off plus 10 min grace period
- Fix: trip energy-breakdown retry queue survives restarts

## 0.6.6 (2026-09-17)
- Fix: B05 uses the C10 status endpoint (HTTP 404)
- Fix: right-side door overlays
- Chore: ESLint config, dependency updates, Node.js 26 in test matrix

## 0.6.5 (2026-09-02)
- New: raw status response logged once per vehicle (debug)
- New: status errors include URL and response body

## 0.6.4 (2026-09-02)
- Chore: admin tab migrated to adapter-react-v5 8.x and MUI v6
- Fix: Diagnostics tab layout and card spacing

## 0.6.3 (2026-09-01)
- Fix: charge schedule kept when changing the charge limit
- Fix: door z-order and window overlays
- Changed: "Language" renamed to "Cloud API Language"
- Adapter is now in the ioBroker stable repository

## 0.6.2 (2026-07-08)
- Fix: B10 uses the C10 status endpoint
- Fix: full i18n for jsonConfig

## 0.6.1 (2026-07-03)
- Fix: repository checker findings

## 0.6.0 (2026-07-03)
- Refactor: standard plain-JS layout (`main.js` in root, modules in `lib/`)
- Fix: cleanup, VIN sanitizing, polling interval limit, timers

## 0.5.8 (2026-07-02)
- Fix: repository checker compliance (channels, state roles, integration test)

## 0.5.7 (2026-06-29)
- Fix: npm publish conflict (no functional changes)

## 0.5.6 (2026-06-29)
- New: Trips tab with daily kilometers and detected trips
- Fix: trip detection backfills kilometers before detection
- Fix: admin tab link 404 and missing admin tab files in the package

## 0.5.5 (2026-06-26)
- Maintenance: dependency cleanup

## 0.5.4 (2026-06-26)
- Fix: `window.setTimeout`/`setInterval` in admin tab

## 0.5.3 (2026-06-26)
- New: `package.test.js` with `@iobroker/testing`

## 0.5.2 (2026-06-24)
- Fix: changelog translations

## 0.5.1 (2026-06-24)
- Fix: `window.setTimeout`/`setInterval` in admin tab

## 0.5.0 (2026-06-23)
- New: React admin dashboard with full vehicle control
- New: climate and charging schedules
- New: comfort features (sentry mode, seat heat/ventilation, steering wheel heat, speed limit, mirror heat)
- New: trip detection and daily mileage
- New: charging cost estimation with dynamic pricing
- New: vehicle messages
- New: model-specific feature system
- New: embeddable vehicle image for VIS

## 0.2.7 (2026-06-13)
- Fix: minor fixes

## 0.2.5 (2026-06-12)
- Fix: dynamic vehicle name in HTML dashboard, debug logs removed

## 0.2.4 (2026-06-12)
- Fix: GitHub release permissions

## 0.2.3 (2026-06-12)
- Fix: missing news entries

## 0.2.2 (2026-06-11)
- Fix: workflow, test scripts

## 0.2.1 (2026-06-10)
- Fix: release script, logo size

## 0.2.0 (2026-06-10)
- Full release: status, consumption, pictures, HTML dashboard
- Automatic token refresh, picture cache
- Remote commands require PIN
