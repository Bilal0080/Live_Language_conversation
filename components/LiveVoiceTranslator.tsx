
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
  const [error, setError] = useState<{ message: string; type: 'permission' | 'network' | 'api' | 'unknown'; details?: string } | null>(null);
  
  // Track if we are viewing a past session
  const [viewingHistoryItem, setViewingHistoryItem] = useState<VoiceHistoryItem | null>(null);

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

  /**
   * Generates a concise summary of the conversation using Gemini API
   */
  const generateConversationSummary = async (id: string, msgs: Array<{ role: 'user' | 'model'; text: string }>) => {
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const transcript = msgs.map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`).join('\n');
      
      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: `Please summarize this translated conversation in exactly one short, descriptive sentence (maximum 12 words). Focus on the main topic discussed. The conversation was between ${sourceLanguage} and ${targetLanguage}.\n\nTranscript:\n${transcript}`,
      });

      const summary = response.text?.trim();
      if (summary) {
        setHistory(prev => prev.map(item => item.id === id ? { ...item, summary } : item));
      }
    } catch (e) {
      console.error('Failed to generate conversation summary:', e);
      setHistory(prev => prev.map(item => {
        if (item.id === id && item.summary === 'Summarizing conversation...') {
          const fallback = msgs[0]?.text.substring(0, 60) + '...';
          return { ...item, summary: fallback };
        }
        return item;
      }));
    }
  };

  const saveCurrentSessionToHistory = (msgs: Array<{ role: 'user' | 'model'; text: string }>) => {
    if (msgs.length === 0) return;
    
    const id = crypto.randomUUID();
    const newItem: VoiceHistoryItem = {
      id,
      timestamp: Date.now(),
      messages: [...msgs],
      summary: 'Summarizing conversation...' 
    };

    setHistory(prev => [newItem, ...prev].slice(0, 30));
    generateConversationSummary(id, msgs);
  };

  const startSession = async () => {
    if (isActive) return;
    setIsConnecting(true);
    setError(null);
    setTranscriptions([]);
    setViewingHistoryItem(null); 
    
    try {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (e: any) {
        if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
          setError({
            type: 'permission',
            message: 'Microphone access denied.',
            details: 'Please enable microphone permissions in your browser settings to use live voice translation.'
          });
        } else if (e.name === 'NotFoundError' || e.name === 'DevicesNotFoundError') {
          setError({
            type: 'permission',
            message: 'No microphone found.',
            details: 'Please ensure a microphone is connected to your device.'
          });
        } else {
          setError({
            type: 'unknown',
            message: 'Could not access microphone.',
            details: e.message
          });
        }
        setIsConnecting(false);
        return;
      }

      streamRef.current = stream;
      audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      outputAudioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const systemInstruction = `You are a professional 2-way live translation assistant. The user is currently in a conversation between ${sourceLanguage} and ${targetLanguage}. 
- When you hear ${sourceLanguage}, translate it into ${targetLanguage} and speak ONLY the translation.
- When you hear ${targetLanguage}, translate it into ${sourceLanguage} and speak ONLY the translation.
- If you are unsure which of the two languages is being spoken, use the context to decide.
- Do not add conversational filler. Speak naturally and concisely.`;

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
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
          onerror: (e: any) => {
            console.error('Live session error:', e);
            const msg = parseApiError(e);
            let errorType: 'network' | 'api' | 'unknown' = 'api';
            
            if (msg.toLowerCase().includes('network') || msg.toLowerCase().includes('connection') || msg.toLowerCase().includes('fetch')) {
              errorType = 'network';
            }

            setError({
              type: errorType,
              message: 'Session Interrupted',
              details: msg
            });
            stopSession();
          },
          onclose: () => {
            if (isActive) stopSession();
          }
        }
      });

      sessionPromiseRef.current = sessionPromise;

    } catch (err: any) {
      console.error('Failed to start session:', err);
      setError({
        type: 'api',
        message: 'Could not connect to translation service.',
        details: parseApiError(err)
      });
      setIsConnecting(false);
      stopSession();
    }
  };

  const stopSession = () => {
    if (isActive) {
      const finalTranscriptions = [...transcriptions];
      saveCurrentSessionToHistory(finalTranscriptions);
    }

    setIsActive(false);
    setIsConnecting(false);
    
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }

    if (outputAudioCtxRef.current) {
      outputAudioCtxRef.current.close().catch(() => {});
      outputAudioCtxRef.current = null;
    }

    sourcesRef.current.forEach(src => {
      try { src.stop(); } catch(e) {}
    });
    sourcesRef.current.clear();
    
    sessionPromiseRef.current?.then(session => {
      try { session.close(); } catch(e) {}
    }).catch(() => {});
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
      setViewingHistoryItem(null);
    }
  };

  const deleteHistoryItem = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setHistory(prev => prev.filter(item => item.id !== id));
    if (viewingHistoryItem?.id === id) {
      setViewingHistoryItem(null);
      setTranscriptions([]);
    }
  };

  const selectHistoryItem = (item: VoiceHistoryItem) => {
    if (isActive) stopSession();
    setViewingHistoryItem(item);
    setTranscriptions(item.messages);
    setShowHistory(false);
  };

  const resetToLive = () => {
    setViewingHistoryItem(null);
    setTranscriptions([]);
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
              </div>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className={`p-4 rounded-2xl border flex items-start text-sm animate-in slide-in-from-top-2 shadow-sm ${
          error.type === 'permission' ? 'bg-amber-50 border-amber-100 text-amber-800' : 'bg-red-50 border-red-100 text-red-600'
        }`}>
          <div className={`mr-3 mt-1 flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center ${
            error.type === 'permission' ? 'bg-amber-100 text-amber-500' : 'bg-red-100 text-red-400'
          }`}>
            <i className={`fa-solid ${error.type === 'permission' ? 'fa-microphone-slash' : 'fa-triangle-exclamation'}`}></i>
          </div>
          <div className="flex-1">
            <p className="font-bold mb-1">{error.message}</p>
            <p className="opacity-80 leading-relaxed mb-3">{error.details}</p>
            
            <div className="bg-white/50 p-3 rounded-xl border border-slate-200/50 space-y-2">
              <p className={`text-[11px] font-bold uppercase tracking-wider flex items-center ${error.type === 'permission' ? 'text-amber-600' : 'text-red-600'}`}>
                <i className="fa-solid fa-lightbulb mr-2"></i>
                Suggested Fix
              </p>
              <ul className="text-xs list-disc list-inside space-y-1 opacity-90">
                {error.type === 'permission' && (
                  <>
                    <li>Check browser address bar for a blocked mic icon</li>
                    <li>Go to Settings &gt; Privacy &gt; Microphone permissions</li>
                    <li>Ensure no other app is currently using the microphone</li>
                  </>
                )}
                {error.type === 'network' && (
                  <>
                    <li>Check your internet connection stability</li>
                    <li>If using a VPN, try disabling it temporarily</li>
                    <li>Ensure your firewall allows WebSocket connections (Port 443)</li>
                  </>
                )}
                {error.type === 'api' && (
                  <>
                    <li>Verify your API key is correctly configured</li>
                    <li>Check if the 'gemini-2.5-flash-native-audio' model is available in your region</li>
                    <li>Ensure your project has an active billing account linked</li>
                  </>
                )}
                {error.type === 'unknown' && (
                  <>
                    <li>Refresh the page and try again</li>
                    <li>Check for browser console errors for more detail</li>
                  </>
                )}
              </ul>
            </div>

            {(error.type === 'network' || error.type === 'api') && (
              <button 
                onClick={startSession}
                className={`mt-4 text-xs font-black uppercase tracking-widest px-4 py-2 rounded-lg transition-colors shadow-sm ${
                  error.type === 'network' ? 'bg-red-100 text-red-700 hover:bg-red-200' : 'bg-red-600 text-white hover:bg-red-700'
                }`}
              >
                Retry Session
              </button>
            )}
          </div>
          <button onClick={() => setError(null)} className="ml-4 opacity-50 hover:opacity-100 transition-opacity">
            <i className="fa-solid fa-xmark text-lg"></i>
          </button>
        </div>
      )}

      <div className={`rounded-3xl p-8 shadow-2xl relative overflow-hidden min-h-[300px] flex flex-col items-center justify-center transition-all duration-500 ${viewingHistoryItem ? 'bg-slate-800' : 'bg-slate-900'}`}>
        <div className="absolute inset-0 opacity-20 pointer-events-none">
          <div className={`absolute top-0 left-0 w-full h-full bg-[radial-gradient(circle_at_center,_var(--tw-gradient-stops))] via-transparent to-transparent ${viewingHistoryItem ? 'from-amber-500/20' : 'from-indigo-500/30'}`}></div>
        </div>

        <div className="z-10 flex flex-col items-center space-y-8 w-full">
          {!viewingHistoryItem && (
            <div className="flex items-end justify-center space-x-1 h-24">
              {visualizerData.map((val, idx) => (
                <div 
                  key={idx} 
                  className={`w-1.5 rounded-full transition-all duration-75 ${isActive ? 'bg-indigo-400 shadow-[0_0_10px_rgba(129,140,248,0.5)]' : 'bg-slate-700'}`}
                  style={{ height: `${val}%` }}
                ></div>
              ))}
            </div>
          )}

          {viewingHistoryItem && (
            <div className="text-center space-y-4 animate-in fade-in zoom-in-95">
              <div className="inline-flex items-center space-x-2 bg-amber-500/10 text-amber-400 px-4 py-2 rounded-full border border-amber-500/20">
                <i className="fa-solid fa-box-archive text-xs"></i>
                <span className="text-xs font-black uppercase tracking-widest">History Archive</span>
              </div>
              <h3 className="text-white font-bold text-lg px-6 italic">"{viewingHistoryItem.summary}"</h3>
              <p className="text-slate-400 text-xs">{new Date(viewingHistoryItem.timestamp).toLocaleString()}</p>
              <button 
                onClick={resetToLive}
                className="mt-4 px-6 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-xl text-xs font-bold transition-all flex items-center space-x-2 mx-auto"
              >
                <i className="fa-solid fa-rotate-left"></i>
                <span>Back to Live Mode</span>
              </button>
            </div>
          )}

          {!viewingHistoryItem && (
            <div className="flex flex-col items-center">
              {isConnecting ? (
                <div className="flex flex-col items-center text-white">
                  <div className="relative w-16 h-16 mb-4">
                    <div className="absolute inset-0 border-4 border-indigo-500/20 rounded-full"></div>
                    <div className="absolute inset-0 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin"></div>
                  </div>
                  <p className="font-bold tracking-widest uppercase text-[10px] animate-pulse">Establishing secure link...</p>
                </div>
              ) : isActive ? (
                <button 
                  onClick={stopSession}
                  className="group relative flex items-center justify-center"
                >
                  <div className="absolute inset-0 bg-red-500/20 blur-2xl rounded-full scale-150 animate-pulse"></div>
                  <div className="w-20 h-20 bg-red-50 rounded-full flex items-center justify-center text-white shadow-lg hover:bg-red-600 transition-all z-10">
                    <i className="fa-solid fa-stop text-2xl text-red-600 group-hover:text-white"></i>
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
          )}
        </div>
      </div>

      <div className="bg-white rounded-2xl shadow-lg border border-slate-200 flex-1 overflow-hidden flex flex-col min-h-[400px]">
        <div className={`p-4 border-b flex items-center justify-between ${viewingHistoryItem ? 'bg-amber-50/50' : 'bg-slate-50'}`}>
          <h3 className="font-bold text-slate-700 flex items-center">
            <i className={`fa-solid ${viewingHistoryItem ? 'fa-book-open text-amber-500' : 'fa-comment-dots text-indigo-500'} mr-2`}></i>
            {viewingHistoryItem ? 'Conversation Log' : 'Live Transcription'}
          </h3>
          <div className="flex items-center space-x-2">
            {!viewingHistoryItem && (
              <button 
                onClick={() => setShowHistory(true)}
                className="text-xs font-bold text-slate-500 hover:text-indigo-600 transition-colors flex items-center bg-white border border-slate-200 px-3 py-1 rounded-full shadow-sm"
              >
                <i className="fa-solid fa-clock-rotate-left mr-2"></i>
                Browse History
              </button>
            )}
            {viewingHistoryItem && (
              <span className="px-2 py-0.5 bg-amber-100 text-amber-700 text-[10px] font-bold rounded uppercase">Log View</span>
            )}
          </div>
        </div>
        
        <div className="flex-1 overflow-y-auto p-6 space-y-6 bg-slate-50/30">
          {transcriptions.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-slate-300 space-y-4">
              <div className="w-20 h-20 bg-slate-100 rounded-full flex items-center justify-center">
                <i className="fa-solid fa-microphone-lines text-3xl opacity-20"></i>
              </div>
              <p className="text-center max-w-[200px] text-xs font-bold uppercase tracking-widest text-slate-400">Transcriptions will appear here</p>
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
                <i className="fa-solid fa-clock-rotate-left mr-3 text-indigo-600"></i>
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
                  placeholder="Search in logs..."
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
                  <p className="font-medium text-center">Your translated voice conversations will be saved here.</p>
                </div>
              ) : filteredHistory.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-slate-300 py-20">
                  <i className="fa-solid fa-magnifying-glass text-4xl mb-3 opacity-20"></i>
                  <p>No matches found</p>
                </div>
              ) : (
                filteredHistory.map((item) => (
                  <div 
                    key={item.id}
                    onClick={() => selectHistoryItem(item)}
                    className={`group border rounded-xl p-4 cursor-pointer hover:border-indigo-400 hover:shadow-md transition-all relative ${viewingHistoryItem?.id === item.id ? 'bg-indigo-50 border-indigo-300' : 'bg-white border-slate-200'}`}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <div className="text-[10px] font-bold text-indigo-600 uppercase tracking-wider flex items-center">
                        {item.messages.length} Turns • {new Date(item.timestamp).toLocaleDateString()}
                        {item.summary === 'Summarizing conversation...' && (
                          <i className="fa-solid fa-circle-notch fa-spin ml-2 text-indigo-400"></i>
                        )}
                      </div>
                      <button 
                        onClick={(e) => deleteHistoryItem(item.id, e)}
                        className="opacity-0 group-hover:opacity-100 w-7 h-7 rounded-full bg-red-50 text-red-400 hover:bg-red-100 hover:text-red-600 transition-all flex items-center justify-center"
                      >
                        <i className="fa-solid fa-trash-can text-xs"></i>
                      </button>
                    </div>
                    <p className={`text-slate-700 text-sm line-clamp-2 font-medium italic ${item.summary === 'Summarizing conversation...' ? 'text-slate-400 animate-pulse' : ''}`}>
                      {item.summary ? `"${item.summary}"` : 'Log summary unavailable'}
                    </p>
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
                  <span>Clear All Logs</span>
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
