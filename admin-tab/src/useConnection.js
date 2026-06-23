import { useState, useEffect, useRef, useCallback } from 'react';
import { AdminConnection } from '@iobroker/adapter-react-v5';

function waitForSocketIo(timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
        if (window.io) return resolve();
        const start = Date.now();
        const interval = setInterval(() => {
            if (window.io) {
                clearInterval(interval);
                resolve();
            } else if (Date.now() - start > timeoutMs) {
                clearInterval(interval);
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

            const timeout = setTimeout(() => {
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
                clearTimeout(cleanupConn._timeout);
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

    return { connected, error, states, getStates, setState, getObjects };
}
