import { useEffect, useState, useRef } from 'react';
import { supabase } from '../supabase';
import { colors } from '../design-tokens';
import * as Sentry from '@sentry/react';

// Connectivity states for the ISP block banner
// 'ok'      — proxy working, no banner shown
// 'warning' — proxy unreachable but orders still arriving via fallback  
// 'error'   — completely unreachable, showing cached orders only
const CONN_OK = 'ok';
const CONN_WARNING = 'warning';
const CONN_ERROR = 'error';

// ── Demo/Fake orders for offline testing ──────────────────────────────────────
const DEMO_ORDERS = [
  {
    order_id: 'D-001',
    status: 'order_received',
    table_number: 3,
    created_at: new Date(Date.now() - 4 * 60000).toISOString(),
    allergen_alert: false,
    allergen_text: null,
    allergen_ack_at: null,
    items: [
      { name: 'Chicken Biryani', quantity: 2 },
      { name: 'Garlic Naan', quantity: 3 },
      { name: 'Raita', quantity: 1 },
    ],
    source: 'whatsapp',
  },
  {
    order_id: 'D-002',
    status: 'preparing',
    table_number: null,
    created_at: new Date(Date.now() - 9 * 60000).toISOString(),
    allergen_alert: true,
    allergen_text: 'Contains PEANUTS',
    allergen_ack_at: null,
    items: [
      { name: 'Pad Thai', quantity: 1 },
      { name: 'Spring Rolls', quantity: 2 },
    ],
    source: 'pos',
  },
  {
    order_id: 'D-003',
    status: 'ready_for_pickup',
    table_number: 7,
    created_at: new Date(Date.now() - 15 * 60000).toISOString(),
    allergen_alert: false,
    allergen_text: null,
    allergen_ack_at: null,
    items: [
      { name: 'Masala Dosa', quantity: 2 },
      { name: 'Filter Coffee', quantity: 2 },
    ],
    source: 'whatsapp',
  },
];

