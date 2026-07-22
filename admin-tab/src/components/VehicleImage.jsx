import React, { useMemo } from 'react';
import { Box } from '@mui/material';

function val(states, id, def = null) {
    return states[id]?.val ?? def;
}

const layerStyle = {
    position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', objectFit: 'contain',
};

// Generates the @keyframes rules for a single animation frame.
// Identical timing to the earlier composite_html animation:
// 15 frames, 0.12s each, briefly fading in one after another ("current flow" effect).
function chargeFrameStyle(index, total) {
    const dur = 0.12;
    const totalDur = (total * dur).toFixed(2);
    // Reversed: frame `total-1-index` fires first instead of `index`, since the
    // animation appeared to flow plug->car instead of car->plug (current should
    // flow INTO the car while charging).
    const delay = ((total - 1 - index) * dur).toFixed(2);
    const pOn = (1 / total * 100).toFixed(1);
    const pOff = (2 / total * 100).toFixed(1);
    const animName = `chf${index}`;
    return { animName, dur: totalDur, delay, pOn, pOff };
}

export default function VehicleImage({ base, states }) {
    const pic = (name) => val(states, `${base}.pictures.${name}`, '');

    const doorDriver = val(states, `${base}.status.door_driver`, false);
    const doorRearLeft = val(states, `${base}.status.door_rear_left`, false);
    const doorFrontRight = val(states, `${base}.status.door_front_right`, false);
    const doorRearRight = val(states, `${base}.status.door_rear_right`, false);
    const doorTrunk = val(states, `${base}.status.door_trunk`, false);
    const windowFlPct = val(states, `${base}.status.window_fl_pct`, null);
    const windowRlPct = val(states, `${base}.status.window_rl_pct`, null);
    const windowDriverOpen = val(states, `${base}.status.window_driver_open`, null);
    const windowRlOpen = val(states, `${base}.status.window_rl_open`, null);
    const plugged = val(states, `${base}.status.charging_plugged`, false);
    const charging = val(states, `${base}.status.charging_active`, false);

    const anyOpen = doorDriver || doorRearLeft || doorFrontRight || doorRearRight || doorTrunk;

    const layers = useMemo(() => {
        const result = [];
        if (!anyOpen && !charging && !plugged) {
            result.push(pic('carpic_for_tripsum'));
        } else {
            result.push(pic('carpic_body'));
            result.push(pic('carpic_hood_close'));
            result.push(doorRearLeft ? pic('carpic_leftbehind_open') : pic('carpic_leftbehind_close'));
            // Window-closed overlay only makes sense when the door itself is
            // closed (window sits within the door frame). Only left-side
            // window-closed images exist in the asset set; no right-side or
            // "window open" counterparts are available.
            if (!doorRearLeft && (windowRlPct === 0 || windowRlOpen === false)) {
                result.push(pic('carpic_leftbehind_window_close'));
            }
            result.push(doorDriver ? pic('carpic_leftfront_open') : pic('carpic_leftfront_close'));
            if (!doorDriver && (windowFlPct === 0 || windowDriverOpen === false)) {
                result.push(pic('carpic_leftfront_window_close'));
            }
            if (doorFrontRight) result.push(pic('carpic_rightfront_open'));
            if (doorRearRight) result.push(pic('carpic_rightbehind_open'));
            if (doorTrunk) result.push(pic('carpic_tailgate_open'));
            if (plugged || charging) result.push(pic('carpic_charge_open'));
        }
        return result.filter(Boolean);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [states, base, anyOpen, charging, plugged]);

    // Animated charging frames (current "pulse" animation), only visible while actually charging
    const chargeFrames = useMemo(() => {
        if (!charging) return [];
        const frames = [];
        for (let i = 0; i < 15; i++) {
            const src = pic(`carpic_charge${i + 1}`);
            if (src) frames.push({ src, ...chargeFrameStyle(i, 15) });
        }
        return frames;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [states, base, charging]);

    if (layers.length === 0) return null;

    return (
        <Box sx={{
            position: 'relative', width: '100%', paddingBottom: '46%',
            background: 'radial-gradient(ellipse at center, #111f35 0%, #070d1a 70%)',
            borderRadius: 2, overflow: 'hidden', mb: 2,
        }}>
            {chargeFrames.length > 0 && (
                <style>
                    {chargeFrames.map(f => `@keyframes ${f.animName}{0%{opacity:0}${f.pOn}%{opacity:1}${f.pOff}%{opacity:0}100%{opacity:0}}`).join('')}
                </style>
            )}
            {layers.map((src, i) => (
                <img key={`l${i}`} src={src} style={layerStyle} alt="" />
            ))}
            {chargeFrames.map((f, i) => (
                <img
                    key={`c${i}`}
                    src={f.src}
                    style={{
                        ...layerStyle,
                        opacity: 0,
                        animation: `${f.animName} ${f.dur}s ${f.delay}s infinite`,
                    }}
                    alt=""
                />
            ))}
        </Box>
    );
}
