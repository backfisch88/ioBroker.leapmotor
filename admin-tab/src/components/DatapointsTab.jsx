import React, { useState } from 'react';
import {
    Box, Accordion, AccordionSummary, AccordionDetails, Typography,
    Table, TableBody, TableCell, TableRow, Chip,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';

const GROUPS = {
    'Batterie': ['battery_soc', 'battery_current', 'battery_voltage', 'battery_energy_kwh', 'temp_battery_min'],
    'Reichweite & Verbrauch': ['range_km', 'range_miles', 'mileage_total'],
    'Laden': ['charging_active', 'charging_state', 'charging_soc_limit', 'charging_remain_min', 'charging_plugged', 'dc_fast_charge', 'charge_time_setting'],
    'Klima': ['ac_on', 'ac_temp', 'ac_fan_speed', 'ac_fan_speed_setting', 'ac_wind_direction', 'ac_recirculate', 'ac_cooling_heating', 'ptc_state', 'ptc_power'],
    'Fahren': ['drive_speed', 'drive_parked', 'gear', 'key_position'],
    'Sicherheit & Türen': ['security_locked', 'door_ctrl_allow', 'door_driver', 'door_front_right', 'door_rear_left', 'door_rear_right', 'door_trunk'],
    'Fenster': ['window_fl_pct', 'window_fr_pct', 'window_rl_pct', 'window_rr_pct', 'window_driver_open', 'window_fr_open', 'window_rl_open', 'window_rr_open', 'sun_shade'],
    'Reifen': ['tire_fl', 'tire_fr', 'tire_rl', 'tire_rr', 'tire_fl_state', 'tire_fr_state', 'tire_rl_state', 'tire_rr_state'],
    'Standort & Datenschutz': ['location_lat', 'location_lon', 'privacy_gps', 'privacy_data'],
    'Konnektivität': ['bluetooth_on', 'bluetooth_addr', 'hotspot_on'],
    'Sonstiges': ['temp_outdoor', 'collect_time', 'collect_time_ms'],
};

function formatVal(v) {
    if (v === null || v === undefined) return '—';
    if (typeof v === 'boolean') return v ? '✓ true' : '✗ false';
    return String(v);
}

export default function DatapointsTab({ base, states }) {
    const [expanded, setExpanded] = useState('Batterie');

    return (
        <Box>
            {Object.entries(GROUPS).map(([groupName, keys]) => (
                <Accordion
                    key={groupName}
                    expanded={expanded === groupName}
                    onChange={() => setExpanded(expanded === groupName ? null : groupName)}
                    sx={{ bgcolor: '#0d1520', border: '1px solid #1e2d45', mb: 1 }}
                >
                    <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                        <Typography sx={{ fontWeight: 700 }}>{groupName}</Typography>
                        <Chip size="small" label={keys.length} sx={{ ml: 1, height: 20 }} />
                    </AccordionSummary>
                    <AccordionDetails>
                        <Table size="small">
                            <TableBody>
                                {keys.map(k => {
                                    const id = `${base}.status.${k}`;
                                    const v = states[id]?.val;
                                    return (
                                        <TableRow key={k}>
                                            <TableCell sx={{ color: '#5a7090', borderColor: '#1e2d45' }}>{k}</TableCell>
                                            <TableCell sx={{ color: '#c8ddf0', borderColor: '#1e2d45', fontFamily: 'monospace' }}>
                                                {formatVal(v)}
                                            </TableCell>
                                        </TableRow>
                                    );
                                })}
                            </TableBody>
                        </Table>
                    </AccordionDetails>
                </Accordion>
            ))}
        </Box>
    );
}
