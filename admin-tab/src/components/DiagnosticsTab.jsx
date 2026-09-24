import React from 'react';
import { Box, Card, CardContent, Typography, Chip, Button, Divider } from '@mui/material';
import Grid from '@mui/material/Grid2';
import { I18n } from '@iobroker/adapter-react-v5';
import RefreshIcon from '@mui/icons-material/Refresh';
import WifiIcon from '@mui/icons-material/Wifi';
import WifiOffIcon from '@mui/icons-material/WifiOff';

function val(states, id, def = null) {
    return states[id]?.val ?? def;
}

export default function DiagnosticsTab({ base, states, setState, adapter }) {
    const connection = val(states, `${adapter}.info.connection`, false);
    // The vehicle's OWN reported timestamp for this data frame - not when
    // our poll happened to succeed. The cloud can silently serve a cached/
    // stale frame while the car is asleep, so "our poll succeeded" doesn't
    // mean "this is what the car reports right now".
    const collectTime = val(states, `${base}.status.collect_time`, '—');
    const dataAgeMin = val(states, `${base}.status.data_age_min`, null);
    const dataStale = val(states, `${base}.status.data_stale`, false);
    const vin = val(states, `${base}.info.vin`, '—');
    const model = val(states, `${base}.info.model`, '—');
    const year = val(states, `${base}.info.year`, '—');
    const rudder = val(states, `${base}.info.rudder`, '—');
    const allocationCode = val(states, `${base}.info.allocation_code`, '—');
    const sohPercent = val(states, `${base}.battery.soh_percent`, 0);
    const estimatedCapacity = val(states, `${base}.battery.estimated_capacity_kwh`, 0);
    const sohSampleCount = val(states, `${base}.battery.soh_sample_count`, 0);

    return (
        <Box>
            <Card sx={{ mb: 2, bgcolor: '#0d1520', border: '1px solid #1e2d45' }}>
                <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
                        {connection ? <WifiIcon sx={{ color: '#00ff88' }} /> : <WifiOffIcon sx={{ color: '#ff4444' }} />}
                        <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                            {I18n.t('Cloud Connection')}
                        </Typography>
                        <Chip
                            size="small"
                            label={connection ? I18n.t('Connected') : I18n.t('Disconnected')}
                            sx={{ bgcolor: connection ? '#00ff8822' : '#ff444422', color: connection ? '#00ff88' : '#ff4444' }}
                        />
                    </Box>
                    <Typography variant="body2" sx={{ color: '#5a7090' }}>
                        {I18n.t('Vehicle last reported')}: {collectTime}
                        {dataAgeMin != null && ` (${dataAgeMin} ${I18n.t('min ago')})`}
                    </Typography>
                    {dataStale && (
                        <Typography variant="caption" sx={{ color: '#ffaa00', display: 'block', mt: 0.5 }}>
                            ⚠️ {I18n.t('Data is over 30 minutes old - the cloud may be serving a cached frame while the vehicle sleeps')}
                        </Typography>
                    )}
                    <Button
                        startIcon={<RefreshIcon />}
                        sx={{ mt: 2 }}
                        variant="outlined"
                        onClick={() => setState(`${base}.cmd.refresh`, true)}
                    >
                        {I18n.t('Refresh Status Now')}
                    </Button>
                </CardContent>
            </Card>

            <Card sx={{ mb: 2, bgcolor: '#0d1520', border: '1px solid #1e2d45' }}>
                <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
                    <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1 }}>
                        {I18n.t('Battery Health (estimated)')}
                    </Typography>
                    {sohPercent ? (
                        <>
                            <Typography sx={{ fontSize: '1.8rem', fontWeight: 800, color: sohPercent >= 90 ? '#00ff88' : sohPercent >= 80 ? '#ffcc00' : '#ff6644' }}>
                                {sohPercent}%
                            </Typography>
                            <Typography variant="caption" sx={{ color: '#5a7090', display: 'block' }}>
                                {I18n.t('Estimated capacity')}: {estimatedCapacity} kWh · {I18n.t('based on')} {sohSampleCount} {I18n.t('trips')}
                            </Typography>
                        </>
                    ) : (
                        <Typography variant="caption" sx={{ color: '#5a7090' }}>
                            {I18n.t('Not enough trip data yet - needs at least 3 trips with official cloud energy data and a meaningful SoC drop.')}
                        </Typography>
                    )}
                    <Typography variant="caption" sx={{ color: '#3a5070', display: 'block', mt: 1, fontStyle: 'italic' }}>
                        {I18n.t('Rough estimate from official per-trip energy vs. SoC used - not a manufacturer diagnostic figure.')}
                    </Typography>
                </CardContent>
            </Card>

            <Card sx={{ bgcolor: '#0d1520', border: '1px solid #1e2d45' }}>
                <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
                    <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1.5 }}>
                        {I18n.t('Vehicle Information')}
                    </Typography>
                    <Divider sx={{ borderColor: '#1e2d45', mb: 1.5 }} />
                    <Grid container spacing={1.5}>
                        {[
                            ['VIN', vin],
                            [I18n.t('Model'), model],
                            [I18n.t('Year'), year],
                            [I18n.t('Steering'), rudder],
                            [I18n.t('Allocation Code'), allocationCode],
                        ].map(([label, value]) => (
                            <Grid size={6} key={label}>
                                <Typography variant="caption" sx={{ color: '#3a5070' }}>{label}</Typography>
                                <Typography sx={{ fontFamily: 'monospace', color: '#c8ddf0' }}>{value}</Typography>
                            </Grid>
                        ))}
                    </Grid>
                </CardContent>
            </Card>
        </Box>
    );
}
