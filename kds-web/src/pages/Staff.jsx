// kds-web/src/pages/Staff.jsx
// Staff POS — Walk-in and phone order entry screen (cashier role minimum)
// Creates orders with source='pos', identical kitchen ticket to WhatsApp orders.

import { useEffect, useState } from 'react';
import { supabase } from '../supabase';
import { logAction } from '../auth';
import { colors } from '../design-tokens';

export default function Staff() {
  const [menuItems, setMenuItems] = useState([]);
  const [cart, setCart] = useState([]);
  const [tableNumber, setTableNumber] = useState('');
  const [orderType, setOrderType] = useState('dine-in'); // 'dine-in' | 'walk-in' | 'phone'
  const [submitting, setSubmitting] = useState(false);
  const [lastOrder, setLastOrder] = useState(null);
  const [search, setSearch] = useState('');
  const [station, setStation] = useState('all');
  const [stations, setStations] = useState(['all']);

  useEffect(() => {
    const fetchMenu = async () => {
      const { data } = await supabase
        .from('menu_items')
        .select('*')
        .eq('available', true)
        .order('category', { ascending: true });
      if (data) {
        setMenuItems(data);
        const unique = ['all', ...new Set(data.map(i => i.station).filter(Boolean))];
        setStations(unique);
      }
    };
    fetchMenu();
  }, []);

  const addItem = (item) => {
    setCart(curr => {
      const existing = curr.find(c => c.code === item.code);
      if (existing) return curr.map(c => c.code === item.code ? { ...c, quantity: c.quantity + 1 } : c);
      return [...curr, { ...item, quantity: 1 }];
    });
  };

  const removeItem = (code) => {
    setCart(curr => {
      const existing = curr.find(c => c.code === code);
      if (!existing) return curr;
      if (existing.quantity <= 1) return curr.filter(c => c.code !== code);
      return curr.map(c => c.code === code ? { ...c, quantity: c.quantity - 1 } : c);
    });
  };

  const cartTotal = cart.reduce((s, i) => s + i.price * i.quantity, 0);
  const taxRate = parseFloat(import.meta.env.VITE_TAX_RATE || '0') / 100;
  const tax = Math.round(cartTotal * taxRate);
  const total = cartTotal + tax;

  const submitOrder = async () => {
    if (cart.length === 0) return alert('Cart is empty');
    if (orderType === 'dine-in' && !tableNumber) return alert('Please enter a table number');

    setSubmitting(true);
    const { data, error } = await supabase.from('orders').insert({
      phone: `pos-${Date.now()}`,
      table_number: orderType === 'dine-in' ? parseInt(tableNumber) : null,
      items: cart,
      status: 'order_received',
      total,
      tax_amount: tax,
      source: 'pos',
      confirmed_at: new Date().toISOString()
    }).select().single();

    if (error) {
      alert(`Error: ${error.message}`);
      setSubmitting(false);
      return;
    }

    await logAction('pos_order_created', data.order_id, { table: tableNumber, items: cart.length });
    setLastOrder(data);
    setCart([]);
    setTableNumber('');
    setSubmitting(false);
  };

  const filteredMenu = menuItems.filter(item => {
    const matchStation = station === 'all' || item.station === station;
    const matchSearch = !search || item.name.toLowerCase().includes(search.toLowerCase()) || item.code?.toLowerCase().includes(search.toLowerCase());
    return matchStation && matchSearch;
  });

  const grouped = filteredMenu.reduce((acc, item) => {
    const cat = item.category || 'Other';
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(item);
    return acc;
  }, {});

  return (
    <div className="flex flex-col lg:flex-row w-full h-full bg-slate-50 overflow-hidden relative">
      {/* Left Panel (65%) */}
      <section className="w-full lg:w-[65%] p-4 lg:p-6 flex flex-col gap-6 overflow-y-auto no-scrollbar" style={{ backgroundColor: colors.bg.light }}>
        {/* Search Bar */}
        <div className="relative shrink-0">
          <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-slate-400">search</span>
          <input 
            type="text"
            placeholder="Search menu items..." 
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full bg-white border-none py-4 pl-12 pr-6 rounded-[22px] shadow-sm text-slate-700 placeholder:text-slate-400 focus:ring-2 focus:ring-[#6366F1] transition-all"
          />
        </div>

        {/* Category Filters */}
        <div className="flex gap-3 overflow-x-auto no-scrollbar pb-2 shrink-0 items-center">
          {stations.map(s => (
            <button key={s} onClick={() => setStation(s)}
              className={`px-6 py-2.5 rounded-full font-semibold whitespace-nowrap transition-all shadow-sm ${
                station === s 
                ? 'bg-[#6366F1] text-white shadow-md' 
                : 'bg-white text-slate-600 border border-slate-200 hover:border-[#6366F1]'
              }`}>
              {s === 'all' ? 'All Items' : s}
            </button>
          ))}
        </div>

        {/* Item Grid */}
        <div className="pb-8 space-y-8">
          {Object.entries(grouped).map(([category, items]) => (
            <div key={category}>
              <h3 className="text-sm font-bold uppercase tracking-wider text-slate-400 mb-4">{category}</h3>
              <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {items.map(item => {
                  const inCart = cart.find(c => c.code === item.code);
                  return (
                    <button key={item.code} onClick={() => addItem(item)}
                      className={`relative bg-white p-4 rounded-[14px] border h-[110px] flex flex-col justify-between text-left shadow-sm hover:scale-[0.98] transition-transform group ${
                        inCart ? 'border-[#6366F1]' : 'border-[#E2E8F0] hover:border-[#6366F1]'
                      }`}>
                      <div className="flex justify-between items-start w-full">
                        <span className="font-bold text-[14px] text-slate-800 line-clamp-2 pr-2">{item.name}</span>
                        {inCart && (
                          <div className="w-6 h-6 bg-[#6366F1] text-white text-[10px] font-bold flex items-center justify-center rounded-full shrink-0 shadow-md">
                            {inCart.quantity}
                          </div>
                        )}
                      </div>
                      <span className="text-slate-500 text-[14px] font-mono font-semibold">₹{item.price}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Right Panel (35% or overlay on mobile if you want, but stacking is fine here) */}
      <section className="w-full lg:w-[35%] bg-white border-t lg:border-t-0 lg:border-l border-[#E2E8F0] flex flex-col h-[50vh] lg:h-full shrink-0">
        <div className="p-5 shrink-0 bg-white z-10 shadow-[0_4px_20px_-10px_rgba(0,0,0,0.05)]">
          <div className="flex items-center justify-between mb-5">
            <h2 className="font-bold text-xl text-slate-800 tracking-tight">Station POS</h2>
            {lastOrder && (
               <span className="text-xs font-bold uppercase tracking-widest text-[#4EDE63] font-mono flex items-center gap-1">
                 <span className="material-symbols-outlined text-[14px]">check_circle</span> #{lastOrder.order_id} active
               </span>
            )}
          </div>

          {/* Service Mode Toggle */}
          <div className="flex p-1 bg-slate-100 rounded-full mb-5">
            {['dine-in', 'walk-in', 'phone'].map(t => (
               <button key={t} onClick={() => setOrderType(t)}
                 className={`flex-1 py-2 text-xs font-bold rounded-full transition-all capitalize ${
                   orderType === t 
                   ? 'bg-white text-[#6366F1] shadow-sm' 
                   : 'text-slate-500 hover:text-slate-700'
                 }`}>
                 {t.replace('-', ' ')}
               </button>
            ))}
          </div>

          {/* Table Input */}
          {orderType === 'dine-in' && (
            <div>
              <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5 ml-1">Table Number</label>
              <input 
                type="number" 
                value={tableNumber}
                onChange={e => setTableNumber(e.target.value)}
                min="1"
                className="w-full border border-slate-200 rounded-[12px] px-4 py-3 text-lg font-bold font-mono focus:ring-2 focus:ring-[#6366F1] focus:border-transparent outline-none transition-shadow placeholder-slate-300" 
                placeholder="0"
              />
            </div>
          )}
        </div>

        {/* Cart Items List */}
        <div className="flex-1 overflow-y-auto p-5 space-y-1 no-scrollbar bg-slate-50/50" style={{ maskImage: cart.length > 0 ? 'linear-gradient(to bottom, black calc(100% - 10px), transparent 100%)' : 'none', WebkitMaskImage: cart.length > 0 ? 'linear-gradient(to bottom, black calc(100% - 10px), transparent 100%)' : 'none' }}>
           {cart.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center opacity-40">
                 <span className="material-symbols-outlined text-[48px] mb-2">shopping_cart</span>
                 <p className="font-bold text-sm uppercase tracking-widest">Cart is empty</p>
              </div>
           ) : (
             cart.map((item, idx) => (
                <div key={item.code}>
                  <div className="flex justify-between items-center py-3">
                    <div className="flex flex-col gap-0.5 max-w-[50%]">
                      <span className="font-bold text-[14px] text-slate-800 leading-tight pr-2">{item.name}</span>
                    </div>
                    <div className="flex items-center gap-4 shrink-0">
                      <div className="flex items-center bg-white rounded-lg border border-slate-200 p-0.5 shadow-sm">
                        <button onClick={() => removeItem(item.code)} className="p-1 text-slate-400 hover:text-red-500 transition-colors bg-slate-50 hover:bg-red-50 rounded-md">
                          <span className="material-symbols-outlined text-[16px]">remove</span>
                        </button>
                        <span className="w-8 text-center font-bold font-mono text-[14px] text-slate-700">{item.quantity}</span>
                        <button onClick={() => addItem(item)} className="p-1 text-slate-400 hover:text-[#4EDE63] transition-colors bg-slate-50 hover:bg-emerald-50 rounded-md">
                          <span className="material-symbols-outlined text-[16px]">add</span>
                        </button>
                      </div>
                      <span className="font-bold text-[14px] text-slate-700 w-[60px] text-right font-mono">₹{item.price * item.quantity}</span>
                    </div>
                  </div>
                  {idx !== cart.length - 1 && <div className="h-[1px] bg-slate-200 w-full"></div>}
                </div>
             ))
           )}
        </div>

        {/* Bottom Fixed Checkout Area */}
        <div className="shrink-0 p-5 pt-6 border-t border-slate-200 bg-white rounded-tl-[16px] rounded-tr-[16px] shadow-[0_-10px_20px_-10px_rgba(0,0,0,0.05)]">
          <div className="space-y-2 mb-6">
            <div className="flex justify-between text-slate-500 text-sm font-medium">
              <span>Subtotal</span>
              <span className="font-mono">₹{cartTotal}</span>
            </div>
            <div className="flex justify-between text-slate-500 text-sm font-medium">
              <span>Tax ({(taxRate * 100).toFixed(1)}%)</span>
              <span className="font-mono">₹{tax}</span>
            </div>
            <div className="flex justify-between text-slate-900 font-black text-xl pt-3 border-t border-slate-100 mt-1">
              <span>Total</span>
              <span className="font-mono">₹{total}</span>
            </div>
          </div>
          <button 
            onClick={submitOrder} 
            disabled={submitting || cart.length === 0}
            className="w-full h-[52px] bg-gradient-to-r from-[#6366F1] to-[#4F46E5] text-white font-bold tracking-wide rounded-xl shadow-lg shadow-indigo-100 hover:brightness-110 active:scale-[0.98] disabled:opacity-50 disabled:grayscale transition-all flex items-center justify-center gap-2"
          >
            <span className="material-symbols-outlined text-[20px]">send</span> 
            {submitting ? 'Transmitting' : 'Send Ticket'}
          </button>
          {cart.length > 0 && (
            <button onClick={() => setCart([])} className="w-full mt-4 text-center text-sm font-bold text-slate-400 hover:text-red-500 transition-colors uppercase tracking-wider py-2">
              Clear Cart
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
