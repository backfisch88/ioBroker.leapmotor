import { useState, useEffect, useRef, useCallback } from 'react';
import { AdminConnection } from '@iobroker/adapter-react-v5';

function waitForSocketIo(timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
        if (window.io) return resolve();
        const start = Date.now();
        const interval = window.setInterval(() => {
            if (window.io) {
                window.clearInterval(interval);
                resolve();
            } else if (Date.now() - start > timeoutMs) {
                window.clearInterval(interval);
                reject(new Error('socket.io.js nicht geladen nach ' + timeoutMs + 'ms'));
            }
        }, 100);
    });
}

// AdminConnection kapselt die Kommunikation mit dem ioBroker Admin-Socket
// korrekt, inklusive Warten auf das via /lib/js/socket.io.js bereitgestellte
// window.io. Das ist robuster als eine eigene io()-Aufruf-Logik.
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

        waitForSocketIo()
            .then(() => { if (!cancelled) initConnection(); })
            .catch((err) => { if (!cancelled) setError(err.message); });

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

    return { connected, error, states, getStates, setState, getObjects, systemLanguage, langError };
}
