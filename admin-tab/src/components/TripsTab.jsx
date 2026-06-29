import React, { useMemo, useState } from 'react';
import {
    Box, Card, CardContent, Typography, Divider, Chip, Collapse, IconButton,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import DirectionsCarIcon from '@mui/icons-material/DirectionsCar';
import HelpOutlineIcon from '@mui/icons-material/HelpOutline';

function val(states, id, def = null) {
    return states[id]?.val ?? def;
}

function SectionLabel({ children }) {
    return (
        <Typography variant="overline" sx={{ color: '#5a7090', letterSpacing: 1.2, display: 'block', mb: 1.5 }}>
            {children}
        </Typography>
    );
}

function fmtDateLong(iso) {
    if (!iso) return iso;
    const [y, m, d] = iso.split('-');
    return `${d}.${m}.${y}`;
}

function fmtDateShort(iso) {
    if (!iso) return iso;
    const [, m, d] = iso.split('-');
    return `${d}.${m}.`;
}

export default function TripsTab({ base, states }) {
    const [expandedDay, setExpandedDay] = useState(null);

    const dailyKm = useMemo(() => {
        const raw = val(states, `${base}.trips.daily_km_json`, '[]');
        try { return JSON.parse(raw); } catch { return []; }
    }, [states, base]);

    const tripHistory = useMemo(() => {
        const raw = val(states, `${base}.trips.history_json`, '[]');
        try { return JSON.parse(raw); } catch { return []; }
    }, [states, base]);

    const todayKm = val(states, `${base}.trips.today_km`, 0);
    const currentTripActive = val(states, `${base}.trips.current_trip_active`, false);

    // Gruppiere Einzelfahrten nach Tag
    const tripsByDay = useMemo(() => {
        const map = {};
        tripHistory.forEach((t) => {
            if (!map[t.date]) map[t.date] = [];
            map[t.date].push(t);
        });
        return map;
    }, [tripHistory]);

    // Kombiniere Tagessummen mit den dazugehörigen Einzelfahrten,
    // berechne die Differenz als "Sonstige" (nicht erfasste km, z.B. kurze
    // Fahrten zwischen zwei 5-Minuten-Polls, die unsere Erkennung verpasst hat).
    const days = useMemo(() => {
        const result = dailyKm.map((d) => {
            const trips = (tripsByDay[d.date] || []).slice().sort((a, b) => a.startTime.localeCompare(b.startTime));
            const tripsKm = trips.reduce((sum, t) => sum + (t.km || 0), 0);
            const otherKm = Math.max(0, Math.round((d.km - tripsKm) * 10) / 10);
            return { date: d.date, totalKm: d.km, trips, otherKm };
        });
        return result.sort((a, b) => b.date.localeCompare(a.date));
    }, [dailyKm, tripsByDay]);

    const weekTotal = useMemo(() => {
        const last7 = days.slice(0, 7);
        return Math.round(last7.reduce((sum, d) => sum + d.totalKm, 0) * 10) / 10;
    }, [days]);

    return (
        <Box sx={{ p: 2 }}>
            {/* Übersicht oben */}
            <Card sx={{ mb: 2, bgcolor: '#0d1520', border: '1px solid #1e2d45' }}>
                <CardContent>
                    <SectionLabel>FAHRTEN-ÜBERSICHT</SectionLabel>
                    <Box sx={{ display: 'flex', gap: 2 }}>
                        <Box sx={{ flex: 1, textAlign: 'center' }}>
                            <Typography sx={{ fontSize: '1.6rem', fontWeight: 800, color: '#00d4ff' }}>
                                {todayKm} km
                            </Typography>
                            <Typography variant="caption" sx={{ color: '#5a7090' }}>Heute</Typography>
                        </Box>
                        <Divider orientation="vertical" flexItem sx={{ borderColor: '#1e2d45' }} />
                        <Box sx={{ flex: 1, textAlign: 'center' }}>
                            <Typography sx={{ fontSize: '1.6rem', fontWeight: 800, color: '#00ff88' }}>
                                {weekTotal} km
                            </Typography>
                            <Typography variant="caption" sx={{ color: '#5a7090' }}>Letzte 7 Tage</Typography>
                        </Box>
                    </Box>
                    {currentTripActive && (
                        <Chip
                            icon={<DirectionsCarIcon sx={{ fontSize: 16 }} />}
                            label="Fahrt läuft gerade"
                            size="small"
                            sx={{ mt: 1.5, bgcolor: '#00d4ff22', color: '#00d4ff', border: '1px solid #00d4ff55' }}
                        />
                    )}
                </CardContent>
            </Card>

            {/* Tagesliste */}
            {days.length === 0 ? (
                <Typography sx={{ color: '#5a7090', textAlign: 'center', mt: 4 }}>
                    Noch keine Fahrtdaten aufgezeichnet.
                </Typography>
            ) : (
                days.map((day) => {
                    const isExpanded = expandedDay === day.date;
                    return (
                        <Card key={day.date} sx={{ mb: 1.5, bgcolor: '#0d1520', border: '1px solid #1e2d45' }}>
                            <CardContent
                                sx={{ cursor: 'pointer', '&:last-child': { pb: 2 } }}
                                onClick={() => setExpandedDay(isExpanded ? null : day.date)}
                            >
                                <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                    <Box>
                                        <Typography sx={{ fontWeight: 700, color: '#c8ddf0' }}>
                                            {fmtDateLong(day.date)}
                                        </Typography>
                                        <Typography variant="caption" sx={{ color: '#5a7090' }}>
                                            {day.trips.length} {day.trips.length === 1 ? 'Fahrt' : 'Fahrten'} erkannt
                                        </Typography>
                                    </Box>
                                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                        <Typography sx={{ fontWeight: 800, fontSize: '1.1rem', color: '#00d4ff' }}>
                                            {day.totalKm} km
                                        </Typography>
                                        <IconButton size="small" sx={{ color: '#5a7090' }}>
                                            {isExpanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
                                        </IconButton>
                                    </Box>
                                </Box>

                                <Collapse in={isExpanded}>
                                    <Divider sx={{ borderColor: '#1e2d45', my: 1.5 }} />
                                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                                        {day.trips.map((trip, i) => {
                                            const startClock = trip.startTime.split(', ')[1] || trip.startTime;
                                            const endClock = trip.endTime.split(', ')[1] || trip.endTime;
                                            return (
                                                <Box
                                                    key={i}
                                                    sx={{
                                                        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                                                        bgcolor: '#070d1a', borderRadius: 1.5, px: 1.5, py: 1,
                                                        border: '1px solid #1e2d4555',
                                                    }}
                                                >
                                                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                                        <DirectionsCarIcon sx={{ fontSize: 16, color: '#00d4ff' }} />
                                                        <Typography variant="caption" sx={{ color: '#c8ddf0' }}>
                                                            {startClock} – {endClock}
                                                        </Typography>
                                                    </Box>
                                                    <Box sx={{ display: 'flex', gap: 1.5 }}>
                                                        <Typography variant="caption" sx={{ color: '#5a7090' }}>
                                                            {trip.durationMin} min
                                                        </Typography>
                                                        {trip.socUsed != null && (
                                                            <Typography variant="caption" sx={{ color: '#ff9900' }}>
                                                                -{trip.socUsed}% Akku
                                                            </Typography>
                                                        )}
                                                        <Typography variant="caption" sx={{ color: '#00ff88', fontWeight: 700 }}>
                                                            {trip.km} km
                                                        </Typography>
                                                    </Box>
                                                </Box>
                                            );
                                        })}
                                        {day.otherKm > 0 && (
                                            <Box
                                                sx={{
                                                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                                                    bgcolor: '#070d1a', borderRadius: 1.5, px: 1.5, py: 1,
                                                    border: '1px dashed #5a709055',
                                                }}
                                            >
                                                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                                    <HelpOutlineIcon sx={{ fontSize: 16, color: '#5a7090' }} />
                                                    <Typography variant="caption" sx={{ color: '#5a7090' }}>
                                                        Sonstige (nicht erfasste Fahrten)
                                                    </Typography>
                                                </Box>
                                                <Typography variant="caption" sx={{ color: '#5a7090', fontWeight: 700 }}>
                                                    {day.otherKm} km
                                                </Typography>
                                            </Box>
                                        )}
                                    </Box>
                                </Collapse>
                            </CardContent>
                        </Card>
                    );
                })
            )}

            <Typography variant="caption" sx={{ color: '#5a7090', display: 'block', textAlign: 'center', mt: 2 }}>
                Fahrten werden alle 5 Minuten anhand der Geschwindigkeit erkannt. Sehr kurze Fahrten zwischen zwei
                Abfragen können als "Sonstige" erscheinen, statt als eigene Fahrt erfasst zu werden.
            </Typography>
        </Box>
    );
}
