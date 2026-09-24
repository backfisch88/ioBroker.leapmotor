import React, { useMemo, useState, useEffect, useRef } from 'react';
import {
    Box, Card, CardContent, Typography, Divider, Chip, Collapse, IconButton,
} from '@mui/material';
import { I18n } from '@iobroker/adapter-react-v5';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import DirectionsCarIcon from '@mui/icons-material/DirectionsCar';
import HelpOutlineIcon from '@mui/icons-material/HelpOutline';
import MergeTypeIcon from '@mui/icons-material/MergeType';
import UndoIcon from '@mui/icons-material/Undo';
import ExportPanel from './ExportPanel';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// Small imperative Leaflet map for one trip's route. Plain leaflet (no
// react-leaflet) keeps this self-contained and avoids an extra dependency
// just for a single polyline per trip.
function RouteMap({ points }) {
    const mapRef = useRef(null);
    const containerRef = useRef(null);

    useEffect(() => {
        if (!containerRef.current || !points || points.length < 2) return undefined;
        const map = L.map(containerRef.current, { attributionControl: false, zoomControl: false });
        mapRef.current = map;
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
        }).addTo(map);
        const line = L.polyline(points, { color: '#00d4ff', weight: 3 }).addTo(map);
        L.circleMarker(points[0], { radius: 5, color: '#00ff88', fillOpacity: 1 }).addTo(map);
        L.circleMarker(points[points.length - 1], { radius: 5, color: '#ff5566', fillOpacity: 1 }).addTo(map);
        map.fitBounds(line.getBounds(), { padding: [12, 12] });
        return () => { map.remove(); mapRef.current = null; };
    }, [points]);

    return <Box ref={containerRef} sx={{ height: 160, borderRadius: 1.5, mt: 0.5, mx: 3, overflow: 'hidden' }} />;
}

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

