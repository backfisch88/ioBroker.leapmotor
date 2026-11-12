import React, { useState, useEffect, useRef, useCallback } from 'react';
import { I18n } from '@iobroker/adapter-react-v5';
import { hasCapability, isKnownUnavailable } from '../vehicleCapabilities';
import {
    Card, CardContent, Typography, Box, Button,
    Slider, IconButton, Chip, LinearProgress,
} from '@mui/material';
import Grid from '@mui/material/Grid2';
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

// Hook: optimistic button state. Sets `active` immediately, sends the
// command, and automatically falls back after delayMs if the real
// status (from `actualActive`) doesn't follow (= command failed).
function useOptimistic(actualActive, delayMs = 6000) {
    const [optimistic, setOptimistic] = useState(null);
    const timeoutRef = useRef(null);

    useEffect(() => {
        // Once the real status matches the optimistic one, clear it
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
            borderColor: 'var(--lm-line)', bgcolor: 'var(--lm-surface)', textAlign: 'center',
            height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'center',
        }}>
            <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
                <Typography variant="caption" sx={{ color: 'var(--lm-muted)', letterSpacing: '0.1em', display: 'block' }}>{label}</Typography>
                <Typography sx={{ fontWeight: 800, fontSize: '1.05rem', color: color || 'var(--lm-text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</Typography>
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
                color: active ? 'var(--lm-ink)' : color,
                bgcolor: active ? color : 'transparent',
                border: `2px solid ${active ? color : 'var(--lm-line)'}`,
                fontWeight: active ? 800 : 500,
                transition: 'background-color 0.15s, color 0.15s',
                '& .MuiButton-startIcon': { mr: 0.3 },
                '&:hover': { bgcolor: active ? color : `color-mix(in srgb, ${color} 14%, transparent)` },
            }}
        >
            {label}
        </Button>
    );
}

function SectionLabel({ children }) {
    return (
        <Typography variant="caption" sx={{ color: 'var(--lm-muted)', letterSpacing: '0.1em', display: 'block', mb: 1 }}>
            {children}
        </Typography>
    );
}

function SliderControl({ icon, iconActive, label, value, max, displaySuffix, onCommit, openValue, color = 'var(--lm-accent)' }) {
    const [local, setLocal] = useState(value);
    useEffect(() => { setLocal(value); }, [value]);

    // iOS Safari fires both a touch event and a synthetic mouse event for
    // slider drags and button taps, which can call onCommit twice in quick
    // succession with the same value. Guard against that: ignore a second
    // commit of the same value within 500ms.
    const lastCommit = useRef({ value: null, ts: 0 });
    const guardedCommit = (v) => {
        const now = Date.now();
        if (lastCommit.current.value === v && now - lastCommit.current.ts < 500) return;
        lastCommit.current = { value: v, ts: now };
        onCommit(v);
    };

    return (
        <Box sx={{ mt: 2 }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 0.5 }}>
                <Typography variant="caption" sx={{ color: 'var(--lm-muted)', display: 'flex', alignItems: 'center', gap: 0.5 }}>
                    {local > 0 ? iconActive : icon}
                    {label}
                </Typography>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Typography variant="caption" sx={{ color, fontWeight: 700 }}>{local}{displaySuffix}</Typography>
                </Box>
            </Box>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                <Button size="small" onClick={() => { setLocal(0); guardedCommit(0); }}
                    sx={{ minWidth: 0, px: 1, border: '1px solid var(--lm-line)', color: local === 0 ? color : undefined }}>
                    {I18n.t('Close')}
                </Button>
                <Slider
                    value={local}
                    min={0}
                    max={max}
                    step={max <= 10 ? 1 : 10}
                    onChange={(_, v) => setLocal(v)}
                    onChangeCommitted={(_, v) => guardedCommit(v)}
                    sx={{ color }}
                />
                <Button size="small" onClick={() => { setLocal(openValue); guardedCommit(openValue); }}
                    sx={{ minWidth: 0, px: 1, border: '1px solid var(--lm-line)', color: local === openValue ? color : undefined }}>
                    {I18n.t('Open')}
                </Button>
            </Box>
        </Box>
    );
}

