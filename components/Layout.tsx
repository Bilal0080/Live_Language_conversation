
import React from 'react';
import { AppMode } from '../types';

interface LayoutProps {
  children: React.ReactNode;
  mode: AppMode;
  onModeChange: (mode: AppMode) => void;
}

const Layout: React.FC<LayoutProps> = ({ children, mode, onModeChange }) => {
  return (
    <div className="min-h-screen flex flex-col">
      <header className="sticky top-0 z-50 glass border-b shadow-sm px-4 py-3 md:px-8">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 gradient-bg rounded-xl flex items-center justify-center text-white shadow-lg">
              <i className="fa-solid fa-language text-xl"></i>
            </div>
            <div>
              <h1 className="text-xl font-bold text-slate-800 leading-tight">LinguaLive</h1>
              <p className="text-xs text-slate-500 font-medium">Next-Gen Translation</p>
            </div>
          </div>
          
          <nav className="flex bg-slate-100 p-1 rounded-lg">
            <button
              onClick={() => onModeChange(AppMode.TEXT)}
              className={`px-4 py-1.5 rounded-md text-sm font-semibold transition-all ${
                mode === AppMode.TEXT 
                ? 'bg-white text-indigo-600 shadow-sm' 
                : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              Text
            </button>
            <button
              onClick={() => onModeChange(AppMode.VOICE)}
              className={`px-4 py-1.5 rounded-md text-sm font-semibold transition-all ${
                mode === AppMode.VOICE 
                ? 'bg-white text-indigo-600 shadow-sm' 
                : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              Live Voice
            </button>
          </nav>
        </div>
      </header>

      <main className="flex-1 max-w-6xl mx-auto w-full p-4 md:p-8">
        {children}
      </main>

      <footer className="py-6 border-t bg-white">
        <div className="max-w-6xl mx-auto px-4 text-center">
          <p className="text-slate-400 text-sm">
            Powered by Gemini 2.5 Flash Native Audio & Gemini 3 Pro
          </p>
        </div>
      </footer>
    </div>
  );
};

export default Layout;
