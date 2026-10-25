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
    <div className="w-full flex flex-col space-y-4 pt-4">
      <h2 className="text-xl font-bold text-center">
        {isSignUp ? 'Create an Account' : 'Welcome Back'}
      </h2>
      
      {error && <div className="text-sm text-red-500 bg-red-50 dark:bg-red-900/20 p-2 rounded">{error}</div>}

      <form onSubmit={handleSubmit} className="flex flex-col space-y-3">
        <input 
          type="email" 
          placeholder="Email address"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full p-2 border rounded text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 border-gray-300 dark:border-gray-700"
          required 
        />
        <input 
          type="password" 
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full p-2 border rounded text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 border-gray-300 dark:border-gray-700"
          required 
        />
        <button 
          type="submit"
          disabled={loading}
          className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-2 rounded"
        >
          {loading ? 'Processing...' : (isSignUp ? 'Sign Up' : 'Sign In')}
        </button>
      </form>


      <button 
        onClick={() => setIsSignUp(!isSignUp)}
        className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
      >
        {isSignUp ? 'Already have an account? Sign in' : 'Need an account? Sign up'}
      </button>

      <div className="pt-2 border-t border-gray-700/40">
        <button
          type="button"
          onClick={() => onAuthSuccess()}
          className="w-full py-1.5 px-3 rounded bg-white/10 hover:bg-white/20 text-[#CDE4E6] text-xs font-medium border border-[#CDE4E6]/20 transition-all flex items-center justify-center gap-1.5"
        >
          <span>⚡ Continue in Local Mode</span>
        </button>
      </div>
    </div>
  );
}
