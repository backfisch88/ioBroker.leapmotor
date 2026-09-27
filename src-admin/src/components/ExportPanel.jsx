import React, { useState } from 'react';
import {
    Box, Card, CardContent, Typography, TextField, Button, Divider,
} from '@mui/material';
import { I18n } from '@iobroker/adapter-react-v5';
import DownloadIcon from '@mui/icons-material/Download';
import PictureAsPdfIcon from '@mui/icons-material/PictureAsPdf';

function val(states, id, def = null) {
    return states[id]?.val ?? def;
}

function isoDateInput(ms) {
    const d = new Date(ms);
    return d.toISOString().slice(0, 10);
}

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Trip data is already loaded in `states` via the normal subscription (same
// history_json every other tab reads) - no extra backend round-trip needed,
// this just filters + formats what's already there for a chosen date range.
export default function ExportPanel({ base, states }) {
    const now = Date.now();
    const monthAgo = now - 30 * 86400000;
    const [fromDate, setFromDate] = useState(isoDateInput(monthAgo));
    const [toDate, setToDate] = useState(isoDateInput(now));
    const [busy, setBusy] = useState(false);

    const getTripsInRange = () => {
        const raw = val(states, `${base}.trips.history_json`, '[]');
        let history = [];
        try { history = JSON.parse(raw); } catch { history = []; }
        const fromMs = new Date(`${fromDate}T00:00:00`).getTime();
        const toMs = new Date(`${toDate}T23:59:59`).getTime();
        return history
            .filter(t => t.startTimeMs >= fromMs && t.startTimeMs <= toMs)
            .sort((a, b) => a.startTimeMs - b.startTimeMs);
    };

    const exportCsv = () => {
        const trips = getTripsInRange();
        const headers = [
            I18n.t('Date'), I18n.t('Start'), I18n.t('End'), 'km',
            I18n.t('Duration (min)'), I18n.t('SoC used (%)'),
            I18n.t('Driving (kWh)'), I18n.t('Climate (kWh)'), I18n.t('Other (kWh)'),
            I18n.t('Regen (kWh)'), I18n.t('Min Temp (°C)'), I18n.t('Max Temp (°C)'),
            I18n.t('Elevation (m)'),
        ];
        const rows = trips.map(t => [
            t.date, t.startTime, t.endTime, t.km, t.durationMin, t.socUsed ?? '',
            t.energyDrivingKwh ?? '', t.energyAcKwh ?? '', t.energyOtherKwh ?? '',
            t.regenKwh ?? '', t.tempMinC ?? '', t.tempMaxC ?? '', t.elevGainM ?? '',
        ]);
        const csv = [headers, ...rows]
            .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(';'))
            .join('\r\n');
        // \ufeff BOM so Excel opens umlauts correctly instead of mangling them
        const blob = new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8;' });
        downloadBlob(blob, `leapmotor_fahrten_${fromDate}_${toDate}.csv`);
    };

    const exportPdf = async () => {
        setBusy(true);
        try {
            const [{ default: jsPDF }] = await Promise.all([
                import('jspdf'),
                import('jspdf-autotable'),
            ]);
            const trips = getTripsInRange();
            const doc = new jsPDF({ orientation: 'landscape' });

            doc.setFontSize(16);
            doc.text(I18n.t('Fahrtenbuch'), 14, 15);
            doc.setFontSize(10);
            doc.text(`${fromDate} - ${toDate}`, 14, 22);

            const totalKm = Math.round(trips.reduce((s, t) => s + (t.km || 0), 0) * 10) / 10;
            const totalMin = trips.reduce((s, t) => s + (t.durationMin || 0), 0);
            doc.text(
                `${I18n.t('Trips')}: ${trips.length}  |  ${I18n.t('Total')}: ${totalKm} km  |  ${I18n.t('Duration')}: ${Math.round(totalMin / 60)} h ${totalMin % 60} min`,
                14, 28,
            );

            doc.autoTable({
                startY: 34,
                head: [[
                    I18n.t('Date'), I18n.t('Start'), I18n.t('End'), 'km',
                    I18n.t('Duration (min)'), I18n.t('SoC used (%)'),
                    I18n.t('Driving (kWh)'), I18n.t('Climate (kWh)'), I18n.t('Other (kWh)'),
                    I18n.t('Regen (kWh)'), I18n.t('Temp (°C)'), I18n.t('Elevation (m)'),
                ]],
                body: trips.map(t => [
                    t.date, t.startTime.split(', ')[1] || t.startTime, t.endTime.split(', ')[1] || t.endTime,
                    t.km, t.durationMin, t.socUsed ?? '-',
                    t.energyDrivingKwh ?? '-', t.energyAcKwh ?? '-', t.energyOtherKwh ?? '-',
                    t.regenKwh ?? '-',
                    (t.tempMinC != null) ? (t.tempMinC === t.tempMaxC ? `${t.tempMinC}` : `${t.tempMinC}-${t.tempMaxC}`) : '-',
                    t.elevGainM ?? '-',
                ]),
                styles: { fontSize: 8 },
                headStyles: { fillColor: [0, 60, 90] },
            });

            doc.save(`leapmotor_fahrtenbuch_${fromDate}_${toDate}.pdf`);
        } finally {
            setBusy(false);
        }
    };

    return (
        <Card sx={{ mb: 2, bgcolor: '#0d1520', border: '1px solid #1e2d45' }}>
            <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
                <Typography
                    variant="caption"
                    sx={{ color: '#3a5070', letterSpacing: '0.1em', display: 'block', mb: 1 }}
                >
                    {I18n.t('EXPORT')}
                </Typography>
                <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', alignItems: 'center' }}>
                    <TextField
                        type="date"
                        label={I18n.t('From')}
                        value={fromDate}
                        onChange={e => setFromDate(e.target.value)}
                        size="small"
                        InputLabelProps={{ shrink: true }}
                    />
                    <TextField
                        type="date"
                        label={I18n.t('To')}
                        value={toDate}
                        onChange={e => setToDate(e.target.value)}
                        size="small"
                        InputLabelProps={{ shrink: true }}
                    />
                    <Button
                        variant="outlined"
                        size="small"
                        startIcon={<DownloadIcon />}
                        onClick={exportCsv}
                    >
                        CSV
                    </Button>
                    <Button
                        variant="outlined"
                        size="small"
                        startIcon={<PictureAsPdfIcon />}
                        onClick={exportPdf}
                        disabled={busy}
                    >
                        {I18n.t('PDF (Fahrtenbuch)')}
                    </Button>
                </Box>
            </CardContent>
        </Card>
    );
}
