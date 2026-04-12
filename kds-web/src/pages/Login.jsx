// kds-web/src/pages/Login.jsx
// Used by Kitchen (/kitchen), Manager (/manager), Staff (/staff), and Reports (/reports)
// Each route specifies the minimum role required.

import { useState } from 'react';
import { signIn } from '../auth';
import { colors } from '../design-tokens';

export default function Login({ onLogin, requiredRole }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const roleLabels = {
    kitchen: '👨‍🍳 Kitchen Display',
    cashier: '🧾 Staff / Cashier',
    manager: '📋 Manager Portal',
    owner: '👑 Owner Dashboard',
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    const { error: authError } = await signIn(email, password);
    if (authError) {
      setError(authError.message);
      setLoading(false);
      return;
    }

    // onLogin callback checks role and either proceeds or shows error
    const allowed = await onLogin();
    if (!allowed) {
      setError(`Access denied. This screen requires ${requiredRole} role or higher.`);
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-6 relative overflow-hidden font-sans" style={{ backgroundColor: colors.bg.dark }}>
      {/* Background glow effects */}
      <div className="absolute inset-0 pointer-events-none flex justify-center items-center opacity-40">
          <div className="w-[600px] h-[600px] rounded-full absolute -top-[150px] -left-[150px] blur-[120px] opacity-20" style={{ background: colors.brand.primary }}></div>
          <div className="w-[600px] h-[600px] rounded-full absolute -bottom-[150px] -right-[150px] blur-[120px] opacity-15" style={{ background: colors.brand.secondary }}></div>
      </div>

      <div className="bg-white/5 backdrop-blur-2xl rounded-3xl shadow-2xl p-10 w-full max-w-md border border-white/10 z-10 flex flex-col items-center">
        <div className="w-16 h-16 rounded-full border border-white/20 bg-white/5 flex items-center justify-center mb-6">
          <span className="material-symbols-outlined text-white text-3xl">lock</span>
        </div>
        
        <div className="text-center mb-8">
          <h1 className="text-[28px] font-bold text-white tracking-tight leading-tight">System Access</h1>
          <p className="text-[14px] text-[#9CA3AF] mt-1">Restricted to authorized staff only</p>
        </div>

        <form onSubmit={handleSubmit} className="w-full flex flex-col gap-5">
          <div className="flex flex-col gap-1.5">
            <label className="text-[#9CA3AF] text-[12px] font-semibold uppercase tracking-wider block">Email Address</label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
              className="w-full h-[52px] px-4 rounded-xl border border-white/5 text-white placeholder-[#4B5563] outline-none transition-all duration-200"
              style={{ backgroundColor: colors.bg.input }}
              placeholder="manager@kinetic.io"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-[#9CA3AF] text-[12px] font-semibold uppercase tracking-wider block">Password</label>
            <div className="relative">
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                className="w-full h-[52px] px-4 pr-12 rounded-xl border border-white/5 text-white placeholder-[#4B5563] outline-none transition-all duration-200"
                style={{ backgroundColor: colors.bg.input }}
                placeholder="••••••••"
              />
              <button type="button" className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white transition-colors">
                <span className="material-symbols-outlined">visibility</span>
              </button>
            </div>
          </div>

          {error && (
            <div className="bg-red-500/10 border border-red-500/20 text-red-400 rounded-xl p-4 text-sm font-bold flex items-center">
              <span className="w-2 h-2 rounded-full bg-red-500 mr-3 animate-pulse"></span>
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full h-[52px] rounded-xl mt-2 hover:brightness-110 active:scale-[0.98] transition-all flex items-center justify-center gap-2 text-white font-bold"
            style={{ background: `linear-gradient(to right, ${colors.brand.primary}, #059669)` }}
          >
            <span className="material-symbols-outlined text-sm" style={{ fontVariationSettings: "'FILL' 1" }}>lock</span>
            {loading ? 'Authenticating…' : 'Sign In'}
          </button>
        </form>

        <footer className="w-full text-center mt-6">
          <p className="text-[12px] text-[#9CA3AF] tracking-wide">Role-based access — Kitchen, Cashier, Manager, Owner</p>
        </footer>
      </div>
    </div>
  );
}
