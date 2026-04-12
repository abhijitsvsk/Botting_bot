import { useEffect, useState } from 'react';
import { supabase } from '../supabase';
import { logAction } from '../auth';
import { colors } from '../design-tokens';

export default function Manager({ userRole }) {
  const [orders, setOrders] = useState([]);
  const [refundModal, setRefundModal] = useState(null); // { order }
  const [refundItems, setRefundItems] = useState({});
  const [refundReason, setRefundReason] = useState('');
  const [refundSubmitting, setRefundSubmitting] = useState(false);
  const [activeTab, setActiveTab] = useState('orders');
  const [menuItems, setMenuItems] = useState([]);

  useEffect(() => {
    const fetchOrders = async () => {
      const { data } = await supabase
        .from('orders')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(250);
      if (data) setOrders(data);
    };
    
    const fetchMenu = async () => {
      const { data } = await supabase.from('menu_items').select('*').order('category', { ascending: true });
      if (data) setMenuItems(data);
    };

    fetchOrders();
    fetchMenu();

    const sub = supabase.channel('mgr:orders')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, fetchOrders)
      .subscribe();

    return () => supabase.removeChannel(sub);
  }, []);

  const updateStatus = async (orderId, newStatus) => {
    const { error } = await supabase.from('orders').update({ status: newStatus }).eq('order_id', orderId);
    if (error) { alert(`Database Error: ${error.message}`); return; }
    await logAction('status_update', orderId, { new_status: newStatus });

    // FIX INFRA-8b: Fire-and-forget notification via proxy — use JWT auth, accept 202
    if (newStatus === 'ready_for_pickup' || newStatus === 'completed') {
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.access_token) {
        fetch('/api/notify', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session.access_token}`
          },
          body: JSON.stringify({ order_id: orderId, status: newStatus })
        }).then(res => {
          // 202 = accepted (fire-and-forget), don't wait for n8n
          if (!res.ok && res.status !== 202) {
            console.warn('Proxy notification failed:', res.status);
          }
        }).catch(console.error);
      }
    }
  };

  const toggleItemAvailability = async (itemCode, currentStatus) => {
    const { error } = await supabase.from('menu_items').update({ available: !currentStatus }).eq('item_code', itemCode);
    if (!error) {
       setMenuItems(curr => curr.map(i => i.item_code === itemCode ? { ...i, available: !currentStatus } : i));
       await logAction('menu_item_toggled', null, { item_code: itemCode, available: !currentStatus });
    } else {
       alert(`Error updating availability: ${error.message}`);
    }
  };

  const openRefund = (order) => {
    const initial = {};
    (order.items || []).forEach((item, i) => { initial[i] = false; });
    setRefundItems(initial);
    setRefundReason('');
    setRefundModal(order);
  };

  const submitRefund = async () => {
    if (!refundModal) return;
    setRefundSubmitting(true);
    const selectedItems = (refundModal.items || []).filter((_, i) => refundItems[i]);
    const refundAmount = selectedItems.reduce((s, it) => s + (it.price || 0) * (it.quantity || 1), 0);

    const { error } = await supabase.from('refunds').insert({
      order_id: refundModal.order_id,
      items_refunded: selectedItems,
      amount: refundAmount,
      reason: refundReason
    });

    if (error) { alert(`Refund error: ${error.message}`); setRefundSubmitting(false); return; }
    await logAction('refund_logged', refundModal.order_id, { amount: refundAmount, items: selectedItems.length });
    setRefundModal(null);
    setRefundSubmitting(false);
  };

  const getStatusBorder = (status) => {
    const map = {
      order_received: colors.status.received,
      preparing: colors.status.preparing,
      ready_for_pickup: colors.status.ready,
      completed: '#10b981', // green
      cancelled: '#ef4444', // red
    };
    return map[status] || '#cbd5e1';
  };

  return (
    <div className="w-full h-full flex flex-col font-sans" style={{ backgroundColor: colors.bg.light }}>
      {/* Refund Modal */}
      {refundModal && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-[24px] shadow-[0_20px_40px_-10px_rgba(0,0,0,0.1)] w-full max-w-md p-8 border border-slate-200">
            <h2 className="text-2xl font-black mb-1 text-slate-800 tracking-tight">Log Refund</h2>
            <p className="text-slate-500 font-medium text-sm mb-6 font-mono">Order #{refundModal.order_id} — Select items</p>
            <div className="space-y-3 mb-6">
              {(refundModal.items || []).map((item, i) => (
                <label key={i} className={`flex items-center gap-4 p-4 rounded-[12px] border cursor-pointer transition-all ${refundItems[i] ? 'bg-red-50 border-red-200' : 'bg-slate-50 border-slate-100 hover:bg-slate-100'}`}>
                  <input type="checkbox" checked={!!refundItems[i]} onChange={e => setRefundItems(prev => ({ ...prev, [i]: e.target.checked }))} className="w-5 h-5 accent-red-500 rounded" />
                  <span className={`flex-1 font-bold text-[14px] ${refundItems[i] ? 'text-red-900' : 'text-slate-800'}`}>{item.quantity}x {item.name}</span>
                  <span className="text-slate-500 font-semibold text-sm font-mono">₹{item.price * item.quantity}</span>
                </label>
              ))}
            </div>
            <div className="mb-6">
              <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest block mb-2">Reason</label>
              <input type="text" value={refundReason} onChange={e => setRefundReason(e.target.value)}
                placeholder="e.g. Wrong order..."
                className="w-full bg-slate-50 border border-slate-200 rounded-[12px] px-4 py-3 text-[14px] font-medium outline-none focus:border-[#6366F1] transition-all" />
            </div>
            <div className="flex gap-3">
              <button onClick={() => setRefundModal(null)} className="flex-1 py-3.5 bg-slate-100 hover:bg-slate-200 rounded-[12px] font-bold text-slate-600 transition-all">Cancel</button>
              <button onClick={submitRefund} disabled={refundSubmitting || !Object.values(refundItems).some(Boolean)}
                className="flex-1 py-3.5 bg-red-500 hover:bg-red-600 disabled:opacity-50 text-white rounded-[12px] font-bold transition-all shadow-md">
                {refundSubmitting ? 'Logging…' : `Log ₹${(refundModal.items||[]).filter((_,i)=>refundItems[i]).reduce((s,it)=>s+(it.price||0)*(it.quantity||1),0)}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="bg-white px-6 py-5 border-b border-slate-200 flex justify-between items-center shrink-0">
        <div>
           <h1 className="text-2xl font-black text-slate-900">Terminal Management</h1>
           <div className="flex gap-2 items-center text-slate-500 text-[13px] font-mono mt-1">
             <span>TX-9982</span>
             <span className="px-1.5 py-0.5 bg-emerald-100 text-emerald-700 rounded text-[10px] font-bold tracking-wider">ONLINE</span>
           </div>
        </div>
        <div className="flex items-center gap-2 bg-indigo-50 border border-indigo-100 px-3 py-1.5 rounded-lg">
           <span className="w-2 h-2 rounded-full bg-[#6366F1] animate-pulse"></span>
           <span className="text-[12px] font-bold text-indigo-700 uppercase tracking-widest">Live Sync</span>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-slate-200 bg-white shrink-0 px-6 pt-2">
        <button onClick={() => setActiveTab('orders')} className={`px-6 py-3 font-bold text-[14px] transition-all relative ${activeTab === 'orders' ? 'text-[#6366F1]' : 'text-slate-500 hover:text-slate-800'}`}>
           Live Pipeline
           {activeTab === 'orders' && <div className="absolute bottom-0 left-0 w-full h-[3px] bg-[#6366F1] rounded-t-lg"></div>}
        </button>
        <button onClick={() => setActiveTab('inventory')} className={`px-6 py-3 font-bold text-[14px] transition-all relative ${activeTab === 'inventory' ? 'text-[#6366F1]' : 'text-slate-500 hover:text-slate-800'}`}>
           Menu Routing & 86
           {activeTab === 'inventory' && <div className="absolute bottom-0 left-0 w-full h-[3px] bg-[#6366F1] rounded-t-lg"></div>}
        </button>
        <button onClick={() => setActiveTab('setup')} className={`px-6 py-3 font-bold text-[14px] transition-all relative ${activeTab === 'setup' ? 'text-[#6366F1]' : 'text-slate-500 hover:text-slate-800'}`}>
           Device Setup
           {activeTab === 'setup' && <div className="absolute bottom-0 left-0 w-full h-[3px] bg-[#6366F1] rounded-t-lg"></div>}
        </button>
      </div>
      
      {/* Scrollable Content */}
      <div className="flex-1 overflow-y-auto p-6 no-scrollbar">
        {activeTab === 'inventory' ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
            {menuItems.map(item => (
              <div key={item.item_code} className={`bg-white rounded-[14px] border flex flex-col justify-between overflow-hidden transition-all shadow-sm ${item.available ? 'border-slate-200' : 'border-red-200 opacity-80'}`}>
                <div className="p-5">
                  <div className="flex items-start justify-between mb-3">
                    <span className="font-bold text-[15px] text-slate-800 leading-tight">{item.name}</span>
                    <span className="text-[13px] font-mono text-slate-500 font-bold bg-slate-100 px-2 py-0.5 rounded">₹{item.price}</span>
                  </div>
                  <div className="flex items-center gap-2">
                     <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400 bg-slate-50 px-2 py-1 rounded border border-slate-100">{item.category}</span>
                     {!item.available && <span className="text-[10px] font-bold uppercase tracking-widest text-red-500 bg-red-50 px-2 py-1 rounded border border-red-100">86'D</span>}
                  </div>
                </div>
                <div className="p-3 border-t border-slate-100 bg-slate-50 flex items-center justify-between">
                   <span className="text-[12px] font-semibold text-slate-500 font-mono">{item.item_code}</span>
                   <button onClick={() => toggleItemAvailability(item.item_code, item.available)}
                     className={`px-4 py-1.5 rounded-lg text-[12px] font-bold transition-all shadow-sm ${item.available ? 'bg-white border border-red-200 text-red-600 hover:bg-red-50' : 'bg-[#6366F1] text-white hover:bg-indigo-500 border border-indigo-600'}`}>
                     {item.available ? 'Mark Sold Out' : 'Mark Available'}
                   </button>
                </div>
              </div>
            ))}
          </div>
        ) : activeTab === 'setup' ? (
          <div className="max-w-2xl mx-auto mt-8 bg-white p-8 rounded-[24px] shadow-sm border border-slate-200">
            <h2 className="text-2xl font-black text-slate-800 tracking-tight mb-2">Configure Replacement KDS iPad</h2>
            <p className="text-slate-500 text-sm font-medium mb-8">Follow these steps on the new iPad to securely bind it to your kitchen network.</p>
            
            <div className="space-y-6">
               <div className="flex gap-4 items-start">
                  <div className="w-8 h-8 rounded-full bg-indigo-100 text-indigo-700 font-black flex items-center justify-center shrink-0">1</div>
                  <div>
                    <h3 className="text-[14px] font-bold text-slate-800 mb-1">Connect to Wi-Fi</h3>
                    <p className="text-slate-500 text-[13px]">Ensure the iPad is connected to the restaurant's internal secure Wi-Fi network.</p>
                  </div>
               </div>
               
               <div className="flex gap-4 items-start">
                  <div className="w-8 h-8 rounded-full bg-indigo-100 text-indigo-700 font-black flex items-center justify-center shrink-0">2</div>
                  <div>
                    <h3 className="text-[14px] font-bold text-slate-800 mb-1">Open Safari and Navigate to KDS URL</h3>
                    <p className="text-slate-500 text-[13px] mb-3">Copy this secure link or type it exactly into Safari on the iPad:</p>
                    <div className="flex items-center gap-2">
                       <code className="bg-slate-50 border border-slate-200 px-4 py-2.5 rounded-[12px] text-slate-800 font-mono text-[13px] select-all w-full md:w-auto">
                          {window.location.origin}/kitchen?station=all
                       </code>
                    </div>
                  </div>
               </div>

               <div className="flex gap-4 items-start">
                  <div className="w-8 h-8 rounded-full bg-indigo-100 text-indigo-700 font-black flex items-center justify-center shrink-0">3</div>
                  <div>
                    <h3 className="text-[14px] font-bold text-slate-800 mb-1">Save to Home Screen</h3>
                    <p className="text-slate-500 text-[13px]">In Safari, tap <strong className="text-slate-700">Share</strong> <span className="material-symbols-outlined text-[14px] align-middle">ios_share</span> and select <strong className="text-slate-700">Add to Home Screen</strong>. This enables persistent offline caching (ITP evasion) and hides the browser UI.</p>
                  </div>
               </div>
            </div>
            
            <div className="mt-8 p-4 bg-amber-50 rounded-[12px] border border-amber-200">
               <p className="text-[12px] font-bold text-amber-800 italic uppercase tracking-widest"><span className="material-symbols-outlined text-[14px] align-middle mr-1">warning</span> Note</p>
               <p className="text-[13px] text-amber-700 mt-1">If the iPad displays an <strong className="text-amber-900 border-b border-amber-400">Offline Mode</strong> banner continuously, it means it cannot reach the local Supabase relay. Check the network connection immediately.</p>
            </div>
          </div>
        ) : (
          <div className="max-w-5xl mx-auto space-y-4">
            {orders.map(order => (
              <div key={order.order_id} className="bg-white rounded-[16px] shadow-sm flex flex-col md:flex-row md:items-stretch overflow-hidden border border-slate-200 border-l-[6px]" style={{ borderLeftColor: getStatusBorder(order.status) }}>
                {/* Left side: Order Info */}
                <div className="flex-1 p-6">
                  <div className="flex items-center gap-3 mb-4 flex-wrap">
                    <span className="font-black text-2xl text-slate-900 font-mono tracking-tighter">#{order.order_id}</span>
                    <span className="px-2.5 py-1 rounded bg-slate-100 text-slate-600 text-[11px] font-bold uppercase tracking-widest border border-slate-200 w-max">{order.status.replace(/_/g, ' ')}</span>
                    {order.source === 'pos' && <span className="px-2.5 py-1 rounded bg-indigo-50 text-indigo-600 text-[11px] font-bold uppercase tracking-widest border border-indigo-100 w-max"><span className="material-symbols-outlined text-[12px] align-text-bottom">point_of_sale</span> POS ENTRY</span>}
                    {order.allergen_alert && <span className="px-2.5 py-1 rounded bg-red-50 text-red-600 text-[11px] font-bold uppercase tracking-widest border border-red-100 w-max animate-pulse">⚠️ ALLERGEN</span>}
                    {order.table_number && <span className="px-2.5 py-1 rounded bg-blue-50 text-blue-600 text-[11px] font-bold uppercase tracking-widest border border-blue-100 w-max">TABLE {order.table_number}</span>}
                  </div>
                  
                  <div className="text-[14px] text-slate-700 font-medium leading-relaxed bg-slate-50 p-4 rounded-[12px] border border-slate-100">
                    {order.items?.map(i => `${i.quantity}x ${i.name}`).join(', ')}
                  </div>
                </div>

                {/* Right side: Controls */}
                <div className="w-full md:w-[280px] bg-slate-50 border-t md:border-t-0 md:border-l border-slate-200 p-6 flex flex-col justify-between shrink-0">
                  <div className="mb-4">
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block">Update Pipeline Status</label>
                    <select value={order.status} onChange={(e) => updateStatus(order.order_id, e.target.value)}
                      className="w-full bg-white border border-slate-200 rounded-[10px] px-3 py-2.5 text-[14px] font-bold text-slate-700 focus:outline-none focus:ring-2 focus:ring-[#6366F1] cursor-pointer shadow-sm">
                      <option value="order_received">Order Received</option>
                      <option value="preparing">Preparing</option>
                      <option value="ready_for_pickup">Ready for Pickup</option>
                      <option value="completed">Completed</option>
                      <option value="cancelled">Cancelled</option>
                    </select>
                  </div>
                  <div className="flex justify-between items-center pt-4 border-t border-slate-200">
                    <span className="text-slate-900 font-bold text-xl font-mono tracking-tight">₹{order.total}</span>
                    {(userRole === 'manager' || userRole === 'owner') && order.status === 'completed' && (
                      <button onClick={() => openRefund(order)} className="flex items-center gap-1.5 text-[12px] text-red-600 hover:text-red-800 font-bold bg-white border border-red-200 shadow-sm px-3 py-1.5 rounded-lg transition-all">
                        <span className="material-symbols-outlined text-[14px]">receipt_long</span> Refund
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
            {orders.length === 0 && (
              <div className="py-20 flex flex-col items-center justify-center opacity-40">
                 <span className="material-symbols-outlined text-[48px] text-slate-500 mb-2">inbox</span>
                 <p className="font-bold text-sm uppercase tracking-widest text-slate-500">Pipeline is empty</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
