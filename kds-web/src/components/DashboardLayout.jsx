import { NavLink, useLocation } from 'react-router-dom';
import { colors } from '../design-tokens';
import { UtensilsCrossed, LogOut } from 'lucide-react';
// Stitch used Material Icons: `dashboard`, `soup_kitchen`, `point_of_sale`, `bar_chart`, `groups`, `add`
// We will use standard span with class `material-symbols-outlined` for exact 1:1 match.

export default function DashboardLayout({ children, userRole, onSignOut }) {
  const location = useLocation();

  const navItems = [
    { to: '/manager', icon: 'dashboard', label: 'Operations' },
    { to: '/kitchen', icon: 'soup_kitchen', label: 'Kitchen', external: true },
    { to: '/staff', icon: 'point_of_sale', label: 'POS' },
    { to: '/reports', icon: 'bar_chart', label: 'Analytics' },
  ];

  return (
    <div className="bg-[#F8FAFC] text-[#1E293B] font-sans min-h-screen flex">
      {/* SideNavBar Anchor */}
      <aside className="hidden lg:flex flex-col h-screen w-64 p-4 gap-2 bg-slate-50 border-r border-[#E2E8F0] sticky top-0 shrink-0">
        <div className="mb-8 px-2 flex flex-col pt-3">
            <h1 className="text-2xl font-black text-[#6366F1]">Kinetic</h1>
            <div className="flex items-center gap-3 mt-4 opacity-80">
              <div className="w-10 h-10 bg-slate-200 rounded-full flex items-center justify-center shrink-0">
                <UtensilsCrossed size={18} className="text-slate-500" />
              </div>
              <div>
                <p className="text-sm font-bold leading-none capitalize">{userRole || 'Staff'}</p>
                <p className="text-[10px] uppercase tracking-widest text-[#64748B] mt-1">Terminal 01</p>
              </div>
            </div>
        </div>

        <nav className="flex-1 space-y-1">
          {navItems.map((item) => {
            const isActive = location.pathname.startsWith(item.to);
            if (item.external) {
              return (
                 <a key={item.to} href={item.to} className="flex items-center gap-3 px-3 py-2 text-[#64748B] hover:bg-indigo-50 transition-all duration-200 rounded-lg">
                    <span className="material-symbols-outlined">{item.icon}</span>
                    <span className="text-sm font-medium">{item.label}</span>
                 </a>
              );
            }
            return (
              <NavLink key={item.to} to={item.to} className={({ isActive }) => 
                `flex items-center gap-3 px-3 py-2 transition-all duration-200 rounded-lg ${
                  isActive 
                  ? 'bg-white text-[#6366F1] shadow-sm font-bold' 
                  : 'text-[#64748B] hover:bg-indigo-50 hover:text-[#6366F1]'
                }`
              }>
                <span className="material-symbols-outlined">{item.icon}</span>
                <span className="text-sm font-medium">{item.label}</span>
              </NavLink>
            )
          })}
        </nav>

        <div className="mt-auto space-y-3">
          <button onClick={onSignOut} className="w-full text-slate-500 hover:text-slate-800 text-sm font-bold py-2 rounded-xl flex items-center justify-center gap-2 transition-colors">
            <LogOut size={16} /> Sign Out
          </button>
          <button className="w-full bg-gradient-to-br from-[#4EDE63] to-[#10b981] text-[#003824] font-bold py-3 rounded-xl shadow-lg flex items-center justify-center gap-2 hover:opacity-90 transition-opacity">
            <span className="material-symbols-outlined">add</span>
            New Order
          </button>
        </div>
      </aside>

      {/* Main Content Canvas */}
      <main className="flex-1 flex flex-col min-w-0 h-screen overflow-hidden">
         {children}
      </main>
    </div>
  );
}
