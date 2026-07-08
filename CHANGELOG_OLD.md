# Older Changelog
## 0.5.6 (2026-06-29)
- New: Trips tab showing daily kilometers with individual detected trips and an "Other" entry for any unaccounted distance
- Fix: trip detection now backfills kilometers driven before the trip was first detected (closes the gap caused by the 5-minute polling interval)
- Fix: critical bug where `adminTab.link` used a relative path, causing a 404 error when opening the tab for all users — now uses an absolute path
- Fix: admin tab files (`index_m.html`, `tab.html`, `tab.js`, `tab_m.html`) were missing from the published package; they are now included
- Fix: `index_m.html` contained leftover placeholder content instead of the real mobile tab loader

## 0.5.5 (2026-06-26)
- Maintenance: dependency cleanup and repository checker compliance fixes

## 0.5.4 (2026-06-26)
- Fix: use `window.setTimeout`/`window.setInterval` in the admin tab frontend to satisfy the repository checker
- Maintenance: dependency cleanup

## 0.5.3 (2026-06-26)
- New: standard `package.test.js` test suite using `@iobroker/testing` for repository compliance

## 0.5.2 (2026-06-24)
- Fix: complete translations for changelog entries

## 0.5.1 (2026-06-24)
- Fix: use `window.setTimeout`/`window.setInterval` in admin-tab frontend to satisfy repository checker
- Maintenance: dependency cleanup

## 0.5.0 (2026-06-23)
- New: React admin dashboard with full vehicle control
- New: climate and charging schedules
- New: comfort features (sentry mode, seat heat/ventilation, steering wheel heat, speed limit, mirror heat)
- New: trip detection and daily mileage tracking
- New: charging cost estimation with dynamic electricity pricing
- New: vehicle messages and unread count
- New: vehicle-model-specific feature capability system
- New: embeddable animated vehicle image for VIS

## 0.5.2 (2026-06-24)
- (placeholder for next release)

## 0.5.1 (2026-06-24)
- Fix: use window.setTimeout/setInterval in admin-tab frontend to satisfy repository checker
- Maintenance: dependency cleanup

## 0.5.0 (2026-06-23)
- New: React admin dashboard with full vehicle control
- New: climate and charging schedules
- New: comfort features (sentry mode, seat heat/ventilation, steering wheel heat, speed limit, mirror heat)
- New: trip detection and daily mileage tracking
- New: charging cost estimation with dynamic electricity pricing
- New: vehicle messages and unread count
- New: vehicle-model-specific feature capability system
- New: embeddable animated vehicle image for VIS

## 0.2.7 (2026-06-13)
- (see previous release notes)

## 0.2.5 (2026-06-12)
- fix: use dynamic vehicle name from API in HTML dashboard
- fix: remove debug log messages

## 0.2.4 (2026-06-12)
- Fix: GitHub release permissions in workflow

## 0.2.3 (2026-06-12)
- Fix: add missing news entries

## 0.2.2 (2026-06-11)
- Fix: workflow, test scripts

## 0.2.1 (2026-06-10)
- Fix: release script, logo size, workflow improvements

## 0.2.0 (2026-06-10)
- Full release: status, consumption, pictures, composite HTML dashboard
- Automatic token refresh
- Picture cache
- All remote commands require PIN verification

## 0.2.4 (2026-06-12)
- Fix: GitHub release permissions in workflow

## 0.2.3 (2026-06-12)
- Fix: add missing news entries

## 0.2.2 (2026-06-11)
- Fix: workflow, test scripts

## 0.2.1 (2026-06-10)
- Fix: release script, logo size, workflow improvements

## 0.2.0 (2026-06-10)
- Full release: status, consumption, pictures, composite HTML dashboard
- Automatic token refresh
- Picture cache
- All remote commands require PIN verification

## 0.2.0 (2026-06-10)
- Full release: status, consumption, pictures, composite HTML dashboard
- Automatic token refresh
- Picture cache
- All remote commands require PIN verification
