import React, { useMemo } from 'react';
import { Box, Card, CardContent, Typography, Divider } from '@mui/material';
import Grid from '@mui/material/Grid2';
import { I18n } from '@iobroker/adapter-react-v5';
import {
    ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, LabelList, ReferenceLine,
} from 'recharts';

function val(states, id, def = null) {
    return states[id]?.val ?? def;
}

function StatBox({ label, value, sub, color }) {
    return (
        <Card sx={{
            bgcolor: 'var(--lm-surface)', border: '1px solid var(--lm-line)', textAlign: 'center',
            height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'center',
        }}>
            <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
                <Typography variant="caption" sx={{ color: 'var(--lm-muted)', letterSpacing: '0.1em', display: 'block' }}>{label}</Typography>
                <Typography variant="h6" sx={{ fontWeight: 800, color: color || 'var(--lm-text)', whiteSpace: 'nowrap' }}>{value}</Typography>
                {sub && <Typography variant="caption" sx={{ color: 'var(--lm-muted)', display: 'block' }}>{sub}</Typography>}
            </CardContent>
        </Card>
    );
}

export default function ConsumptionTab({ base, states, adapter }) {
    const avgKwh = val(states, `${base}.consumption.kwh_100km`, null);
    const rank = val(states, `${base}.consumption.rank`, null);
    const totalKm = val(states, `${base}.consumption.mileage_total_km`, null);
    const totalMiles = val(states, `${base}.consumption.mileage_total_miles`, null);

    const homeKwh = Number(val(states, `${base}.charging.home_total_kwh`, 0)) || 0;
    const homeCost = Number(val(states, `${base}.charging.home_total_cost`, 0)) || 0;
    const publicKwh = Number(val(states, `${base}.charging.public_total_kwh`, 0)) || 0;
    const publicCost = Number(val(states, `${base}.charging.public_total_cost`, 0)) || 0;
    const unknownKwh = Number(val(states, `${base}.charging.unknown_total_kwh`, 0)) || 0;
    const unknownCost = Number(val(states, `${base}.charging.unknown_total_cost`, 0)) || 0;
    const sessionActive = val(states, `${base}.charging.session_active`, false);
    const sessionKwh = Number(val(states, `${base}.charging.session_kwh`, 0)) || 0;
    const sessionCost = Number(val(states, `${base}.charging.session_cost`, 0)) || 0;
    const sessionLocation = val(states, `${base}.charging.session_location`, 'unknown');

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

    const energyPrice = val(states, `${adapter}.config.energy_price_eur_kwh`, 0.30);

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
        // simple trend: last value vs. average of the previous ones
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
                <Grid size={4}>
                    <StatBox label={I18n.t('AVG CONSUMPTION')} value={avgKwh !== null ? `${avgKwh}` : '—'} sub={avgKwh !== null ? `kWh/100km · ≈${(avgKwh * energyPrice).toFixed(2)}€` : 'kWh/100km (Cloud)'} color="var(--lm-accent)" />
                </Grid>
                <Grid size={4}>
                    <StatBox label={I18n.t('RANKING')} value={rank ?? '—'} />
                </Grid>
                <Grid size={4}>
                    <StatBox label={I18n.t('TOTAL')} value={totalKm !== null ? `${totalKm}` : '—'} sub={totalMiles ? `km · ${totalMiles} mi` : 'km'} />
                </Grid>
            </Grid>

            <Card sx={{ mb: 2, bgcolor: 'var(--lm-surface)', border: '1px solid var(--lm-line)' }}>
                <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
                    <Typography variant="caption" sx={{ color: 'var(--lm-muted)', letterSpacing: '0.1em', display: 'block', mb: 1 }}>
                        {I18n.t('CHARGING COSTS')}
                    </Typography>
                    <Grid container spacing={1.5}>
                        <Grid size={4}>
                            <StatBox
                                label={I18n.t('Home')}
                                value={`${homeCost.toFixed(2)}€`}
                                sub={`${homeKwh.toFixed(1)} kWh`}
                                color="var(--lm-ok)"
                            />
                        </Grid>
                        <Grid size={4}>
                            <StatBox
                                label={I18n.t('Public')}
                                value={`${publicCost.toFixed(2)}€`}
                                sub={`${publicKwh.toFixed(1)} kWh`}
                                color="var(--lm-warn)"
                            />
                        </Grid>
                        <Grid size={4}>
                            <StatBox
                                label={I18n.t('Unknown')}
                                value={`${unknownCost.toFixed(2)}€`}
                                sub={`${unknownKwh.toFixed(1)} kWh`}
                                color="var(--lm-muted)"
                            />
                        </Grid>
                    </Grid>
                    {sessionActive && (
                        <Typography variant="caption" sx={{ color: 'var(--lm-accent)', display: 'block', mt: 1.5 }}>
                            🔌 {I18n.t('Charging now')}: {sessionKwh.toFixed(1)} kWh · {sessionCost.toFixed(2)}€ ({I18n.t(sessionLocation === 'home' ? 'Home' : sessionLocation === 'public' ? 'Public' : 'Unknown')})
                        </Typography>
                    )}
                </CardContent>
            </Card>

            {stats && (
                <Grid container spacing={1.5} sx={{ mb: 2 }}>
                    <Grid size={4}>
                        <StatBox label={I18n.t('BEST WEEK')} value={`${stats.min}`} sub={stats.best?.week} color="var(--lm-ok)" />
                    </Grid>
                    <Grid size={4}>
                        <StatBox label={I18n.t('WORST WEEK')} value={`${stats.max}`} sub={stats.worst?.week} color="#ff6644" />
                    </Grid>
                    <Grid size={4}>
                        <StatBox
                            label={I18n.t('TREND')}
                            value={`${stats.trend > 0 ? '+' : ''}${stats.trend.toFixed(1)}`}
                            sub={I18n.t('vs. average')}
                            color={stats.trend > 0 ? '#ff6644' : 'var(--lm-ok)'}
                        />
                    </Grid>
                </Grid>
            )}

            <Card sx={{ bgcolor: 'var(--lm-surface)', border: '1px solid var(--lm-line)' }}>
                <CardContent>
                    <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 2 }}>
                        {I18n.t('Consumption over the last 6 weeks')}
                    </Typography>
                    {weeklyData.length === 0 ? (
                        <Typography color="text.secondary">{I18n.t('No weekly data available yet.')}</Typography>
                    ) : (
                        <>
                            <ResponsiveContainer width="100%" height={300}>
                                <ComposedChart data={chartData} margin={{ top: 28, right: 8, left: -8, bottom: 4 }}>
                                    <CartesianGrid strokeDasharray="3 3" stroke="var(--lm-line)" vertical={false} />
                                    <XAxis dataKey="week" stroke="var(--lm-muted)" fontSize={12} tickLine={false} tick={{ fill: 'var(--lm-muted)', fontWeight: 600 }} />
                                    <YAxis stroke="var(--lm-muted)" fontSize={12} tickLine={false} width={36} domain={[dataMin => Math.floor(dataMin - 1), dataMax => Math.ceil(dataMax + 1)]} tick={{ fill: 'var(--lm-muted)' }} />
                                    <Tooltip
                                        contentStyle={{ background: 'var(--lm-surface)', border: '1px solid var(--lm-line)', borderRadius: 10, color: 'var(--lm-text)', fontSize: 13 }}
                                        labelStyle={{ color: 'var(--lm-accent)', fontWeight: 700, marginBottom: 4 }}
                                        itemStyle={{ color: 'var(--lm-text)' }}
                                        formatter={(v, name) => name === 'kwh100km' ? [`${v} kWh/100km`, I18n.t('Consumption')] : [null, null]}
                                        labelFormatter={(label, payload) => payload?.[0]?.payload?.fullRange || label}
                                    />
                                    {stats && (
                                        <ReferenceLine
                                            y={stats.avg}
                                            stroke="var(--lm-muted)"
                                            strokeDasharray="6 3"
                                            label={{ value: `Ø ${stats.avg.toFixed(1)}`, position: 'insideTopRight', fill: 'var(--lm-muted)', fontSize: 12 }}
                                        />
                                    )}
                                    <Bar dataKey="kwh100km" name="kwh100km" radius={[8, 8, 0, 0]} maxBarSize={52}>
                                        <LabelList dataKey="kwh100km" position="top" style={{ fill: 'var(--lm-text)', fontSize: 14, fontWeight: 800 }} />
                                        {weeklyData.map((entry, idx) => (
                                            <Cell key={idx} fill={entry.kwh100km > 18 ? '#ff6644' : entry.kwh100km > 14 ? 'var(--lm-warn)' : 'var(--lm-ok)'} fillOpacity={0.9} />
                                        ))}
                                    </Bar>
                                </ComposedChart>
                            </ResponsiveContainer>
                            <Divider sx={{ borderColor: 'var(--lm-line)', my: 2 }} />
                            <Grid container spacing={1}>
                                {weeklyData.map((w, i) => (
                                    <Grid size={6} key={i}>
                                        <Box sx={{ bgcolor: 'var(--lm-sunken)', border: '1px solid var(--lm-line)', borderRadius: 1.5, px: 1.5, py: 1 }}>
                                            <Typography variant="caption" sx={{ color: 'var(--lm-muted)', display: 'block', fontSize: '0.7rem' }}>{w.fullRange || w.week}</Typography>
                                            <Typography sx={{
                                                color: w.kwh100km > 18 ? '#ff6644' : w.kwh100km > 14 ? 'var(--lm-warn)' : 'var(--lm-ok)',
                                                fontWeight: 800, fontSize: '1rem',
                                            }}>
                                                {w.kwh100km} <Typography component="span" variant="caption" sx={{ color: 'var(--lm-muted)' }}>kWh/100km</Typography>
                                            </Typography>
                                            <Typography variant="caption" sx={{ color: 'var(--lm-ok)', display: 'block' }}>
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
