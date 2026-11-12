# Older Changelog
## 0.7.2 (2026-09-24)
- New: notification for new vehicle inbox messages (service reminders, recalls, etc.), separate from the existing software-update notification
- Fix: outdoor temperature (used for trip min/max temp and Prepare-to-Drive/Work) now falls back to Open-Meteo not just when the vehicle doesn't report a value at all, but also when its reported value has stopped updating (confirmed on T03: the cloud keeps serving the same reading once parked long enough) - same 30min staleness threshold as the existing data-age indicator, cached for 10min so this never polls Open-Meteo more than necessary
- Fix: the Cloud API Language field's help text (and its translations, which didn't exist in any language) referenced settings under wording that predated their move to the Settings tab
- Note: 0.7.1 was pushed to GitHub but never tagged/published to npm - its changes are included here in 0.7.2 instead

## 0.7.0 (2026-09-24)
- New: trip merge undo (`cmd.trips_merge_undo`, one slot, lost on adapter restart)
- Fix: merging a trip's GPS route now works correctly - previously the merged route was deleted right after being written, due to an off-by-one in the route-key handling during merge
- New: elevation gain per trip (via Open-Meteo, no API key)
- New: min/max outdoor temperature per trip
- New: regen estimate per trip (voltage x current integration), now correctly excluded from charging sessions
- New: CSV export for a chosen date range
- New: PDF trip-log export (table + summary row, chosen date range)
- New: configurable trip and GPS-route history retention, independently, in days (0 = forever, with a hard count-based safety cap)
- New: Prepare-to-Drive - auto heat/cool/vent on ignition-on based on outdoor-temperature thresholds, with a lock-state check and a guard against self-triggered commands causing false positives
- New: Prepare-to-Work - same climate-prep core, triggered via `cmd.prepare_to_work` instead of an ignition edge, for shift-schedule/calendar automation
- New: sunshade automation for both Prepare-to-Drive/Work, with separate position for heat/cool/vent and an "open when dark" rule (kept closed when heating for cold protection)
- New: outdoor temperature now sourced from Open-Meteo instead of the vehicle's own sensor (missing entirely on some models, e.g. B10, and misleading when parked in a garage) - 30-minute cache, falls back to the last known value on API errors
- New: estimated battery health (SoH), derived from official per-trip cloud energy vs. SoC used (median of the last 30 trips, deliberately not derived from the adapter's own charging-cost estimate to avoid a circular "always ~100%" result)
- New: home/public charging cost split by GPS distance to a configurable home location (address search via Nominatim, map with draggable marker and radius circle); home charging can use a dynamic price datapoint (e.g. Tibber/aWATTar), public charging always uses a separate fixed manual price
- New: notifications (trip done, charge done, OTA update, window-left-open warning, Prepare-to-Drive/Work triggered) via `sendTo`, with telegrammenu2 severity levels/area support and a dedicated email payload; test-notification button in the Settings tab
- Fix: Prepare-to-Drive missed real drive starts after a long idle period, because the vehicle auto-relocks itself while driving - now also gates on movement (speed/gear), not lock state alone
- Fix: Prepare-to-Drive could misfire from a transient ignition-on reading caused by any remote command (its own or an external script's) waking the vehicle - now ignores an ignition edge within 2 minutes of any command sent
- Fix: `bcmKeyPositionOn1` staying on during charging previously kept a trip open and counted charging current as regen - now correctly separated
- Fix: Leaflet's default marker showed as a broken "?" under Vite (bundler doesn't serve `leaflet/dist/images/*.png` automatically) - now explicitly imported and overridden
- Fix: several `{condition && <JSX>}` renders showing a literal "0" instead of nothing, when `condition` was the number `0` rather than `false`
- Improved: Datapoints tab moved to the end of the tab order
- Improved: full i18n coverage across all 11 languages - fixed several previously silent gaps (category group headings, tab names, "Parked")
- Fix: battery color threshold corrected (turns yellow at 20%, was incorrectly 50%)
- Fix: vehicles west of Greenwich (UK, Ireland, Portugal, parts of Spain/France) showed their GPS position mirrored into the wrong hemisphere; latitude/longitude now use the signed signal values instead of the absolute-value-only fields (community-confirmed via leapmotor-ha)
- Fix: window open/close/set-to-percent commands now scale to each model's native range - B05/B10/C10 expect a 0-10 scale, not 0-100 like T03; commands sent to those models previously moved the window far less than requested
- Fix: the "charging" status could get stuck showing active from a stale/phantom cloud flag while the car was actually being driven or just powered on and ready; it's now cross-checked against gear position, speed and ignition before being reported
- Fix: on T03, the binary window-open flags could remain at 0 even with the window actually open; open/closed status on this model now falls back to the live position percentage
- Fix: steering-wheel heating and seat heating/ventilation commands used a payload format the cloud silently ignored; both now send the numeric level/position format confirmed correct against two independent community reverse-engineering projects - not live-tested here, as this T03 doesn't have this hardware
- Known limitation: mirror heating is not controllable via the API on this T03 - confirmed non-functional even via the official Leapmotor app, so likely not exposed to the API/app for this vehicle at all. Payload sent matches the community-verified format; left in for other models/regions where it may work.
- Chore: cross-checked the tire-pressure signal ID mapping (front-left/front-right/rear-left/rear-right) against leapmotor-ha's independently corrected mapping - confirmed correct, no code change
- New: added B11 handling - not a separate model, it's Leapmotor's internal platform code for the C10 itself (confirmed via ADAC vehicle database); some cloud responses surface this code as carType instead of "C10", now mapped to the same endpoint and window scale.
- New (untested, community feedback welcome): start/stop charging, unlock charging connector, healthy-charging-mode toggle, fuel-heater toggle (REEV/range-extender models only), and sending a navigation destination (address or coordinates) to the vehicle. Payloads verified against two independent community reverse-engineering projects, not against real hardware - none of this is testable on this T03 (no REEV fuel heater; the other commands need a vehicle where charging/nav can safely be tried). Please open a GitHub issue with your model and result if you test any of these.
- Fix: trip tracking lives entirely in memory and gets wiped on every adapter restart, but trips.current_trip_active kept whatever value it last had - if a trip was active when the adapter restarted (or crashed), it stayed stuck showing "in progress" forever, since nothing afterward re-evaluated it without a matching in-memory entry. Now cleared at startup if left over from before the restart (the original trip's exact end time/mileage can't be recovered at that point).
- Improved: every remote command now logs a "Command: ..." line before sending and a "successful"/"failed" line after, at debug level - previously several commands (ac_temp/fan/position, speed limit, seat heat/ventilation, destination send, charge limit, refresh, defrost cycle) sent silently on success, making it impossible to tell from the log whether anything actually happened without also checking the raw status. Commands that only stage a value for a later command (ac_temp, climate/charge schedule fields, defrost level) now log that explicitly instead, so they're not mistaken for a command that was actually sent to the vehicle.
- Fix: cmd.charge_limit_set never synced with the vehicle's actual charge limit unless changed through this adapter's own control - if you changed it via the official app instead (e.g. to 100%), the internal control stayed frozen at its creation-time default of 80. cmd.charge_schedule_apply would then silently send that stale 80 back to the vehicle, overwriting your real setting. Now synced from the vehicle's actual reported limit on every poll, and charge_schedule_apply falls back to the vehicle's current schedule value instead of a hardcoded 80 if the control was never touched.
- Improved: trip detection now closes a trip immediately once the vehicle is locked and the ignition is explicitly off, instead of always waiting the full 10-minute grace period. The 10-minute grace period still applies for ambiguous cases (e.g. ignition status not reported, or car left unlocked with ignition off). Also added a second, independent fast-path signal: a completed lock → unlock → lock cycle since the trip started (the car auto-locks while driving, so getting out requires unlocking, then it's locked again afterward) is treated as equally definitive proof the trip is over, even on models where ignition status isn't reliably reported.
- Fix: a token expiry hitting exactly during cmd.refresh (or the delayed status fetch after certain commands) crashed the whole adapter process with an unhandled promise rejection, instead of re-logging in like the regular polling cycle already does. Both paths now catch the error and retry after a fresh login, same as the poller.
- Confirmed via a real B10 owner (extensive status field testing, 2026-07): battery/range/mileage/speed/ignition/doors/windows/tire pressure/sunroof/GPS/charge plan/charge limit status all report correctly; the hotspot status field doesn't exist on B10, same as T03. Also confirmed the vehicle's reported AC vent direction is decoded correctly (2026-09 dumps). Battery preheat was attempted but inconclusive (vehicle declined to activate in warm weather) - still untested.

## 0.6.8 (2026-09-19)
- Fix: the 0.6.7 re-login fix correctly detected an expired session token, but retried login using the same device identity every time - which the cloud started rejecting after the first failure, leaving the adapter stuck until a manual restart. A fresh device identity is now generated on every login attempt.
- Fix: remote pre-conditioning (heating/cooling the car before getting in, which turns the ignition on without the car moving) no longer gets misdetected as the start of a trip
- Fix: a completed trip's recorded end time now uses the vehicle's own reported timestamp instead of when our next poll happened to notice the stop, giving more accurate trip duration and a better match for the cloud's energy-breakdown time window
- Chore: added diagnostic logging of raw login/energy-breakdown responses to aid future troubleshooting

## 0.6.7 (2026-09-18)
- Fix: the automatic re-login on an expired session token was case-sensitive and never triggered for the cloud's "TOKEN_NOT_AVAILABLE" error, causing all polling to silently fail until a manual adapter restart
- Fix: a trip now only ends once the ignition is actually off (not just when speed reaches 0), and only after a 10-minute confirmation grace period - a brief stop at a light or curb no longer splits one drive into several
- Fix: the trip energy-breakdown retry queue now survives adapter restarts instead of leaving trips stuck showing "not yet available" forever; trips whose data never arrives are now clearly marked unavailable after the retry budget is exhausted
- Chore: raw status/energy-breakdown debug logging improvements to aid future diagnosis

## 0.6.6 (2026-09-17)
- Fix: B05 vehicles now use the shared C10 status endpoint (community-confirmed via leapmotor-ha), resolving the HTTP 404 status error (#38)
- Fix: right-side door overlays now render correctly behind the vehicle body/hood for proper depth ordering
- Chore: added ESLint config, tsconfig.json, VSCode JSON schema hints, converted i18n files to short format, bumped several dependencies, added Node.js 26 to the test matrix

## 0.6.5 (2026-09-02)
- New: on adapter start, the raw (pre-parsing) status response is logged once per vehicle at debug level, to help diagnose unsupported or under-tested vehicle models (e.g. B05)
- New: status request errors now also include the requested URL and the server's response body (if any)

## 0.6.4 (2026-09-02)
- Chore: migrated Admin Tab to adapter-react-v5 8.x and MUI v6 (React stays on 18, no breaking change for users)
- Fix: corrected Grid layout usage after the MUI v6 update, which had caused overlapping text on the Diagnostics tab
- Fix: unified card spacing/padding across all Admin Tab pages for a consistent look
- Fix: pinned react-dom to 18.3.1 to avoid a dependency resolution conflict
- Chore: minor CI workflow fix

## 0.6.3 (2026-09-01)
- Fix: preserve the existing charge schedule (enabled state, recurrence, start/end time) when changing the charge limit, instead of resetting it every time
- Fix: corrected door z-order and window-closed overlay logic on both vehicle sides
- Fix: clarified that the "Language" setting only affects Leapmotor cloud API text, not the Admin Tab UI (renamed to "Cloud API Language")
- Chore: bumped axios to 1.19.0
- Adapter is now available in the ioBroker stable repository
- (ioBroker-Bot) Adapter requires admin >= 7.8.23 now.

## 0.6.2 (2026-07-08)
- Fix: B10 model now correctly uses the c10 cloud status endpoint (community-confirmed), resolving empty status/trips/charging datapoints
- Fix: enabled full i18n for jsonConfig.json now that admin/i18n translation files cover all keys

## 0.6.1 (2026-07-03)
- Fix: repository checker findings - node: prefix for built-in modules, removed raw setTimeout fallback, included admin-tab i18n source in npm package, trimmed news list to 7 entries

## 0.6.0 (2026-07-03)
- Refactor: moved to standard plain-JS repository layout (main.js at repository root, supporting modules under lib/ instead of build/)
- Fix: removed dead/duplicate code, added VIN sanitization for object IDs, subscribed and acknowledged config.* states
- Fix: enforced upper bound on polling interval in code, switched picture cache from package-directory file to adapter's own file storage
- Fix: translated remaining German backend strings to English, enabled compact mode support, adapter-managed timers used throughout

## 0.5.8 (2026-07-02)
- Fix: repository checker compliance - added missing intermediate object structure (charging/consumption/pictures/trips channels), corrected invalid state roles, added real integration test

## 0.5.7 (2026-06-29)
- Fix: avoid npm transparency log conflict from a previous failed publish attempt (no functional changes vs. 0.5.5)

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
