import React from 'react';
import { Box, Card, CardContent, Typography, Chip, Button, Grid, Divider } from '@mui/material';
import { I18n } from '@iobroker/adapter-react-v5';
import RefreshIcon from '@mui/icons-material/Refresh';
import WifiIcon from '@mui/icons-material/Wifi';
import WifiOffIcon from '@mui/icons-material/WifiOff';

function val(states, id, def = null) {
    return states[id]?.val ?? def;
}

export default function DiagnosticsTab({ base, states, setState, adapter }) {
    const connection = val(states, `${adapter}.info.connection`, false);
    const collectTime = val(states, `${base}.status.last_poll_time`, '—');
    const vin = val(states, `${base}.info.vin`, '—');
    const model = val(states, `${base}.info.model`, '—');
    const year = val(states, `${base}.info.year`, '—');
    const rudder = val(states, `${base}.info.rudder`, '—');
    const allocationCode = val(states, `${base}.info.allocation_code`, '—');

    return (
        <Box>
            <Card sx={{ mb: 2, bgcolor: '#0d1520', border: '1px solid #1e2d45' }}>
                <CardContent>
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
                        {I18n.t('Last data update')}: {collectTime}
                    </Typography>
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

            <Card sx={{ bgcolor: '#0d1520', border: '1px solid #1e2d45' }}>
                <CardContent>
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
                            <Grid item xs={6} key={label}>
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