export default function DashboardTab({ base, states, setState }) {
    const soc = val(states, `${base}.status.battery_soc`, 0);
    const socColor = soc > 20 ? 'var(--lm-accent)' : soc > 10 ? 'var(--lm-warn)' : 'var(--lm-bad)';
    const vehicleName = val(states, `${base}.info.name`, '');
    const socTs = states[`${base}.status.battery_soc`]?.ts;
    const updatedAt = socTs ? new Date(socTs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
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
    const fanMax = val(states, `${base}.status.ac_fan_max`, 7);
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

    // Optimistic states with automatic rollback after 6s if the API call fails
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
    // On models where ac_cooling_heating is confirmed unavailable (e.g. B10),
    // acMode is always null, so once the brief optimistic highlight after a
    // click expires, none of the 4 buttons would show as active even though
    // the climate is demonstrably running (acOn works fine on these models).
    // Show a plain "Climate is ON/OFF" hint instead of falsely highlighting
    // (or leaving unhighlighted) a specific mode we can't actually detect.
    const acModeUnknown = acModeLocal===null && isKnownUnavailable(carType,'ac_cooling_heating');

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

    // On temperature change -> resend the current mode after 2s so the new
    // temperature is actually applied (API needs mode+temp together)
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
            {/* Hero: Reichweite, Ladestand, Status, Fahrzeugbild */}
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1.1fr' }, gap: { xs: 2, md: 5 }, alignItems: 'center' }}>
                <Box>
                    <Typography sx={{ fontSize: 24, fontWeight: 600, letterSpacing: '-0.02em' }}>{vehicleName}</Typography>
                    {updatedAt && <Typography sx={{ fontSize: 13, color: 'var(--lm-muted)' }}>{I18n.t('Last update')} {updatedAt}</Typography>}
                    <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, mt: 2.5 }}>
                        <Typography component="span" sx={{ fontSize: 'clamp(64px, 12vw, 96px)', fontWeight: 500, lineHeight: 1, letterSpacing: '-0.05em', fontVariantNumeric: 'tabular-nums' }}>{range}</Typography>
                        <Typography component="span" sx={{ fontSize: 18, color: 'var(--lm-muted)' }}>km</Typography>
                    </Box>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mt: 1.5, maxWidth: 380 }}>
                        <LinearProgress variant="determinate" value={soc} sx={{
                            flex: 1, height: 5, borderRadius: 3, bgcolor: 'color-mix(in srgb, var(--lm-accent) 18%, var(--lm-sunken))',
                            '& .MuiLinearProgress-bar': { bgcolor: socColor, borderRadius: 3 },
                        }} />
                        <Typography sx={{ fontSize: 14, fontVariantNumeric: 'tabular-nums' }}>{soc} %</Typography>
                    </Box>
                    <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mt: 2.5 }}>
                        <Chip icon={locked ? <LockIcon /> : <LockOpenIcon />} label={locked ? I18n.t('Locked') : I18n.t('Unlocked')}
                            sx={{ bgcolor: 'var(--lm-surface)', border: '1px solid var(--lm-line)', '& .MuiChip-icon': { fontSize: 18, color: 'var(--lm-text)' } }} />
                        {charging && <Chip label={`${I18n.t('CHARGING')} · ${remainMin} min`} sx={{ bgcolor: 'var(--lm-soft)', textTransform: 'capitalize' }} />}
                        {acOn && <Chip label={I18n.t('CLIMATE')} sx={{ bgcolor: 'var(--lm-soft)', textTransform: 'capitalize' }} />}
                        {doorOpen && <Chip label={I18n.t('DOOR OPEN')} sx={{ bgcolor: 'color-mix(in srgb, var(--lm-warn) 18%, transparent)', textTransform: 'capitalize' }} />}
                        {outdoor !== '—' && <Chip label={`${outdoor} °C`} sx={{ bgcolor: 'var(--lm-surface)', border: '1px solid var(--lm-line)' }} />}
                    </Box>
                </Box>
                <Box sx={{ position: 'relative', minHeight: 180 }}>
                    <VehicleImage base={base} states={states} />
                    <Typography sx={{ textAlign: 'center', fontSize: 15, mt: 0.5 }}>
                        {parked ? I18n.t('Parked') : `${speed} km/h`}
                    </Typography>
                </Box>
            </Box>

            {/* Schnellaktionen */}
            <Box sx={{ display: 'flex', gap: 1, mt: 3, mb: 3.5, overflowX: 'auto', overflowY: 'hidden', touchAction: 'pan-x', scrollbarWidth: 'none', '&::-webkit-scrollbar': { display: 'none' } }}>
                {[
                    { label: locked ? I18n.t('Locked') : I18n.t('Unlocked'), icon: locked ? <LockIcon /> : <LockOpenIcon />, on: locked, run: () => { triggerLocked(!locked); send(locked ? 'unlock' : 'lock'); } },
                    { label: I18n.t('Trunk'), icon: <DirectionsCarIcon />, on: doorTrunk, run: () => { triggerDoorTrunk(!doorTrunk); send(doorTrunk ? 'trunk_close' : 'trunk_open'); } },
                    { label: I18n.t('Locate Vehicle'), icon: <LocationSearchingIcon />, on: false, run: () => send('find') },
                    { label: I18n.t('Refresh'), icon: <RefreshIcon />, on: false, run: () => send('refresh') },
                ].map(q => (
                    <Box key={q.label} component="button" type="button" onClick={q.run} sx={{
                        flex: '1 1 0', minWidth: 72, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1,
                        background: 'none', border: 0, p: 0, cursor: 'pointer', color: 'var(--lm-text)', fontFamily: 'inherit', fontSize: 14,
                        '& .circle': { width: 64, height: 64, borderRadius: '50%', display: 'grid', placeItems: 'center', bgcolor: q.on ? 'var(--lm-soft)' : 'var(--lm-surface)', border: '1px solid var(--lm-line)', transition: 'transform 160ms cubic-bezier(0.23,1,0.32,1), background-color 160ms' },
                        '&:active .circle': { transform: 'scale(0.94)' },
                        '@media (hover: hover) and (pointer: fine)': { '&:hover .circle': { bgcolor: 'var(--lm-sunken)' } },
                    }}>
                        <span className="circle">{q.icon}</span>
                        {q.label}
                    </Box>
                ))}
            </Box>

            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 1.5, alignItems: 'start' }}>
            {/* Climate control */}
            <Card >
                <CardContent>
                    <SectionLabel>{I18n.t('CLIMATE CONTROL')}</SectionLabel>
                    <Box sx={{ display: 'flex', gap: 1, mt: 1, mb: 2, flexWrap: 'wrap' }}>
                        <ToggleButton active={isHeat} color="#ff6644" icon={<WhatshotIcon />} label={I18n.t('Heat')} onClick={() => sendClimate('heat', 'ac_heat')} />
                        <ToggleButton active={isCool} color="var(--lm-accent)" icon={<AcUnitIcon />} label={I18n.t('Cool')} onClick={() => sendClimate('cool', 'ac_cool')} />
                        <ToggleButton active={isVent} color="var(--lm-accent)" icon={<AirIcon />} label={I18n.t('Vent')} onClick={() => sendClimate('vent', 'ac_vent')} />
                        <ToggleButton active={isOff} color="var(--lm-bad)" icon={<PowerOffIcon />} label={I18n.t('Off')} onClick={() => sendClimate('off', 'ac_off')} />
                    </Box>
                    {acModeUnknown && (
                        <Typography variant="caption" sx={{ display: 'block', mt: -1, mb: 2, color: acOn ? 'var(--lm-ok)' : 'var(--lm-muted)' }}>
                            ℹ️ {acOn ? I18n.t('Climate is currently ON (exact mode not reported by this vehicle model)') : I18n.t('Climate is currently OFF')}
                        </Typography>
                    )}
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 2 }}>
                        <IconButton size="small" onClick={() => onTempCommit(Math.max(16, acTemp - 1))} sx={{ border: '1px solid var(--lm-line)' }}><RemoveIcon /></IconButton>
                        <Typography sx={{ minWidth: 60, textAlign: 'center', fontWeight: 800, color: 'var(--lm-accent)', fontSize: '1.3rem' }}>{acTemp}°C</Typography>
                        <IconButton size="small" onClick={() => onTempCommit(Math.min(30, acTemp + 1))} sx={{ border: '1px solid var(--lm-line)' }}><AddIcon /></IconButton>
                        <TempSlider value={acTemp} onCommit={onTempCommit} />
                    </Box>
                    <Box sx={{ mb: 2 }}>
                        <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5 }}>
                            <Typography variant="caption" sx={{ color: 'var(--lm-muted)', display: 'flex', alignItems: 'center', gap: 0.5 }}>
                                <AirIcon sx={{ fontSize: 14 }} /> {I18n.t('Fan Speed')}
                            </Typography>
                            <Typography variant="caption" sx={{ color: 'var(--lm-accent)', fontWeight: 700 }}>{fanSpeed}/{fanMax}</Typography>
                        </Box>
                        <FanSlider value={fanSpeed} max={fanMax} onCommit={onFanCommit} />
                    </Box>
                    <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
                        {can('defrost') && (
                        <Button size="small" startIcon={<AcUnitOutlinedIcon />} onClick={() => send('defrost')}
                            sx={{ border: '1px solid var(--lm-line)' }}>
                            {I18n.t('Windshield Defrost (full heat)')}
                        </Button>
                        )}
                        {can('batteryPreheat') && (
                        <Button size="small" startIcon={<BatteryFullIcon />}
                            onClick={() => { triggerPtc(!ptcState); send(ptcState ? 'battery_preheat_off' : 'battery_preheat'); }}
                            sx={{ border: '1px solid var(--lm-line)', color: ptcState ? 'var(--lm-warn)' : undefined }}>
                            {ptcState ? I18n.t('Battery Preheat Off') : I18n.t('Preheat Battery')}
                        </Button>
                        )}
                        <Button size="small" startIcon={<AcUnitIcon />} onClick={() => sendQuick('cool', 'quick_cool')}
                            sx={{ border: `1px solid ${quickActive === 'quick_cool' ? 'var(--lm-accent)' : 'var(--lm-line)'}`, color: quickActive === 'quick_cool' ? 'var(--lm-ink)' : undefined, bgcolor: quickActive === 'quick_cool' ? 'var(--lm-accent)' : 'transparent' }}>
                            {I18n.t('Quick Cool')}
                        </Button>
                        <Button size="small" startIcon={<WhatshotIcon />} onClick={() => sendQuick('heat', 'quick_heat')}
                            sx={{ border: `1px solid ${quickActive === 'quick_heat' ? '#ff6644' : 'var(--lm-line)'}`, color: quickActive === 'quick_heat' ? 'var(--lm-ink)' : undefined, bgcolor: quickActive === 'quick_heat' ? '#ff6644' : 'transparent' }}>
                            {I18n.t('Quick Heat')}
                        </Button>
                    </Box>
                </CardContent>
            </Card>

            {/* Charging */}
            <Card >
                <CardContent>
                    <SectionLabel>{I18n.t('CHARGE')}</SectionLabel>
                    <ChargeLimitSlider value={chargeLimit} onCommit={(v) => setState(`${base}.cmd.charge_limit_set`, v)} />
                    <Box sx={{ mt: 3 }}>
                        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1.5 }}>
                            <Typography variant="caption" sx={{ color: 'var(--lm-muted)' }}>{I18n.t('Charge Schedule')}</Typography>
                            <Button
                                size="small"
                                onClick={() => { setScheduleEnabled(!scheduleEnabled); setState(`${base}.cmd.charge_schedule_enable`, !scheduleEnabled); }}
                                sx={{
                                    minWidth: 0, px: 1.5,
                                    border: '1px solid var(--lm-line)',
                                    color: scheduleEnabled ? 'var(--lm-ink)' : 'var(--lm-muted)',
                                    bgcolor: scheduleEnabled ? 'var(--lm-ok)' : 'transparent',
                                }}>
                                {scheduleEnabled ? I18n.t('Active') : I18n.t('Inactive')}
                            </Button>
                        </Box>
                        <Box sx={{ display: 'flex', gap: 1.5, mb: 1.5 }}>
                            <Box sx={{ flex: 1 }}>
                                <Typography variant="caption" sx={{ color: 'var(--lm-muted)', display: 'block', mb: 0.5 }}>{I18n.t('Start')}</Typography>
                                <input
                                    type="time"
                                    value={scheduleStart}
                                    onChange={(e) => { setScheduleStart(e.target.value); setState(`${base}.cmd.charge_schedule_start`, e.target.value); }}
                                    style={{
                                        width: '100%', padding: '8px', borderRadius: 6,
                                        border: '1px solid var(--lm-line)', background: 'var(--lm-sunken)', color: 'var(--lm-text)',
                                        fontSize: '0.95rem', colorScheme: 'dark',
                                    }}
                                />
                            </Box>
                            <Box sx={{ flex: 1 }}>
                                <Typography variant="caption" sx={{ color: 'var(--lm-muted)', display: 'block', mb: 0.5 }}>{I18n.t('End')}</Typography>
                                <input
                                    type="time"
                                    value={scheduleEnd}
                                    onChange={(e) => { setScheduleEnd(e.target.value); setState(`${base}.cmd.charge_schedule_end`, e.target.value); }}
                                    style={{
                                        width: '100%', padding: '8px', borderRadius: 6,
                                        border: '1px solid var(--lm-line)', background: 'var(--lm-sunken)', color: 'var(--lm-text)',
                                        fontSize: '0.95rem', colorScheme: 'dark',
                                    }}
                                />
                            </Box>
                        </Box>
                        <Button fullWidth onClick={() => send('charge_schedule_apply')} sx={{ border: '1px solid color-mix(in srgb, var(--lm-accent) 33%, transparent)', color: 'var(--lm-accent)' }}>
                            {I18n.t('Apply Schedule')}
                        </Button>
                    </Box>
                </CardContent>
            </Card>

            {/* Climate schedule */}
            <Card >
                <CardContent>
                    <SectionLabel>{I18n.t('CLIMATE SCHEDULE')}</SectionLabel>

                    {/* Current schedule status */}
                    <Box sx={{ mb: 2, p: 1, bgcolor: climateScheduleActive ? 'color-mix(in srgb, var(--lm-accent) 7%, transparent)' : 'var(--lm-line)', borderRadius: 1, border: `1px solid ${climateScheduleActive ? 'color-mix(in srgb, var(--lm-accent) 20%, transparent)' : 'var(--lm-line)'}` }}>
                        <Typography variant="caption" sx={{ color: climateScheduleActive ? 'var(--lm-accent)' : 'var(--lm-muted)' }}>
                            {climateScheduleActive
                                ? `⏰ ${I18n.t('Active schedule')}: ${climateScheduleInfo}`
                                : climateScheduleInfo
                                    ? `○ ${I18n.t('Inactive (last')}: ${climateScheduleInfo})`
                                    : `○ ${I18n.t('No schedule set')}`}
                        </Typography>
                    </Box>

                    {/* Active/Inactive */}
                    <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1.5 }}>
                        <Typography variant="caption" sx={{ color: 'var(--lm-muted)' }}>{I18n.t('Climate Schedule')}</Typography>
                        <Button size="small"
                            onClick={() => {
                                const next = !climateScheduleEnabled;
                                setClimateScheduleEnabled(next);
                                setState(`${base}.cmd.climate_schedule_enable`, next);
                                setState(`${base}.status.climate_schedule_active`, next);
                            }}
                            sx={{ minWidth: 0, px: 1.5, border: '1px solid var(--lm-line)', color: climateScheduleEnabled ? 'var(--lm-ink)' : 'var(--lm-muted)', bgcolor: climateScheduleEnabled ? 'var(--lm-accent)' : 'transparent' }}>
                            {climateScheduleEnabled ? I18n.t('Active') : I18n.t('Inactive')}
                        </Button>
                    </Box>

                    {/* Mode */}
                    <Box sx={{ mb: 1.5 }}>
                        <Typography variant="caption" sx={{ color: 'var(--lm-muted)', display: 'block', mb: 0.5 }}>{I18n.t('Mode')}</Typography>
                        <Box sx={{ display: 'flex', gap: 0.5 }}>
                            {[{v:'hot',l:`🔥 ${I18n.t('Heat')}`,c:'#ff6b35'},{v:'cold',l:`❄️ ${I18n.t('Cool')}`,c:'var(--lm-accent)'},{v:'wind',l:`💨 ${I18n.t('Vent')}`,c:'var(--lm-ok)'}].map(({v,l,c})=>(
                                <Button key={v} size="small"
                                    onClick={() => { setClimateScheduleMode(v); setState(`${base}.cmd.climate_schedule_mode`, v); }}
                                    sx={{ flex:1, minWidth:0, px:0.5, border:'1px solid var(--lm-line)', color: climateScheduleMode===v ? 'var(--lm-ink)' : 'var(--lm-muted)', bgcolor: climateScheduleMode===v ? c : 'transparent', fontSize:'0.7rem' }}>
                                    {l}
                                </Button>
                            ))}
                        </Box>
                    </Box>

                    {/* Time */}
                    <Box sx={{ mb: 1.5 }}>
                        <Typography variant="caption" sx={{ color: 'var(--lm-muted)', display: 'block', mb: 0.5 }}>{I18n.t('Start Time')}</Typography>
                        <input type="time" value={climateScheduleTime}
                            onChange={(e) => { setClimateScheduleTime(e.target.value); setState(`${base}.cmd.climate_schedule_time`, e.target.value); }}
                            style={{ width:'100%', padding:'8px', borderRadius:6, border:'1px solid var(--lm-line)', background:'var(--lm-sunken)', color:'var(--lm-text)', fontSize:'0.95rem', colorScheme:'light dark' }}
                        />
                    </Box>

                    {/* Weekdays */}
                    <Box sx={{ mb: 1.5 }}>
                        <Typography variant="caption" sx={{ color: 'var(--lm-muted)', display: 'block', mb: 0.5 }}>{I18n.t('Repeat')}</Typography>
                        <Box sx={{ display: 'flex', gap: 0.5 }}>
                            {[{d:1,l:I18n.t('Mon')},{d:2,l:I18n.t('Tue')},{d:3,l:I18n.t('Wed')},{d:4,l:I18n.t('Thu')},{d:5,l:I18n.t('Fri')},{d:6,l:I18n.t('Sat')},{d:0,l:I18n.t('Sun')}].map(({d,l})=>{
                                const sel = climateScheduleDays.includes(d);
                                return (
                                    <Button key={d} size="small"
                                        onClick={() => {
                                            const next = sel ? climateScheduleDays.filter(x=>x!==d) : [...climateScheduleDays, d];
                                            setClimateScheduleDays(next);
                                            setState(`${base}.cmd.climate_schedule_days`, next.join(','));
                                        }}
                                        sx={{ minWidth:0, flex:1, px:0, border:'1px solid var(--lm-line)', color: sel ? 'var(--lm-ink)' : 'var(--lm-muted)', bgcolor: sel ? 'var(--lm-accent)' : 'transparent', fontSize:'0.65rem' }}>
                                        {l}
                                    </Button>
                                );
                            })}
                        </Box>
                    </Box>

                    {/* Buttons */}
                    <Box sx={{ display: 'flex', gap: 1 }}>
                        <Button fullWidth onClick={() => { send('climate_schedule_apply'); setTimeout(() => send('refresh'), 3000); }} sx={{ border: '1px solid color-mix(in srgb, var(--lm-accent) 33%, transparent)', color: 'var(--lm-accent)' }}>
                            {I18n.t('Apply Schedule')}
                        </Button>
                        <Button onClick={() => { send('climate_schedule_cancel'); setTimeout(() => send('refresh'), 3000); }} sx={{ border: '1px solid color-mix(in srgb, var(--lm-bad) 33%, transparent)', color: 'var(--lm-bad)', minWidth: 0, px: 1.5 }}>
                            {I18n.t('Delete')}
                        </Button>
                    </Box>
                </CardContent>
            </Card>

            {/* Doors, trunk, windows, sunshade */}
            <Card >
                <CardContent>
                    <SectionLabel>{I18n.t('LOCKS & OPENINGS')}</SectionLabel>
                    <Grid container spacing={1}>
                        <Grid size={{ xs: 6, sm: 4 }}>
                            <Button fullWidth startIcon={<LockIcon />} onClick={() => { triggerLocked(true); send('lock'); }}
                                sx={{ color: locked ? 'var(--lm-ink)' : 'var(--lm-accent)', bgcolor: locked ? 'var(--lm-accent)' : 'transparent', border: '1px solid var(--lm-line)', transition: 'background-color 0.15s' }}>
                                {I18n.t('Lock')}
                            </Button>
                        </Grid>
                        <Grid size={{ xs: 6, sm: 4 }}>
                            <Button fullWidth startIcon={<LockOpenIcon />} onClick={() => { triggerLocked(false); send('unlock'); }}
                                sx={{ color: !locked ? 'var(--lm-ink)' : 'var(--lm-warn)', bgcolor: !locked ? 'var(--lm-warn)' : 'transparent', border: '1px solid var(--lm-line)', transition: 'background-color 0.15s' }}>
                                {I18n.t('Unlock')}
                            </Button>
                        </Grid>
                        <Grid size={{ xs: 6, sm: 4 }}>
                            <Button fullWidth startIcon={<DirectionsCarIcon />}
                                onClick={() => { triggerDoorTrunk(!doorTrunk); send(doorTrunk ? 'trunk_close' : 'trunk_open'); }}
                                sx={{ border: '1px solid var(--lm-line)' }}>
                                {I18n.t('Trunk')} {doorTrunk ? I18n.t('Close') : I18n.t('Open')}
                            </Button>
                        </Grid>
                        <Grid size={{ xs: 6, sm: 4 }}>
                            <Button fullWidth startIcon={<LocationSearchingIcon />} onClick={() => send('find')} sx={{ border: '1px solid var(--lm-line)' }}>
                                {I18n.t('Locate Vehicle')}
                            </Button>
                        </Grid>
                    </Grid>

                    <SliderControl
                        icon={<BlindsClosedIcon sx={{ fontSize: 14 }} />}
                        iconActive={<BlindsIcon sx={{ fontSize: 14 }} />}
                        label={I18n.t('Window')}
                        value={windowFL}
                        max={100}
                        displaySuffix="%"
                        openValue={100}
                        onCommit={(v) => setState(`${base}.cmd.windows_set`, v)}
                    />

                    <SliderControl
                        icon={<BlindsClosedIcon sx={{ fontSize: 14 }} />}
                        iconActive={<BlindsIcon sx={{ fontSize: 14 }} />}
                        label={I18n.t('Sunshade')}
                        value={sunShade}
                        max={10}
                        displaySuffix="/10"
                        openValue={10}
                        onCommit={(v) => setState(`${base}.cmd.sunshade_set`, v)}
                    />
                </CardContent>
            </Card>

            {/* Comfort (Sentry Mode, Speed Limit, Seat Heat etc.) */}
            {(can('sentryMode') || can('speedLimit') || can('seatHeat') || can('steeringWheelHeat') || can('mirrorHeat')) && (
            <Card >
                <CardContent>
                    <SectionLabel>{I18n.t('COMFORT')}</SectionLabel>
                    <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                        {can('sentryMode') && (
                            <Button size="small" onClick={() => send('sentry_mode_on')} sx={{ border: '1px solid var(--lm-line)' }}>
                                {I18n.t('Sentry Mode On')}
                            </Button>
                        )}
                        {can('sentryMode') && (
                            <Button size="small" onClick={() => send('sentry_mode_off')} sx={{ border: '1px solid var(--lm-line)' }}>
                                {I18n.t('Sentry Mode Off')}
                            </Button>
                        )}
                        {can('steeringWheelHeat') && (
                            <Button size="small" onClick={() => send('steering_wheel_heat_on')} sx={{ border: '1px solid var(--lm-line)' }}>
                                {I18n.t('Steering Wheel Heat On')}
                            </Button>
                        )}
                        {can('steeringWheelHeat') && (
                            <Button size="small" onClick={() => send('steering_wheel_heat_off')} sx={{ border: '1px solid var(--lm-line)' }}>
                                {I18n.t('Steering Wheel Heat Off')}
                            </Button>
                        )}
                        {can('mirrorHeat') && (
                            <Button size="small" onClick={() => send('mirror_heat_on')} sx={{ border: '1px solid var(--lm-line)' }}>
                                {I18n.t('Mirror/Rear Window Heat On')}
                            </Button>
                        )}
                        {can('mirrorHeat') && (
                            <Button size="small" onClick={() => send('mirror_heat_off')} sx={{ border: '1px solid var(--lm-line)' }}>
                                {I18n.t('Mirror/Rear Window Heat Off')}
                            </Button>
                        )}
                    </Box>
                    {can('speedLimit') && (
                        <Box sx={{ mt: 2 }}>
                            <Typography variant="caption" sx={{ color: 'var(--lm-muted)', display: 'block', mb: 0.5 }}>{I18n.t('Speed Limit (0 = off)')}</Typography>
                            <input type="number" min="0" max="150" defaultValue={0}
                                onBlur={(e) => setState(`${base}.cmd.speed_limit_set`, Number(e.target.value))}
                                style={{ width: '100%', padding: '8px', borderRadius: 6, border: '1px solid var(--lm-line)', background: 'var(--lm-sunken)', color: 'var(--lm-text)', fontSize: '0.95rem' }}
                            />
                        </Box>
                    )}
                    {can('seatHeat') && (
                        <Box sx={{ mt: 2, display: 'flex', gap: 1 }}>
                            {[0, 1, 2, 3].map((lvl) => (
                                <Button key={lvl} size="small" onClick={() => setState(`${base}.cmd.seat_heat_driver`, lvl)} sx={{ minWidth: 0, flex: 1, border: '1px solid var(--lm-line)' }}>
                                    {I18n.t('Seat Heat')} {lvl}
                                </Button>
                            ))}
                        </Box>
                    )}
                </CardContent>
            </Card>
            )}

            {/* Connectivity */}
            {can('hotspot') && (
            <Card >
                <CardContent>
                    <SectionLabel>{I18n.t('CONNECTIVITY')}</SectionLabel>
                    <Button
                        fullWidth
                        startIcon={hotspotOn ? <WifiIcon /> : <WifiOffIcon />}
                        onClick={() => { triggerHotspot(!hotspotOn); send(hotspotOn ? 'hotspot_off' : 'hotspot_on'); }}
                        sx={{
                            color: hotspotOn ? 'var(--lm-ink)' : 'var(--lm-accent)',
                            bgcolor: hotspotOn ? 'var(--lm-accent)' : 'transparent',
                            border: '1px solid var(--lm-line)',
                            transition: 'background-color 0.15s',
                        }}
                    >
                        {I18n.t('Hotspot')} {hotspotOn ? I18n.t('Turn Off') : I18n.t('Turn On')}
                    </Button>
                </CardContent>
            </Card>
            )}

            </Box>
            <Button fullWidth startIcon={<RefreshIcon />} onClick={() => send('refresh')} sx={{ border: '1px solid var(--lm-line)' }}>
                {I18n.t('Refresh Status')}
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
            sx={{ ml: 2, color: 'var(--lm-accent)' }}
        />
    );
}

function FanSlider({ value, max = 7, onCommit }) {
    const [local, setLocal] = useState(value);
    useEffect(() => { setLocal(value); }, [value]);
    return (
        <Slider
            value={local}
            min={1}
            max={max}
            step={1}
            marks
            onChange={(_, v) => setLocal(v)}
            onChangeCommitted={(_, v) => onCommit(v)}
            sx={{ color: 'var(--lm-accent)' }}
        />
    );
}

function ChargeLimitSlider({ value, onCommit }) {
    const [local, setLocal] = useState(value);
    useEffect(() => { setLocal(value); }, [value]);
    return (
        <Box>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5 }}>
                <Typography variant="caption" sx={{ color: 'var(--lm-muted)' }}>{I18n.t('Charge Limit')}</Typography>
                <Typography variant="caption" sx={{ color: 'var(--lm-ok)', fontWeight: 700 }}>{local}%</Typography>
            </Box>
            <Slider
                value={local}
                min={50}
                max={100}
                step={5}
                marks
                onChange={(_, v) => setLocal(v)}
                onChangeCommitted={(_, v) => onCommit(v)}
                sx={{ color: 'var(--lm-ok)' }}
            />
        </Box>
    );
}
