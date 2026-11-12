import React, { useState, useEffect, useMemo } from 'react';
import {
    ThemeProvider, createTheme, CssBaseline, Box, Tabs, Tab,
    Typography, GlobalStyles, CircularProgress, Alert,
    Select, MenuItem,
} from '@mui/material';
import { I18n } from '@iobroker/adapter-react-v5';

import { useConnection } from './useConnection';
import DashboardTab from './components/DashboardTab';
import DatapointsTab from './components/DatapointsTab';
import ConsumptionTab from './components/ConsumptionTab';
import DiagnosticsTab from './components/DiagnosticsTab';
import TripsTab from './components/TripsTab';
import SettingsTab from './components/SettingsTab';

// Theme folgt dem ioBroker-Admin (localStorage "App.themeName" bzw. URL-Parameter
// "react"), sonst dem System.
function detectThemeType() {
    const lum = (c) => {
        const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/.exec(c || '');
        if (!m || (m[4] !== undefined && Number(m[4]) === 0)) return null;
        return (0.2126 * m[1] + 0.7152 * m[2] + 0.0722 * m[3]) / 255;
    };
    // 1. Tatsächliche Hintergrundfarbe des ioBroker-Admins (gleiche Origin, daher lesbar)
    try {
        const pd = window.parent && window.parent !== window ? window.parent.document : null;
        if (pd) {
            for (const el of [pd.body, pd.documentElement, pd.getElementById('root')]) {
                const l = el ? lum(window.parent.getComputedStyle(el).backgroundColor) : null;
                if (l !== null) return l < 0.5 ? 'dark' : 'light';
            }
        }
    } catch { /* ignore */ }
    // 2. Gespeichertes Admin-Theme
    let name = '';
    try {
        const ls = window.localStorage;
        name = ls.getItem('App.themeType') || ls.getItem('App.themeName') || ls.getItem('App.theme') || '';
    } catch { /* ignore */ }
    if (!name) {
        try { name = new URLSearchParams(window.location.search).get('react') || ''; } catch { /* ignore */ }
    }
    if (name === 'dark' || name === 'blue') return 'dark';
    if (name === 'light' || name === 'colored') return 'light';
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

const TOKENS = {
    light: {
        '--lm-bg': '#f1f3f4', '--lm-surface': '#ffffff', '--lm-sunken': '#eaeded', '--lm-line': '#e3e7e8',
        '--lm-text': '#1b1e20', '--lm-muted': '#656d72', '--lm-accent': '#3a9a78', '--lm-ink': '#ffffff',
        '--lm-soft': '#e2f3ec', '--lm-ok': '#2e9e6b', '--lm-bad': '#c9423a', '--lm-warn': '#b9770e',
        '--lm-stage': '#e6f1ed', '--lm-glow': '#d9f3ea',
    },
    dark: {
        '--lm-bg': '#101213', '--lm-surface': '#191c1d', '--lm-sunken': '#141617', '--lm-line': '#2a2e30',
        '--lm-text': '#e8ebec', '--lm-muted': '#9aa3a6', '--lm-accent': '#6fc4a3', '--lm-ink': '#08140f',
        '--lm-soft': '#1b2a24', '--lm-ok': '#6fc4a3', '--lm-bad': '#ff8a80', '--lm-warn': '#e0a64a',
        '--lm-stage': '#19231f', '--lm-glow': '#16302a',
    },
};

function buildTheme(type) {
    const t = TOKENS[type];
    return createTheme({
        palette: {
            mode: type,
            background: { default: t['--lm-bg'], paper: t['--lm-surface'] },
            primary: { main: t['--lm-accent'], contrastText: t['--lm-ink'] },
            text: { primary: t['--lm-text'], secondary: t['--lm-muted'] },
            divider: t['--lm-line'],
        },
        shape: { borderRadius: 10 },
        typography: {
            fontFamily: 'Geist, "Helvetica Neue", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
            button: { textTransform: 'none', fontWeight: 500 },
        },
        components: {
            MuiCard: { styleOverrides: { root: { backgroundImage: 'none', backgroundColor: 'var(--lm-surface)', border: '1px solid var(--lm-line)', borderRadius: 16, boxShadow: 'none' } } },
            MuiCardContent: { styleOverrides: { root: { padding: 20, '&:last-child': { paddingBottom: 20 } } } },
            MuiPaper: { styleOverrides: { root: { backgroundImage: 'none' } } },
            MuiButton: {
                styleOverrides: {
                    root: { borderRadius: 10, transition: 'transform 160ms cubic-bezier(0.23,1,0.32,1), background-color 160ms', '&:active': { transform: 'scale(0.97)' } },
                },
            },
            MuiChip: { styleOverrides: { root: { borderRadius: 16 } } },
        },
    });
}

function GlobalTokens({ type }) {
    const t = TOKENS[type];
    const vars = Object.entries(t).map(([k, v]) => `${k}:${v};`).join('');
    return (
        <GlobalStyles styles={`
            :root { ${vars} color-scheme: ${type}; }
            html, body { background-color: var(--lm-bg) !important; }
            body { background-image: linear-gradient(180deg, var(--lm-glow) 0, var(--lm-bg) 380px) !important; background-repeat: no-repeat; min-height: 100dvh; }
            @media (prefers-reduced-motion: reduce) { * { transition-duration: 1ms !important; animation-duration: 1ms !important; } }
        `} />
    );
}

const ADAPTER = (window.adapterInstance || 'leapmotor.0').replace(/^system\.adapter\./, '');

export default function App() {
    const { connected, error, states, getStates, getObjects, setState, sendTo, systemLanguage } = useConnection(ADAPTER);
    // Sprache SYNCHRON während des Renderns setzen (nicht in einem useEffect,
    // da Effects erst NACH dem Rendern laufen - das würde bedeuten, dass genau
    // der erste Render-Durchlauf mit bekannter Sprache noch die alte/Default-
    // Sprache für alle I18n.t()-Aufrufe verwendet).
    if (systemLanguage && I18n.getLanguage() !== systemLanguage) {
        I18n.setLanguage(systemLanguage);
    }
    const [tab, setTab] = useState(0);
    const themeType = useMemo(detectThemeType, []);
    const theme = useMemo(() => buildTheme(themeType), [themeType]);
    const [vins, setVins] = useState([]);
    const [selectedVin, setSelectedVin] = useState(null);
    const [loading, setLoading] = useState(true);
    const [debugInfo, setDebugInfo] = useState('');

    useEffect(() => {
        setDebugInfo(`adapterInstance=${window.adapterInstance}, ADAPTER=${ADAPTER}, window.io=${!!window.io}`);
    }, []);

    useEffect(() => {
        if (!connected) return;
        getObjects(`${ADAPTER}.*`, (err, objs) => {
            if (err || !objs) { setLoading(false); return; }
            const found = new Set();
            Object.keys(objs).forEach(id => {
                const m = id.match(new RegExp(`^${ADAPTER}\\.([A-Z0-9]+)\\.info\\.vin$`));
                if (m) found.add(m[1]);
            });
            const list = Array.from(found).sort();
            setVins(list);
            if (list.length && !selectedVin) setSelectedVin(list[0]);
            getStates(`${ADAPTER}.*`, () => setLoading(false));
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [connected]);

    const base = selectedVin ? `${ADAPTER}.${selectedVin}` : null;

    const vehicleName = (vin) => states[`${ADAPTER}.${vin}.info.name`]?.val || vin;

    const currentVehicleName = useMemo(() => {
        if (!base) return '';
        return states[`${base}.info.name`]?.val || selectedVin || '';
    }, [states, base, selectedVin]);

    if (error || (!connected && loading)) {
        return (
            <ThemeProvider theme={theme}>
                <CssBaseline />
                <Box sx={{ p: 3 }}>
                    <Alert severity={error ? 'error' : 'info'} sx={{ mb: 2 }}>
                        {error || I18n.t('Connecting...')}
                    </Alert>
                    <Typography variant="caption" sx={{ display: 'block', color: 'var(--lm-muted)', fontFamily: 'monospace' }}>
                        Debug: {debugInfo}
                    </Typography>
                    <Typography variant="caption" sx={{ display: 'block', color: 'var(--lm-muted)', fontFamily: 'monospace' }}>
                        connected={String(connected)}, loading={String(loading)}
                    </Typography>
                    {!error && <CircularProgress sx={{ mt: 2 }} />}
                </Box>
            </ThemeProvider>
        );
    }

    return (
        <ThemeProvider theme={theme}>
            <CssBaseline />
            <GlobalTokens type={themeType} />
            <Box sx={{ minHeight: '100dvh', maxWidth: 1240, mx: 'auto', px: { xs: 2, md: 3 }, pb: 4 }}>
                <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1.5, pt: 2.5, flexWrap: 'wrap' }}>
                    <Typography sx={{ fontWeight: 700, fontSize: 16, letterSpacing: '-0.01em' }}>Leapmotor</Typography>
                    {vins.length <= 1 && currentVehicleName && (
                        <Typography sx={{ color: 'var(--lm-muted)', fontSize: 16 }}>{currentVehicleName}</Typography>
                    )}
                    <Box sx={{ flexGrow: 1 }} />
                    {vins.length > 1 && (
                        <Select size="small" value={selectedVin || ''} onChange={(e) => setSelectedVin(e.target.value)} sx={{ minWidth: 140, alignSelf: 'center' }}>
                            {vins.map((vin) => (<MenuItem key={vin} value={vin}>{vehicleName(vin)}</MenuItem>))}
                        </Select>
                    )}
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, color: 'var(--lm-muted)', fontSize: 13 }}>
                        <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: connected ? 'var(--lm-ok)' : 'var(--lm-bad)' }} />
                        {connected ? I18n.t('Connected') : I18n.t('Connecting...')}
                    </Box>
                </Box>
                <Tabs
                    value={tab}
                    onChange={(_, v) => setTab(v)}
                    variant="scrollable"
                    scrollButtons={false}
                    sx={{
                        mt: 1.5, mb: 3, minHeight: 44, borderBottom: '1px solid var(--lm-line)',
                        touchAction: 'pan-x', overscrollBehavior: 'contain',
                        '& .MuiTabs-scroller': { overflowY: 'hidden !important' },
                        '& .MuiTabs-indicator': { height: 2, bgcolor: 'var(--lm-text)' },
                        '& .MuiTab-root': { minHeight: 44, minWidth: 0, px: 0, mr: 3, fontSize: 15, color: 'var(--lm-muted)', textTransform: 'none' },
                        '& .MuiTab-root.Mui-selected': { color: 'var(--lm-text)' },
                    }}
                >
                    <Tab disableRipple label={I18n.t('Dashboard')} />
                    <Tab disableRipple label={I18n.t('Consumption')} />
                    <Tab disableRipple label={I18n.t('Trips')} />
                    <Tab disableRipple label={I18n.t('Diagnostics')} />
                    <Tab disableRipple label={I18n.t('Settings')} />
                    <Tab disableRipple label={I18n.t('Datapoints')} />
                </Tabs>

                <Box>
                    {!base && <Typography color="text.secondary">{I18n.t('No vehicle found. Is the adapter running?')}</Typography>}
                    {base && tab === 0 && <DashboardTab base={base} states={states} setState={setState} />}
                    {base && tab === 1 && <ConsumptionTab base={base} states={states} adapter={ADAPTER} />}
                    {base && tab === 2 && <TripsTab base={base} states={states} setState={setState} />}
                    {base && tab === 3 && <DiagnosticsTab base={base} states={states} setState={setState} adapter={ADAPTER} />}
                    {tab === 4 && <SettingsTab adapter={ADAPTER} base={base} states={states} setState={setState} sendTo={sendTo} />}
                    {base && tab === 5 && <DatapointsTab base={base} states={states} />}
                </Box>
            </Box>
        </ThemeProvider>
    );
}
