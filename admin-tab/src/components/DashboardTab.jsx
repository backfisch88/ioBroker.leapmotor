import React, { useState, useEffect, useRef, useCallback } from 'react';
import { hasCapability } from '../vehicleCapabilities';
import {
    Grid, Card, CardContent, Typography, Box, Button,
    Slider, IconButton, Chip, LinearProgress,
} from '@mui/material';
import BatteryFullIcon from '@mui/icons-material/BatteryFull';
import LockIcon from '@mui/icons-material/Lock';
import LockOpenIcon from '@mui/icons-material/LockOpen';
import AcUnitIcon from '@mui/icons-material/AcUnit';
import WhatshotIcon from '@mui/icons-material/Whatshot';
import AirIcon from '@mui/icons-material/Air';
import PowerOffIcon from '@mui/icons-material/PowerOff';
import RefreshIcon from '@mui/icons-material/Refresh';
import RemoveIcon from '@mui/icons-material/Remove';
import AddIcon from '@mui/icons-material/Add';
import AcUnitOutlinedIcon from '@mui/icons-material/AcUnitOutlined';
import DirectionsCarIcon from '@mui/icons-material/DirectionsCar';
import LocationSearchingIcon from '@mui/icons-material/LocationSearching';
import WifiIcon from '@mui/icons-material/Wifi';
import WifiOffIcon from '@mui/icons-material/WifiOff';
import BlindsIcon from '@mui/icons-material/Blinds';
import BlindsClosedIcon from '@mui/icons-material/BlindsClosed';
import VerticalAlignTopIcon from '@mui/icons-material/VerticalAlignTop';
import VerticalAlignBottomIcon from '@mui/icons-material/VerticalAlignBottom';

import VehicleImage from './VehicleImage';

function val(states, id, def = null) {
    return states[id]?.val ?? def;
}

