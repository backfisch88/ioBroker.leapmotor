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
    // B10, C10, C16: still UNTESTED. Other users can provide feedback via debug
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
