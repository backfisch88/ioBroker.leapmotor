![Logo](admin/leapmotor.png)

# ioBroker.leapmotor

[![Version](https://img.shields.io/badge/version-0.5.7-blue.svg)](https://github.com/backfisch88/ioBroker.leapmotor)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Unofficial Leapmotor electric vehicle integration for ioBroker. Tested on T03.

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
leapmotor.0.<VIN>.pictures.*              → Vehicle images (read-only)
leapmotor.0.<VIN>.pictures.composite_html → Full dashboard HTML widget
leapmotor.0.<VIN>.cmd.*                   → Commands (writable)
```

### VIS Dashboard Widget

Add a **basic - string (unescaped)** widget in VIS and set the Object ID to:
```
leapmotor.0.<VIN>.pictures.composite_html
```

### Available Commands

| Command | Description | PIN required |
|---------|-------------|:------------:|
| cmd.ac_heiz | Start heating | ✅ |
| cmd.ac_kuehl | Start cooling | ✅ |
| cmd.ac_luft | Start ventilation | ✅ |
| cmd.ac_off | Stop climate | ✅ |
| cmd.ac_temp | Target temperature (16–30°C) | – |
| cmd.defrost | Windshield defrost | ✅ |
| cmd.lock | Lock vehicle | ✅ |
| cmd.unlock | Unlock vehicle | ✅ |
| cmd.trunk_open | Open trunk | ✅ |
| cmd.trunk_close | Close trunk | ✅ |
| cmd.windows_open | Open windows | – |
| cmd.windows_close | Close windows | – |
| cmd.find | Find vehicle (horn/lights) | – |
| cmd.battery_preheat | Battery preheat on | ✅ |
| cmd.battery_preheat_off | Battery preheat off | ✅ |
| cmd.refresh | Trigger immediate status update | – |

## Changelog
### **WORK IN PROGRESS**
- (placeholder for next release)

### 0.5.7 (2026-06-29)
- Fix: avoid npm transparency log conflict from a previous failed publish attempt (no functional changes vs. 0.5.5)

### 0.5.6 (2026-06-29)
- New: Trips tab showing daily kilometers with individual detected trips and an "Other" entry for any unaccounted distance
- Fix: trip detection now backfills kilometers driven before the trip was first detected (closes the gap caused by the 5-minute polling interval)
- Fix: critical bug where `adminTab.link` used a relative path, causing a 404 error when opening the tab for all users — now uses an absolute path
- Fix: admin tab files (`index_m.html`, `tab.html`, `tab.js`, `tab_m.html`) were missing from the published package; they are now included
- Fix: `index_m.html` contained leftover placeholder content instead of the real mobile tab loader

### 0.5.5 (2026-06-26)
- Maintenance: dependency cleanup and repository checker compliance fixes

### 0.5.4 (2026-06-26)
- Fix: use `window.setTimeout`/`window.setInterval` in the admin tab frontend to satisfy the repository checker
- Maintenance: dependency cleanup

### 0.5.3 (2026-06-26)
- New: standard `package.test.js` test suite using `@iobroker/testing` for repository compliance

### 0.5.2 (2026-06-24)
- Fix: complete translations for changelog entries

### 0.5.1 (2026-06-24)
- Fix: use `window.setTimeout`/`window.setInterval` in admin-tab frontend to satisfy repository checker
- Maintenance: dependency cleanup

### 0.5.0 (2026-06-23)
- New: React admin dashboard with full vehicle control
- New: climate and charging schedules
- New: comfort features (sentry mode, seat heat/ventilation, steering wheel heat, speed limit, mirror heat)
- New: trip detection and daily mileage tracking
- New: charging cost estimation with dynamic electricity pricing
- New: vehicle messages and unread count
- New: vehicle-model-specific feature capability system
- New: embeddable animated vehicle image for VIS

Older changes can be found in [CHANGELOG_OLD.md](CHANGELOG_OLD.md).

## License

MIT License

Copyright (c) 2026 Henrik Schönhofen (backfisch88)