// Hook: optimistischer Button-Zustand. Setzt sofort `active`, sendet den
// Befehl, und faellt nach delayMs automatisch zurueck, falls der echte
// Status (von `actualActive`) nicht nachzieht (= Befehl fehlgeschlagen).
function useOptimistic(actualActive, delayMs = 6000) {
    const [optimistic, setOptimistic] = useState(null);
    const timeoutRef = useRef(null);

    useEffect(() => {
        // Wenn der echte Status den optimistischen erreicht hat, optimistic loeschen
        if (optimistic !== null && actualActive === optimistic) {
            setOptimistic(null);
            if (timeoutRef.current) clearTimeout(timeoutRef.current);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [actualActive]);

    const trigger = useCallback((value) => {
        setOptimistic(value);
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
        timeoutRef.current = setTimeout(() => setOptimistic(null), delayMs);
    }, [delayMs]);

    useEffect(() => () => { if (timeoutRef.current) clearTimeout(timeoutRef.current); }, []);

    return [optimistic !== null ? optimistic : actualActive, trigger];
}

function StatTile({ label, value, color }) {
    return (
        <Card variant="outlined" sx={{
            borderColor: '#1e2d45', bgcolor: '#0d1520', textAlign: 'center',
            height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'center',
        }}>
            <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
                <Typography variant="caption" sx={{ color: '#3a5070', letterSpacing: '0.1em', display: 'block' }}>{label}</Typography>
                <Typography variant="h6" sx={{ fontWeight: 800, color: color || '#c8ddf0', whiteSpace: 'nowrap' }}>{value}</Typography>
            </CardContent>
        </Card>
    );
}

function ToggleButton({ active, color, icon, label, onClick }) {
    return (
        <Button
            onClick={onClick}
            startIcon={icon}
            size="small"
            sx={{
                flex: 1,
                py: 0.7,
                px: 0.5,
                minWidth: 0,
                fontSize: '0.72rem',
                color: active ? '#070d1a' : color,
                bgcolor: active ? color : 'transparent',
                border: `2px solid ${active ? color : '#1e2d45'}`,
                fontWeight: active ? 800 : 500,
                transition: 'background-color 0.15s, color 0.15s',
                '& .MuiButton-startIcon': { mr: 0.3 },
                '&:hover': { bgcolor: active ? color : `${color}22` },
            }}
        >
            {label}
        </Button>
    );
}

function SectionLabel({ children }) {
    return (
        <Typography variant="caption" sx={{ color: '#3a5070', letterSpacing: '0.1em', display: 'block', mb: 1 }}>
            {children}
        </Typography>
    );
}

function SliderControl({ icon, iconActive, label, value, max, displaySuffix, onCommit, openValue, color = '#00d4ff' }) {
    const [local, setLocal] = useState(value);
    useEffect(() => { setLocal(value); }, [value]);

    return (
        <Box sx={{ mt: 2 }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 0.5 }}>
                <Typography variant="caption" sx={{ color: '#5a7090', display: 'flex', alignItems: 'center', gap: 0.5 }}>
                    {local > 0 ? iconActive : icon}
                    {label}
                </Typography>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Typography variant="caption" sx={{ color, fontWeight: 700 }}>{local}{displaySuffix}</Typography>
                </Box>
            </Box>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                <Button size="small" onClick={() => { setLocal(0); onCommit(0); }}
                    sx={{ minWidth: 0, px: 1, border: '1px solid #1e2d45', color: local === 0 ? color : undefined }}>
                    Zu
                </Button>
                <Slider
                    value={local}
                    min={0}
                    max={max}
                    step={max <= 10 ? 1 : 10}
                    onChange={(_, v) => setLocal(v)}
                    onChangeCommitted={(_, v) => onCommit(v)}
                    sx={{ color }}
                />
                <Button size="small" onClick={() => { setLocal(openValue); onCommit(openValue); }}
                    sx={{ minWidth: 0, px: 1, border: '1px solid #1e2d45', color: local === openValue ? color : undefined }}>
                    Auf
                </Button>
            </Box>
        </Box>
    );
}

export default function DashboardTab({ base, states, setState }) {
    const soc = val(states, `${base}.status.battery_soc`, 0);
    const socColor = soc > 50 ? '#00ff88' : soc > 20 ? '#ffcc00' : '#ff4444';
    const range = val(states, `${base}.status.range_km`, 0);
    const outdoor = val(states, `${base}.status.temp_outdoor`, '—');
    const parked = val(states, `${base}.status.drive_parked`, true);
    const speed = val(states, `${base}.status.drive_speed`, 0);
    const lockedActual = val(states, `${base}.status.security_locked`, false);
    const charging = val(states, `${base}.status.charging_active`, false);
    const remainMin = val(states, `${base}.status.charging_remain_min`, 0);
    const acOnActual = val(states, `${base}.status.ac_on`, false);
    const carType = val(states, `${base}.info.model`, '');
    const can = (feature) => hasCapability(carType, feature);
    const acTemp = val(states, `${base}.status.ac_temp`, 22);
    const fanSpeed = val(states, `${base}.status.ac_fan_speed`, 3);
    const acPosition = val(states, `${base}.cmd.ac_position`, 'all');
    const chargeLimit = val(states, `${base}.status.charging_soc_limit`, 80);
    const scheduleEnabledActual = val(states, `${base}.cmd.charge_schedule_enable`, false);
    const scheduleStartActual = val(states, `${base}.cmd.charge_schedule_start`, '00:00');
    const scheduleEndActual = val(states, `${base}.cmd.charge_schedule_end`, '08:00');
    const [scheduleEnabled, setScheduleEnabled] = useState(scheduleEnabledActual);
    const [scheduleStart, setScheduleStart] = useState(scheduleStartActual);
    const [scheduleEnd, setScheduleEnd] = useState(scheduleEndActual);
    useEffect(() => { setScheduleEnabled(scheduleEnabledActual); }, [scheduleEnabledActual]);
    useEffect(() => { setScheduleStart(scheduleStartActual); }, [scheduleStartActual]);
    useEffect(() => { setScheduleEnd(scheduleEndActual); }, [scheduleEndActual]);
    const climateScheduleActive = val(states, `${base}.status.climate_schedule_active`, false);
    const climateScheduleInfo = val(states, `${base}.status.climate_schedule_info`, '');
    const climateScheduleEnabledActual = val(states, `${base}.cmd.climate_schedule_enable`, false);
    const climateScheduleTimeActual = val(states, `${base}.cmd.climate_schedule_time`, '07:00');
    const climateScheduleModeActual = val(states, `${base}.cmd.climate_schedule_mode`, 'hot');
    const climateScheduleDaysActual = val(states, `${base}.cmd.climate_schedule_days`, '0,1,2,3,4,5,6');
    const [climateScheduleEnabled, setClimateScheduleEnabled] = useState(climateScheduleEnabledActual);
    const [climateScheduleTime, setClimateScheduleTime] = useState(climateScheduleTimeActual);
    const [climateScheduleMode, setClimateScheduleMode] = useState(climateScheduleModeActual);
    const [climateScheduleDays, setClimateScheduleDays] = useState(
        String(climateScheduleDaysActual).split(',').map(Number).filter(n => !isNaN(n))
    );
    useEffect(() => { setClimateScheduleEnabled(climateScheduleEnabledActual); }, [climateScheduleEnabledActual]);
    useEffect(() => { setClimateScheduleTime(climateScheduleTimeActual); }, [climateScheduleTimeActual]);
    useEffect(() => { setClimateScheduleMode(climateScheduleModeActual); }, [climateScheduleModeActual]);
    useEffect(() => { setClimateScheduleDays(String(climateScheduleDaysActual).split(',').map(Number).filter(n => !isNaN(n))); }, [climateScheduleDaysActual]);
    const acMode = val(states, `${base}.status.ac_cooling_heating`, null);
    const doorTrunkActual = val(states, `${base}.status.door_trunk`, false);
    const doorOpen = ['door_driver', 'door_front_right', 'door_rear_left', 'door_rear_right', 'door_trunk']
        .some(k => val(states, `${base}.status.${k}`, false));
    const windowFL = val(states, `${base}.status.window_fl_pct`, 0);
    const sunShade = val(states, `${base}.status.sun_shade`, 0);
    const hotspotOnActual = val(states, `${base}.status.hotspot_on`, false);
    const ptcStateActual = val(states, `${base}.status.ptc_state`, 2) !== 2;
    const defrostLevel = val(states, `${base}.cmd.defrost_level`, 1);

    const send = (cmd) => setState(`${base}.cmd.${cmd}`, true);
    const setTemp = (t) => setState(`${base}.cmd.ac_temp`, t);

    // Optimistische Zustaende mit automatischem Rollback nach 6s falls API-Aufruf scheitert
    const [locked, triggerLocked] = useOptimistic(lockedActual);
    const [acOn, triggerAcOn] = useOptimistic(acOnActual);
    const [doorTrunk, triggerDoorTrunk] = useOptimistic(doorTrunkActual);
    const [hotspotOn, triggerHotspot] = useOptimistic(hotspotOnActual);
    const [ptcState, triggerPtc] = useOptimistic(ptcStateActual);

    const [acModeLocal, setAcModeLocal] = useState(null);
    const [quickActive, setQuickActive] = useState(null);
    useEffect(() => {
        if (acModeLocal !== null && acOnActual === (acModeLocal !== 'off') && acMode === acModeLocal) {
            setAcModeLocal(null);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [acMode, acOnActual]);

    const isHeat = acModeLocal !== null ? acModeLocal === 'heat' : (acOn && acMode === 2);
    const isCool = acModeLocal !== null ? acModeLocal === 'cool' : (acOn && acMode === 1);
    const isVent = acModeLocal !== null ? acModeLocal === 'vent' : (acOn && acMode === 0);
    const isOff = acModeLocal !== null ? acModeLocal === 'off' : !acOn;

    const sendClimate = (mode, cmd) => {
        setAcModeLocal(mode);
        setQuickActive(null);
        triggerAcOn(mode !== 'off');
        send(cmd);
        setTimeout(() => { setAcModeLocal(null); }, 6000);
    };

    const sendQuick = (mode, cmd) => {
        setAcModeLocal(mode);
        setQuickActive(cmd);
        triggerAcOn(true);
        send(cmd);
        setTimeout(() => { setAcModeLocal(null); setQuickActive(null); }, 6000);
    };

    // Temperatur aendern -> nach 2s den aktuellen Modus erneut senden, damit
    // die neue Temperatur tatsaechlich uebernommen wird (API braucht Modus+Temp zusammen)
    const tempResendTimer = useRef(null);
    const onTempCommit = (t) => {
        setTemp(t);
        if (tempResendTimer.current) clearTimeout(tempResendTimer.current);
        tempResendTimer.current = setTimeout(() => {
            if (isHeat) send('ac_heat');
            else if (isCool) send('ac_cool');
            else if (isVent) send('ac_vent');
        }, 2000);
    };

    const fanResendTimer = useRef(null);
    const onFanCommit = (f) => {
        setState(`${base}.cmd.ac_fan_speed`, f);
        if (fanResendTimer.current) clearTimeout(fanResendTimer.current);
        fanResendTimer.current = setTimeout(() => {
            if (isHeat) send('ac_heat');
            else if (isCool) send('ac_cool');
            else if (isVent) send('ac_vent');
        }, 2000);
    };

    return (
        <Box>
            <VehicleImage base={base} states={states} />

            <Card sx={{ mb: 2, bgcolor: '#0d1520', border: '1px solid #1e2d45' }}>
                <CardContent>
                    <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1, flexWrap: 'wrap', gap: 1 }}>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                            <BatteryFullIcon sx={{ color: socColor }} />
                            <Typography variant="h5" sx={{ fontWeight: 800, color: socColor }}>{soc}%</Typography>
                        </Box>
                        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                            {locked && <Chip size="small" label="GESPERRT" sx={{ bgcolor: '#00d4ff22', color: '#00d4ff' }} />}
                            {charging && <Chip size="small" label="LÄDT" sx={{ bgcolor: '#00ff8822', color: '#00ff88' }} />}
                            {acOn && <Chip size="small" label="KLIMA" sx={{ bgcolor: '#7c6aff22', color: '#a090ff' }} />}
                            {doorOpen && <Chip size="small" label="TÜR OFFEN" sx={{ bgcolor: '#ff990022', color: '#ff9900' }} />}
                        </Box>
                    </Box>
                    <LinearProgress variant="determinate" value={soc} sx={{
                        height: 6, borderRadius: 3, bgcolor: '#1e2d45',
                        '& .MuiLinearProgress-bar': { bgcolor: socColor },
                    }} />
                </CardContent>
            </Card>

            <Grid container spacing={1.5} sx={{ mb: 2 }}>
                <Grid item xs={4}><StatTile label="AUSSEN" value={`${outdoor}°C`} /></Grid>
                <Grid item xs={4}><StatTile label="REICHWEITE" value={`${range} km`} color="#00d4ff" /></Grid>
                <Grid item xs={4}>
                    <StatTile label="STATUS" value={parked ? '🅿 Parked' : `▶ ${speed} km/h`} color={parked ? '#00ff88' : '#ffcc00'} />
                </Grid>
                <Grid item xs={4}>
                    <StatTile label="LADEN" value={charging ? `⚡ ${remainMin} min` : '— —'} color={charging ? '#00ff88' : undefined} />
                </Grid>
                <Grid item xs={4}>
                    <StatTile label="TÜREN" value={doorOpen ? '🚪 Offen' : '✓ Zu'} color={doorOpen ? '#ff4444' : '#00ff88'} />
                </Grid>
                <Grid item xs={4}>
                    <StatTile label="SCHLOSS" value={locked ? '🔒 Zu' : '🔓 Offen'} color={locked ? '#00d4ff' : '#ff4444'} />
                </Grid>
            </Grid>

            {/* Klimaanlage */}
            <Card sx={{ mb: 2, bgcolor: '#0d1520', border: '1px solid #1e2d45' }}>
                <CardContent>
                    <SectionLabel>KLIMAANLAGE</SectionLabel>
                    <Box sx={{ display: 'flex', gap: 1, mt: 1, mb: 2, flexWrap: 'wrap' }}>
                        <ToggleButton active={isHeat} color="#ff6644" icon={<WhatshotIcon />} label="Heizen" onClick={() => sendClimate('heat', 'ac_heat')} />
                        <ToggleButton active={isCool} color="#00d4ff" icon={<AcUnitIcon />} label="Kühlen" onClick={() => sendClimate('cool', 'ac_cool')} />
                        <ToggleButton active={isVent} color="#a090ff" icon={<AirIcon />} label="Lüften" onClick={() => sendClimate('vent', 'ac_vent')} />
                        <ToggleButton active={isOff} color="#ff4444" icon={<PowerOffIcon />} label="Aus" onClick={() => sendClimate('off', 'ac_off')} />
                    </Box>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 2 }}>
                        <IconButton size="small" onClick={() => onTempCommit(Math.max(16, acTemp - 1))} sx={{ border: '1px solid #1e2d45' }}><RemoveIcon /></IconButton>
                        <Typography sx={{ minWidth: 60, textAlign: 'center', fontWeight: 800, color: '#00d4ff', fontSize: '1.3rem' }}>{acTemp}°C</Typography>
                        <IconButton size="small" onClick={() => onTempCommit(Math.min(30, acTemp + 1))} sx={{ border: '1px solid #1e2d45' }}><AddIcon /></IconButton>
                        <TempSlider value={acTemp} onCommit={onTempCommit} />
                    </Box>
                    <Box sx={{ mb: 2 }}>
                        <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5 }}>
                            <Typography variant="caption" sx={{ color: '#5a7090', display: 'flex', alignItems: 'center', gap: 0.5 }}>
                                <AirIcon sx={{ fontSize: 14 }} /> Lüfterstufe
                            </Typography>
                            <Typography variant="caption" sx={{ color: '#00d4ff', fontWeight: 700 }}>{fanSpeed}/7</Typography>
                        </Box>
                        <FanSlider value={fanSpeed} onCommit={onFanCommit} />
                    </Box>
                    <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
                        {can('defrost') && (
                        <Button size="small" startIcon={<AcUnitOutlinedIcon />} onClick={() => send('defrost')}
                            sx={{ border: '1px solid #1e2d45' }}>
                            Frontscheibe Defrost (volle Heizung)
                        </Button>
                        )}
                        {can('batteryPreheat') && (
                        <Button size="small" startIcon={<BatteryFullIcon />}
                            onClick={() => { triggerPtc(!ptcState); send(ptcState ? 'battery_preheat_off' : 'battery_preheat'); }}
                            sx={{ border: '1px solid #1e2d45', color: ptcState ? '#ff9900' : undefined }}>
                            {ptcState ? 'Batterievorheizung aus' : 'Batterie vorheizen'}
                        </Button>
                        )}
                        <Button size="small" startIcon={<AcUnitIcon />} onClick={() => sendQuick('cool', 'quick_cool')}
                            sx={{ border: `1px solid ${quickActive === 'quick_cool' ? '#00d4ff' : '#1e2d45'}`, color: quickActive === 'quick_cool' ? '#070d1a' : undefined, bgcolor: quickActive === 'quick_cool' ? '#00d4ff' : 'transparent' }}>
                            Schnelles Kühlen
                        </Button>
                        <Button size="small" startIcon={<WhatshotIcon />} onClick={() => sendQuick('heat', 'quick_heat')}
                            sx={{ border: `1px solid ${quickActive === 'quick_heat' ? '#ff6644' : '#1e2d45'}`, color: quickActive === 'quick_heat' ? '#070d1a' : undefined, bgcolor: quickActive === 'quick_heat' ? '#ff6644' : 'transparent' }}>
                            Schnelles Heizen
                        </Button>
                    </Box>
                </CardContent>
            </Card>

            {/* Laden */}
            <Card sx={{ mb: 2, bgcolor: '#0d1520', border: '1px solid #1e2d45' }}>
                <CardContent>
                    <SectionLabel>LADEN</SectionLabel>
                    <ChargeLimitSlider value={chargeLimit} onCommit={(v) => setState(`${base}.cmd.charge_limit_set`, v)} />
                    <Box sx={{ mt: 3 }}>
                        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1.5 }}>
                            <Typography variant="caption" sx={{ color: '#5a7090' }}>Ladezeitplan</Typography>
                            <Button
                                size="small"
                                onClick={() => { setScheduleEnabled(!scheduleEnabled); setState(`${base}.cmd.charge_schedule_enable`, !scheduleEnabled); }}
                                sx={{
                                    minWidth: 0, px: 1.5,
                                    border: '1px solid #1e2d45',
                                    color: scheduleEnabled ? '#070d1a' : '#5a7090',
                                    bgcolor: scheduleEnabled ? '#00ff88' : 'transparent',
                                }}>
                                {scheduleEnabled ? 'Aktiv' : 'Inaktiv'}
                            </Button>
                        </Box>
                        <Box sx={{ display: 'flex', gap: 1.5, mb: 1.5 }}>
                            <Box sx={{ flex: 1 }}>
                                <Typography variant="caption" sx={{ color: '#5a7090', display: 'block', mb: 0.5 }}>Start</Typography>
                                <input
                                    type="time"
                                    value={scheduleStart}
                                    onChange={(e) => { setScheduleStart(e.target.value); setState(`${base}.cmd.charge_schedule_start`, e.target.value); }}
                                    style={{
                                        width: '100%', padding: '8px', borderRadius: 6,
                                        border: '1px solid #1e2d45', background: '#070d1a', color: '#c8ddf0',
                                        fontSize: '0.95rem', colorScheme: 'dark',
                                    }}
                                />
                            </Box>
                            <Box sx={{ flex: 1 }}>
                                <Typography variant="caption" sx={{ color: '#5a7090', display: 'block', mb: 0.5 }}>Ende</Typography>
                                <input
                                    type="time"
                                    value={scheduleEnd}
                                    onChange={(e) => { setScheduleEnd(e.target.value); setState(`${base}.cmd.charge_schedule_end`, e.target.value); }}
                                    style={{
                                        width: '100%', padding: '8px', borderRadius: 6,
                                        border: '1px solid #1e2d45', background: '#070d1a', color: '#c8ddf0',
                                        fontSize: '0.95rem', colorScheme: 'dark',
                                    }}
                                />
                            </Box>
                        </Box>
                        <Button fullWidth onClick={() => send('charge_schedule_apply')} sx={{ border: '1px solid #00d4ff55', color: '#00d4ff' }}>
                            Zeitplan anwenden
                        </Button>
                    </Box>
                </CardContent>
            </Card>

            {/* Klima-Zeitplan */}
            <Card sx={{ mb: 2, bgcolor: '#0d1520', border: '1px solid #1e2d45' }}>
                <CardContent>
                    <SectionLabel>KLIMA-ZEITPLAN</SectionLabel>

                    {/* Status aktueller Zeitplan */}
                    <Box sx={{ mb: 2, p: 1, bgcolor: climateScheduleActive ? '#00d4ff11' : '#1e2d45', borderRadius: 1, border: `1px solid ${climateScheduleActive ? '#00d4ff33' : '#1e2d45'}` }}>
                        <Typography variant="caption" sx={{ color: climateScheduleActive ? '#00d4ff' : '#5a7090' }}>
                            {climateScheduleActive
                                ? `⏰ Aktiver Zeitplan: ${climateScheduleInfo}`
                                : climateScheduleInfo
                                    ? `○ Inaktiv (zuletzt: ${climateScheduleInfo})`
                                    : '○ Kein Zeitplan gesetzt'}
                        </Typography>
                    </Box>

                    {/* Aktiv/Inaktiv */}
                    <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1.5 }}>
                        <Typography variant="caption" sx={{ color: '#5a7090' }}>Klimazeitplan</Typography>
                        <Button size="small"
                            onClick={() => {
                                const next = !climateScheduleEnabled;
                                setClimateScheduleEnabled(next);
                                setState(`${base}.cmd.climate_schedule_enable`, next);
                                setState(`${base}.status.climate_schedule_active`, next);
                            }}
                            sx={{ minWidth: 0, px: 1.5, border: '1px solid #1e2d45', color: climateScheduleEnabled ? '#070d1a' : '#5a7090', bgcolor: climateScheduleEnabled ? '#00d4ff' : 'transparent' }}>
                            {climateScheduleEnabled ? 'Aktiv' : 'Inaktiv'}
                        </Button>
                    </Box>

                    {/* Modus */}
                    <Box sx={{ mb: 1.5 }}>
                        <Typography variant="caption" sx={{ color: '#5a7090', display: 'block', mb: 0.5 }}>Modus</Typography>
                        <Box sx={{ display: 'flex', gap: 0.5 }}>
                            {[{v:'hot',l:'🔥 Heizen',c:'#ff6b35'},{v:'cold',l:'❄️ Kühlen',c:'#00d4ff'},{v:'wind',l:'💨 Lüften',c:'#00ff88'}].map(({v,l,c})=>(
                                <Button key={v} size="small"
                                    onClick={() => { setClimateScheduleMode(v); setState(`${base}.cmd.climate_schedule_mode`, v); }}
                                    sx={{ flex:1, minWidth:0, px:0.5, border:'1px solid #1e2d45', color: climateScheduleMode===v ? '#070d1a' : '#5a7090', bgcolor: climateScheduleMode===v ? c : 'transparent', fontSize:'0.7rem' }}>
                                    {l}
                                </Button>
                            ))}
                        </Box>
                    </Box>

                    {/* Zeit */}
                    <Box sx={{ mb: 1.5 }}>
                        <Typography variant="caption" sx={{ color: '#5a7090', display: 'block', mb: 0.5 }}>Startzeit</Typography>
                        <input type="time" value={climateScheduleTime}
                            onChange={(e) => { setClimateScheduleTime(e.target.value); setState(`${base}.cmd.climate_schedule_time`, e.target.value); }}
                            style={{ width:'100%', padding:'8px', borderRadius:6, border:'1px solid #1e2d45', background:'#070d1a', color:'#c8ddf0', fontSize:'0.95rem', colorScheme:'dark' }}
                        />
                    </Box>

                    {/* Wochentage */}
                    <Box sx={{ mb: 1.5 }}>
                        <Typography variant="caption" sx={{ color: '#5a7090', display: 'block', mb: 0.5 }}>Wiederholen</Typography>
                        <Box sx={{ display: 'flex', gap: 0.5 }}>
                            {[{d:1,l:'Mo'},{d:2,l:'Di'},{d:3,l:'Mi'},{d:4,l:'Do'},{d:5,l:'Fr'},{d:6,l:'Sa'},{d:0,l:'So'}].map(({d,l})=>{
                                const sel = climateScheduleDays.includes(d);
                                return (
                                    <Button key={d} size="small"
                                        onClick={() => {
                                            const next = sel ? climateScheduleDays.filter(x=>x!==d) : [...climateScheduleDays, d];
                                            setClimateScheduleDays(next);
                                            setState(`${base}.cmd.climate_schedule_days`, next.join(','));
                                        }}
                                        sx={{ minWidth:0, flex:1, px:0, border:'1px solid #1e2d45', color: sel ? '#070d1a' : '#5a7090', bgcolor: sel ? '#00d4ff' : 'transparent', fontSize:'0.65rem' }}>
                                        {l}
                                    </Button>
                                );
                            })}
                        </Box>
                    </Box>

                    {/* Buttons */}
                    <Box sx={{ display: 'flex', gap: 1 }}>
                        <Button fullWidth onClick={() => { send('climate_schedule_apply'); setTimeout(() => send('refresh'), 3000); }} sx={{ border: '1px solid #00d4ff55', color: '#00d4ff' }}>
                            Zeitplan anwenden
                        </Button>
                        <Button onClick={() => { send('climate_schedule_cancel'); setTimeout(() => send('refresh'), 3000); }} sx={{ border: '1px solid #ff444455', color: '#ff4444', minWidth: 0, px: 1.5 }}>
                            Löschen
                        </Button>
                    </Box>
                </CardContent>
            </Card>

            {/* Türen, Kofferraum, Fenster, Sonnenblende */}
            <Card sx={{ mb: 2, bgcolor: '#0d1520', border: '1px solid #1e2d45' }}>
                <CardContent>
                    <SectionLabel>VERRIEGELUNG & ÖFFNUNGEN</SectionLabel>
                    <Grid container spacing={1}>
                        <Grid item xs={6} sm={4}>
                            <Button fullWidth startIcon={<LockIcon />} onClick={() => { triggerLocked(true); send('lock'); }}
                                sx={{ color: locked ? '#070d1a' : '#00d4ff', bgcolor: locked ? '#00d4ff' : 'transparent', border: '1px solid #1e2d45', transition: 'background-color 0.15s' }}>
                                Sperren
                            </Button>
                        </Grid>
                        <Grid item xs={6} sm={4}>
                            <Button fullWidth startIcon={<LockOpenIcon />} onClick={() => { triggerLocked(false); send('unlock'); }}
                                sx={{ color: !locked ? '#070d1a' : '#ff9900', bgcolor: !locked ? '#ff9900' : 'transparent', border: '1px solid #1e2d45', transition: 'background-color 0.15s' }}>
                                Öffnen
                            </Button>
                        </Grid>
                        <Grid item xs={6} sm={4}>
                            <Button fullWidth startIcon={<DirectionsCarIcon />}
                                onClick={() => { triggerDoorTrunk(!doorTrunk); send(doorTrunk ? 'trunk_close' : 'trunk_open'); }}
                                sx={{ border: '1px solid #1e2d45' }}>
                                Kofferraum {doorTrunk ? 'schließen' : 'öffnen'}
                            </Button>
                        </Grid>
                        <Grid item xs={6} sm={4}>
                            <Button fullWidth startIcon={<LocationSearchingIcon />} onClick={() => send('find')} sx={{ border: '1px solid #1e2d45' }}>
                                Fahrzeug orten
                            </Button>
                        </Grid>
                    </Grid>

                    <SliderControl
                        icon={<BlindsClosedIcon sx={{ fontSize: 14 }} />}
                        iconActive={<BlindsIcon sx={{ fontSize: 14 }} />}
                        label="Fenster"
                        value={windowFL}
                        max={100}
                        displaySuffix="%"
                        openValue={100}
                        onCommit={(v) => setState(`${base}.cmd.windows_set`, v)}
                    />

                    <SliderControl
                        icon={<BlindsClosedIcon sx={{ fontSize: 14 }} />}
                        iconActive={<BlindsIcon sx={{ fontSize: 14 }} />}
                        label="Sonnenblende"
                        value={sunShade}
                        max={10}
                        displaySuffix="/10"
                        openValue={10}
                        onCommit={(v) => setState(`${base}.cmd.sunshade_set`, v)}
                    />
                </CardContent>
            </Card>

            {/* Komfort (Sentry Mode, Speed Limit, Sitzheizung etc.) */}
            {(can('sentryMode') || can('speedLimit') || can('seatHeat') || can('steeringWheelHeat') || can('mirrorHeat')) && (
            <Card sx={{ mb: 2, bgcolor: '#0d1520', border: '1px solid #1e2d45' }}>
                <CardContent>
                    <SectionLabel>KOMFORT</SectionLabel>
                    <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                        {can('sentryMode') && (
                            <Button size="small" onClick={() => send('sentry_mode_on')} sx={{ border: '1px solid #1e2d45' }}>
                                Wachmodus an
                            </Button>
                        )}
                        {can('sentryMode') && (
                            <Button size="small" onClick={() => send('sentry_mode_off')} sx={{ border: '1px solid #1e2d45' }}>
                                Wachmodus aus
                            </Button>
                        )}
                        {can('steeringWheelHeat') && (
                            <Button size="small" onClick={() => send('steering_wheel_heat_on')} sx={{ border: '1px solid #1e2d45' }}>
                                Lenkradheizung an
                            </Button>
                        )}
                        {can('steeringWheelHeat') && (
                            <Button size="small" onClick={() => send('steering_wheel_heat_off')} sx={{ border: '1px solid #1e2d45' }}>
                                Lenkradheizung aus
                            </Button>
                        )}
                        {can('mirrorHeat') && (
                            <Button size="small" onClick={() => send('mirror_heat_on')} sx={{ border: '1px solid #1e2d45' }}>
                                Spiegel-/Heckscheibenheizung an
                            </Button>
                        )}
                        {can('mirrorHeat') && (
                            <Button size="small" onClick={() => send('mirror_heat_off')} sx={{ border: '1px solid #1e2d45' }}>
                                Spiegel-/Heckscheibenheizung aus
                            </Button>
                        )}
                    </Box>
                    {can('speedLimit') && (
                        <Box sx={{ mt: 2 }}>
                            <Typography variant="caption" sx={{ color: '#5a7090', display: 'block', mb: 0.5 }}>Geschwindigkeitsbegrenzung (0 = aus)</Typography>
                            <input type="number" min="0" max="150" defaultValue={0}
                                onBlur={(e) => setState(`${base}.cmd.speed_limit_set`, Number(e.target.value))}
                                style={{ width: '100%', padding: '8px', borderRadius: 6, border: '1px solid #1e2d45', background: '#070d1a', color: '#c8ddf0', fontSize: '0.95rem' }}
                            />
                        </Box>
                    )}
                    {can('seatHeat') && (
                        <Box sx={{ mt: 2, display: 'flex', gap: 1 }}>
                            {[0, 1, 2, 3].map((lvl) => (
                                <Button key={lvl} size="small" onClick={() => setState(`${base}.cmd.seat_heat_driver`, lvl)} sx={{ minWidth: 0, flex: 1, border: '1px solid #1e2d45' }}>
                                    Sitzheizung {lvl}
                                </Button>
                            ))}
                        </Box>
                    )}
                </CardContent>
            </Card>
            )}

            {/* Konnektivität */}
            {can('hotspot') && (
            <Card sx={{ mb: 2, bgcolor: '#0d1520', border: '1px solid #1e2d45' }}>
                <CardContent>
                    <SectionLabel>KONNEKTIVITÄT</SectionLabel>
                    <Button
                        fullWidth
                        startIcon={hotspotOn ? <WifiIcon /> : <WifiOffIcon />}
                        onClick={() => { triggerHotspot(!hotspotOn); send(hotspotOn ? 'hotspot_off' : 'hotspot_on'); }}
                        sx={{
                            color: hotspotOn ? '#070d1a' : '#00d4ff',
                            bgcolor: hotspotOn ? '#00d4ff' : 'transparent',
                            border: '1px solid #1e2d45',
                            transition: 'background-color 0.15s',
                        }}
                    >
                        Hotspot {hotspotOn ? 'ausschalten' : 'einschalten'}
                    </Button>
                </CardContent>
            </Card>
            )}

            <Button fullWidth startIcon={<RefreshIcon />} onClick={() => send('refresh')} sx={{ border: '1px solid #1e2d45' }}>
                Status aktualisieren
            </Button>
        </Box>
    );
}

