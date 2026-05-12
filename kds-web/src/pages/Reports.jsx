// kds-web/src/pages/Reports.jsx
// Analytics & Reporting — requires manager or owner role.
// Real-time from Supabase. Date range picker, revenue summary, top items, abandoned carts.

import { useEffect, useState } from 'react';
import { supabase } from '../supabase';
import { colors } from '../design-tokens';

const fmt = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;

export default function Reports() {
  const [range, setRange] = useState('today');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const getRangeFilter = () => {
    const now = new Date();
    if (range === 'today') return now.toISOString().slice(0, 10);
    if (range === 'week') {
      const d = new Date(now); d.setDate(d.getDate() - 7);
      return d.toISOString().slice(0, 10);
    }
    if (range === 'month') {
      const d = new Date(now); d.setDate(d.getDate() - 30);
      return d.toISOString().slice(0, 10);
    }
    return '2000-01-01';
  };

  useEffect(() => {
    const fetch = async () => {
      setLoading(true);
      const since = getRangeFilter();

      const [ordersRes, abandonedRes, cancelledCountRes] = await Promise.all([
        supabase.from('orders')
          .select('order_id, total, tax_amount, tax_rate, status, items, created_at, source')
          .gte('created_at', since)
          .neq('status', 'cancelled'), // FIX FIN-7d: Filter in SQL, prevents massive items array fetch
        supabase.from('abandoned_carts').select('id').gte('detected_at', since),
        supabase.from('orders').select('order_id', { count: 'exact', head: true })
          .gte('created_at', since).eq('status', 'cancelled') // Fetch only the count
      ]);

      const completed = ordersRes.data || [];
      const cancelledCount = cancelledCountRes.count || 0;
      const totalCount = completed.length + cancelledCount;
      
      const revenue = completed.reduce((s, o) => s + (o.total || 0), 0);
      const taxCollected = completed.reduce((s, o) => s + (o.tax_amount || 0), 0);
      const avgOrder = completed.length ? revenue / completed.length : 0;
      const cancelRate = totalCount ? ((cancelledCount / totalCount) * 100).toFixed(1) : '0.0';

      // FIX OPS-6g: Tax rate report grouping across rate change boundaries
      const taxGroups = {};
      completed.forEach(o => {
        const rateLabel = ((o.tax_rate || 0) * 100).toFixed(1) + '%';
        if (!taxGroups[rateLabel]) taxGroups[rateLabel] = { count: 0, tax: 0, total: 0 };
        taxGroups[rateLabel].count += 1;
        taxGroups[rateLabel].tax += (o.tax_amount || 0);
        taxGroups[rateLabel].total += (o.total || 0);
      });

      // Item frequency
      const itemFreq = {};
      completed.forEach(o => {
        (o.items || []).forEach(item => {
          const key = item.name || item.code;
          itemFreq[key] = (itemFreq[key] || 0) + (item.quantity || 1);
        });
      });
      const topItems = Object.entries(itemFreq)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8);

      // Peak hour
      const hourCounts = {};
      completed.forEach(o => {
        const h = new Date(o.created_at).getHours();
        hourCounts[h] = (hourCounts[h] || 0) + 1;
      });
      const peakHour = Object.entries(hourCounts).sort((a, b) => b[1] - a[1])[0];

      // Source breakdown
      const posOrders = completed.filter(o => o.source === 'pos').length;
      const waOrders = completed.filter(o => o.source === 'whatsapp').length;

      setData({
        totalOrders: completed.length,
        cancelled: cancelledCount,
        revenue,
        taxCollected,
        avgOrder,
        topItems,
        peakHour,
        posOrders,
        waOrders,
        abandoned: abandonedRes.data?.length || 0,
        cancelRate,
        taxGroups: Object.entries(taxGroups)
      });
      setLoading(false);
    };
    fetch();
  }, [range]);

  const exportOrdersCSV = async () => {
    const { data: rows } = await supabase.from('orders').select('*');
    const csv = [['order_id', 'phone', 'table', 'items', 'total', 'tax', 'status', 'source', 'created_at'],
      ...(rows || []).map(r => [r.order_id, r.phone, r.table_number, `"${JSON.stringify(r.items).replace(/"/g, '""')}"`, r.total, r.tax_amount, r.status, r.source, r.created_at])
    ].map(row => row.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `orders_full.csv`; a.click();
  };

  const exportMenuCSV = async () => {
    const { data: rows } = await supabase.from('menu_items').select('*');
    const csv = [['item_code', 'name', 'price', 'category', 'available', 'times_ordered'],
      ...(rows || []).map(r => [r.item_code, `"${(r.name || '').replace(/"/g, '""')}"`, r.price, r.category, r.available, r.times_ordered])
    ].map(row => row.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `menu_catalog.csv`; a.click();
  };

  const exportFinancialsCSV = async () => {
    const { data: orders } = await supabase.from('orders').select('*').in('status', ['completed', 'order_received', 'preparing', 'ready_for_pickup']);
    const { data: refunds } = await supabase.from('refunds').select('*');
    const csv = [['Type', 'Date', 'Amount', 'Tax', 'Net', 'Order_ID'],
      ...(orders || []).map(r => ['Revenue', r.created_at, r.subtotal, r.tax_amount, r.total, r.order_id]),
      ...(refunds || []).map(r => ['Refund', r.created_at, r.amount, 0, -r.amount, r.order_id])
    ].map(row => row.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `financial_ledger.csv`; a.click();
  };

  return (
    <div className="w-full h-full p-6 lg:p-8 font-sans overflow-y-auto" style={{ backgroundColor: colors.bg.light }}>
      <div className="max-w-[1400px] mx-auto space-y-8">
        
        {/* Header */}
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6">
          <div>
            <h1 className="text-3xl font-black text-slate-800 tracking-tight flex items-center gap-3">
              <span className="material-symbols-outlined text-[32px] text-[#6366F1]">monitoring</span>
              Analytics Dashboard
            </h1>
            <p className="text-slate-500 font-medium text-sm mt-1">Real-time analytical telemetry & operational insights</p>
          </div>
          <div className="flex flex-wrap gap-4 items-center">
            <div className="flex p-1 bg-white border border-slate-200 rounded-[12px] shadow-sm">
              {['today', 'week', 'month', 'all'].map(r => (
                <button key={r} onClick={() => setRange(r)}
                  className={`px-5 py-2 text-[13px] font-bold uppercase tracking-wider rounded-[8px] transition-all ${range === r ? 'bg-[#6366F1] text-white shadow-md' : 'text-slate-500 hover:text-slate-800 hover:bg-slate-50'}`}>
                  {r === 'week' ? '7D' : r === 'month' ? '30D' : r}
                </button>
              ))}
            </div>
          </div>
        </div>

        {loading ? (
          <div className="flex flex-col items-center justify-center py-32 space-y-4">
             <span className="material-symbols-outlined animate-spin text-[48px] text-[#6366F1]">refresh</span>
             <p className="text-slate-400 font-bold tracking-widest uppercase text-sm">Aggregating Data...</p>
          </div>
        ) : (
          <div className="space-y-8">
            {/* KPI Cards */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
              {[
                { label: 'Total Revenue', value: fmt(data.revenue), icon: 'trending_up', color: '#10B981', bg: 'bg-emerald-50' },
                { label: 'Tax Reserves', value: fmt(data.taxCollected), icon: 'account_balance_wallet', color: '#6366F1', bg: 'bg-indigo-50' },
                { label: 'Completed Tickets', value: data.totalOrders, icon: 'receipt_long', color: '#8B5CF6', bg: 'bg-purple-50' },
                { label: 'Gross Avg Value', value: fmt(data.avgOrder), icon: 'schedule', color: '#F59E0B', bg: 'bg-amber-50' },
              ].map(card => (
                <div key={card.label} className="bg-white border border-slate-200 rounded-[20px] p-6 shadow-sm hover:shadow-md transition-shadow relative overflow-hidden group">
                  <div className={`w-12 h-12 rounded-[12px] flex items-center justify-center mb-4 ${card.bg}`}>
                     <span className="material-symbols-outlined" style={{ color: card.color }}>{card.icon}</span>
                  </div>
                  <div className="text-3xl font-black text-slate-800 font-mono tracking-tight">{card.value}</div>
                  <div className="text-slate-500 font-bold text-xs uppercase tracking-widest mt-1">{card.label}</div>
                  <div className={`absolute top-0 right-0 p-6 opacity-[0.03] transform group-hover:scale-125 transition-transform duration-500 pointer-events-none`}>
                     <span className="material-symbols-outlined text-[120px]" style={{ color: card.color }}>{card.icon}</span>
                  </div>
                </div>
              ))}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-5 gap-8">
              {/* Top Items */}
              <div className="lg:col-span-3 bg-white rounded-[24px] p-6 lg:p-8 border border-slate-200 shadow-sm">
                <div className="flex items-center gap-3 mb-8">
                  <span className="material-symbols-outlined text-[24px] text-slate-800">emoji_events</span>
                  <h2 className="font-bold text-slate-800 text-xl tracking-tight">Blockbuster Items</h2>
                </div>
                <div className="space-y-6">
                  {data.topItems.map(([name, count], i) => (
                    <div key={name} className="flex items-center gap-4">
                      <span className="text-slate-300 font-bold text-[16px] w-[20px] text-right">{i + 1}</span>
                      <div className="flex-1 bg-slate-100 rounded-full h-3 overflow-hidden relative">
                        <div className="bg-[#6366F1] h-full rounded-full transition-all duration-1000 ease-out"
                          style={{ width: `${(count / (data.topItems[0]?.[1] || 1)) * 100}%` }}>
                        </div>
                      </div>
                      <div className="flex flex-col w-[140px] items-end">
                        <span className="text-slate-800 text-[13px] font-bold truncate w-full text-right">{name}</span>
                        <span className="text-slate-400 text-[11px] font-bold tracking-widest">{count} UNITS</span>
                      </div>
                    </div>
                  ))}
                  {data.topItems.length === 0 && (
                    <div className="p-8 bg-slate-50 rounded-[16px] text-center border border-slate-100 font-bold text-slate-400 text-sm tracking-widest uppercase">No Data Points</div>
                  )}
                </div>
              </div>

              {/* Operational Telemetry */}
              <div className="lg:col-span-2 bg-white rounded-[24px] p-6 lg:p-8 border border-slate-200 shadow-sm space-y-6">
                <div className="flex items-center gap-3 mb-8">
                  <span className="material-symbols-outlined text-[24px] text-slate-800">data_thresholding</span>
                  <h2 className="font-bold text-slate-800 text-xl tracking-tight">Operational Telemetry</h2>
                </div>
                <div className="space-y-4">
                  <StatRow label="Rush Hour Peak" value={data.peakHour ? `${data.peakHour[0]}:00 – ${data.peakHour[0]}:59` : 'N/A'} subValue={data.peakHour ? `(${data.peakHour[1]} orders)` : ''} />
                  <StatRow label="Cancelled Inbounds" value={data.cancelled} />
                  <StatRow label="Cancellation Rate" value={`${data.cancelRate}%`} highlight={parseFloat(data.cancelRate) > 10} />
                  <StatRow label="WhatsApp Channels" value={data.waOrders} />
                  <StatRow label="Origin POS Systems" value={data.posOrders} />
                  <StatRow label="Abandoned Connections" value={data.abandoned} highlight={true} />
                  
                  <div className="pt-4 border-t border-slate-100 mt-4">
                     <h3 className="text-slate-800 font-bold text-[14px] uppercase tracking-widest mb-3">Tax Groupings</h3>
                     {data.taxGroups.map(([rate, info]) => (
                        <StatRow key={rate} label={`Bracket ${rate}`} value={fmt(info.tax)} subValue={`${info.count} tickets · Gross: ${fmt(info.total)}`} />
                     ))}
                     {data.taxGroups.length === 0 && <span className="text-xs text-slate-400 font-bold uppercase tracking-widest">No Tax Data</span>}
                  </div>
                </div>
              </div>
              {/* Data Portability Card */}
              <div className="lg:col-span-5 bg-white rounded-[24px] p-6 lg:p-8 border border-slate-200 shadow-sm">
                <div className="flex items-center gap-3 mb-6">
                  <span className="material-symbols-outlined text-[24px] text-slate-800">archive</span>
                  <h2 className="font-bold text-slate-800 text-xl tracking-tight">Data Portability Exports</h2>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
                  <button onClick={exportOrdersCSV} className="flex flex-col items-center justify-center gap-2 bg-slate-50 hover:bg-slate-100 border border-slate-200 p-6 rounded-[16px] transition-all">
                    <span className="material-symbols-outlined text-[28px] text-[#6366F1]">receipt_long</span>
                    <span className="font-bold text-slate-800 tracking-tight">Export Orders</span>
                    <span className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">Complete history</span>
                  </button>
                  <button onClick={exportMenuCSV} className="flex flex-col items-center justify-center gap-2 bg-slate-50 hover:bg-slate-100 border border-slate-200 p-6 rounded-[16px] transition-all">
                    <span className="material-symbols-outlined text-[28px] text-emerald-500">restaurant_menu</span>
                    <span className="font-bold text-slate-800 tracking-tight">Export Menu</span>
                    <span className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">Database snapshot</span>
                  </button>
                  <button onClick={exportFinancialsCSV} className="flex flex-col items-center justify-center gap-2 bg-slate-50 hover:bg-slate-100 border border-slate-200 p-6 rounded-[16px] transition-all">
                    <span className="material-symbols-outlined text-[28px] text-amber-500">account_balance</span>
                    <span className="font-bold text-slate-800 tracking-tight">Export Financials</span>
                    <span className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">Ledger sequence</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function StatRow({ label, value, subValue, highlight }) {
  return (
    <div className="flex justify-between items-start py-3 border-b border-slate-100 last:border-0 hover:bg-slate-50 px-2 rounded-lg transition-colors -mx-2">
      <span className="text-slate-500 font-bold text-[14px]">{label}</span>
      <div className="flex flex-col items-end">
         <span className={`font-mono font-bold text-[16px] ${highlight && value > 0 ? 'text-red-500 animate-pulse' : 'text-slate-800'}`}>{value}</span>
         {subValue && <span className="text-slate-400 text-[11px] font-bold mt-0.5">{subValue}</span>}
      </div>
    </div>
  );
}
