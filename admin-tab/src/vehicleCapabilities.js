// Vehicle-specific feature support
// Basis: own testing + leapconnect/leapmotor_api references
//
// Status per feature:
//   true  = confirmed working
//   false = confirmed NOT working (command is accepted but has no effect)
//   undefined = unknown/untested -> treated like 'true' (shown optimistically)

const CAPABILITIES = {
    // T03: fully verified through own testing (see comments below)
    T03: {
        lock: true,
        find: true,
        trunk: true,
        windows: true,
        sunshade: true, // sunshade under fixed glass roof (no movable roof on the T03)
        sunroof: false, // T03 has no movable glass roof
        climate: true,
        quickClimate: true,
        climateSchedule: true,
        chargeLimit: true,
        chargeSchedule: true,
        batteryPreheat: true,
        defrost: true, // sends the command, but the windshield icon in the display doesn't demonstrably react
        hotspot: false, // command is accepted but has no effect
        mirrorHeat: false, // confirmed no effect on the T03 (tested 2026-06-19)
        sentryMode: false, // T03 has no sentry/watch mode installed
        speedLimit: false, // confirmed no effect on the T03 (tested 2026-06-19)
        seatHeat: false, // T03 has no seat heating installed
        seatVentilation: false, // T03 has no seat ventilation installed
        steeringWheelHeat: false, // T03 has no steering wheel heating installed
        windDirection: false, // demonstrably not controllable via cloud API (tested systematically multiple times)
        rearWindowHeating: false, // signal doesn't exist on the T03 (only on C10/B10)
    },
    // B10: partially confirmed via a real owner's status dumps (2026-07).
    // Only what has actually been confirmed is listed here; everything else
    // stays undocumented (optimistic default via hasCapability()).
    B10: {
        sunshade: true, // confirmed: B10 has an electric sunroof, unlike T03's fixed shade (signal 1724)
        sunroof: true,
    },
    // C10, C16: still UNTESTED. Other users can provide feedback via debug
    // logs (e.g. "remote 301 failed: ..." or success without effect) on which
    // features actually work on their model. Until then, all features are
    // shown optimistically (see hasCapability() fallback).
};

// List of all known feature keys, used as an "everything allowed" fallback for unknown models
const ALL_FEATURES = [
    'lock', 'find', 'trunk', 'windows', 'sunshade', 'sunroof', 'climate',
    'quickClimate', 'climateSchedule', 'chargeLimit', 'chargeSchedule',
    'batteryPreheat', 'defrost', 'hotspot', 'mirrorHeat', 'sentryMode',
    'speedLimit', 'seatHeat', 'seatVentilation', 'steeringWheelHeat',
    'windDirection', 'rearWindowHeating',
];

/**
 * Returns true/false whether a feature should be shown/enabled for the given
 * vehicle model.
 * - Known model + feature explicitly false -> false (hide)
 * - Known model + feature explicitly true or undefined -> true (show)
 * - Unknown model -> always true (show, since we don't know what works)
 */
export function hasCapability(carType, feature) {
    const model = CAPABILITIES[carType];
    if (!model) return true; // unknown model: optimistically show everything
    if (!(feature in model)) return true; // feature not documented for this model: show optimistically
    return model[feature] !== false; // only an explicit false hides it
}

export { ALL_FEATURES };

// Status datapoints that are confirmed to genuinely NOT exist in the cloud's
// response for a given model family - not a bug, not "not yet loaded", but a
// real limitation of the vehicle's data endpoint. Confirmed 2026-07 via a
// real B10 owner's before/after tests (toggling each feature and checking
// whether ANY signal ID changed) plus cross-referencing two independent
// community reverse-engineering projects (leapmotor-api, leapmotor-ha), which
// both only ever read these fields from the T03-style named-field response,
// never from a C10/B10-style numeric signal ID.
//
// Model families share the same underlying cloud status endpoint (see
// STATUS_ENDPOINT_OVERRIDES in lib/leapmotor-client.js), so this list applies
// to any model routed through that endpoint, not just B10 specifically.
const SIGNAL_FAMILY_UNAVAILABLE_STATUS_FIELDS = [
    'ac_cooling_heating',
    'ac_fan_speed_setting',
    'bluetooth_on',
    'hotspot_on',
    'door_ctrl_allow',
    'ptc_state',
    'temp_outdoor',
];

// carType -> list of status.* key suffixes confirmed unavailable for that
// specific model. Currently only B10 has been tested; models sharing its
// endpoint (see above) are assumed to have the same limitation until an
// owner confirms otherwise.
const UNAVAILABLE_STATUS_FIELDS = {
    B10: SIGNAL_FAMILY_UNAVAILABLE_STATUS_FIELDS,
};

/**
 * Returns true if a given status.* datapoint (by its key suffix, e.g.
 * "temp_outdoor") is confirmed to never be available for this vehicle model,
 * so the UI can show a clear "not supported on this model" indicator instead
 * of looking like a stuck/broken value.
 */
export function isKnownUnavailable(carType, statusKey) {
    const list = UNAVAILABLE_STATUS_FIELDS[carType];
    return Array.isArray(list) && list.includes(statusKey);
}
