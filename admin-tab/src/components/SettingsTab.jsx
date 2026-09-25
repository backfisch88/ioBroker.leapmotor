import React, { useState, useEffect, useRef } from 'react';
import {
    Box,
    Card,
    CardContent,
    Typography,
    TextField,
    Switch,
    FormControlLabel,
    Divider,
    MenuItem,
    Button,
    CircularProgress,
    Slider,
} from '@mui/material';
import { I18n } from '@iobroker/adapter-react-v5';
import RouteIcon from '@mui/icons-material/Route';
import BoltIcon from '@mui/icons-material/Bolt';
import NotificationsIcon from '@mui/icons-material/Notifications';
import AcUnitIcon from '@mui/icons-material/AcUnit';
import WorkIcon from '@mui/icons-material/Work';
import HomeIcon from '@mui/icons-material/Home';
import SpeedIcon from '@mui/icons-material/Speed';
import RefreshIcon from '@mui/icons-material/Refresh';
import SendIcon from '@mui/icons-material/Send';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorIcon from '@mui/icons-material/Error';
import StorageIcon from '@mui/icons-material/Storage';

import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';

// Vite doesn't automatically serve Leaflet's default marker images from
// node_modules, so the built-in icon 404s and shows as a broken "?" image.
// Explicitly importing them (so Vite bundles + fingerprints the URLs) and
// overriding the default icon options fixes it for every plain L.marker()
// call in this file.
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
    iconRetinaUrl: markerIcon2x,
    iconUrl: markerIcon,
    shadowUrl: markerShadow,
});

function val(states, id, def = null) {
    return states[id]?.val ?? def;
}

