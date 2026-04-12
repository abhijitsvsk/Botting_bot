import { BrowserRouter, Routes, Route, Link } from 'react-router-dom';
import React, { useState, useEffect } from 'react';
import Kitchen from './pages/Kitchen';
import Manager from './pages/Manager';
import Staff from './pages/Staff';
import Reports from './pages/Reports';
import Login from './pages/Login';
import { getUserRole, signOut, hasPermission, onAuthChange } from './auth';
// lucide-react removed — using Material Symbols exclusively

import DashboardLayout from './components/DashboardLayout';

// RBAC route guard — wraps each route with login + role check
function ProtectedRoute({ children, requiredRole }) {
  const [status, setStatus] = useState('loading');
  const [userRole, setUserRole] = useState(null);

  useEffect(() => {
    const check = async () => {
      const role = await getUserRole();
      if (!role) { setStatus('login'); return; }
      setUserRole(role);
      setStatus(hasPermission(role, requiredRole) ? 'authorized' : 'denied');
    };
    check();
    const { data: { subscription } } = onAuthChange((event) => {
      if (event === 'SIGNED_OUT') { setStatus('login'); setUserRole(null); }
    });
    return () => subscription.unsubscribe();
  }, [requiredRole]);

  const handleLogin = async () => {
    const role = await getUserRole();
    if (!role) return false;
    setUserRole(role);
    if (hasPermission(role, requiredRole)) { setStatus('authorized'); return true; }
    setStatus('denied');
    return false;
  };

  const handleSignOut = () => { signOut(); setStatus('login'); };

  if (status === 'loading') {
    return (
      <div className="min-h-screen bg-[#0E1217] flex items-center justify-center">
        <div className="text-white text-lg font-bold animate-pulse tracking-widest uppercase text-xs">Initializing System…</div>
      </div>
    );
  }

  if (status === 'login') return <Login onLogin={handleLogin} requiredRole={requiredRole} />;

  if (status === 'denied') {
    return (
      <div className="min-h-screen bg-[#0E1217] flex flex-col items-center justify-center gap-4 text-white">
        <span className="material-symbols-outlined text-red-500 text-6xl">block</span>
        <h1 className="text-white text-2xl font-black tracking-tight">Access Denied</h1>
        <p className="text-gray-400 text-sm font-medium">Your authorization ({userRole}) is insufficient for this terminal.</p>
        <button onClick={handleSignOut}
          className="px-6 py-3 mt-4 bg-white/10 hover:bg-white/20 text-white rounded-xl font-bold transition-all border border-white/10">
          Terminate Session
        </button>
      </div>
    );
  }

  // Inject props into children (userRole, onSignOut) so DashboardLayout can use them
  return React.cloneElement(children, { userRole, onSignOut: handleSignOut });
}

function Home() {
  return (
    <div className="min-h-screen bg-[#0E1217] flex flex-col items-center justify-center gap-6 p-6">
      <div className="w-16 h-16 rounded-full bg-gradient-to-tr from-emerald-500 to-teal-400 p-0.5 shadow-lg shadow-emerald-500/20 mb-2 flex items-center justify-center">
        <div className="w-full h-full bg-[#0E1217] rounded-full flex items-center justify-center">
          <span className="material-symbols-outlined text-emerald-400 text-[28px]" style={{ fontVariationSettings: "'FILL' 1" }}>restaurant_menu</span>
        </div>
      </div>
      <h1 className="text-4xl font-black text-white tracking-tight">Kinetic Engine</h1>
      <p className="text-gray-400 text-sm font-medium tracking-widest uppercase text-xs">Select operating terminal</p>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 w-full max-w-3xl mt-4">
        {[
          { to: '/kitchen', label: 'Kitchen', icon: 'soup_kitchen', color: 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400' },
          { to: '/manager', label: 'Operations', icon: 'dashboard', color: 'bg-indigo-500/10 border-indigo-500/30 text-indigo-400' },
          { to: '/staff', label: 'Station POS', icon: 'point_of_sale', color: 'bg-amber-500/10 border-amber-500/30 text-amber-400' },
          { to: '/reports', label: 'Analytics', icon: 'bar_chart', color: 'bg-purple-500/10 border-purple-500/30 text-purple-400' },
        ].map(item => (
          <Link key={item.to} to={item.to}
            className={`border rounded-2xl p-6 text-center shadow-xl transition-all hover:-translate-y-1 hover:shadow-2xl hover:bg-white/5 bg-white/5`}>
            <span className={`material-symbols-outlined text-4xl mb-3 ${item.color.split(' ').pop()}`}>{item.icon}</span>
            <div className="font-bold text-white text-md tracking-tight">{item.label}</div>
          </Link>
        ))}
      </div>
    </div>
  );
}

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/kitchen" element={<ProtectedRoute requiredRole="kitchen"><Kitchen /></ProtectedRoute>} />
        <Route path="/manager" element={<ProtectedRoute requiredRole="manager"><DashboardLayout><Manager /></DashboardLayout></ProtectedRoute>} />
        <Route path="/staff"   element={<ProtectedRoute requiredRole="cashier"><DashboardLayout><Staff /></DashboardLayout></ProtectedRoute>} />
        <Route path="/reports" element={<ProtectedRoute requiredRole="manager"><DashboardLayout><Reports /></DashboardLayout></ProtectedRoute>} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
