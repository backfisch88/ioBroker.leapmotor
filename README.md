![Logo](admin/leapmotor.png)

# ioBroker.leapmotor

[![NPM version](https://img.shields.io/npm/v/iobroker.leapmotor.svg)](https://www.npmjs.com/package/iobroker.leapmotor)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Unofficial [Leapmotor](https://www.leapmotor.com/) electric vehicle integration for ioBroker. Tested on T03.

## ⚠️ Important: Use a Second Account

**Do not use your main Leapmotor account!**

The adapter maintains a permanent session with the Leapmotor cloud. If the same account is used simultaneously in the Leapmotor app, both sessions will conflict and log each other out.

**Recommended setup:**
1. Create a second Leapmotor account (e.g. with a second email address)
2. In the Leapmotor app, navigate to:
   **Personal Center → My Vehicle → [Vehicle Name] → Shared Members → Add Shared Member**
3. Enter the second account's email and grant all rights
4. Use the second account credentials in the adapter configuration

This way your main account stays logged in to the app at all times.

---

## Features

- React-based admin dashboard with Dashboard, Consumption, Trips, Datapoints, and Diagnostics tabs
- Vehicle status polling every 1–60 minutes (configurable)
- Battery SOC, range, temperature, tire pressure, GPS, doors, windows
- Remote control: climate (heat/cool/vent), lock/unlock, windows, sunshade, trunk, find
- Climate scheduling (recurring, by weekday) and charge limit / charge scheduling
- Comfort features where supported by the vehicle: sentry mode, seat heat/ventilation, steering wheel heat, speed limit, mirror heat
- Trip detection with daily kilometer tracking and individual trip history
- Charging cost estimation based on configurable electricity price
- Vehicle messages and unread count
- Vehicle-model-specific feature capability system (unsupported features are hidden automatically)
- Consumption statistics with weekly history
- Dynamic vehicle dashboard (composite HTML widget for VIS)
- Automatic token refresh
- Picture cache (downloaded once, stored locally)

## Tested Vehicles

- Leapmotor T03 ✅ (fully tested)
- Leapmotor B10 / C10 / C16 – should work, comfort feature availability not yet verified

## Installation

Install via ioBroker Admin UI.

## Configuration

| Setting | Description |
|---------|-------------|
| Email | Leapmotor account email (recommend using a dedicated second account) |
| Password | Leapmotor account password |
| Vehicle PIN | 4-digit vehicle PIN – required for all remote commands |
| Polling interval | Status update interval in minutes (default: 5) |

## Datapoints

```
leapmotor.0.<VIN>.status.*                → Vehicle status (read-only)
leapmotor.0.<VIN>.consumption.*           → Consumption & statistics (read-only)
leapmotor.0.<VIN>.trips.*                 → Daily kilometers and trip history (read-only)
leapmotor.0.<VIN>.charging.*              → Current charging session cost/kWh (read-only)
leapmotor.0.<VIN>.pictures.*              → Vehicle images, including an animated composite image (read-only)
leapmotor.0.<VIN>.cmd.*                   → Commands (writable)
leapmotor.0.<VIN>.info.*                  → Static vehicle info (read-only)
leapmotor.0.messages.*                    → Vehicle messages from the Leapmotor app (read-only)
leapmotor.0.config.*                      → Electricity price / battery capacity used for cost estimation
```

The full set of available datapoints, including all writable command states, is best explored
directly in the ioBroker object tree, or via the **Datapoints** tab in the adapter's own admin UI
— it lists every datapoint with its current value and a short description.

### Admin Dashboard

The adapter ships its own React-based admin tab (click the adapter icon in the instance list) with
five sub-tabs: **Dashboard** (live status and remote control), **Consumption** (weekly energy use
and cost estimate), **Trips** (daily kilometers and individual detected trips), **Datapoints**
(full datapoint browser), and **Diagnostics**.

### Animated Vehicle Image for VIS

`leapmotor.0.<VIN>.pictures.composite_html` now contains a simple, embeddable animated vehicle
image (transparent background, no buttons or dashboard chrome — that has moved into the admin
tab). Add a **basic - string (unescaped)** widget in VIS, or embed it via `<iframe>`, and set the
Object ID to:
```
leapmotor.0.<VIN>.pictures.composite_html
```

### Available Commands (selection)

Simple on/off buttons under `cmd.*` (role `button`, set to `true` to trigger):

| Command | Description | PIN required | Tested |
|---------|-------------|:------------:|:------:|
| cmd.ac_heat | Start heating | ✅ | ✅ |
| cmd.ac_cool | Start cooling | ✅ | ✅ |
| cmd.ac_vent | Start ventilation | ✅ | ✅ |
| cmd.ac_off | Stop climate | ✅ | ✅ |
| cmd.defrost | Windshield defrost | ✅ | ✅ |
| cmd.windows_open | Open windows | – | ✅ |
| cmd.windows_close | Close windows | – | ✅ |
| cmd.find | Find vehicle (horn/lights) | – | ✅ |
| cmd.battery_preheat | Battery preheat on | ✅ | ✅ |
| cmd.battery_preheat_off | Battery preheat off | ✅ | ✅ |
| cmd.lock | Lock vehicle | ✅ | ✅ |
| cmd.unlock | Unlock vehicle | ✅ | ✅ |
| cmd.trunk_open | Open trunk | ✅ | ✅ |
| cmd.trunk_close | Close trunk | ✅ | ✅ |
| cmd.refresh | Trigger immediate status update | – | ✅ |
| cmd.charge_start / charge_stop | Start/stop charging directly (not just via schedule) - same charging subsystem as cmd.charge_limit_set, expected to work on any model (T03, B05, B10, B11/C10, C16) | ✅ | ❌ community-test |
| cmd.unlock_charger | Unlock the charging connector remotely - expected to work on any model, same charging subsystem | ✅ | ❌ community-test |
| cmd.healthy_charging_on / off | Toggle battery-health charging mode - expected to work on any model, same charging subsystem | ✅ | ❌ community-test |
| cmd.fuel_heating_on / off | Fuel heater on/off - **REEV/range-extender models only** (e.g. C10 EREV) | ✅ | ❌ not applicable on T03 (BEV) |
| cmd.destination_send | Send the address/coordinates set below to the vehicle's built-in nav - expected on nav-equipped models (C10/B10/B11); unclear whether T03's built-in nav accepts cloud-pushed destinations at all | – | ❌ community-test |

Value-based commands:

| Command | Description |
|---------|-------------|
| cmd.ac_temp | Target temperature, 16–30 °C |
| cmd.ac_fan_speed | Fan speed, 1–7 |
| cmd.ac_position | Air position: all / up / down / front / rear |
| cmd.windows_set | Window position, 0–100 % |
| cmd.sunshade_set / sunshade_open / sunshade_close | Sunshade position (T03), 0–10 |
| cmd.charge_limit_set | Charge limit, 50–100 % |
| cmd.charge_schedule_enable / start / end / apply | Charging schedule |
| cmd.climate_schedule_enable / mode / time / days / apply / cancel | Recurring climate schedule |
| cmd.speed_limit_set | Speed limit, if supported by the vehicle |
| cmd.destination_address / destination_latitude / destination_longitude | Destination to send via cmd.destination_send (fill address, or lat/lon, then trigger) - community-test, not tested here |

Comfort commands (only created/shown if the vehicle model supports the feature):

| Command | Description | Confirmed on | Expected on (untested, reasoned guess) |
|---------|-------------|--------------|------------------------------|
| cmd.sentry_mode_on / off | Sentry mode | – | Confirmed **not** on T03 |
| cmd.seat_heat_driver / copilot | Seat heating | – | B10, B11/C10 - trim-dependent, at least one C10 spec sheet had no heated seats standard. Confirmed **not** on T03 |
| cmd.seat_ventilation_driver / copilot | Seat ventilation | – | Same as seat heating |
| cmd.steering_wheel_heat_on / off | Steering wheel heating | – | Same as seat heating. Confirmed **not** on T03 |
| cmd.mirror_heat_on / off | Mirror heating | – | B10, B11/C10, B05. Confirmed **not exposed via API/app at all** on this T03 |
| cmd.hotspot_on / off | Wi-Fi hotspot | – | Unknown other models. Confirmed **not** on T03 |

`sunroof`/`sunshade` are handled the same way — see `admin-tab/src/vehicleCapabilities.js` for the confirmed B10 vs T03 difference.

Which comfort commands actually appear depends on the detected vehicle model — see
`admin-tab/src/vehicleCapabilities.js` in the repository for the current capability matrix per model.

## Changelog

### **WORK IN PROGRESS**
- Fix: vehicles west of Greenwich (UK, Ireland, Portugal, parts of Spain/France) showed their GPS position mirrored into the wrong hemisphere; latitude/longitude now use the signed signal values instead of the absolute-value-only fields (community-confirmed via leapmotor-ha)
- Fix: window open/close/set-to-percent commands now scale to each model's native range - B05/B10/C10 expect a 0-10 scale, not 0-100 like T03; commands sent to those models previously moved the window far less than requested
- Fix: the "charging" status could get stuck showing active from a stale/phantom cloud flag while the car was actually being driven or just powered on and ready; it's now cross-checked against gear position, speed and ignition before being reported
- Fix: on T03, the binary window-open flags could remain at 0 even with the window actually open; open/closed status on this model now falls back to the live position percentage
- Fix: steering-wheel heating and seat heating/ventilation commands used a payload format the cloud silently ignored; both now send the numeric level/position format confirmed correct against two independent community reverse-engineering projects - not live-tested here, as this T03 doesn't have this hardware
- Known limitation: mirror heating is not controllable via the API on this T03 - confirmed non-functional even via the official Leapmotor app, so likely not exposed to the API/app for this vehicle at all. Payload sent matches the community-verified format; left in for other models/regions where it may work.
- Chore: cross-checked the tire-pressure signal ID mapping (front-left/front-right/rear-left/rear-right) against leapmotor-ha's independently corrected mapping - confirmed correct, no code change
- New: added B11 handling - not a separate model, it's Leapmotor's internal platform code for the C10 itself (confirmed via ADAC vehicle database); some cloud responses surface this code as carType instead of "C10", now mapped to the same endpoint and window scale.
- New (untested, community feedback welcome): start/stop charging, unlock charging connector, healthy-charging-mode toggle, fuel-heater toggle (REEV/range-extender models only), and sending a navigation destination (address or coordinates) to the vehicle. Payloads verified against two independent community reverse-engineering projects, not against real hardware - none of this is testable on this T03 (no REEV fuel heater; the other commands need a vehicle where charging/nav can safely be tried). Please open a GitHub issue with your model and result if you test any of these.

### 0.6.8 (2026-09-19)
- Fix: the 0.6.7 re-login fix correctly detected an expired session token, but retried login using the same device identity every time - which the cloud started rejecting after the first failure, leaving the adapter stuck until a manual restart. A fresh device identity is now generated on every login attempt.
- Fix: remote pre-conditioning (heating/cooling the car before getting in, which turns the ignition on without the car moving) no longer gets misdetected as the start of a trip
- Fix: a completed trip's recorded end time now uses the vehicle's own reported timestamp instead of when our next poll happened to notice the stop, giving more accurate trip duration and a better match for the cloud's energy-breakdown time window
- Chore: added diagnostic logging of raw login/energy-breakdown responses to aid future troubleshooting

### 0.6.7 (2026-09-18)
- Fix: the automatic re-login on an expired session token was case-sensitive and never triggered for the cloud's "TOKEN_NOT_AVAILABLE" error, causing all polling to silently fail until a manual adapter restart
- Fix: a trip now only ends once the ignition is actually off (not just when speed reaches 0), and only after a 10-minute confirmation grace period - a brief stop at a light or curb no longer splits one drive into several
- Fix: the trip energy-breakdown retry queue now survives adapter restarts instead of leaving trips stuck showing "not yet available" forever; trips whose data never arrives are now clearly marked unavailable after the retry budget is exhausted
- Chore: raw status/energy-breakdown debug logging improvements to aid future diagnosis

### 0.6.6 (2026-09-17)
- Fix: B05 vehicles now use the shared C10 status endpoint (community-confirmed via leapmotor-ha), resolving the HTTP 404 status error (#38)
- Fix: right-side door overlays now render correctly behind the vehicle body/hood for proper depth ordering
- Chore: added ESLint config, tsconfig.json, VSCode JSON schema hints, converted i18n files to short format, bumped several dependencies, added Node.js 26 to the test matrix

### 0.6.5 (2026-09-02)
- New: on adapter start, the raw (pre-parsing) status response is logged once per vehicle at debug level, to help diagnose unsupported or under-tested vehicle models (e.g. B05)
- New: status request errors now also include the requested URL and the server's response body (if any)

### 0.6.4 (2026-09-02)
- Chore: migrated Admin Tab to adapter-react-v5 8.x and MUI v6 (React stays on 18, no breaking change for users)
- Fix: corrected Grid layout usage after the MUI v6 update, which had caused overlapping text on the Diagnostics tab
- Fix: unified card spacing/padding across all Admin Tab pages for a consistent look
- Fix: pinned react-dom to 18.3.1 to avoid a dependency resolution conflict
- Chore: minor CI workflow fix

### 0.6.3 (2026-09-01)
- Fix: preserve the existing charge schedule (enabled state, recurrence, start/end time) when changing the charge limit, instead of resetting it every time
- Fix: corrected door z-order and window-closed overlay logic on both vehicle sides
- Fix: clarified that the "Language" setting only affects Leapmotor cloud API text, not the Admin Tab UI (renamed to "Cloud API Language")
- Chore: bumped axios to 1.19.0
- Adapter is now available in the ioBroker stable repository
- (ioBroker-Bot) Adapter requires admin >= 7.8.23 now.

### 0.6.2 (2026-07-08)
- Fix: B10 model now correctly uses the c10 cloud status endpoint (community-confirmed), resolving empty status/trips/charging datapoints
- Fix: enabled full i18n for jsonConfig.json now that admin/i18n translation files cover all keys

### 0.6.1 (2026-07-03)
- Fix: repository checker findings - node: prefix for built-in modules, removed raw setTimeout fallback, included admin-tab i18n source in npm package, trimmed news list to 7 entries

### 0.6.0 (2026-07-03)
- Refactor: moved to standard plain-JS repository layout (main.js at repository root, supporting modules under lib/ instead of build/)
- Fix: removed dead/duplicate code, added VIN sanitization for object IDs, subscribed and acknowledged config.* states
- Fix: enforced upper bound on polling interval in code, switched picture cache from package-directory file to adapter's own file storage
- Fix: translated remaining German backend strings to English, enabled compact mode support, adapter-managed timers used throughout

### 0.5.8 (2026-07-02)
- Fix: repository checker compliance - added missing intermediate object structure (charging/consumption/pictures/trips channels), corrected invalid state roles, added real integration test

### 0.5.7 (2026-06-29)
- Fix: avoid npm transparency log conflict from a previous failed publish attempt (no functional changes vs. 0.5.5)

Older changes can be found in [CHANGELOG_OLD.md](CHANGELOG_OLD.md).

[Older changelogs can be found there](CHANGELOG_OLD.md)

## License

MIT License

Copyright (c) 2026 Henrik Schönhofen (backfisch88) <henrik.schoenhofen@icloud.com>

See [LICENSE](LICENSE) for the full license text.