// Draggable-marker map for fine-tuning the home location after picking an
// address suggestion (or just dragging directly, no search needed).
function HomeLocationMap({ lat, lon, radiusM, onChange }) {
    const containerRef = useRef(null);
    const mapRef = useRef(null);
    const markerRef = useRef(null);
    const circleRef = useRef(null);

    useEffect(() => {
        if (!containerRef.current) {
            return undefined;
        }

        const hasLocation =
            Number.isFinite(Number(lat))
            && Number.isFinite(Number(lon))
            && Number(lat) !== 0
            && Number(lon) !== 0;

        const center = hasLocation
            ? [Number(lat), Number(lon)]
            : [50.1109, 8.6821];

        const map = L.map(containerRef.current, {
            attributionControl: false,
        }).setView(center, hasLocation ? 15 : 6);

        mapRef.current = map;

        L.tileLayer(
            'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
            {
                maxZoom: 19,
            },
        ).addTo(map);

        const marker = L.marker(center, {
            draggable: true,
        }).addTo(map);

        markerRef.current = marker;

        const circle = L.circle(center, {
            radius: Number(radiusM) || 300,
            color: '#00d4ff',
            weight: 1.5,
            fillColor: '#00d4ff',
            fillOpacity: 0.12,
        }).addTo(map);
        circleRef.current = circle;

        marker.on('dragend', () => {
            const pos = marker.getLatLng();
            circle.setLatLng(pos);
            onChange(pos.lat, pos.lng);
        });

        map.on('click', e => {
            marker.setLatLng(e.latlng);
            circle.setLatLng(e.latlng);
            onChange(e.latlng.lat, e.latlng.lng);
        });

        // Leaflet sometimes calculates the size too early inside tabs/cards.
        // Recalculate shortly after mounting.
        setTimeout(() => {
            map.invalidateSize();
        }, 100);

        return () => {
            marker.off();
            map.off();
            map.remove();

            mapRef.current = null;
            markerRef.current = null;
            circleRef.current = null;
        };
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // Re-center when lat/lon change from outside, e.g. address search pick.
    useEffect(() => {
        if (!mapRef.current || !markerRef.current) {
            return;
        }

        const latitude = Number(lat);
        const longitude = Number(lon);

        if (
            !Number.isFinite(latitude)
            || !Number.isFinite(longitude)
            || latitude === 0
            || longitude === 0
        ) {
            return;
        }

        const current = markerRef.current.getLatLng();

        if (
            Math.abs(current.lat - latitude) > 0.0001
            || Math.abs(current.lng - longitude) > 0.0001
        ) {
            markerRef.current.setLatLng([latitude, longitude]);
            circleRef.current?.setLatLng([latitude, longitude]);
            mapRef.current.setView([latitude, longitude], 15);
        }
    }, [lat, lon]);

    // Radius changes (typed into the number field) update the circle
    // without needing to touch the marker/map center.
    useEffect(() => {
        if (!circleRef.current) {
            return;
        }
        circleRef.current.setRadius(Number(radiusM) || 300);
    }, [radiusM]);

    return (
        <Box
            ref={containerRef}
            sx={{
                height: 220,
                width: '100%',
                borderRadius: 1.5,
                overflow: 'hidden',
                mt: 1.5,
                bgcolor: '#08101a',
            }}
        />
    );
}

function SectionCard({ icon, title, children }) {
    return (
        <Card
            sx={{
                mb: 2,
                bgcolor: '#0d1520',
                border: '1px solid #1e2d45',
            }}
        >
            <CardContent>
                <Box
                    sx={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 1,
                        mb: 2,
                    }}
                >
                    {icon}

                    <Typography
                        variant="subtitle1"
                        sx={{ fontWeight: 700 }}
                    >
                        {title}
                    </Typography>
                </Box>

                {children}
            </CardContent>
        </Card>
    );
}

// This tab writes to global config.* datapoints (not the ioBroker instance
// config panel) - every setting here takes effect on the NEXT poll/action,
// no adapter restart needed. See main.js createVehicleObjects() for where
// these datapoints are created and read.
export default function SettingsTab({
    adapter,
    base,
    states,
    setState,
    sendTo,
}) {
    const cfg = (name, def) =>
        val(states, `${adapter}.config.${name}`, def);

    const [priceStateId, setPriceStateId] = useState(
        cfg('energy_price_state_id', ''),
    );

    const [homeLat, setHomeLat] = useState(
        cfg('home_latitude', 0),
    );

    const [homeLon, setHomeLon] = useState(
        cfg('home_longitude', 0),
    );

    const [addressQuery, setAddressQuery] = useState('');
    const [addressResults, setAddressResults] = useState(null);
    const [addressLoading, setAddressLoading] = useState(false);

    const [notifyAdapter, setNotifyAdapter] = useState(
        cfg('notify_adapter', ''),
    );

    const [notifyTarget, setNotifyTarget] = useState(
        cfg('notify_target', ''),
    );
    const [tm2Area, setTm2Area] = useState(
        cfg('notify_telegrammenu2_area', ''),
    );

    // null = not loaded
    // []   = loaded but empty
    const [telegramUsers, setTelegramUsers] = useState(null);
    const [loadingUsers, setLoadingUsers] = useState(false);

    // null = not loaded yet
    const [notifyAdapters, setNotifyAdapters] = useState(null);

    const [testState, setTestState] = useState(null);

    // Keep local text-field state in sync if the underlying datapoint
    // changes from elsewhere, e.g. another browser tab.
    useEffect(() => {
        setPriceStateId(
            cfg('energy_price_state_id', ''),
        );
    }, [states]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        setHomeLat(
            cfg('home_latitude', 0),
        );
    }, [states]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        setHomeLon(
            cfg('home_longitude', 0),
        );
    }, [states]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        setNotifyAdapter(
            cfg('notify_adapter', ''),
        );
    }, [states]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        setNotifyTarget(
            cfg('notify_target', ''),
        );
    }, [states]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        setTm2Area(
            cfg('notify_telegrammenu2_area', ''),
        );
    }, [states]); // eslint-disable-line react-hooks/exhaustive-deps

    // Ask our own backend which notify-capable adapters are actually
    // installed.
    useEffect(() => {
        if (!sendTo || !adapter) {
            return;
        }

        let cancelled = false;

        sendTo(
            adapter,
            'getNotifAdapters',
            null,
        )
            .then(res => {
                if (!cancelled) {
                    setNotifyAdapters(
                        Array.isArray(res?.adapters)
                            ? res.adapters
                            : [],
                    );
                }
            })
            .catch(() => {
                if (!cancelled) {
                    setNotifyAdapters([]);
                }
            });

        return () => {
            cancelled = true;
        };
    }, [adapter, sendTo]);

    const isTelegram =
        typeof notifyAdapter === 'string'
        && notifyAdapter
            .trim()
            .toLowerCase()
            .startsWith('telegram');

    const isTelegrammenu2 =
        typeof notifyAdapter === 'string'
        && notifyAdapter
            .trim()
            .toLowerCase()
            .startsWith('telegrammenu2');

    // Reset loaded Telegram users if another notification adapter gets selected.
    useEffect(() => {
        setTelegramUsers(null);
    }, [notifyAdapter]);

    // Debounced address search via Open-Meteo's free geocoding API.
    useEffect(() => {
        const query = addressQuery.trim();

        if (query.length < 3) {
            setAddressResults(null);
            setAddressLoading(false);

            return undefined;
        }

        let cancelled = false;

        const timer = setTimeout(async () => {
            setAddressLoading(true);

            try {
                // Open-Meteo's geocoder only resolves place/city names, not
                // street addresses ("Musterstraße 1, Berlin" never matched
                // anything - confirmed in practice). Nominatim (OpenStreetMap)
                // handles full street-level addresses and is also free with
                // no API key, so switched to that.
                const response = await fetch(
                    `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&addressdetails=0&limit=5&accept-language=de`,
                );

                if (!response.ok) {
                    throw new Error(
                        `HTTP ${response.status}`,
                    );
                }

                const data = await response.json();

                if (!cancelled) {
                    setAddressResults(
                        Array.isArray(data)
                            ? data.map(item => ({
                                latitude: Number(item.lat),
                                longitude: Number(item.lon),
                                name: item.display_name,
                                admin1: '',
                                country: '',
                            }))
                            : [],
                    );
                }
            } catch (error) {
                if (!cancelled) {
                    setAddressResults([]);
                }
            } finally {
                if (!cancelled) {
                    setAddressLoading(false);
                }
            }
        }, 500);

        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [addressQuery]);

    const loadTelegramUsers = async () => {
        if (
            !isTelegram
            || !sendTo
            || !notifyAdapter
        ) {
            return;
        }

        setLoadingUsers(true);

        try {
            const result = await sendTo(
                notifyAdapter.trim(),
                'adminuser',
                null,
            );

            const users =
                result?.result
                || result
                || {};

            const list = Object.entries(users)
                .map(([chatId, user]) => {
                    const firstName =
                        user?.firstName
                        || '';

                    const userName =
                        user?.userName
                        || '';

                    let label = firstName;

                    if (userName) {
                        label += label
                            ? ` (${userName})`
                            : userName;
                    }

                    label = label.trim();

                    return {
                        chatId,
                        label: label || chatId,
                    };
                });

            setTelegramUsers(list);
        } catch (error) {
            setTelegramUsers([]);
        } finally {
            setLoadingUsers(false);
        }
    };

    const sendTest = async () => {
        if (
            !notifyAdapter
            || !sendTo
        ) {
            return;
        }

        setTestState('sending');

        try {
            const result = await sendTo(
                adapter,
                'testNotification',
                {
                    notifyAdapter,
                    target: notifyTarget,
                },
            );

            if (result?.ok) {
                setTestState('ok');
            } else {
                setTestState({
                    error:
                        result?.error
                        || 'unknown error',
                });
            }
        } catch (error) {
            setTestState({
                error:
                    error instanceof Error
                        ? error.message
                        : String(error),
            });
        }
    };

    return (
        <Box>
            <SectionCard
                icon={
                    <SpeedIcon
                        sx={{ color: '#00d4ff' }}
                    />
                }
                title={I18n.t('Polling')}
            >
                <Box
                    sx={{
                        display: 'flex',
                        gap: 2,
                        flexWrap: 'wrap',
                    }}
                >
                    <TextField
                        type="number"
                        label={I18n.t(
                            'Parked/charging interval (s)',
                        )}
                        value={cfg(
                            'polling_interval_parked_sec',
                            60,
                        )}
                        onChange={e =>
                            setState(
                                `${adapter}.config.polling_interval_parked_sec`,
                                Number(e.target.value),
                            )
                        }
                        inputProps={{
                            min: 20,
                            max: 3600,
                        }}
                        size="small"
                        sx={{ width: 220 }}
                    />

                    <TextField
                        type="number"
                        label={I18n.t(
                            'Driving interval (s)',
                        )}
                        value={cfg(
                            'polling_interval_driving_sec',
                            15,
                        )}
                        onChange={e =>
                            setState(
                                `${adapter}.config.polling_interval_driving_sec`,
                                Number(e.target.value),
                            )
                        }
                        inputProps={{
                            min: 5,
                            max: 300,
                        }}
                        size="small"
                        sx={{ width: 220 }}
                    />
                </Box>

                <Typography
                    variant="caption"
                    sx={{
                        color: '#5a7090',
                        display: 'block',
                        mt: 1,
                    }}
                >
                    {I18n.t(
                        'Lower values mean more API calls to the Leapmotor cloud - go easy and increase again if you see rate-limit-style errors in the log.',
                    )}
                </Typography>
            </SectionCard>

            <SectionCard
                icon={
                    <RouteIcon
                        sx={{ color: '#00d4ff' }}
                    />
                }
                title={I18n.t(
                    'GPS Route Recording',
                )}
            >
                <FormControlLabel
                    control={
                        <Switch
                            checked={Boolean(
                                cfg(
                                    'route_recording_enabled',
                                    false,
                                ),
                            )}
                            onChange={e =>
                                setState(
                                    `${adapter}.config.route_recording_enabled`,
                                    e.target.checked,
                                )
                            }
                        />
                    }
                    label={I18n.t(
                        'Record GPS route during trips',
                    )}
                />

                <Typography
                    variant="caption"
                    sx={{
                        color: '#5a7090',
                        display: 'block',
                    }}
                >
                    {I18n.t(
                        'Opt-in, off by default. Only the last 20 trips\' routes are kept, separate from trip history, to keep storage size bounded.',
                    )}
                </Typography>
            </SectionCard>

            <SectionCard
                icon={
                    <BoltIcon
                        sx={{ color: '#00d4ff' }}
                    />
                }
                title={I18n.t(
                    'Electricity Prices',
                )}
            >
                <Box
                    sx={{
                        display: 'flex',
                        gap: 2,
                        flexWrap: 'wrap',
                        mb: 1.5,
                    }}
                >
                    <TextField
                        type="number"
                        label={I18n.t(
                            'Home price (manual, EUR/kWh)',
                        )}
                        value={cfg(
                            'energy_price_eur_kwh',
                            0.30,
                        )}
                        onChange={e =>
                            setState(
                                `${adapter}.config.energy_price_eur_kwh`,
                                Number(e.target.value),
                            )
                        }
                        inputProps={{
                            step: 0.01,
                            min: 0,
                            max: 2,
                        }}
                        size="small"
                        sx={{ width: 220 }}
                    />

                    <TextField
                        type="number"
                        label={I18n.t(
                            'Public charging price (EUR/kWh)',
                        )}
                        value={cfg(
                            'energy_price_public_eur_kwh',
                            0.55,
                        )}
                        onChange={e =>
                            setState(
                                `${adapter}.config.energy_price_public_eur_kwh`,
                                Number(e.target.value),
                            )
                        }
                        inputProps={{
                            step: 0.01,
                            min: 0,
                            max: 2,
                        }}
                        size="small"
                        sx={{ width: 220 }}
                    />
                </Box>

                <Typography
                    variant="caption"
                    sx={{
                        color: '#5a7090',
                        display: 'block',
                        mb: 1.5,
                    }}
                >
                    {I18n.t(
                        'Used for sessions classified as "public" (outside the home radius set below) - always this manual price, never the dynamic state.',
                    )}
                </Typography>

                <Divider
                    sx={{
                        my: 1.5,
                        borderColor: '#1e2d45',
                    }}
                />

                <TextField
                    fullWidth
                    label={I18n.t(
                        'Dynamic price state ID (optional, home only)',
                    )}
                    value={priceStateId}
                    onChange={e =>
                        setPriceStateId(
                            e.target.value,
                        )
                    }
                    onBlur={() =>
                        setState(
                            `${adapter}.config.energy_price_state_id`,
                            priceStateId,
                        )
                    }
                    size="small"
                    placeholder="e.g. tibber.0.Homes.xxx.currentPrice.total"
                />

                <Typography
                    variant="caption"
                    sx={{
                        color: '#5a7090',
                        display: 'block',
                        mt: 1,
                    }}
                >
                    {I18n.t(
                        'An existing ioBroker state from another adapter (e.g. Tibber/aWATTar/EPEX) reporting the current price in EUR/kWh. If set, HOME charging cost uses this live value instead of the manual home price above, so a mid-charge price change is picked up on the next poll. Leave empty to use the manual home price only. Public charging always uses the manual public price, regardless of this setting.',
                    )}
                </Typography>
            </SectionCard>

            <SectionCard
                icon={
                    <StorageIcon
                        sx={{ color: '#00d4ff' }}
                    />
                }
                title={I18n.t(
                    'Data Retention',
                )}
            >
                <Typography
                    variant="caption"
                    sx={{
                        color: '#5a7090',
                        display: 'block',
                        mb: 1.5,
                    }}
                >
                    {I18n.t(
                        '0 = keep forever. GPS routes take up much more space per trip than trip summaries, so they have their own (shorter) setting. A hard safety limit always applies regardless (5000 trips / 2000 routes) so storage can never grow truly unbounded.',
                    )}
                </Typography>
                <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
                    <TextField
                        type="number"
                        label={I18n.t(
                            'Trip history (days, 0 = forever)',
                        )}
                        value={cfg('trip_history_retention_days', 365)}
                        onChange={e =>
                            setState(
                                `${adapter}.config.trip_history_retention_days`,
                                Number(e.target.value),
                            )
                        }
                        size="small"
                        sx={{ width: 260 }}
                    />
                    <TextField
                        type="number"
                        label={I18n.t(
                            'GPS route history (days, 0 = forever)',
                        )}
                        value={cfg('route_history_retention_days', 30)}
                        onChange={e =>
                            setState(
                                `${adapter}.config.route_history_retention_days`,
                                Number(e.target.value),
                            )
                        }
                        size="small"
                        sx={{ width: 260 }}
                    />
                </Box>
            </SectionCard>

            <SectionCard
                icon={
                    <HomeIcon
                        sx={{ color: '#00d4ff' }}
                    />
                }
                title={I18n.t(
                    'Home Location (for charging cost split)',
                )}
            >
                <Typography
                    variant="caption"
                    sx={{
                        color: '#5a7090',
                        display: 'block',
                        mb: 1.5,
                    }}
                >
                    {I18n.t(
                        'Charging sessions within this radius of home are tracked separately from public charging. Leave both coordinates at 0 to disable the split.',
                    )}
                </Typography>

                <TextField
                    fullWidth
                    label={I18n.t(
                        'Search address',
                    )}
                    value={addressQuery}
                    onChange={e => {
                        setAddressQuery(
                            e.target.value,
                        );

                        setAddressResults(null);
                    }}
                    size="small"
                    placeholder="z.B. Alexanderplatz 1, 10178 Berlin"
                />

                {addressLoading && (
                    <Typography
                        variant="caption"
                        sx={{
                            color: '#5a7090',
                            display: 'block',
                            mt: 0.5,
                        }}
                    >
                        {I18n.t(
                            'Searching...',
                        )}
                    </Typography>
                )}

                {addressResults
                    && addressResults.length > 0
                    && (
                        <Box
                            sx={{
                                mt: 0.5,
                                border:
                                    '1px solid #1e2d45',
                                borderRadius: 1,
                                overflow: 'hidden',
                            }}
                        >
                            {addressResults.map(
                                result => (
                                    <Box
                                        key={`${result.latitude},${result.longitude}`}
                                        sx={{
                                            px: 1.5,
                                            py: 1,
                                            cursor: 'pointer',
                                            fontSize:
                                                '0.85rem',
                                            borderBottom:
                                                '1px solid #1e2d4555',
                                            '&:hover': {
                                                bgcolor:
                                                    '#0d1520',
                                            },
                                        }}
                                        onClick={() => {
                                            const latitude =
                                                Number(
                                                    result.latitude,
                                                );

                                            const longitude =
                                                Number(
                                                    result.longitude,
                                                );

                                            setHomeLat(
                                                latitude,
                                            );

                                            setHomeLon(
                                                longitude,
                                            );

                                            setState(
                                                `${adapter}.config.home_latitude`,
                                                latitude,
                                            );

                                            setState(
                                                `${adapter}.config.home_longitude`,
                                                longitude,
                                            );

                                            setAddressQuery(
                                                `${result.name}${result.admin1 ? `, ${result.admin1}` : ''}${result.country ? `, ${result.country}` : ''}`,
                                            );

                                            setAddressResults(
                                                null,
                                            );
                                        }}
                                    >
                                        {result.name}

                                        {result.admin1
                                            ? `, ${result.admin1}`
                                            : ''}

                                        {result.country
                                            ? `, ${result.country}`
                                            : ''}
                                    </Box>
                                ),
                            )}
                        </Box>
                    )}

                {addressResults
                    && addressResults.length === 0
                    && !addressLoading
                    && (
                        <Typography
                            variant="caption"
                            sx={{
                                color: '#ff8844',
                                display: 'block',
                                mt: 0.5,
                            }}
                        >
                            {I18n.t(
                                'No results - try a different search, or just drag the marker on the map below.',
                            )}
                        </Typography>
                    )}

                <HomeLocationMap
                    lat={
                        Number(homeLat)
                        || null
                    }
                    lon={
                        Number(homeLon)
                        || null
                    }
                    radiusM={cfg('home_radius_m', 300)}
                    onChange={(
                        latitude,
                        longitude,
                    ) => {
                        setHomeLat(
                            latitude,
                        );

                        setHomeLon(
                            longitude,
                        );

                        setState(
                            `${adapter}.config.home_latitude`,
                            latitude,
                        );

                        setState(
                            `${adapter}.config.home_longitude`,
                            longitude,
                        );
                    }}
                />

                <Typography
                    variant="caption"
                    sx={{
                        color: '#5a7090',
                        display: 'block',
                        mt: 1,
                    }}
                >
                    {I18n.t(
                        'Drag the marker or click the map to fine-tune - saves immediately.',
                    )}
                </Typography>

                <Box
                    sx={{
                        display: 'flex',
                        gap: 2,
                        flexWrap: 'wrap',
                        mt: 1.5,
                    }}
                >
                    <TextField
                        type="number"
                        label={I18n.t(
                            'Radius (m)',
                        )}
                        value={cfg(
                            'home_radius_m',
                            300,
                        )}
                        onChange={e =>
                            setState(
                                `${adapter}.config.home_radius_m`,
                                Number(e.target.value),
                            )
                        }
                        inputProps={{
                            min: 1,
                        }}
                        size="small"
                        sx={{ width: 140 }}
                    />
                </Box>
            </SectionCard>

            <SectionCard
                icon={
                    <AcUnitIcon
                        sx={{ color: '#00d4ff' }}
                    />
                }
                title={I18n.t(
                    'Prepare to Drive',
                )}
            >
                <FormControlLabel
                    control={
                        <Switch
                            checked={Boolean(
                                cfg(
                                    'prepare_to_drive_enabled',
                                    false,
                                ),
                            )}
                            onChange={e =>
                                setState(
                                    `${adapter}.config.prepare_to_drive_enabled`,
                                    e.target.checked,
                                )
                            }
                        />
                    }
                    label={I18n.t(
                        'Auto-climate when getting in (ignition on)',
                    )}
                />

                <Typography
                    variant="caption"
                    sx={{
                        color: '#5a7090',
                        display: 'block',
                        mb: 1.5,
                    }}
                >
                    {I18n.t(
                        'Triggers once per ignition-on edge - heats below the cold threshold, cools above the hot threshold, vents in between.',
                    )}
                </Typography>

                <Box
                    sx={{
                        display: 'flex',
                        gap: 2,
                        flexWrap: 'wrap',
                    }}
                >
                    <TextField
                        type="number"
                        label={I18n.t(
                            'Heat below (°C)',
                        )}
                        value={cfg(
                            'prepare_to_drive_temp_cold',
                            14,
                        )}
                        onChange={e =>
                            setState(
                                `${adapter}.config.prepare_to_drive_temp_cold`,
                                Number(e.target.value),
                            )
                        }
                        size="small"
                        sx={{ width: 160 }}
                    />

                    <TextField
                        type="number"
                        label={I18n.t(
                            'Cool above (°C)',
                        )}
                        value={cfg(
                            'prepare_to_drive_temp_hot',
                            23,
                        )}
                        onChange={e =>
                            setState(
                                `${adapter}.config.prepare_to_drive_temp_hot`,
                                Number(e.target.value),
                            )
                        }
                        size="small"
                        sx={{ width: 160 }}
                    />

                    <TextField
                        type="number"
                        label={I18n.t(
                            'Target temperature (°C)',
                        )}
                        value={cfg(
                            'prepare_to_drive_target_temp',
                            22,
                        )}
                        onChange={e =>
                            setState(
                                `${adapter}.config.prepare_to_drive_target_temp`,
                                Number(e.target.value),
                            )
                        }
                        size="small"
                        sx={{ width: 160 }}
                    />
                </Box>

                <Box sx={{ width: 260, mb: 1 }}>
                    <Typography
                        variant="caption"
                        sx={{ color: '#5a7090' }}
                    >
                        {I18n.t('Fan speed')}: {cfg('prepare_to_drive_fan_speed', 3)}
                    </Typography>
                    <Slider
                        min={1}
                        max={7}
                        step={1}
                        marks
                        value={cfg('prepare_to_drive_fan_speed', 3)}
                        onChange={(e, v) =>
                            setState(
                                `${adapter}.config.prepare_to_drive_fan_speed`,
                                v,
                            )
                        }
                    />
                </Box>

                <FormControlLabel
                    sx={{ mt: 1 }}
                    control={
                        <Switch
                            checked={Boolean(
                                cfg(
                                    'notify_prepare_to_drive',
                                    false,
                                ),
                            )}
                            onChange={e =>
                                setState(
                                    `${adapter}.config.notify_prepare_to_drive`,
                                    e.target.checked,
                                )
                            }
                        />
                    }
                    label={I18n.t(
                        'Notify when Prepare-to-Drive triggers',
                    )}
                />

                <Divider
                    sx={{
                        my: 2,
                        borderColor: '#1e2d45',
                    }}
                />

                <FormControlLabel
                    control={
                        <Switch
                            checked={Boolean(
                                cfg(
                                    'prepare_to_drive_sunshade_enabled',
                                    false,
                                ),
                            )}
                            onChange={e =>
                                setState(
                                    `${adapter}.config.prepare_to_drive_sunshade_enabled`,
                                    e.target.checked,
                                )
                            }
                        />
                    }
                    label={I18n.t(
                        'Also control sunshade',
                    )}
                />

                <Typography
                    variant="caption"
                    sx={{
                        color: '#5a7090',
                        display: 'block',
                        mb: 1.5,
                    }}
                >
                    {I18n.t(
                        'Position 0 = closed, 10 = fully open, per climate action.',
                    )}
                </Typography>

                <Box
                    sx={{
                        display: 'flex',
                        gap: 2,
                        flexWrap: 'wrap',
                    }}
                >
                    <TextField
                        type="number"
                        label={I18n.t(
                            'Sunshade when heating (cold)',
                        )}
                        value={cfg(
                            'prepare_to_drive_sunshade_heat',
                            0,
                        )}
                        onChange={e =>
                            setState(
                                `${adapter}.config.prepare_to_drive_sunshade_heat`,
                                Number(e.target.value),
                            )
                        }
                        inputProps={{
                            min: 0,
                            max: 10,
                        }}
                        size="small"
                        sx={{ width: 200 }}
                        disabled={
                            !cfg(
                                'prepare_to_drive_sunshade_enabled',
                                false,
                            )
                        }
                    />

                    <TextField
                        type="number"
                        label={I18n.t(
                            'Sunshade when cooling (hot)',
                        )}
                        value={cfg(
                            'prepare_to_drive_sunshade_cool',
                            0,
                        )}
                        onChange={e =>
                            setState(
                                `${adapter}.config.prepare_to_drive_sunshade_cool`,
                                Number(e.target.value),
                            )
                        }
                        inputProps={{
                            min: 0,
                            max: 10,
                        }}
                        size="small"
                        sx={{ width: 200 }}
                        disabled={
                            !cfg(
                                'prepare_to_drive_sunshade_enabled',
                                false,
                            )
                        }
                    />

                    <TextField
                        type="number"
                        label={I18n.t(
                            'Sunshade when venting (mild)',
                        )}
                        value={cfg(
                            'prepare_to_drive_sunshade_vent',
                            10,
                        )}
                        onChange={e =>
                            setState(
                                `${adapter}.config.prepare_to_drive_sunshade_vent`,
                                Number(e.target.value),
                            )
                        }
                        inputProps={{
                            min: 0,
                            max: 10,
                        }}
                        size="small"
                        sx={{ width: 200 }}
                        disabled={
                            !cfg(
                                'prepare_to_drive_sunshade_enabled',
                                false,
                            )
                        }
                    />
                </Box>

                <FormControlLabel
                    sx={{ mt: 1 }}
                    control={
                        <Switch
                            checked={Boolean(
                                cfg(
                                    'prepare_to_drive_sunshade_skip_dark',
                                    false,
                                ),
                            )}
                            onChange={e =>
                                setState(
                                    `${adapter}.config.prepare_to_drive_sunshade_skip_dark`,
                                    e.target.checked,
                                )
                            }
                            disabled={
                                !cfg(
                                    'prepare_to_drive_sunshade_enabled',
                                    false,
                                )
                            }
                        />
                    }
                    label={I18n.t(
                        'Skip sunshade when dark (based on sunrise/sunset at vehicle location)',
                    )}
                />

                <Divider
                    sx={{
                        my: 2,
                        borderColor: '#1e2d45',
                    }}
                />

                <Typography
                    variant="caption"
                    sx={{
                        color: '#5a7090',
                        display: 'block',
                        mb: 1,
                    }}
                >
                    {I18n.t(
                        'Optional extras - not every model/trim has these, only enable what your own vehicle actually supports.',
                    )}
                </Typography>

                <FormControlLabel
                    control={
                        <Switch
                            checked={Boolean(
                                cfg('prepare_to_drive_seat_heat_enabled', false),
                            )}
                            onChange={e =>
                                setState(
                                    `${adapter}.config.prepare_to_drive_seat_heat_enabled`,
                                    e.target.checked,
                                )
                            }
                        />
                    }
                    label={I18n.t('Also turn on driver seat heat when heating')}
                />
                <TextField
                    type="number"
                    label={I18n.t('Seat heat level (1-3)')}
                    value={cfg('prepare_to_drive_seat_heat_level', 2)}
                    onChange={e =>
                        setState(
                            `${adapter}.config.prepare_to_drive_seat_heat_level`,
                            Number(e.target.value),
                        )
                    }
                    inputProps={{ min: 1, max: 3 }}
                    size="small"
                    sx={{ width: 200, ml: 2 }}
                    disabled={!cfg('prepare_to_drive_seat_heat_enabled', false)}
                />
                <br />
                <FormControlLabel
                    control={
                        <Switch
                            checked={Boolean(
                                cfg('prepare_to_drive_steering_wheel_heat_enabled', false),
                            )}
                            onChange={e =>
                                setState(
                                    `${adapter}.config.prepare_to_drive_steering_wheel_heat_enabled`,
                                    e.target.checked,
                                )
                            }
                        />
                    }
                    label={I18n.t('Also turn on steering wheel heat when heating')}
                />
                <br />
                <FormControlLabel
                    control={
                        <Switch
                            checked={Boolean(
                                cfg('prepare_to_drive_defrost_enabled', false),
                            )}
                            onChange={e =>
                                setState(
                                    `${adapter}.config.prepare_to_drive_defrost_enabled`,
                                    e.target.checked,
                                )
                            }
                        />
                    }
                    label={I18n.t('Also turn on windshield defrost below')}
                />
                <TextField
                    type="number"
                    label={I18n.t('Defrost threshold (°C)')}
                    value={cfg('prepare_to_drive_defrost_below', 0)}
                    onChange={e =>
                        setState(
                            `${adapter}.config.prepare_to_drive_defrost_below`,
                            Number(e.target.value),
                        )
                    }
                    size="small"
                    sx={{ width: 200, ml: 2 }}
                    disabled={!cfg('prepare_to_drive_defrost_enabled', false)}
                />
            </SectionCard>

            <SectionCard
                icon={
                    <WorkIcon
                        sx={{ color: '#00d4ff' }}
                    />
                }
                title={I18n.t(
                    'Prepare to Work',
                )}
            >
                <FormControlLabel
                    control={
                        <Switch
                            checked={Boolean(
                                cfg(
                                    'prepare_to_work_enabled',
                                    false,
                                ),
                            )}
                            onChange={e =>
                                setState(
                                    `${adapter}.config.prepare_to_work_enabled`,
                                    e.target.checked,
                                )
                            }
                        />
                    }
                    label={I18n.t(
                        'Enable Prepare-to-Work',
                    )}
                />

                <Typography
                    variant="caption"
                    sx={{
                        color: '#5a7090',
                        display: 'block',
                        mb: 1.5,
                    }}
                >
                    {I18n.t(
                        'Triggered via cmd.prepare_to_work (write true) - couple it to a shift schedule or calendar script. Heats below the cold threshold, cools above the hot threshold, vents in between.',
                    )}
                </Typography>
                <Typography
                    variant="caption"
                    sx={{
                        color: '#ff8844',
                        display: 'block',
                        mb: 1.5,
                    }}
                >
                    {I18n.t(
                        'Limited by the Leapmotor cloud API - climate commands only work reliably while the vehicle is reachable/awake. Sunshade support (if enabled below) varies by vehicle model and firmware and may not respond every time.',
                    )}
                </Typography>

                <Button
                    variant="outlined"
                    size="small"
                    onClick={() => setState(`${base}.cmd.prepare_to_work`, true)}
                    sx={{ mb: 2 }}
                >
                    {I18n.t('Trigger now (test)')}
                </Button>

                <Box
                    sx={{
                        display: 'flex',
                        gap: 2,
                        flexWrap: 'wrap',
                    }}
                >
                    <TextField
                        type="number"
                        label={I18n.t(
                            'Heat below (°C)',
                        )}
                        value={cfg(
                            'prepare_to_work_temp_cold',
                            14,
                        )}
                        onChange={e =>
                            setState(
                                `${adapter}.config.prepare_to_work_temp_cold`,
                                Number(e.target.value),
                            )
                        }
                        size="small"
                        sx={{ width: 160 }}
                    />

                    <TextField
                        type="number"
                        label={I18n.t(
                            'Cool above (°C)',
                        )}
                        value={cfg(
                            'prepare_to_work_temp_hot',
                            23,
                        )}
                        onChange={e =>
                            setState(
                                `${adapter}.config.prepare_to_work_temp_hot`,
                                Number(e.target.value),
                            )
                        }
                        size="small"
                        sx={{ width: 160 }}
                    />

                    <TextField
                        type="number"
                        label={I18n.t(
                            'Target temperature (°C)',
                        )}
                        value={cfg(
                            'prepare_to_work_target_temp',
                            22,
                        )}
                        onChange={e =>
                            setState(
                                `${adapter}.config.prepare_to_work_target_temp`,
                                Number(e.target.value),
                            )
                        }
                        size="small"
                        sx={{ width: 160 }}
                    />
                </Box>

                <Box sx={{ width: 260, mb: 1 }}>
                    <Typography
                        variant="caption"
                        sx={{ color: '#5a7090' }}
                    >
                        {I18n.t('Fan speed')}: {cfg('prepare_to_work_fan_speed', 3)}
                    </Typography>
                    <Slider
                        min={1}
                        max={7}
                        step={1}
                        marks
                        value={cfg('prepare_to_work_fan_speed', 3)}
                        onChange={(e, v) =>
                            setState(
                                `${adapter}.config.prepare_to_work_fan_speed`,
                                v,
                            )
                        }
                    />
                </Box>

                <FormControlLabel
                    sx={{ mt: 1 }}
                    control={
                        <Switch
                            checked={Boolean(
                                cfg(
                                    'notify_prepare_to_work',
                                    false,
                                ),
                            )}
                            onChange={e =>
                                setState(
                                    `${adapter}.config.notify_prepare_to_work`,
                                    e.target.checked,
                                )
                            }
                        />
                    }
                    label={I18n.t(
                        'Notify when Prepare-to-Work triggers',
                    )}
                />

                <Divider
                    sx={{
                        my: 2,
                        borderColor: '#1e2d45',
                    }}
                />

                <FormControlLabel
                    control={
                        <Switch
                            checked={Boolean(
                                cfg(
                                    'prepare_to_work_sunshade_enabled',
                                    false,
                                ),
                            )}
                            onChange={e =>
                                setState(
                                    `${adapter}.config.prepare_to_work_sunshade_enabled`,
                                    e.target.checked,
                                )
                            }
                        />
                    }
                    label={I18n.t(
                        'Also control sunshade',
                    )}
                />

                <Typography
                    variant="caption"
                    sx={{
                        color: '#5a7090',
                        display: 'block',
                        mb: 1.5,
                    }}
                >
                    {I18n.t(
                        'Position 0 = closed, 10 = fully open, per climate action.',
                    )}
                </Typography>

                <Box
                    sx={{
                        display: 'flex',
                        gap: 2,
                        flexWrap: 'wrap',
                    }}
                >
                    <TextField
                        type="number"
                        label={I18n.t(
                            'Sunshade when heating (cold)',
                        )}
                        value={cfg(
                            'prepare_to_work_sunshade_heat',
                            0,
                        )}
                        onChange={e =>
                            setState(
                                `${adapter}.config.prepare_to_work_sunshade_heat`,
                                Number(e.target.value),
                            )
                        }
                        inputProps={{
                            min: 0,
                            max: 10,
                        }}
                        size="small"
                        sx={{ width: 200 }}
                        disabled={
                            !cfg(
                                'prepare_to_work_sunshade_enabled',
                                false,
                            )
                        }
                    />

                    <TextField
                        type="number"
                        label={I18n.t(
                            'Sunshade when cooling (hot)',
                        )}
                        value={cfg(
                            'prepare_to_work_sunshade_cool',
                            0,
                        )}
                        onChange={e =>
                            setState(
                                `${adapter}.config.prepare_to_work_sunshade_cool`,
                                Number(e.target.value),
                            )
                        }
                        inputProps={{
                            min: 0,
                            max: 10,
                        }}
                        size="small"
                        sx={{ width: 200 }}
                        disabled={
                            !cfg(
                                'prepare_to_work_sunshade_enabled',
                                false,
                            )
                        }
                    />

                    <TextField
                        type="number"
                        label={I18n.t(
                            'Sunshade when venting (mild)',
                        )}
                        value={cfg(
                            'prepare_to_work_sunshade_vent',
                            10,
                        )}
                        onChange={e =>
                            setState(
                                `${adapter}.config.prepare_to_work_sunshade_vent`,
                                Number(e.target.value),
                            )
                        }
                        inputProps={{
                            min: 0,
                            max: 10,
                        }}
                        size="small"
                        sx={{ width: 200 }}
                        disabled={
                            !cfg(
                                'prepare_to_work_sunshade_enabled',
                                false,
                            )
                        }
                    />
                </Box>

                <FormControlLabel
                    sx={{ mt: 1 }}
                    control={
                        <Switch
                            checked={Boolean(
                                cfg(
                                    'prepare_to_work_sunshade_skip_dark',
                                    false,
                                ),
                            )}
                            onChange={e =>
                                setState(
                                    `${adapter}.config.prepare_to_work_sunshade_skip_dark`,
                                    e.target.checked,
                                )
                            }
                            disabled={
                                !cfg(
                                    'prepare_to_work_sunshade_enabled',
                                    false,
                                )
                            }
                        />
                    }
                    label={I18n.t(
                        'Skip sunshade when dark (based on sunrise/sunset at vehicle location)',
                    )}
                />

                <Divider
                    sx={{
                        my: 2,
                        borderColor: '#1e2d45',
                    }}
                />

                <Typography
                    variant="caption"
                    sx={{
                        color: '#5a7090',
                        display: 'block',
                        mb: 1,
                    }}
                >
                    {I18n.t(
                        'Optional extras - not every model/trim has these, only enable what your own vehicle actually supports.',
                    )}
                </Typography>

                <FormControlLabel
                    control={
                        <Switch
                            checked={Boolean(
                                cfg('prepare_to_work_seat_heat_enabled', false),
                            )}
                            onChange={e =>
                                setState(
                                    `${adapter}.config.prepare_to_work_seat_heat_enabled`,
                                    e.target.checked,
                                )
                            }
                        />
                    }
                    label={I18n.t('Also turn on driver seat heat when heating')}
                />
                <TextField
                    type="number"
                    label={I18n.t('Seat heat level (1-3)')}
                    value={cfg('prepare_to_work_seat_heat_level', 2)}
                    onChange={e =>
                        setState(
                            `${adapter}.config.prepare_to_work_seat_heat_level`,
                            Number(e.target.value),
                        )
                    }
                    inputProps={{ min: 1, max: 3 }}
                    size="small"
                    sx={{ width: 200, ml: 2 }}
                    disabled={!cfg('prepare_to_work_seat_heat_enabled', false)}
                />
                <br />
                <FormControlLabel
                    control={
                        <Switch
                            checked={Boolean(
                                cfg('prepare_to_work_steering_wheel_heat_enabled', false),
                            )}
                            onChange={e =>
                                setState(
                                    `${adapter}.config.prepare_to_work_steering_wheel_heat_enabled`,
                                    e.target.checked,
                                )
                            }
                        />
                    }
                    label={I18n.t('Also turn on steering wheel heat when heating')}
                />
                <br />
                <FormControlLabel
                    control={
                        <Switch
                            checked={Boolean(
                                cfg('prepare_to_work_defrost_enabled', false),
                            )}
                            onChange={e =>
                                setState(
                                    `${adapter}.config.prepare_to_work_defrost_enabled`,
                                    e.target.checked,
                                )
                            }
                        />
                    }
                    label={I18n.t('Also turn on windshield defrost below')}
                />
                <TextField
                    type="number"
                    label={I18n.t('Defrost threshold (°C)')}
                    value={cfg('prepare_to_work_defrost_below', 0)}
                    onChange={e =>
                        setState(
                            `${adapter}.config.prepare_to_work_defrost_below`,
                            Number(e.target.value),
                        )
                    }
                    size="small"
                    sx={{ width: 200, ml: 2 }}
                    disabled={!cfg('prepare_to_work_defrost_enabled', false)}
                />
            </SectionCard>

            <SectionCard
                icon={
                    <NotificationsIcon
                        sx={{ color: '#00d4ff' }}
                    />
                }
                title={I18n.t(
                    'Push Notifications',
                )}
            >
                <Typography
                    variant="caption"
                    sx={{
                        color: '#5a7090',
                        display: 'block',
                        mb: 1.5,
                    }}
                >
                    {I18n.t(
                        'Works with Telegram, WhatsApp, email, and other sendTo-capable notification adapters. The chat list button below is a Telegram-specific convenience - other adapters need the target entered manually.',
                    )}
                </Typography>

                <Box
                    sx={{
                        display: 'flex',
                        gap: 2,
                        flexWrap: 'wrap',
                        mb: 1,
                    }}
                >
                    <TextField
                        select
                        label={I18n.t(
                            'Notification adapter instance',
                        )}
                        value={
                            notifyAdapters?.some(
                                item =>
                                    item.id
                                    === notifyAdapter,
                            )
                                ? notifyAdapter
                                : ''
                        }
                        onChange={e => {
                            const value =
                                e.target.value;

                            setNotifyAdapter(
                                value,
                            );

                            setState(
                                `${adapter}.config.notify_adapter`,
                                value,
                            );
                        }}
                        size="small"
                        sx={{ width: 260 }}
                        helperText={
                            notifyAdapters
                            && notifyAdapters.length
                                === 0
                                ? I18n.t(
                                    'No compatible notification adapter installed',
                                )
                                : ''
                        }
                    >
                        <MenuItem value="">
                            {I18n.t(
                                '(none)',
                            )}
                        </MenuItem>

                        {(notifyAdapters || []).map(
                            item => (
                                <MenuItem
                                    key={item.id}
                                    value={item.id}
                                >
                                    {item.name} ({item.id})
                                </MenuItem>
                            ),
                        )}
                    </TextField>

                    {isTelegram
                        && telegramUsers === null
                        && (
                            <Button
                                size="small"
                                variant="outlined"
                                startIcon={
                                    loadingUsers
                                        ? (
                                            <CircularProgress
                                                size={14}
                                            />
                                        )
                                        : (
                                            <RefreshIcon />
                                        )
                                }
                                onClick={
                                    loadTelegramUsers
                                }
                                disabled={
                                    loadingUsers
                                }
                            >
                                {I18n.t(
                                    'Load Telegram chat list',
                                )}
                            </Button>
                        )}
                </Box>

                {isTelegram
                    && Array.isArray(
                        telegramUsers,
                    )
                    && telegramUsers.length > 0
                    ? (
                        <TextField
                            select
                            label={I18n.t(
                                'Target (chat)',
                            )}
                            value={notifyTarget}
                            onChange={e => {
                                const value =
                                    e.target.value;

                                setNotifyTarget(
                                    value,
                                );

                                setState(
                                    `${adapter}.config.notify_target`,
                                    value,
                                );
                            }}
                            size="small"
                            sx={{ width: 260 }}
                        >
                            <MenuItem value="">
                                {I18n.t(
                                    '(adapter default)',
                                )}
                            </MenuItem>

                            {telegramUsers.map(
                                user => (
                                    <MenuItem
                                        key={
                                            user.chatId
                                        }
                                        value={
                                            user.chatId
                                        }
                                    >
                                        {user.label}
                                    </MenuItem>
                                ),
                            )}
                        </TextField>
                    )
                    : (
                        <TextField
                            label={I18n.t(
                                'Target (chat ID / recipient, optional)',
                            )}
                            value={notifyTarget}
                            onChange={e =>
                                setNotifyTarget(
                                    e.target.value,
                                )
                            }
                            onBlur={() =>
                                setState(
                                    `${adapter}.config.notify_target`,
                                    notifyTarget,
                                )
                            }
                            size="small"
                            sx={{ width: 260 }}
                        />
                    )}

                {isTelegram
                    && Array.isArray(
                        telegramUsers,
                    )
                    && telegramUsers.length === 0
                    && (
                        <Typography
                            variant="caption"
                            sx={{
                                color: '#ff8844',
                                display: 'block',
                                mt: 0.5,
                            }}
                        >
                            {I18n.t(
                                'No known Telegram users found - message your bot once first, then reload.',
                            )}
                        </Typography>
                    )}

                {isTelegrammenu2 && (
                    <TextField
                        fullWidth
                        label={I18n.t(
                            'telegrammenu2 area (optional)',
                        )}
                        value={tm2Area}
                        onChange={e => setTm2Area(e.target.value)}
                        onBlur={() =>
                            setState(
                                `${adapter}.config.notify_telegrammenu2_area`,
                                tm2Area,
                            )
                        }
                        size="small"
                        placeholder="z.B. Knöpsel"
                        sx={{ mt: 1.5 }}
                        helperText={I18n.t(
                            'Must already be an approved area in telegrammenu2. Leave empty to use the vehicle name.',
                        )}
                    />
                )}

                <Divider
                    sx={{
                        my: 2,
                        borderColor: '#1e2d45',
                    }}
                />

                <FormControlLabel
                    control={
                        <Switch
                            checked={Boolean(
                                cfg(
                                    'notify_trip_done',
                                    false,
                                ),
                            )}
                            onChange={e =>
                                setState(
                                    `${adapter}.config.notify_trip_done`,
                                    e.target.checked,
                                )
                            }
                        />
                    }
                    label={I18n.t(
                        'Notify when a trip ends',
                    )}
                />

                <br />

                <FormControlLabel
                    control={
                        <Switch
                            checked={Boolean(
                                cfg(
                                    'notify_charge_done',
                                    false,
                                ),
                            )}
                            onChange={e =>
                                setState(
                                    `${adapter}.config.notify_charge_done`,
                                    e.target.checked,
                                )
                            }
                        />
                    }
                    label={I18n.t(
                        'Notify when charging finishes',
                    )}
                />

                <br />

                <FormControlLabel
                    control={
                        <Switch
                            checked={Boolean(
                                cfg(
                                    'notify_ota_update',
                                    false,
                                ),
                            )}
                            onChange={e =>
                                setState(
                                    `${adapter}.config.notify_ota_update`,
                                    e.target.checked,
                                )
                            }
                        />
                    }
                    label={I18n.t(
                        'Notify on software update available',
                    )}
                />

                <br />

                <FormControlLabel
                    control={
                        <Switch
                            checked={Boolean(
                                cfg(
                                    'notify_new_message',
                                    false,
                                ),
                            )}
                            onChange={e =>
                                setState(
                                    `${adapter}.config.notify_new_message`,
                                    e.target.checked,
                                )
                            }
                        />
                    }
                    label={I18n.t(
                        'Notify on new vehicle message (service reminders, recalls, etc.)',
                    )}
                />

                <br />

                <FormControlLabel
                    control={
                        <Switch
                            checked={Boolean(
                                cfg(
                                    'notify_window_open',
                                    false,
                                ),
                            )}
                            onChange={e =>
                                setState(
                                    `${adapter}.config.notify_window_open`,
                                    e.target.checked,
                                )
                            }
                        />
                    }
                    label={I18n.t(
                        'Notify if a window is left open while parked',
                    )}
                />

                <Divider
                    sx={{
                        my: 2,
                        borderColor: '#1e2d45',
                    }}
                />

                <Box
                    sx={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 1.5,
                        flexWrap: 'wrap',
                    }}
                >
                    <Button
                        variant="contained"
                        size="small"
                        startIcon={
                            testState === 'sending'
                                ? (
                                    <CircularProgress
                                        size={14}
                                    />
                                )
                                : (
                                    <SendIcon />
                                )
                        }
                        onClick={sendTest}
                        disabled={
                            !notifyAdapter
                            || testState
                                === 'sending'
                        }
                    >
                        {I18n.t(
                            'Send test notification',
                        )}
                    </Button>

                    {testState === 'ok' && (
                        <Box
                            sx={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 0.5,
                                color: '#00ff88',
                            }}
                        >
                            <CheckCircleIcon
                                fontSize="small"
                            />

                            <Typography
                                variant="body2"
                            >
                                {I18n.t(
                                    'Sent successfully',
                                )}
                            </Typography>
                        </Box>
                    )}

                    {typeof testState
                        === 'object'
                        && testState?.error
                        && (
                            <Box
                                sx={{
                                    display: 'flex',
                                    alignItems:
                                        'center',
                                    gap: 0.5,
                                    color:
                                        '#ff4444',
                                }}
                            >
                                <ErrorIcon
                                    fontSize="small"
                                />

                                <Typography
                                    variant="body2"
                                >
                                    {
                                        testState.error
                                    }
                                </Typography>
                            </Box>
                        )}
                </Box>
            </SectionCard>
        </Box>
    );
}