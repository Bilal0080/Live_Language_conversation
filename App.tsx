
import React, { useState, useEffect } from 'react';
import Layout from './components/Layout';
import TextTranslator from './components/TextTranslator';
import LiveVoiceTranslator from './components/LiveVoiceTranslator';
import { AppMode } from './types';

const App: React.FC = () => {
  const [mode, setMode] = useState<AppMode>(AppMode.TEXT);
  const [isOnline, setIsOnline] = useState(navigator.onLine);

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  return (
    <Layout mode={mode} onModeChange={setMode}>
      {!isOnline && (
        <div className="fixed top-16 left-0 right-0 z-40 px-4 animate-slide-down pointer-events-none">
          <div className="max-w-6xl mx-auto">
            <div className="bg-amber-500 text-white text-[10px] font-black uppercase tracking-[0.2em] py-1.5 px-4 rounded-b-lg shadow-lg flex items-center justify-center space-x-2 border-t border-amber-400/50">
              <i className="fa-solid fa-cloud-slash animate-pulse"></i>
              <span>Offline Mode • History Only</span>
            </div>
          </div>
        </div>
      )}

      {mode === AppMode.TEXT ? (
        <div className="space-y-8 animate-in fade-in duration-500">
          <div className="text-center space-y-2">
            <h2 className="text-3xl font-bold text-slate-800 tracking-tight">Precision Text Translation</h2>
            <p className="text-slate-500 max-w-lg mx-auto">
              Professional-grade translation between Asian, European and Middle Eastern languages.
            </p>
          </div>
          <TextTranslator />
          
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="bg-white p-6 rounded-2xl border border-slate-100 shadow-sm flex items-start space-x-4">
              <div className="bg-blue-50 text-blue-600 p-3 rounded-xl">
                <i className="fa-solid fa-bolt"></i>
              </div>
              <div>
                <h4 className="font-bold text-slate-800">Instant AI</h4>
                <p className="text-sm text-slate-500">Powered by Gemini 3 Flash for zero-latency results.</p>
              </div>
            </div>
            <div className="bg-white p-6 rounded-2xl border border-slate-100 shadow-sm flex items-start space-x-4">
              <div className="bg-emerald-50 text-emerald-600 p-3 rounded-xl">
                <i className="fa-solid fa-earth-asia"></i>
              </div>
              <div>
                <h4 className="font-bold text-slate-800">Multi-Lang</h4>
                <p className="text-sm text-slate-500">Supports CJK, French, Italian, English & Urdu.</p>
              </div>
            </div>
            <div className="bg-white p-6 rounded-2xl border border-slate-100 shadow-sm flex items-start space-x-4">
              <div className="bg-amber-50 text-amber-600 p-3 rounded-xl">
                <i className="fa-solid fa-history"></i>
              </div>
              <div>
                <h4 className="font-bold text-slate-800">Offline Ready</h4>
                <p className="text-sm text-slate-500">Access your settings and history without internet.</p>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="max-w-4xl mx-auto space-y-8 animate-in slide-in-from-bottom-4 duration-500 h-full flex flex-col">
          <div className="text-center space-y-2">
            <h2 className="text-3xl font-bold text-slate-800 tracking-tight">Live Conversational Voice</h2>
            <p className="text-slate-500">
              Have a real-time conversation. The AI will listen and translate on the fly.
            </p>
          </div>
          <div className="flex-1">
            <LiveVoiceTranslator />
          </div>
        </div>
      )}
    </Layout>
  );
};

export default App;