export default function TripsTab({ base, states, setState }) {
    const [expandedDay, setExpandedDay] = useState(null);

    const dailyKm = useMemo(() => {
        const raw = val(states, `${base}.trips.daily_km_json`, '[]');
        try { return JSON.parse(raw); } catch { return []; }
    }, [states, base]);

    const tripHistory = useMemo(() => {
        const raw = val(states, `${base}.trips.history_json`, '[]');
        try { return JSON.parse(raw); } catch { return []; }
    }, [states, base]);

    const tripRoutes = useMemo(() => {
        const raw = val(states, `${base}.trips.routes_json`, '{}');
        try { return JSON.parse(raw); } catch { return {}; }
    }, [states, base]);

    const lastMergeStartMs = val(states, `${base}.trips.last_merge_startms`, 0);

    const todayKm = val(states, `${base}.trips.today_km`, 0);
    const currentTripActive = val(states, `${base}.trips.current_trip_active`, false);

    // Group individual trips by day
    const tripsByDay = useMemo(() => {
        const map = {};
        tripHistory.forEach((t) => {
            if (!map[t.date]) map[t.date] = [];
            map[t.date].push(t);
        });
        return map;
    }, [tripHistory]);

    // Combine daily totals with their individual trips, calculate the difference
    // as "Other" (untracked km, e.g. short trips between two 5-minute polls
    // that our detection missed).
    const days = useMemo(() => {
        const result = dailyKm.map((d) => {
            const trips = (tripsByDay[d.date] || []).slice().sort((a, b) => b.startTime.localeCompare(a.startTime));
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
        <Box>
            <ExportPanel base={base} states={states} />
            {/* Overview at the top */}
            <Card sx={{ mb: 2, bgcolor: '#0d1520', border: '1px solid #1e2d45' }}>
                <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
                    <SectionLabel>{I18n.t('TRIP OVERVIEW')}</SectionLabel>
                    <Box sx={{ display: 'flex', gap: 2 }}>
                        <Box sx={{ flex: 1, textAlign: 'center' }}>
                            <Typography sx={{ fontSize: '1.6rem', fontWeight: 800, color: '#00d4ff' }}>
                                {todayKm} km
                            </Typography>
                            <Typography variant="caption" sx={{ color: '#5a7090' }}>{I18n.t('Today')}</Typography>
                        </Box>
                        <Divider orientation="vertical" flexItem sx={{ borderColor: '#1e2d45' }} />
                        <Box sx={{ flex: 1, textAlign: 'center' }}>
                            <Typography sx={{ fontSize: '1.6rem', fontWeight: 800, color: '#00ff88' }}>
                                {weekTotal} km
                            </Typography>
                            <Typography variant="caption" sx={{ color: '#5a7090' }}>{I18n.t('Last 7 days')}</Typography>
                        </Box>
                    </Box>
                    {currentTripActive && (
                        <Chip
                            icon={<DirectionsCarIcon sx={{ fontSize: 16 }} />}
                            label={I18n.t('Trip in progress')}
                            size="small"
                            sx={{ mt: 1.5, bgcolor: '#00d4ff22', color: '#00d4ff', border: '1px solid #00d4ff55' }}
                        />
                    )}
                </CardContent>
            </Card>

            {/* Daily list */}
            {days.length === 0 ? (
                <Typography sx={{ color: '#5a7090', textAlign: 'center', mt: 4 }}>
                    {I18n.t('No trip data recorded yet.')}
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
                                            {day.trips.length} {day.trips.length === 1 ? I18n.t('trip detected') : I18n.t('trips detected')}
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
                                            const startClock = (trip.startTime.split(', ')[1] || trip.startTime).slice(0, 5);
                                            const endClock = (trip.endTime.split(', ')[1] || trip.endTime).slice(0, 5);
                                            const prevTrip = i < day.trips.length - 1 ? day.trips[i + 1] : null;
                                            const gapMin = (prevTrip && trip.startTimeMs && prevTrip.endTimeMs)
                                                ? Math.round((trip.startTimeMs - prevTrip.endTimeMs) / 60000) : null;
                                            const canMerge = gapMin != null && gapMin >= 0 && gapMin <= 15;
                                            const canUndo = !!lastMergeStartMs && trip.startTimeMs === lastMergeStartMs;
                                            return (
                                                <Box
                                                    key={i}
                                                    sx={{
                                                        bgcolor: '#070d1a', borderRadius: 1.5, px: 1.5, py: 1,
                                                        border: '1px solid #1e2d4555',
                                                        display: 'flex', flexDirection: 'column', gap: 0.5,
                                                    }}
                                                >
                                                    {canUndo && (
                                                        <Box
                                                            sx={{
                                                                display: 'flex', alignItems: 'center', gap: 0.5,
                                                                cursor: 'pointer', color: '#5a7090', mb: 0.5,
                                                                '&:hover': { color: '#00d4ff' },
                                                            }}
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                setState(`${base}.cmd.trips_merge_undo`, true);
                                                            }}
                                                        >
                                                            <UndoIcon sx={{ fontSize: 14 }} />
                                                            <Typography variant="caption" sx={{ fontSize: '0.7rem' }}>
                                                                {I18n.t('Undo last merge')}
                                                            </Typography>
                                                        </Box>
                                                    )}
                                                    {!canUndo && canMerge && (
                                                        <Box
                                                            sx={{
                                                                display: 'flex', alignItems: 'center', gap: 0.5,
                                                                cursor: 'pointer', color: '#5a7090', mb: 0.5,
                                                                '&:hover': { color: '#00d4ff' },
                                                            }}
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                setState(`${base}.cmd.trips_merge`, String(trip.startTimeMs));
                                                            }}
                                                        >
                                                            <MergeTypeIcon sx={{ fontSize: 14 }} />
                                                            <Typography variant="caption" sx={{ fontSize: '0.7rem' }}>
                                                                {I18n.t('Merge with previous trip')} ({gapMin} min {I18n.t('gap')})
                                                            </Typography>
                                                        </Box>
                                                    )}
                                                    <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
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
                                                                    -{trip.socUsed}% {I18n.t('battery')}
                                                                </Typography>
                                                            )}
                                                            <Typography variant="caption" sx={{ color: '#00ff88', fontWeight: 700 }}>
                                                                {trip.km} km
                                                            </Typography>
                                                        </Box>
                                                    </Box>
                                                    {(trip.tempMinC != null || trip.elevGainM != null || trip.regenKwh != null) && (
                                                        <Box sx={{ display: 'flex', gap: 1.5, pl: 3 }}>
                                                            {trip.tempMinC != null && (
                                                                <Typography variant="caption" sx={{ color: '#5a7090', fontSize: '0.7rem' }}>
                                                                    🌡️ {trip.tempMinC === trip.tempMaxC ? `${trip.tempMinC}°C` : `${trip.tempMinC}–${trip.tempMaxC}°C`}
                                                                </Typography>
                                                            )}
                                                            {trip.elevGainM != null && trip.elevGainM !== 0 && (
                                                                <Typography variant="caption" sx={{ color: '#5a7090', fontSize: '0.7rem' }}>
                                                                    {trip.elevGainM > 0 ? '⬆️' : '⬇️'} {Math.abs(trip.elevGainM)} m
                                                                </Typography>
                                                            )}
                                                            {trip.regenKwh != null && (
                                                                <Typography variant="caption" sx={{ color: '#00ff88', fontSize: '0.7rem' }}>
                                                                    ♻️ {trip.regenKwh} kWh {I18n.t('regen')}
                                                                </Typography>
                                                            )}
                                                        </Box>
                                                    )}
                                                    {trip.energyOfficial && (
                                                        <Box sx={{ display: 'flex', gap: 1.5, pl: 3 }}>
                                                            <Typography variant="caption" sx={{ color: '#3a5070', fontSize: '0.7rem' }}>
                                                                🔋 {I18n.t('Official energy split')}:
                                                            </Typography>
                                                            <Typography variant="caption" sx={{ color: '#00d4ff', fontSize: '0.7rem' }}>
                                                                {I18n.t('Driving')} {trip.energyDrivingKwh} kWh
                                                            </Typography>
                                                            <Typography variant="caption" sx={{ color: '#a090ff', fontSize: '0.7rem' }}>
                                                                {I18n.t('Climate')} {trip.energyAcKwh} kWh
                                                            </Typography>
                                                            <Typography variant="caption" sx={{ color: '#5a7090', fontSize: '0.7rem' }}>
                                                                {I18n.t('Other')} {trip.energyOtherKwh} kWh
                                                            </Typography>
                                                        </Box>
                                                    )}
                                                    {trip.energyPending && (
                                                        <Typography variant="caption" sx={{ color: '#5a7090', fontSize: '0.7rem', pl: 3, fontStyle: 'italic' }}>
                                                            ⏳ {I18n.t('Official energy data not yet available from the cloud')}
                                                        </Typography>
                                                    )}
                                                    {trip.energyUnavailable && (
                                                        <Typography variant="caption" sx={{ color: '#5a7090', fontSize: '0.7rem', pl: 3, fontStyle: 'italic' }}>
                                                            ⚠️ {I18n.t('Official energy data unavailable for this trip')}
                                                        </Typography>
                                                    )}
                                                    {tripRoutes[trip.startTimeMs] && (
                                                        <RouteMap points={tripRoutes[trip.startTimeMs]} />
                                                    )}
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
                                                        {I18n.t('Other (untracked trips)')}
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
                {I18n.t('Trips are detected every 5 minutes based on speed. Very short trips between two polls may show up as "Other" instead of being recorded as an individual trip.')}
            </Typography>
        </Box>
    );
}
