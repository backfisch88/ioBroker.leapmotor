import { useState, useEffect, useRef, useCallback } from 'react';
import { AdminConnection } from '@iobroker/adapter-react-v5';

// window.registerSocketOnLoad is set up by index.html's inline loader script.
// This is the pattern used by other ioBroker admin-tab apps: no blind polling
// for window.io, just a callback fired once the script actually loads.
export function useConnection(adapterInstance) {
    const [connected, setConnected] = useState(false);
    const [error, setError] = useState(null);
    const [states, setStates] = useState({});
    const [systemLanguage, setSystemLanguage] = useState(null);
    const [langError, setLangError] = useState(null);
    const connRef = useRef(null);

    useEffect(() => {
        let cancelled = false;
        let cleanupConn = null;

        function initConnection() {
            const conn = new AdminConnection({
                protocol: window.location.protocol.replace(':', ''),
                host: window.location.hostname,
                port: parseInt(window.location.port, 10) || 8081,
                admin5only: false,
                autoSubscribes: [],
                onReady: () => {
                    if (cancelled) return;
                    setConnected(true);
                    setError(null);
                    conn.subscribeState(`${adapterInstance}.*`, (id, state) => {
                        setStates(prev => ({ ...prev, [id]: state }));
                    });
                    // Echte ioBroker-Systemsprache holen (statt Browser-Sprache zu
                    // raten), damit die Oberfläche der Admin-Spracheinstellung folgt.
                    conn.getObject('system.config')
                        .then((obj) => {
                            if (!cancelled) setSystemLanguage(obj?.common?.language || 'en');
                        })
                        .catch((err) => {
                            if (!cancelled) {
                                setLangError(String(err?.message || err));
                                setSystemLanguage('en');
                            }
                        });
                },
                onError: (err) => {
                    if (!cancelled) setError('Connection error: ' + (err?.message || JSON.stringify(err)));
                },
            });

            connRef.current = conn;
            cleanupConn = conn;

            conn.startSocket().catch((err) => {
                if (!cancelled) setError('startSocket failed: ' + (err?.message || err));
            });

            const timeout = window.setTimeout(() => {
                if (!cancelled && !conn.isConnected?.()) {
                    setError('Timeout: Keine Verbindung nach 10 Sekunden');
                }
            }, 10000);
            cleanupConn._timeout = timeout;
        }

        if (window.io) {
            initConnection();
        } else if (window.registerSocketOnLoad) {
            window.registerSocketOnLoad(() => { if (!cancelled) initConnection(); });
        } else {
            setError('ioBroker socket loader not available');
        }

        return () => {
            cancelled = true;
            if (cleanupConn) {
                window.clearTimeout(cleanupConn._timeout);
                try { cleanupConn.destroy?.(); } catch (e) { /* ignore */ }
            }
        };
    }, [adapterInstance]);

    const getStates = useCallback((pattern, cb) => {
        connRef.current?.getStates(pattern)
            .then((result) => {
                if (result) setStates(prev => ({ ...prev, ...result }));
                cb?.(null, result);
            })
            .catch((err) => cb?.(err));
    }, []);

    const setState = useCallback((id, val) => {
        connRef.current?.setState(id, { val, ack: false });
    }, []);

    // Used by SettingsTab to ask another adapter instance directly (e.g.
    // "adminuser" on a Telegram instance, returning its known chat users) -
    // same mechanism jsonConfig's selectSendTo uses server-side, just called
    // straight from our own tab instead.
    const sendTo = useCallback((instance, command, message) => {
        return connRef.current?.sendTo(instance, command, message);
    }, []);

    const getObjects = useCallback((pattern, cb) => {
        connRef.current?.getObjects(true)
            .then((result) => {
                const filtered = {};
                const prefix = pattern.replace('*', '');
                Object.keys(result || {}).forEach(id => {
                    if (id.startsWith(prefix)) filtered[id] = result[id];
                });
                cb?.(null, filtered);
            })
            .catch((err) => cb?.(err));
    }, []);

    return { connected, error, states, getStates, setState, sendTo, getObjects, systemLanguage, langError };
}