// ── Device ID Registration (Phase 1.12) — FIX KDS-4d: Use IndexedDB for Safari ITP
// Safari clears localStorage on ITP-affected origins. IndexedDB is more persistent.
const getOrCreateDeviceUUID = async () => {
  // Try IndexedDB first (survives Safari ITP)
  try {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('kds_device', 2); // upgraded version for cache
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('config')) db.createObjectStore('config');
        if (!db.objectStoreNames.contains('orders_cache')) db.createObjectStore('orders_cache');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const tx = db.transaction('config', 'readonly');
    const store = tx.objectStore('config');
    const existing = await new Promise((resolve) => {
      const req = store.get('device_uuid');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
    if (existing) {
      db.close();
      return existing;
    }
    // Generate new UUID
    const uuid = window.crypto?.randomUUID ? window.crypto.randomUUID() : 'dev-' + Math.random().toString(36).substr(2, 9);
    const writeTx = db.transaction('config', 'readwrite');
    writeTx.objectStore('config').put(uuid, 'device_uuid');
    db.close();
    // Also write to localStorage as fallback
    try { localStorage.setItem('kds_device_uuid', uuid); } catch(e) {}
    return uuid;
  } catch (e) {
    // IndexedDB unavailable — fall back to localStorage
    let uuid = localStorage.getItem('kds_device_uuid');
    if (!uuid) {
      uuid = window.crypto?.randomUUID ? window.crypto.randomUUID() : 'dev-' + Math.random().toString(36).substr(2, 9);
      localStorage.setItem('kds_device_uuid', uuid);
    }
    return uuid;
  }
};
// Initialize synchronously with localStorage fallback, async update with IndexedDB
let DEVICE_ID = localStorage.getItem('kds_device_uuid') || 'initializing';
getOrCreateDeviceUUID().then(id => { DEVICE_ID = id; });

export default function Kitchen() {
  const [orders, setOrders] = useState([]);
  const [isDemoMode, setIsDemoMode] = useState(false);
  const [isOffline, setIsOffline] = useState(false); // OPS-6d
  const audioRef = useRef(null);
  const [currentTick, setCurrentTick] = useState(Date.now());
  const [soundEnabled, setSoundEnabled] = useState(false);
  const [readyTimes, setReadyTimes] = useState({});
  const [autoClearSeconds, setAutoClearSeconds] = useState(30);
  const [allergenAcked, setAllergenAcked] = useState({}); // orderId → bool
  const [missedOrders, setMissedOrders] = useState([]);
  const [station, setStation] = useState(new URLSearchParams(window.location.search).get('station') || 'all');
  const [lastSyncTime, setLastSyncTime] = useState(Date.now());
  const [deviceWarning, setDeviceWarning] = useState(null);
  // ISP block connectivity banner state
  const [connStatus, setConnStatus] = useState(CONN_OK);

  // ── ISP Block Connectivity Check ─────────────────────────────────────────
  // Runs once on mount. Checks if the Cloudflare proxy is working.
  // Sets a visible banner if the proxy is down — readable from 3 metres.
  useEffect(() => {
    const proxyUrl = import.meta.env.VITE_SUPABASE_PROXY_URL;
    const directUrl = import.meta.env.VITE_SUPABASE_URL;
    const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

    if (!proxyUrl) return; // No proxy configured — running in direct/dev mode, no banner needed

    const check = async () => {
      try {
        const res = await fetch(`${proxyUrl}/rest/v1/`, {
          method: 'HEAD',
          headers: { 'apikey': anonKey },
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok || res.status === 404) {
          setConnStatus(CONN_OK); // Proxy healthy — no banner
          return;
        }
      } catch (_) {
        // Proxy failed — check if direct connection works (orders still arriving via fallback)
        try {
          await fetch(`${directUrl}/rest/v1/`, {
            method: 'HEAD',
            headers: { 'apikey': anonKey },
            signal: AbortSignal.timeout(5000),
          });
          // Direct works — proxy issue only, orders still arriving
          setConnStatus(CONN_WARNING);
        } catch (_2) {
          // Nothing works — total connectivity loss
          setConnStatus(CONN_ERROR);
        }
      }
    };

    check();
  }, []);

  useEffect(() => {
    const checkCredentials = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      
      const { data: staffData } = await supabase.from('staff').select('id, active_device_id, last_login_at').eq('id', user.id).single();
      
      if (staffData && staffData.active_device_id && staffData.active_device_id !== DEVICE_ID) {
        const lastLogin = new Date(staffData.last_login_at || 0);
        const hoursSince = (Date.now() - lastLogin.getTime()) / (1000 * 60 * 60);
        
        if (hoursSince < 4) {
          setDeviceWarning('This account is active on another device. Continue anyway?');
        }
      }
      
      // Claim the session
      await supabase.from('staff').update({
        active_device_id: DEVICE_ID,
        last_login_at: new Date().toISOString()
      }).eq('id', user.id);
    };
    checkCredentials();
  }, []);

  useEffect(() => {
    const fetchOrders = async () => {
      const { data, error } = await supabase
        .from('orders')
        .select('*')
        .in('status', ['order_received', 'preparing', 'ready_for_pickup'])
        .order('created_at', { ascending: true });
      if (error) {
         setIsOffline(true);
         // OPS-6d: Load from IndexedDB cache on outage
         try {
           const db = await new Promise((resolve) => {
               const req = indexedDB.open('kds_device', 2);
               req.onsuccess = () => resolve(req.result);
               req.onerror = () => resolve(null);
           });
           if (db) {
               const tx = db.transaction('orders_cache', 'readonly');
               const cachedOrders = await new Promise((resolve) => {
                   const req = tx.objectStore('orders_cache').get('last_orders');
                   req.onsuccess = () => resolve(req.result);
                   req.onerror = () => resolve(null);
               });
               db.close();
               if (cachedOrders && Array.isArray(cachedOrders)) {
                   setOrders(cachedOrders);
                   const initialReady = {};
                   cachedOrders.forEach(o => { if (o.status === 'ready_for_pickup') initialReady[o.order_id] = Date.now(); });
                   setReadyTimes(initialReady);
                   return; // loaded offline cache successfully
               }
           }
         } catch (e) {
           console.error('Failed to read from KDS offline cache', e);
         }
         
         // Fallback to demo mode if no network and no cache
         setOrders(DEMO_ORDERS);
         setIsDemoMode(true);
         const initialReady = {};
         DEMO_ORDERS.forEach(o => { if (o.status === 'ready_for_pickup') initialReady[o.order_id] = Date.now(); });
         setReadyTimes(initialReady);
      } else if (data && data.length > 0) {
         setOrders(data);
         setIsDemoMode(false);
         setIsOffline(false);
         const initialReady = {};
         const now = Date.now();
         data.forEach(o => {
             if (o.status === 'ready_for_pickup') initialReady[o.order_id] = now;
         });
         setReadyTimes(initialReady);
         
         // Save to offline cache
         try {
           const db = await new Promise((resolve) => {
               const req = indexedDB.open('kds_device', 2);
               req.onsuccess = () => resolve(req.result);
               req.onerror = () => resolve(null);
           });
           if (db) {
               const tx = db.transaction('orders_cache', 'readwrite');
               tx.objectStore('orders_cache').put(data, 'last_orders');
               db.close();
           }
         } catch(e) {}
      } else if (data && data.length === 0) {
         setOrders([]);
         setIsOffline(false);
      }
    };
    fetchOrders();

    const subs = supabase.channel('public:orders')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, payload => {
        if (payload.eventType === 'INSERT') {
          setOrders(curr => [...curr, payload.new]);
          if (audioRef.current && soundEnabled) audioRef.current.play().catch(()=>null);
        } else if (payload.eventType === 'UPDATE') {
          const valid = ['order_received', 'preparing', 'ready_for_pickup'];
          if (!valid.includes(payload.new.status)) {
             setOrders(curr => curr.filter(o => o.order_id !== payload.new.order_id));
          } else {
             setOrders(curr => curr.map(o => o.order_id === payload.new.order_id ? payload.new : o));
             if (payload.new.status === 'ready_for_pickup') {
                 setReadyTimes(prev => ({ ...prev, [payload.new.order_id]: prev[payload.new.order_id] || Date.now() }));
             }
          }
        }
      }).subscribe();

    const interval = setInterval(() => setCurrentTick(Date.now()), 1000);
    const syncInterval = setInterval(() => { fetchOrders(); setLastSyncTime(Date.now()); }, 180000);

    // ── KDS Device Registration & Health ───────────────────────────────────
    const registerDevice = async () => {
      const { data } = await supabase.from('kds_devices').select('device_uuid').eq('device_uuid', DEVICE_ID).maybeSingle();
      if (!data) {
         await supabase.from('kds_devices').insert({ device_uuid: DEVICE_ID, station: new URLSearchParams(window.location.search).get('station') || 'all' });
      } else {
         await supabase.from('kds_devices').update({ last_seen_at: new Date().toISOString() }).eq('device_uuid', DEVICE_ID);
      }
    };
    registerDevice();

    // ── Heartbeat: ping settings table every 60s for n8n detector
    const heartbeat = setInterval(async () => {
      await supabase.from('settings').upsert({ key: 'kds_last_heartbeat', value: new Date().toISOString() });
    }, 60000);

    // ── KDS Application-Level Realtime Health Check (Phase 2.9) ─────────────────
    let lastPingId = null;
    let pingTimeout = null;
    
    const pingSubs = supabase.channel('kds-health')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'kds_pings' }, payload => {
        if (payload.new.device_id === DEVICE_ID && payload.new.id === lastPingId) {
           clearTimeout(pingTimeout); // Realtime is fully operational
        }
      }).subscribe();

    const appLevelPing = setInterval(async () => {
      const { data } = await supabase.from('kds_pings')
          .insert({ device_id: DEVICE_ID })
          .select('id').maybeSingle();
      if (data) {
          lastPingId = data.id;
          pingTimeout = setTimeout(() => {
              console.error("Realtime socket is connected but events are stalled! Forcing app reload.");
              window.location.reload(); 
          }, 10000);
      }
    }, 60000);

    // ── FIX KDS-4c: Status-based boot recovery (replaces 12-min fixed window) ────
    // Catches ALL active orders regardless of age — not just last 12 minutes
    setTimeout(async () => {
      const { data: activeOrders } = await supabase
        .from('orders')
        .select('*')
        .in('status', ['order_received', 'preparing'])
        .order('created_at', { ascending: true });
      if (activeOrders && activeOrders.length > 0) {
        setOrders(curr => {
          const existingIds = new Set(curr.map(o => o.order_id));
          const missed = activeOrders.filter(o => !existingIds.has(o.order_id));
          if (missed.length > 0) {
            setMissedOrders(missed);
            if (audioRef.current) missed.forEach(() => audioRef.current.play().catch(() => null));
          }
          return [...curr, ...missed];
        });
      }
    }, 3000);

    return () => { 
      supabase.removeChannel(subs); 
      supabase.removeChannel(pingSubs);
      clearInterval(interval); 
      clearInterval(syncInterval); 
      clearInterval(heartbeat); 
      clearInterval(appLevelPing);
      clearTimeout(pingTimeout);
    };
  }, []);

  const displayOrders = orders.filter(o => {
      if (['preparing', 'order_received'].includes(o.status)) return true;
      if (o.status === 'ready_for_pickup') {
          const markedTime = readyTimes[o.order_id];
          if (!markedTime) return true;
          return (currentTick - markedTime) < (autoClearSeconds * 1000);
      }
      return false;
  });

  // In demo mode: update orders locally instead of hitting Supabase
  const handleAllergenAck = async (orderId) => {
    if (!isDemoMode) {
      await supabase.from('orders').update({
        allergen_ack_at: new Date().toISOString(),
        allergen_ack_device: DEVICE_ID
      }).eq('order_id', orderId);
    }
    setAllergenAcked(prev => ({ ...prev, [orderId]: true }));
  };

  const handleUpdateStatus = async (orderId, currentStatus) => {
    let nextStatus = 'ready_for_pickup';
    if (currentStatus === 'order_received') nextStatus = 'preparing';

    if (!isDemoMode) {
      // FIX DB-1c: Use stored procedures for status transitions instead of bare .update()
      const rpcName = currentStatus === 'order_received' ? 'kds_start_preparing' : 'kds_mark_ready';
      const { error } = await supabase.rpc(rpcName, { p_order_id: orderId });
      if (error) {
        if (error.message?.includes('INVALID_TRANSITION')) {
          alert('Order status changed — refreshing');
          // Trigger refetch
          const { data } = await supabase.from('orders').select('*').in('status', ['order_received', 'preparing', 'ready_for_pickup']).order('created_at', { ascending: true });
          if (data) setOrders(data);
          return;
        }
        console.error('Status update error:', error);
        return;
      }
    }
    if (nextStatus === 'ready_for_pickup') {
       setReadyTimes(prev => ({ ...prev, [orderId]: Date.now() }));
    }
    setOrders(curr => curr.map(o => o.order_id === orderId ? { ...o, status: nextStatus } : o));
  };


  // FIX KDS-4e: Use wall-clock time comparison instead of setInterval delta
  // setInterval drifts when iPad sleeps; Date.now() always returns real wall time
  const getTimeInfo = (createdAt) => {
    const minDiff = Math.floor((Date.now() - new Date(createdAt).getTime()) / 60000);
    return minDiff;
  };

  if (!soundEnabled) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-6 space-y-8" style={{ backgroundColor: colors.bg.dark }}>
        <h1 className="text-4xl font-black text-white tracking-tighter">
          Kitchen Display System
        </h1>
        <p className="text-gray-400 text-center max-w-md font-medium text-lg">Browsers block audio by default. Tap to ignite the dashboard and enable live order alarms.</p>
        <button onClick={() => setSoundEnabled(true)} className="px-12 py-6 bg-emerald-500 hover:bg-emerald-400 text-white font-black text-xl rounded-2xl">
           Start & Enable Audio
        </button>
      </div>
    );
  }

  return (
    <Sentry.ErrorBoundary fallback={<div className="p-4 bg-red-100 text-red-900 rounded">Kitchen Interface Crashed. Reloading...</div>}>
    <div className="h-screen overflow-hidden flex flex-col font-sans" style={{ backgroundColor: colors.bg.dark }}>
      <audio ref={audioRef} src="https://actions.google.com/sounds/v1/alarms/ding.ogg" preload="auto" />

      {/* ── ISP Block Detection Banner ─────────────────────────────────────────
           Large text (readable from 3m), full width, high contrast.
           Yellow = proxy issue but orders still arriving.
           Red    = total connectivity loss, showing cached orders only. */}
      {connStatus === CONN_WARNING && (
        <div className="w-full px-6 py-4 flex items-center gap-4 shrink-0" style={{ backgroundColor: '#92400e' }}>
          <span className="material-symbols-outlined text-yellow-200 text-4xl" style={{ fontVariationSettings: "'FILL' 1" }}>warning</span>
          <span className="text-yellow-100 font-black text-2xl tracking-tight">
            ⚠ Network proxy issue detected. Contact your system administrator. Orders are still arriving.
          </span>
        </div>
      )}
      {connStatus === CONN_ERROR && (
        <div className="w-full px-6 py-4 flex items-center gap-4 shrink-0" style={{ backgroundColor: '#7f1d1d' }}>
          <span className="material-symbols-outlined text-red-200 text-4xl" style={{ fontVariationSettings: "'FILL' 1" }}>signal_wifi_off</span>
          <span className="text-red-100 font-black text-2xl tracking-tight">
            ✗ Cannot reach database. Check internet connection. Last known orders shown below.
          </span>
        </div>
      )}

      {/* Top Navigation Bar */}
      <header className="w-full h-[64px] border-b px-6 flex items-center justify-between z-50 shrink-0" style={{ backgroundColor: colors.bg.cardDark, borderColor: '#21262D' }}>
        <div className="flex items-center gap-3">
          <span className="material-symbols-outlined text-emerald-400">restaurant</span>
          <h1 className="text-white text-[20px] font-bold tracking-tight">Live Kitchen</h1>
          {isDemoMode && (
            <span className="text-[10px] font-bold uppercase tracking-widest px-2 py-1 rounded border border-amber-500/40 text-amber-400 bg-amber-500/10">DEMO MODE</span>
          )}
          {isOffline && !isDemoMode && (
            <span className="text-[10px] font-bold uppercase tracking-widest px-2 py-1 rounded border border-red-500/40 text-red-400 bg-red-500/10 animate-pulse">OFFLINE MODE (VIEW ONLY)</span>
          )}
        </div>
        <div className="absolute left-1/2 -translate-x-1/2 hidden md:block">
          <span className="font-mono text-[18px] text-white tracking-widest px-4 py-1 rounded-md border" style={{ backgroundColor: colors.bg.dark, borderColor: '#21262D' }}>
              {new Date(currentTick).toLocaleTimeString('en-US', { hour12: false })}
          </span>
        </div>
        <div className="flex items-center gap-4 text-slate-400 text-sm">
          <div className="flex items-center gap-3">
            <label className="font-medium hidden sm:block" htmlFor="auto-clear">Auto-clear ready orders:</label>
            <div className="relative">
              <input 
                id="auto-clear"
                type="number" 
                value={autoClearSeconds} 
                onChange={(e) => setAutoClearSeconds(Math.max(0, parseInt(e.target.value) || 0))}
                className="w-[60px] h-8 rounded text-center text-white focus:ring-1 focus:ring-emerald-500 outline-none border"
                style={{ backgroundColor: colors.bg.dark, borderColor: '#21262D' }}
              />
            </div>
            <span className="uppercase tracking-widest text-[10px] font-bold hidden sm:block">sec</span>
          </div>
        </div>
      </header>

      {deviceWarning && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[100] flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl w-full max-w-md p-6 border-l-[6px] border-amber-500 shadow-2xl">
             <h2 className="text-xl font-black text-slate-800 mb-2">Security Warning</h2>
             <p className="text-slate-600 font-medium mb-6">{deviceWarning}</p>
             <div className="flex gap-3 justify-end">
                <button onClick={() => setDeviceWarning(null)} className="px-5 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-lg transition-all">Cancel</button>
                <button onClick={async () => {
                  setDeviceWarning(null);
                  supabase.from('audit_log').insert([{ action: 'override_credential_warning', metadata: { device: DEVICE_ID } }]);
                }} className="px-5 py-2.5 bg-amber-500 hover:bg-amber-600 text-white font-bold rounded-lg shadow-sm transition-all">Acknowledge & Continue</button>
             </div>
          </div>
        </div>
      )}
      
      <main className="p-4 flex-1 overflow-y-auto">
        {displayOrders.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center gap-4 opacity-30 pt-24">
            <span className="material-symbols-outlined text-white text-[64px]">check_circle</span>
            <p className="text-white font-bold text-lg tracking-widest uppercase">All Clear — No Active Tickets</p>
          </div>
        ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {displayOrders.map(order => {
            const waitMins = getTimeInfo(order.created_at);
            const isAllergen = order.allergen_alert;
            const isAcked = allergenAcked[order.order_id] || !!order.allergen_ack_at;
            
            let statusColor = colors.status.received; // blue
            if (order.status === 'preparing') statusColor = colors.status.preparing; // amber
            if (order.status === 'ready_for_pickup') statusColor = colors.status.ready; // green
            
            // Late order override for received/preparing
            const isLate = waitMins > 10 && order.status !== 'ready_for_pickup';
            
            return (
              <div key={order.order_id} className="rounded-[16px] border-[3px] flex flex-col p-4 shadow-2xl transition-all" style={{ backgroundColor: colors.bg.cardDark, borderColor: statusColor, opacity: order.status === 'ready_for_pickup' ? 0.8 : 1 }}>
                
                <div className="flex justify-between items-center mb-4">
                  <span className="text-white font-bold text-[16px] font-mono">#{order.order_id}</span>
                  <span className="bg-blue-900/40 text-blue-100 text-[12px] font-bold px-3 py-1 rounded-full uppercase tracking-wider">
                    {order.table_number ? `Table ${order.table_number}` : 'Takeaway'}
                  </span>
                  
                  {order.status === 'ready_for_pickup' ? (
                    <span className="flex items-center gap-1 px-3 py-1 rounded-full text-[13px] font-black uppercase tracking-widest" style={{ backgroundColor: colors.status.ready + '22', color: colors.status.ready }}>
                      <span className="material-symbols-outlined text-[15px]">done_all</span> Ready
                    </span>
                  ) : (
                    <span className={`flex items-center gap-1 px-3 py-1.5 rounded-full text-[15px] font-black uppercase tracking-widest ${isLate ? 'animate-pulse' : ''}`}
                      style={{ backgroundColor: isLate ? '#ef444422' : '#ffffff12', color: isLate ? '#ef4444' : '#ffffff' }}>
                      <span className="material-symbols-outlined text-[16px]">{isLate ? 'timer_off' : 'schedule'}</span>
                      WAIT&nbsp;{waitMins}m
                    </span>
                  )}
                </div>
                
                <div className="h-[1px] w-full mb-4" style={{ backgroundColor: '#21262D' }}></div>
                
                <div className="flex-grow space-y-4 mb-6">
                  {order.items?.map((item, idx) => (
                    <div key={idx} className="flex items-center gap-3">
                      <span className="font-black text-[22px] font-mono leading-none" style={{ color: colors.status.preparing }}>{item.quantity}×</span>
                      <span className="text-white text-[20px] font-semibold leading-snug">{item.name}</span>
                    </div>
                  ))}
                </div>
                
                {isAllergen && !isAcked && (
                  <>
                    <div className="rounded-[8px] p-2.5 mb-4 flex items-center gap-3 border border-red-500/30" style={{ backgroundColor: colors.allergen.alertBg }}>
                      <span className="material-symbols-outlined text-white" style={{ fontVariationSettings: "'FILL' 1" }}>warning</span>
                      <span className="text-white font-bold text-[13px] leading-tight uppercase tracking-tight">ALLERGEN: {order.allergen_text}</span>
                    </div>
                    <button onClick={() => handleAllergenAck(order.order_id)} className="w-full h-[48px] rounded-[10px] bg-red-600 hover:bg-red-500 text-white font-bold tracking-wide transition-all flex items-center justify-center gap-2">
                       <span className="material-symbols-outlined">lock_open</span> ACKNOWLEDGE
                    </button>
                  </>
                )}
                
                {(!isAllergen || isAcked) && (
                  <>
                    {order.status === 'order_received' && (
                      <button onClick={() => handleUpdateStatus(order.order_id, order.status)} className="w-full h-[48px] rounded-[10px] text-white font-bold tracking-wide hover:opacity-90 transition-all flex items-center justify-center gap-2" style={{ backgroundColor: colors.status.preparing }}>
                        <span className="material-symbols-outlined">play_arrow</span> START PREPARING
                      </button>
                    )}
                    
                    {order.status === 'preparing' && (
                      <button onClick={() => handleUpdateStatus(order.order_id, order.status)} className="w-full h-[48px] rounded-[10px] text-white font-bold tracking-wide hover:opacity-90 transition-all flex items-center justify-center gap-2" style={{ backgroundColor: colors.status.ready }}>
                        <span className="material-symbols-outlined">check_circle</span> MARK READY
                      </button>
                    )}
                    
                    {order.status === 'ready_for_pickup' && (
                      <button className="w-full h-[48px] rounded-[10px] border font-bold tracking-wide flex items-center justify-center gap-2 cursor-default" style={{ borderColor: colors.status.ready, color: colors.status.ready }}>
                        <span className="material-symbols-outlined">check</span> CLEARING IN {Math.max(0, autoClearSeconds - Math.floor((currentTick - (readyTimes[order.order_id] || Date.now())) / 1000))}S
                      </button>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
        )}
      </main>
    </div>
    </Sentry.ErrorBoundary>
  );
}
