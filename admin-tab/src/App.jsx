import React, { useState, useEffect, useMemo } from 'react';
import {
    ThemeProvider, createTheme, CssBaseline, Box, Tabs, Tab,
    AppBar, Toolbar, Typography, CircularProgress, Alert,
} from '@mui/material';
import DashboardIcon from '@mui/icons-material/DirectionsCar';
import ListAltIcon from '@mui/icons-material/ListAlt';
import BarChartIcon from '@mui/icons-material/BarChart';
import BuildIcon from '@mui/icons-material/Build';

import { useConnection } from './useConnection';
import DashboardTab from './components/DashboardTab';
import DatapointsTab from './components/DatapointsTab';
import ConsumptionTab from './components/ConsumptionTab';
import DiagnosticsTab from './components/DiagnosticsTab';

const theme = createTheme({
    palette: {
        mode: 'dark',
        background: { default: '#070d1a', paper: '#0d1520' },
        primary: { main: '#00d4ff' },
        text: { primary: '#c8ddf0', secondary: '#5a7090' },
    },
    shape: { borderRadius: 12 },
});

const ADAPTER = (window.adapterInstance || 'leapmotor.0').replace(/^system\.adapter\./, '');

export default function App() {
    const { connected, error, states, getStates, getObjects, setState } = useConnection(ADAPTER);
    const [tab, setTab] = useState(0);
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
            const list = Array.from(found);
            setVins(list);
            if (list.length && !selectedVin) setSelectedVin(list[0]);
            getStates(`${ADAPTER}.*`, () => setLoading(false));
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [connected]);

    const base = selectedVin ? `${ADAPTER}.${selectedVin}` : null;

    const vehicleName = useMemo(() => {
        if (!base) return '';
        return states[`${base}.info.name`]?.val || selectedVin || '';
    }, [states, base, selectedVin]);

    if (error || (!connected && loading)) {
        return (
            <ThemeProvider theme={theme}>
                <CssBaseline />
                <Box sx={{ p: 3 }}>
                    <Alert severity={error ? 'error' : 'info'} sx={{ mb: 2 }}>
                        {error || 'Verbinde...'}
                    </Alert>
                    <Typography variant="caption" sx={{ display: 'block', color: '#5a7090', fontFamily: 'monospace' }}>
                        Debug: {debugInfo}
                    </Typography>
                    <Typography variant="caption" sx={{ display: 'block', color: '#5a7090', fontFamily: 'monospace' }}>
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
            <Box sx={{ minHeight: '100vh', bgcolor: 'background.default' }}>
                <AppBar position="static" elevation={0} sx={{ bgcolor: 'background.paper', borderBottom: '1px solid #1e2d45' }}>
                    <Toolbar>
                        <Typography variant="h6" sx={{ flexGrow: 1, fontWeight: 800, letterSpacing: '0.05em' }}>
                            🚗 LEAPMOTOR {vehicleName ? `— ${vehicleName}` : ''}
                        </Typography>
                        <Box sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: connected ? '#00ff88' : '#ff4444' }} />
                    </Toolbar>
                    <Tabs
                        value={tab}
                        onChange={(_, v) => setTab(v)}
                        textColor="primary"
                        indicatorColor="primary"
                        variant="scrollable"
                        scrollButtons="auto"
                        allowScrollButtonsMobile
                    >
                        <Tab icon={<DashboardIcon />} label="Dashboard" />
                        <Tab icon={<BarChartIcon />} label="Verbrauch" />
                        <Tab icon={<ListAltIcon />} label="Datenpunkte" />
                        <Tab icon={<BuildIcon />} label="Diagnose" />
                    </Tabs>
                </AppBar>

                <Box sx={{ p: 2 }}>
                    {!base && <Typography color="text.secondary">Kein Fahrzeug gefunden. Ist der Adapter gestartet?</Typography>}
                    {base && tab === 0 && <DashboardTab base={base} states={states} setState={setState} />}
                    {base && tab === 1 && <ConsumptionTab base={base} states={states} />}
                    {base && tab === 2 && <DatapointsTab base={base} states={states} />}
                    {base && tab === 3 && <DiagnosticsTab base={base} states={states} setState={setState} adapter={ADAPTER} />}
                </Box>
            </Box>
        </ThemeProvider>
    );
}
