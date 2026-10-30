import { useEffect, useRef, useCallback, useState } from 'react';

export default function useWebSocket() {
  const wsRef = useRef(null);
  const retriesRef = useRef(0);
  const [lastEvent, setLastEvent] = useState({ type: null, ts: 0 });

  const connect = useCallback(() => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws`);

    ws.onopen = () => { retriesRef.current = 0; };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type && msg.type !== 'hello') {
          setLastEvent({ type: msg.type, payload: msg.payload, ts: Date.now() });
        }
      } catch {}
    };

    ws.onclose = () => {
      wsRef.current = null;
      const delay = Math.min(1000 * 2 ** retriesRef.current, 30000);
      retriesRef.current++;
      setTimeout(connect, delay);
    };

    wsRef.current = ws;
  }, []);

  useEffect(() => {
    connect();
    return () => { if (wsRef.current) wsRef.current.close(); };
  }, [connect]);

  return lastEvent;
}
