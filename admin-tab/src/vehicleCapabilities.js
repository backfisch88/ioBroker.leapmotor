// Fahrzeugspezifische Feature-Unterstützung
// Basis: eigene Tests + leapconnect/leapmotor_api Referenzen
//
// Status pro Feature:
//   true  = bestätigt funktionierend
//   false = bestätigt NICHT funktionierend (Befehl wird angenommen, aber wirkungslos)
//   undefined = unbekannt/ungetestet -> wird wie 'true' behandelt (optimistisch anzeigen)

const CAPABILITIES = {
    // T03: vollständig durch eigene Tests verifiziert (siehe Kommentare unten)
    T03: {
        lock: true,
        find: true,
        trunk: true,
        windows: true,
        sunshade: true, // Sonnenblende unter festem Glasdach (kein bewegliches Dach beim T03)
        sunroof: false, // T03 hat kein bewegliches Glasdach
        climate: true,
        quickClimate: true,
        climateSchedule: true,
        chargeLimit: true,
        chargeSchedule: true,
        batteryPreheat: true,
        defrost: true, // sendet Befehl, aber Frontscheiben-Symbol im Display reagiert nicht nachweislich
        hotspot: false, // Befehl wird angenommen, aber wirkungslos
        mirrorHeat: false, // bestätigt wirkungslos beim T03 (Test 2026-06-19)
        sentryMode: false, // T03 hat keinen Wächter-/Sentry-Modus verbaut
        speedLimit: false, // bestätigt wirkungslos beim T03 (Test 2026-06-19)
        seatHeat: false, // T03 hat keine Sitzheizung verbaut
        seatVentilation: false, // T03 hat keine Sitzbelüftung verbaut
        steeringWheelHeat: false, // T03 hat keine Lenkradheizung verbaut
        windDirection: false, // nachweislich nicht über Cloud-API steuerbar (mehrfach systematisch getestet)
        rearWindowHeating: false, // Signal existiert beim T03 nicht (nur bei C10/B10)
    },
    // B10, C10, C16: noch UNGETESTET. Andere Nutzer können über die Debug-Logs
    // (z.B. "remote 301 failed: ..." oder Erfolg ohne Wirkung) Rückmeldung geben,
    // welche Funktionen bei ihrem Modell tatsächlich funktionieren. Bis dahin
    // werden alle Features optimistisch angezeigt (siehe hasCapability() Fallback).
};

// Liste aller bekannten Feature-Keys, für unbekannte Modelle als "alles erlaubt" Fallback
const ALL_FEATURES = [
    'lock', 'find', 'trunk', 'windows', 'sunshade', 'sunroof', 'climate',
    'quickClimate', 'climateSchedule', 'chargeLimit', 'chargeSchedule',
    'batteryPreheat', 'defrost', 'hotspot', 'mirrorHeat', 'sentryMode',
    'speedLimit', 'seatHeat', 'seatVentilation', 'steeringWheelHeat',
    'windDirection', 'rearWindowHeating',
];

/**
 * Gibt true/false zurück ob ein Feature für das gegebene Fahrzeugmodell
 * angezeigt/aktiviert werden soll.
 * - Bekanntes Modell + Feature explizit false -> false (ausblenden)
 * - Bekanntes Modell + Feature explizit true oder undefined -> true (anzeigen)
 * - Unbekanntes Modell -> immer true (anzeigen, da wir nicht wissen was geht)
 */
export function hasCapability(carType, feature) {
    const model = CAPABILITIES[carType];
    if (!model) return true; // unbekanntes Modell: optimistisch alles zeigen
    if (!(feature in model)) return true; // Feature für dieses Modell nicht dokumentiert: optimistisch zeigen
    return model[feature] !== false; // nur explizites false blendet aus
}

export { ALL_FEATURES };
