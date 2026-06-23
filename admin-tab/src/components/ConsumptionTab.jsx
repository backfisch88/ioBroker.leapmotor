import React, { useMemo } from 'react';
import { Box, Card, CardContent, Typography, Grid, Divider } from '@mui/material';
import {
    ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, LabelList, ReferenceLine,
} from 'recharts';

function val(states, id, def = null) {
    return states[id]?.val ?? def;
}

function StatBox({ label, value, sub, color }) {
    return (
        <Card sx={{
            bgcolor: '#0d1520', border: '1px solid #1e2d45', textAlign: 'center',
            height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'center',
        }}>
            <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
                <Typography variant="caption" sx={{ color: '#3a5070', letterSpacing: '0.1em', display: 'block' }}>{label}</Typography>
                <Typography variant="h6" sx={{ fontWeight: 800, color: color || '#c8ddf0', whiteSpace: 'nowrap' }}>{value}</Typography>
                {sub && <Typography variant="caption" sx={{ color: '#5a7090', display: 'block' }}>{sub}</Typography>}
            </CardContent>
        </Card>
    );
}

export default function ConsumptionTab({ base, states }) {
    const avgKwh = val(states, `${base}.consumption.kwh_100km`, null);
    const rank = val(states, `${base}.consumption.rank`, null);
    const totalKm = val(states, `${base}.consumption.mileage_total_km`, null);
    const totalMiles = val(states, `${base}.consumption.mileage_total_miles`, null);

    const fmtDate = (iso) => {
        if (!iso || iso.length < 10) return iso;
        const [y, m, d] = iso.split('-');
        return `${d}.${m}.${y}`;
    };
    const fmtShort = (iso) => {
        if (!iso || iso.length < 10) return iso;
        const [, m, d] = iso.split('-');
        return `${d}.${m}`;
    };

    const energyPrice = val(states, `${base}.config.energy_price_eur_kwh`, 0.30);

    const weeklyData = useMemo(() => {
        const data = [];
        for (let i = 1; i <= 6; i++) {
            const wb = `${base}.consumption.week_${i}`;
            const kwh = val(states, `${wb}.kwh_100km`, null);
            const start = val(states, `${wb}.week_start`, '');
            const end = val(states, `${wb}.week_end`, '');
            if (kwh === null) continue;
            data.push({
                week: start ? fmtShort(start) : `W${i}`,
                fullRange: start && end ? `${fmtDate(start)} – ${fmtDate(end)}` : '',
                kwh100km: kwh,
            });
        }
        return data;
    }, [states, base]);

    const stats = useMemo(() => {
        if (weeklyData.length === 0) return null;
        const vals = weeklyData.map(d => d.kwh100km);
        const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
        const min = Math.min(...vals);
        const max = Math.max(...vals);
        const best = weeklyData.find(d => d.kwh100km === min);
        const worst = weeklyData.find(d => d.kwh100km === max);
        // einfacher Trend: letzter Wert vs. Durchschnitt der vorherigen
        const last = vals[vals.length - 1];
        const prevAvg = vals.length > 1 ? vals.slice(0, -1).reduce((a, b) => a + b, 0) / (vals.length - 1) : last;
        const trend = last - prevAvg;
        return { avg, min, max, best, worst, trend };
    }, [weeklyData]);

    const chartData = useMemo(() => weeklyData.map(d => ({
        ...d,
        avgLine: stats ? Math.round(stats.avg * 10) / 10 : null,
    })), [weeklyData, stats]);

    return (
        <Box>
            <Grid container spacing={1.5} sx={{ mb: 2 }}>
                <Grid item xs={4}>
                    <StatBox label="Ø VERBRAUCH" value={avgKwh !== null ? `${avgKwh}` : '—'} sub={avgKwh !== null ? `kWh/100km · ≈${(avgKwh * energyPrice).toFixed(2)}€` : 'kWh/100km (Cloud)'} color="#00d4ff" />
                </Grid>
                <Grid item xs={4}>
                    <StatBox label="RANKING" value={rank ?? '—'} />
                </Grid>
                <Grid item xs={4}>
                    <StatBox label="GESAMT" value={totalKm !== null ? `${totalKm}` : '—'} sub={totalMiles ? `km · ${totalMiles} mi` : 'km'} />
                </Grid>
            </Grid>

            {stats && (
                <Grid container spacing={1.5} sx={{ mb: 2 }}>
                    <Grid item xs={4}>
                        <StatBox label="BESTE WOCHE" value={`${stats.min}`} sub={stats.best?.week} color="#00ff88" />
                    </Grid>
                    <Grid item xs={4}>
                        <StatBox label="SCHLECHTESTE" value={`${stats.max}`} sub={stats.worst?.week} color="#ff6644" />
                    </Grid>
                    <Grid item xs={4}>
                        <StatBox
                            label="TREND"
                            value={`${stats.trend > 0 ? '+' : ''}${stats.trend.toFixed(1)}`}
                            sub="vs. Schnitt"
                            color={stats.trend > 0 ? '#ff6644' : '#00ff88'}
                        />
                    </Grid>
                </Grid>
            )}

            <Card sx={{ bgcolor: '#0d1520', border: '1px solid #1e2d45' }}>
                <CardContent>
                    <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 2 }}>
                        Verbrauch der letzten 6 Wochen
                    </Typography>
                    {weeklyData.length === 0 ? (
                        <Typography color="text.secondary">Noch keine Wochendaten verfügbar.</Typography>
                    ) : (
                        <>
                            <ResponsiveContainer width="100%" height={300}>
                                <ComposedChart data={chartData} margin={{ top: 28, right: 8, left: -8, bottom: 4 }}>
                                    <CartesianGrid strokeDasharray="3 3" stroke="#1e2d45" vertical={false} />
                                    <XAxis dataKey="week" stroke="#5a7090" fontSize={12} tickLine={false} tick={{ fill: '#8aa0bd', fontWeight: 600 }} />
                                    <YAxis stroke="#5a7090" fontSize={12} tickLine={false} width={36} domain={[dataMin => Math.floor(dataMin - 1), dataMax => Math.ceil(dataMax + 1)]} tick={{ fill: '#8aa0bd' }} />
                                    <Tooltip
                                        contentStyle={{ background: '#0d1520', border: '1px solid #2a4060', borderRadius: 10, color: '#c8ddf0', fontSize: 13 }}
                                        labelStyle={{ color: '#00d4ff', fontWeight: 700, marginBottom: 4 }}
                                        itemStyle={{ color: '#c8ddf0' }}
                                        formatter={(v, name) => name === 'kwh100km' ? [`${v} kWh/100km`, 'Verbrauch'] : [null, null]}
                                        labelFormatter={(label, payload) => payload?.[0]?.payload?.fullRange || label}
                                    />
                                    {stats && (
                                        <ReferenceLine
                                            y={stats.avg}
                                            stroke="#3a5070"
                                            strokeDasharray="6 3"
                                            label={{ value: `Ø ${stats.avg.toFixed(1)}`, position: 'insideTopRight', fill: '#5a7090', fontSize: 12 }}
                                        />
                                    )}
                                    <Bar dataKey="kwh100km" name="kwh100km" radius={[8, 8, 0, 0]} maxBarSize={52}>
                                        <LabelList dataKey="kwh100km" position="top" style={{ fill: '#ffffff', fontSize: 14, fontWeight: 800 }} />
                                        {weeklyData.map((entry, idx) => (
                                            <Cell key={idx} fill={entry.kwh100km > 18 ? '#ff6644' : entry.kwh100km > 14 ? '#ffcc00' : '#00cc66'} fillOpacity={0.9} />
                                        ))}
                                    </Bar>
                                </ComposedChart>
                            </ResponsiveContainer>
                            <Divider sx={{ borderColor: '#1e2d45', my: 2 }} />
                            <Grid container spacing={1}>
                                {weeklyData.map((w, i) => (
                                    <Grid item xs={6} key={i}>
                                        <Box sx={{ bgcolor: '#070d1a', border: '1px solid #1e2d45', borderRadius: 1.5, px: 1.5, py: 1 }}>
                                            <Typography variant="caption" sx={{ color: '#5a7090', display: 'block', fontSize: '0.7rem' }}>{w.fullRange || w.week}</Typography>
                                            <Typography sx={{
                                                color: w.kwh100km > 18 ? '#ff6644' : w.kwh100km > 14 ? '#ffcc00' : '#00cc66',
                                                fontWeight: 800, fontSize: '1rem',
                                            }}>
                                                {w.kwh100km} <Typography component="span" variant="caption" sx={{ color: '#5a7090' }}>kWh/100km</Typography>
                                            </Typography>
                                            <Typography variant="caption" sx={{ color: '#00ff88', display: 'block' }}>
                                                ≈ {(w.kwh100km * energyPrice).toFixed(2)} €/100km
                                            </Typography>
                                        </Box>
                                    </Grid>
                                ))}
                            </Grid>
                        </>
                    )}
                </CardContent>
            </Card>
        </Box>
    );
}
