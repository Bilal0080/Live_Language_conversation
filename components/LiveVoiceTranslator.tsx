
import React, { useState, useRef, useEffect, useMemo } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage } from '@google/genai';
import { decode, decodeAudioData, createBlob } from '../utils/audioUtils';
import { parseApiError } from '../utils/errorUtils';
import { VoiceHistoryItem, Language, ALL_LANGUAGES } from '../types';

const AVAILABLE_VOICES = [
  { id: 'Zephyr', label: 'Zephyr', desc: 'Balanced & Natural' },
  { id: 'Puck', label: 'Puck', desc: 'Bright & Energetic' },
  { id: 'Charon', label: 'Charon', desc: 'Deep & Authoritative' },
  { id: 'Kore', label: 'Kore', desc: 'Clear & Soft' },
  { id: 'Fenrir', label: 'Fenrir', desc: 'Warm & Solid' },
];

const LiveVoiceTranslator: React.FC = () => {
  const [isActive, setIsActive] = useState(false);
  const [transcriptions, setTranscriptions] = useState<Array<{ role: 'user' | 'model'; text: string }>>([]);
  const [isConnecting, setIsConnecting] = useState(false);
  const [visualizerData, setVisualizerData] = useState<number[]>(new Array(40).fill(5));
  const [error, setError] = useState<string | null>(null);
  
  const [sourceLanguage, setSourceLanguage] = useState<Language>(() => {
    return (localStorage.getItem('lingua_voice_source') as Language) || 'English';
  });
  const [targetLanguage, setTargetLanguage] = useState<Language>(() => {
    return (localStorage.getItem('lingua_voice_target') as Language) || 'Japanese';
  });

  // Voice Customization States
  const [selectedVoice, setSelectedVoice] = useState<string>(() => {
    return localStorage.getItem('lingua_live_voice') || 'Kore';
  });
  const [speechRate, setSpeechRate] = useState<number>(() => {
    const saved = localStorage.getItem('lingua_live_speech_rate');
    return saved ? parseFloat(saved) : 1.0;
  });
  const [showSettings, setShowSettings] = useState(false);

  const [history, setHistory] = useState<VoiceHistoryItem[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const audioCtxRef = useRef<AudioContext | null>(null);
  const outputAudioCtxRef = useRef<AudioContext | null>(null);
  const sessionPromiseRef = useRef<Promise<any> | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const streamRef = useRef<MediaStream | null>(null);
  const currentTranscriptionRef = useRef({ user: '', model: '' });

  useEffect(() => {
    const savedHistory = localStorage.getItem('lingua_voice_history');
    if (savedHistory) {
      try {
        setHistory(JSON.parse(savedHistory));
      } catch (e) {
        console.error('Failed to parse voice history', e);
      }
    }
  }, []);

  useEffect(() => {
    localStorage.setItem('lingua_voice_history', JSON.stringify(history));
  }, [history]);

  useEffect(() => {
    localStorage.setItem('lingua_voice_source', sourceLanguage);
  }, [sourceLanguage]);

  useEffect(() => {
    localStorage.setItem('lingua_voice_target', targetLanguage);
  }, [targetLanguage]);

  // Persist Voice Settings
  useEffect(() => {
    localStorage.setItem('lingua_live_voice', selectedVoice);
  }, [selectedVoice]);

  useEffect(() => {
    localStorage.setItem('lingua_live_speech_rate', speechRate.toString());
  }, [speechRate]);

  const filteredHistory = useMemo(() => {
    if (!searchQuery.trim()) return history;
    const query = searchQuery.toLowerCase();
    return history.filter(item => 
      item.messages.some(m => m.text.toLowerCase().includes(query)) ||
      (item.summary && item.summary.toLowerCase().includes(query))
    );
  }, [history, searchQuery]);

  useEffect(() => {
    return () => {
      stopSession();
    };
  }, []);

  const saveCurrentSessionToHistory = (msgs: Array<{ role: 'user' | 'model'; text: string }>) => {
    if (msgs.length === 0) return;
    
    const firstMsg = msgs[0].text;
    const summary = firstMsg.length > 60 ? firstMsg.substring(0, 60) + '...' : firstMsg;

    const newItem: VoiceHistoryItem = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      messages: [...msgs],
      summary
    };

    setHistory(prev => [newItem, ...prev].slice(0, 30));
  };

  const startSession = async () => {
    if (isActive) return;
    setIsConnecting(true);
    setError(null);
    setTranscriptions([]);
    
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
      
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      outputAudioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      
      const systemInstruction = `You are a professional 2-way live translation assistant. The user is currently in a conversation between ${sourceLanguage} and ${targetLanguage}. 
- When you hear ${sourceLanguage}, translate it into ${targetLanguage} and speak ONLY the translation.
- When you hear ${targetLanguage}, translate it into ${sourceLanguage} and speak ONLY the translation.
- If you are unsure which of the two languages is being spoken, use the context to decide.
- Do not add conversational filler. Speak naturally and concisely.`;

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          outputAudioTranscription: {},
          inputAudioTranscription: {},
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: selectedVoice } },
          },
          systemInstruction,
        },
        callbacks: {
          onopen: () => {
            setIsActive(true);
            setIsConnecting(false);
            
            const source = audioCtxRef.current!.createMediaStreamSource(stream);
            const scriptProcessor = audioCtxRef.current!.createScriptProcessor(4096, 1, 1);
            
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmBlob = createBlob(inputData);
              
              const sum = inputData.reduce((a, b) => a + Math.abs(b), 0);
              const avg = sum / inputData.length;
              setVisualizerData(prev => [...prev.slice(1), Math.max(5, avg * 300)]);

              sessionPromise.then((session) => {
                session.sendRealtimeInput({ media: pcmBlob });
              });
            };

            source.connect(scriptProcessor);
            scriptProcessor.connect(audioCtxRef.current!.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            const audioData = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (audioData) {
              const outCtx = outputAudioCtxRef.current!;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, outCtx.currentTime);
              
              try {
                const audioBuffer = await decodeAudioData(decode(audioData), outCtx, 24000, 1);
                const source = outCtx.createBufferSource();
                source.buffer = audioBuffer;
                
                // Apply speed customization
                source.playbackRate.value = speechRate;
                
                source.connect(outCtx.destination);
                source.onended = () => {
                  sourcesRef.current.delete(source);
                };
                
                source.start(nextStartTimeRef.current);
                nextStartTimeRef.current += audioBuffer.duration / speechRate;
                sourcesRef.current.add(source);
              } catch (e) {
                console.error('Audio decoding error:', e);
              }
            }

            if (message.serverContent?.interrupted) {
              sourcesRef.current.forEach(src => {
                try { src.stop(); } catch(e) {}
              });
              sourcesRef.current.clear();
              nextStartTimeRef.current = 0;
            }

            if (message.serverContent?.inputTranscription) {
              currentTranscriptionRef.current.user += message.serverContent.inputTranscription.text;
            }
            if (message.serverContent?.outputTranscription) {
              currentTranscriptionRef.current.model += message.serverContent.outputTranscription.text;
            }

            if (message.serverContent?.turnComplete) {
              const u = currentTranscriptionRef.current.user.trim();
              const m = currentTranscriptionRef.current.model.trim();
              
              if (u || m) {
                setTranscriptions(prev => {
                  const updated = [
                    ...prev,
                    ...(u ? [{ role: 'user' as const, text: u }] : []),
                    ...(m ? [{ role: 'model' as const, text: m }] : [])
                  ];
                  return updated.slice(-20);
                });
              }
              currentTranscriptionRef.current = { user: '', model: '' };
            }
          },
          onerror: (e) => {
            console.error('Live session error:', e);
            setError(`Session error: ${parseApiError(e)}`);
            stopSession();
          },
          onclose: () => {
            stopSession();
          }
        }
      });

      sessionPromiseRef.current = sessionPromise;

    } catch (err) {
      console.error('Failed to start session:', err);
      setError(parseApiError(err));
      setIsConnecting(false);
      stopSession();
    }
  };

  const stopSession = () => {
    if (isActive) {
      setTranscriptions(current => {
        saveCurrentSessionToHistory(current);
        return current;
      });
    }

    setIsActive(false);
    setIsConnecting(false);
    
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    
    if (audioCtxRef.current) {
      audioCtxRef.current.close();
      audioCtxRef.current = null;
    }

    if (outputAudioCtxRef.current) {
      outputAudioCtxRef.current.close();
      outputAudioCtxRef.current = null;
    }

    sourcesRef.current.forEach(src => {
      try { src.stop(); } catch(e) {}
    });
    sourcesRef.current.clear();
    
    sessionPromiseRef.current?.then(session => session.close());
    sessionPromiseRef.current = null;
  };

  const swapLanguages = () => {
    const temp = sourceLanguage;
    setSourceLanguage(targetLanguage);
    setTargetLanguage(temp);
  };

  const clearVoiceHistory = () => {
    if (window.confirm('Clear all voice transcription history?')) {
      setHistory([]);
    }
  };

  const deleteHistoryItem = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setHistory(prev => prev.filter(item => item.id !== id));
  };

  const selectHistoryItem = (item: VoiceHistoryItem) => {
    setTranscriptions(item.messages);
    setShowHistory(false);
  };

  return (
    <div className="flex flex-col h-full space-y-6">
      <div className="bg-white p-3 rounded-2xl border border-slate-200 shadow-sm flex items-center justify-between gap-4">
        <div className="flex flex-1 items-center space-x-2">
          <select 
            value={sourceLanguage}
            onChange={(e) => setSourceLanguage(e.target.value as Language)}
            disabled={isActive || isConnecting}
            className="flex-1 bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-sm font-semibold focus:ring-2 focus:ring-indigo-500 outline-none cursor-pointer disabled:opacity-50 transition-all"
          >
            {ALL_LANGUAGES.map(lang => (
              <option key={`voice-source-${lang}`} value={lang}>{lang}</option>
            ))}
          </select>
          
          <button 
            onClick={swapLanguages}
            disabled={isActive || isConnecting}
            className="w-10 h-10 rounded-full hover:bg-indigo-50 text-slate-400 hover:text-indigo-600 transition-all flex items-center justify-center border border-slate-200 bg-white disabled:opacity-50 active:scale-95"
          >
            <i className="fa-solid fa-right-left text-xs"></i>
          </button>

          <select 
            value={targetLanguage}
            onChange={(e) => setTargetLanguage(e.target.value as Language)}
            disabled={isActive || isConnecting}
            className="flex-1 bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-sm font-semibold focus:ring-2 focus:ring-indigo-500 outline-none cursor-pointer disabled:opacity-50 transition-all"
          >
            {ALL_LANGUAGES.map(lang => (
              <option key={`voice-target-${lang}`} value={lang}>{lang}</option>
            ))}
          </select>
        </div>

        <button 
          onClick={() => setShowSettings(!showSettings)}
          className={`w-10 h-10 rounded-lg flex items-center justify-center transition-all ${
            showSettings ? 'bg-indigo-600 text-white shadow-md' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
          }`}
          title="Voice Settings"
        >
          <i className="fa-solid fa-sliders"></i>
        </button>
      </div>

      {/* Voice Settings Panel */}
      {showSettings && (
        <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-xl animate-in slide-in-from-top-2">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            <div className="space-y-3">
              <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Assistant Voice</label>
              <div className="grid grid-cols-1 gap-1">
                {AVAILABLE_VOICES.map(voice => (
                  <button
                    key={voice.id}
                    onClick={() => setSelectedVoice(voice.id)}
                    className={`w-full text-left px-4 py-2 rounded-xl text-xs flex items-center justify-between transition-all ${
                      selectedVoice === voice.id 
                      ? 'bg-indigo-600 text-white shadow-md' 
                      : 'bg-slate-50 text-slate-600 hover:bg-slate-100'
                    }`}
                  >
                    <div className="flex flex-col">
                      <span className="font-bold">{voice.label}</span>
                      <span className={`text-[9px] opacity-70 ${selectedVoice === voice.id ? 'text-indigo-100' : 'text-slate-400'}`}>{voice.desc}</span>
                    </div>
                    {selectedVoice === voice.id && <i className="fa-solid fa-check text-[10px]"></i>}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-4">
              <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">Speech Rate ({speechRate.toFixed(1)}x)</label>
              <div className="bg-slate-50 p-4 rounded-xl border border-slate-100">
                <input 
                  type="range" 
                  min="0.5" 
                  max="2.0" 
                  step="0.1" 
                  value={speechRate}
                  onChange={(e) => setSpeechRate(parseFloat(e.target.value))}
                  className="w-full h-1.5 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-indigo-600"
                />
                <div className="flex justify-between mt-2 text-[10px] text-slate-400 font-bold">
                  <span>Slow</span>
                  <span>Normal</span>
                  <span>Fast</span>
                </div>
              </div>
              <p className="text-[10px] text-slate-400 italic">Changing voice settings while a session is active will take effect on the next utterance.</p>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-100 p-4 rounded-2xl flex items-start text-red-600 text-sm animate-in slide-in-from-top-2">
          <i className="fa-solid fa-triangle-exclamation mr-3 mt-0.5 text-red-400"></i>
          <div className="flex-1">
            <p className="font-bold mb-0.5">Voice Session Error</p>
            <p>{error}</p>
          </div>
          <button onClick={() => setError(null)} className="ml-2 text-red-400 hover:text-red-600 transition-colors">
            <i className="fa-solid fa-xmark"></i>
          </button>
        </div>
      )}

      <div className="bg-slate-900 rounded-3xl p-8 shadow-2xl relative overflow-hidden min-h-[300px] flex flex-col items-center justify-center">
        <div className="absolute inset-0 opacity-20 pointer-events-none">
          <div className="absolute top-0 left-0 w-full h-full bg-[radial-gradient(circle_at_center,_var(--tw-gradient-stops))] from-indigo-500/30 via-transparent to-transparent"></div>
        </div>

        <div className="z-10 flex flex-col items-center space-y-8 w-full">
          <div className="flex items-end justify-center space-x-1 h-24">
            {visualizerData.map((val, idx) => (
              <div 
                key={idx} 
                className={`w-1.5 rounded-full transition-all duration-75 ${isActive ? 'bg-indigo-400 shadow-[0_0_10px_rgba(129,140,248,0.5)]' : 'bg-slate-700'}`}
                style={{ height: `${val}%` }}
              ></div>
            ))}
          </div>

          <div className="flex flex-col items-center">
            {isConnecting ? (
              <div className="flex flex-col items-center text-white">
                <i className="fa-solid fa-circle-notch fa-spin text-4xl mb-3 text-indigo-400"></i>
                <p className="font-medium animate-pulse">Establishing secure link...</p>
              </div>
            ) : isActive ? (
              <button 
                onClick={stopSession}
                className="group relative flex items-center justify-center"
              >
                <div className="absolute inset-0 bg-red-500/20 blur-2xl rounded-full scale-150 animate-pulse"></div>
                <div className="w-20 h-20 bg-red-500 rounded-full flex items-center justify-center text-white shadow-lg hover:bg-red-600 transition-all z-10">
                  <i className="fa-solid fa-stop text-2xl"></i>
                </div>
                <span className="absolute -bottom-10 text-white font-bold tracking-widest uppercase text-xs">End Session</span>
              </button>
            ) : (
              <button 
                onClick={startSession}
                className="group relative flex items-center justify-center"
              >
                <div className="absolute inset-0 bg-indigo-500/20 blur-2xl rounded-full scale-150 group-hover:bg-indigo-500/40 transition-all"></div>
                <div className="w-20 h-20 bg-indigo-600 rounded-full flex items-center justify-center text-white shadow-lg hover:bg-indigo-700 hover:scale-105 transition-all z-10">
                  <i className="fa-solid fa-microphone text-2xl"></i>
                </div>
                <span className="absolute -bottom-10 text-slate-400 font-bold tracking-widest uppercase text-xs">Start Listening</span>
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="bg-white rounded-2xl shadow-lg border border-slate-200 flex-1 overflow-hidden flex flex-col min-h-[400px]">
        <div className="p-4 bg-slate-50 border-b flex items-center justify-between">
          <h3 className="font-bold text-slate-700 flex items-center">
            <i className="fa-solid fa-comment-dots text-indigo-500 mr-2"></i>
            Live Transcription
          </h3>
          <div className="flex items-center space-x-2">
            <button 
              onClick={() => setShowHistory(true)}
              className="text-xs font-bold text-slate-500 hover:text-indigo-600 transition-colors flex items-center bg-white border border-slate-200 px-3 py-1 rounded-full shadow-sm"
            >
              <i className="fa-solid fa-clock-rotate-left mr-2"></i>
              History
            </button>
            <span className="px-2 py-0.5 bg-indigo-100 text-indigo-700 text-[10px] font-bold rounded uppercase">Real-time</span>
          </div>
        </div>
        
        <div className="flex-1 overflow-y-auto p-6 space-y-6 bg-slate-50/30">
          {transcriptions.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-slate-300 space-y-4">
              <i className="fa-solid fa-microphone-lines text-5xl opacity-20"></i>
              <p className="text-center max-w-[200px]">Transcriptions will appear here when you start talking</p>
            </div>
          ) : (
            transcriptions.map((t, i) => (
              <div key={i} className={`flex ${t.role === 'user' ? 'justify-end' : 'justify-start'} animate-in slide-in-from-bottom-2`}>
                <div className={`max-w-[80%] rounded-2xl p-4 shadow-sm border ${
                  t.role === 'user' 
                  ? 'bg-indigo-600 text-white border-indigo-500 rounded-tr-none' 
                  : 'bg-white text-slate-800 border-slate-200 rounded-tl-none'
                }`}>
                  <div className={`text-[10px] font-bold uppercase mb-1 ${t.role === 'user' ? 'text-indigo-200' : 'text-slate-400'}`}>
                    {t.role === 'user' ? 'You' : 'Assistant'}
                  </div>
                  <p className="text-sm leading-relaxed">{t.text}</p>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {showHistory && (
        <div className="fixed inset-0 z-[60] flex justify-end">
          <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" onClick={() => setShowHistory(false)}></div>
          <div className="relative w-full max-w-md bg-white h-full shadow-2xl flex flex-col animate-in slide-in-from-right duration-300">
            <div className="p-6 border-b border-slate-100 flex items-center justify-between bg-slate-50">
              <h3 className="text-xl font-bold text-slate-800 flex items-center">
                <i className="fa-solid fa-microphone-lines mr-3 text-indigo-600"></i>
                Voice Logs
              </h3>
              <button 
                onClick={() => setShowHistory(false)}
                className="w-10 h-10 rounded-full hover:bg-slate-200 text-slate-400 transition-colors flex items-center justify-center"
              >
                <i className="fa-solid fa-xmark text-lg"></i>
              </button>
            </div>

            <div className="px-6 py-4 border-b border-slate-100">
              <div className="relative">
                <i className="fa-solid fa-magnifying-glass absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"></i>
                <input 
                  type="text"
                  placeholder="Search in conversations..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full pl-10 pr-4 py-2 bg-slate-100 border-none rounded-xl text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
                />
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {history.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-slate-300 space-y-4 py-20">
                  <i className="fa-solid fa-ghost text-5xl opacity-20"></i>
                  <p className="font-medium">No voice logs saved</p>
                </div>
              ) : filteredHistory.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-slate-300 py-20">
                  <i className="fa-solid fa-magnifying-glass text-4xl mb-3 opacity-20"></i>
                  <p>No matches for "{searchQuery}"</p>
                </div>
              ) : (
                filteredHistory.map((item) => (
                  <div 
                    key={item.id}
                    onClick={() => selectHistoryItem(item)}
                    className="group bg-white border border-slate-200 rounded-xl p-4 cursor-pointer hover:border-indigo-400 hover:shadow-md transition-all relative"
                  >
                    <div className="flex items-center justify-between mb-2">
                      <div className="text-[10px] font-bold text-indigo-600 uppercase tracking-wider">
                        {item.messages.length} Turns • {new Date(item.timestamp).toLocaleDateString()}
                      </div>
                      <button 
                        onClick={(e) => deleteHistoryItem(item.id, e)}
                        className="opacity-0 group-hover:opacity-100 w-7 h-7 rounded-full bg-red-50 text-red-400 hover:bg-red-100 hover:text-red-600 transition-all flex items-center justify-center"
                      >
                        <i className="fa-solid fa-trash-can text-xs"></i>
                      </button>
                    </div>
                    <p className="text-slate-700 text-sm line-clamp-2 font-medium italic">
                      "{item.summary}"
                    </p>
                    <div className="mt-2 text-[10px] text-slate-400">
                      {new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </div>
                  </div>
                ))
              )}
            </div>

            {history.length > 0 && (
              <div className="p-4 border-t border-slate-100">
                <button 
                  onClick={clearVoiceHistory}
                  className="w-full py-3 bg-slate-50 hover:bg-red-50 hover:text-red-600 text-slate-500 rounded-xl text-sm font-bold transition-all border border-slate-100 flex items-center justify-center space-x-2"
                >
                  <i className="fa-solid fa-broom"></i>
                  <span>Clear Voice History</span>
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default LiveVoiceTranslator;