function TempSlider({ value, onCommit }) {
    const [local, setLocal] = useState(value);
    useEffect(() => { setLocal(value); }, [value]);
    return (
        <Slider
            value={local}
            min={16}
            max={30}
            onChange={(_, v) => setLocal(v)}
            onChangeCommitted={(_, v) => onCommit(v)}
            sx={{ ml: 2, color: '#00d4ff' }}
        />
    );
}

function FanSlider({ value, onCommit }) {
    const [local, setLocal] = useState(value);
    useEffect(() => { setLocal(value); }, [value]);
    return (
        <Slider
            value={local}
            min={1}
            max={7}
            step={1}
            marks
            onChange={(_, v) => setLocal(v)}
            onChangeCommitted={(_, v) => onCommit(v)}
            sx={{ color: '#00d4ff' }}
        />
    );
}

function ChargeLimitSlider({ value, onCommit }) {
    const [local, setLocal] = useState(value);
    useEffect(() => { setLocal(value); }, [value]);
    return (
        <Box>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5 }}>
                <Typography variant="caption" sx={{ color: '#5a7090' }}>Ladelimit</Typography>
                <Typography variant="caption" sx={{ color: '#00ff88', fontWeight: 700 }}>{local}%</Typography>
            </Box>
            <Slider
                value={local}
                min={50}
                max={100}
                step={5}
                marks
                onChange={(_, v) => setLocal(v)}
                onChangeCommitted={(_, v) => onCommit(v)}
                sx={{ color: '#00ff88' }}
            />
        </Box>
    );
}
