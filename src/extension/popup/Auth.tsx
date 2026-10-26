import { useState } from 'react';
import { 
  signInWithEmailAndPassword, 
  createUserWithEmailAndPassword
} from 'firebase/auth';
import { auth } from '../../firebase/config';

export function Auth({ onAuthSuccess }: { onAuthSuccess: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isSignUp, setIsSignUp] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      if (isSignUp) {
        await createUserWithEmailAndPassword(auth, email, password);
      } else {
        await signInWithEmailAndPassword(auth, email, password);
      }
      onAuthSuccess();
    } catch (err: any) {
      setError(err.message || "Failed to authenticate");
    } finally {
      setLoading(false);
    }
  };



  return (
    <div className="w-full flex flex-col space-y-4 py-4 px-1">
      <div className="text-center space-y-1">
        <h2 className="text-base font-extrabold bg-gradient-to-r from-[#FFF3D1] via-[#F9DF9F] to-[#E4BD65] bg-clip-text text-transparent">
          {isSignUp ? 'Create your Account' : 'Welcome to FlowOnce'}
        </h2>
        <p className="text-[11px] text-[#CDE4E6]/60">
          {isSignUp ? 'Sync and backup your automations securely to cloud' : 'Sign in to access your cloud-synced workflows'}
        </p>
      </div>
      
      {error && (
        <div className="text-xs text-rose-300 bg-rose-950/70 border border-rose-500/30 p-2.5 rounded-lg text-center font-medium">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="flex flex-col space-y-3">
        <div className="space-y-2">
          <input 
            type="email" 
            placeholder="Email address"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full px-3 py-2.5 rounded-xl text-xs bg-[#0D1224] text-[#CDE4E6] placeholder-[#CDE4E6]/40 border border-white/10 focus:border-[#F9DF9F]/50 focus:ring-1 focus:ring-[#F9DF9F]/30 outline-none transition-all"
            required 
          />
          <input 
            type="password" 
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full px-3 py-2.5 rounded-xl text-xs bg-[#0D1224] text-[#CDE4E6] placeholder-[#CDE4E6]/40 border border-white/10 focus:border-[#F9DF9F]/50 focus:ring-1 focus:ring-[#F9DF9F]/30 outline-none transition-all"
            required 
          />
        </div>

        <button 
          type="submit"
          disabled={loading}
          className="w-full bg-gradient-to-r from-[#F9DF9F] via-[#F4D58D] to-[#E5BD64] hover:brightness-105 disabled:opacity-50 text-[#10152B] font-extrabold py-2.5 rounded-xl text-xs transition-all shadow-md active:scale-[0.98] cursor-pointer"
        >
          {loading ? 'Authenticating...' : (isSignUp ? 'Create Account' : 'Sign In')}
        </button>
      </form>

      <div className="text-center">
        <button 
          onClick={() => setIsSignUp(!isSignUp)}
          className="text-xs text-[#F9DF9F]/80 hover:text-[#F9DF9F] hover:underline transition-colors"
        >
          {isSignUp ? 'Already have an account? Sign in' : "Don't have an account? Sign up"}
        </button>
      </div>

      <div className="pt-3 border-t border-white/5">
        <button
          type="button"
          onClick={() => onAuthSuccess()}
          className="w-full py-2 px-3 rounded-xl bg-[#0D1224] hover:bg-white/5 text-[#CDE4E6] text-xs font-semibold border border-white/10 transition-all flex items-center justify-center gap-1.5 active:scale-[0.98] cursor-pointer"
        >
          <span>⚡ Continue in Local Mode</span>
        </button>
      </div>
    </div>
  );
}
