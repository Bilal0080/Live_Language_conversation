
import React, { useState, useRef, useEffect } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage } from '@google/genai';
import { Language, TranslationState, HistoryItem, ALL_LANGUAGES } from '../types';
import { decode, decodeAudioData, createBlob } from '../utils/audioUtils';
import { parseApiError } from '../utils/errorUtils';
import { offlineTranslate, getOfflineSuggestions } from '../utils/offlineEngine';

const AVAILABLE_VOICES = [
  { id: 'Zephyr', label: 'Zephyr', desc: 'Balanced & Natural' },
  { id: 'Puck', label: 'Puck', desc: 'Bright & Energetic' },
  { id: 'Charon', label: 'Charon', desc: 'Deep & Authoritative' },
  { id: 'Kore', label: 'Kore', desc: 'Clear & Soft' },
  { id: 'Fenrir', label: 'Fenrir', desc: 'Warm & Solid' },
];

const VOICE_INPUT_LIMIT_SEC = 60;
const CONCURRENCY_LIMIT = 3; // Number of sentences to translate simultaneously

interface SentenceJob {
  source: string;
  translated: string;
  status: 'pending' | 'translating' | 'done' | 'error';
}

const TextTranslator: React.FC = () => {
  const [state, setState] = useState<TranslationState>({
    sourceText: '',
    translatedText: '',
    sourceLanguage: 'Japanese',
    targetLanguage: 'English',
    isLoading: false,
    error: null,
    pronunciationGuide: '',
  });

  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [isOfflineResult, setIsOfflineResult] = useState(false);
  const [showOfflineSuggestions, setShowOfflineSuggestions] = useState(false);

  useEffect(() => {
    const handleStatusChange = () => setIsOnline(navigator.onLine);
    window.addEventListener('online', handleStatusChange);
    window.addEventListener('offline', handleStatusChange);
    return () => {
      window.removeEventListener('online', handleStatusChange);
      window.removeEventListener('offline', handleStatusChange);
    };
  }, []);

  // Voice & Live States
  const [isLiveMode, setIsLiveMode] = useState(false);
  const [listeningTimeLeft, setListeningTimeLeft] = useState(VOICE_INPUT_LIMIT_SEC);
  const [micLevel, setMicLevel] = useState(0);
  const listeningIntervalRef = useRef<number | null>(null);

  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  
  const [speechRate, setSpeechRate] = useState<number>(() => {
    const saved = localStorage.getItem('lingua_speech_rate');
    return saved ? parseFloat(saved) : 1.0;
  });

  const [selectedVoice, setSelectedVoice] = useState<string>(() => {
    return localStorage.getItem('lingua_selected_voice') || 'Zephyr';
  });

  const [isAutoPlayEnabled, setIsAutoPlayEnabled] = useState<boolean>(() => {
    const saved = localStorage.getItem('lingua_auto_play');
    return saved === 'true';
  });

  const [isVoicePanelOpen, setIsVoicePanelOpen] = useState(false);
  const [isAutoDetect, setIsAutoDetect] = useState(true);
  const [isDetecting, setIsDetecting] = useState(false);
  const [lastDetectedLanguage, setLastDetectedLanguage] = useState<Language | null>(null);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isGeneratingGuide, setIsGeneratingGuide] = useState(false);
  const [showGuide, setShowGuide] = useState(false);

  const [sentenceJobs, setSentenceJobs] = useState<SentenceJob[]>([]);
  const [isSequentialMode, setIsSequentialMode] = useState(false);

  // Refs for audio and live sessions
  const audioCtxRef = useRef<AudioContext | null>(null);
  const outputAudioCtxRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const ttsAudioCtxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sessionPromiseRef = useRef<Promise<any> | null>(null);
  const detectionTimerRef = useRef<number | null>(null);
  const ttsSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const languageSelectRef = useRef<HTMLSelectElement>(null);
  const lastProcessedTextRef = useRef<string>('');

  useEffect(() => {
    const savedHistory = localStorage.getItem('lingua_history');
    if (savedHistory) {
      try {
        setHistory(JSON.parse(savedHistory));
      } catch (e) {
        console.error('Failed to parse history', e);
      }
    }
  }, []);

  useEffect(() => {
    localStorage.setItem('lingua_history', JSON.stringify(history));
  }, [history]);

  useEffect(() => {
    localStorage.setItem('lingua_speech_rate', speechRate.toString());
  }, [speechRate]);

  useEffect(() => {
    localStorage.setItem('lingua_selected_voice', selectedVoice);
  }, [selectedVoice]);

  useEffect(() => {
    localStorage.setItem('lingua_auto_play', isAutoPlayEnabled.toString());
  }, [isAutoPlayEnabled]);

  // Real-Time Detection
  useEffect(() => {
    const text = state.sourceText.trim();
    if (!isOnline || !isAutoDetect || text.length < 3 || text === lastProcessedTextRef.current || isLiveMode) {
      if (!text) setLastDetectedLanguage(null);
      setIsDetecting(false);
      return;
    }

    if (detectionTimerRef.current) window.clearTimeout(detectionTimerRef.current);

    detectionTimerRef.current = window.setTimeout(async () => {
      setIsDetecting(true);
      lastProcessedTextRef.current = text;
      try {
        const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
        const response = await ai.models.generateContent({
          model: 'gemini-3-flash-preview',
          contents: `Detect language: ${text.substring(0, 350)}. List: ${ALL_LANGUAGES.join(', ')}. Return ONLY the name.`,
          config: { temperature: 0 },
        });
        const detected = response.text?.trim() as Language;
        if (detected && ALL_LANGUAGES.includes(detected)) {
          setLastDetectedLanguage(detected);
          if (isAutoDetect && detected !== state.sourceLanguage) {
            setState(prev => ({ ...prev, sourceLanguage: detected }));
          }
        }
      } catch (err) {
        console.error('Detection error:', err);
      } finally {
        setIsDetecting(false);
      }
    }, 1000);

    return () => {
      if (detectionTimerRef.current) window.clearTimeout(detectionTimerRef.current);
    };
  }, [state.sourceText, isAutoDetect, isOnline, isLiveMode]);

  const handleCorrectDetection = () => {
    setIsAutoDetect(false);
    setLastDetectedLanguage(null);
    languageSelectRef.current?.focus();
  };

  const saveToHistory = (source: string, translated: string) => {
    const newItem: HistoryItem = {
      id: crypto.randomUUID(),
      sourceText: source,
      translatedText: translated,
      sourceLanguage: state.sourceLanguage,
      targetLanguage: state.targetLanguage,
      timestamp: Date.now(),
    };
    setHistory(prev => [newItem, ...prev].slice(0, 50));
  };

  const handleSpeak = async (textToSpeak: string) => {
    if (isSpeaking) {
      ttsSourceRef.current?.stop();
      setIsSpeaking(false);
      return;
    }
    setIsSpeaking(true);
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash-preview-tts',
        contents: [{ parts: [{ text: textToSpeak }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: selectedVoice } },
          },
        },
      });
      if (!ttsAudioCtxRef.current) ttsAudioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      const ctx = ttsAudioCtxRef.current;
      const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (base64Audio) {
        const audioBuffer = await decodeAudioData(decode(base64Audio), ctx, 24000, 1);
        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;
        source.playbackRate.value = speechRate;
        source.connect(ctx.destination);
        ttsSourceRef.current = source;
        source.onended = () => { setIsSpeaking(false); ttsSourceRef.current = null; };
        source.start();
      } else {
        setIsSpeaking(false);
      }
    } catch (err) {
      console.error('TTS Error:', err);
      setIsSpeaking(false);
    }
  };

  const splitIntoSentences = (text: string): string[] => {
    // Advanced split that captures CJK and Western sentence delimiters
    const parts = text.split(/([.!?。！？]\s*|\n+)/).filter(Boolean);
    const result: string[] = [];
    
    let currentSentence = "";
    for (const part of parts) {
      if (/^[.!?。！？\s\n]+$/.test(part)) {
        currentSentence += part;
        result.push(currentSentence.trim());
        currentSentence = "";
      } else {
        if (currentSentence) result.push(currentSentence.trim());
        currentSentence = part;
      }
    }
    if (currentSentence.trim()) result.push(currentSentence.trim());
    
    return result.filter(s => s.length > 0);
  };

  const handleGenerateGuide = async () => {
    if (!state.translatedText || isGeneratingGuide) return;
    
    setShowGuide(true);
    setIsGeneratingGuide(true);
    
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: `Provide a phonetic pronunciation guide (IPA or simple phonetic notation) for the following ${state.targetLanguage} text: "${state.translatedText}". Return ONLY the guide text without any preamble.`,
        config: { temperature: 0.1 }
      });
      
      const guide = response.text?.trim() || 'Guide unavailable';
      setState(prev => ({ ...prev, pronunciationGuide: guide }));
    } catch (err) {
      console.error('Failed to generate pronunciation guide:', err);
      setState(prev => ({ ...prev, pronunciationGuide: 'Phonetic guide generation failed.' }));
    } finally {
      setIsGeneratingGuide(false);
    }
  };

  const handleTranslate = async () => {
    const text = state.sourceText.trim();
    if (!text) return;
    
    setState(prev => ({ ...prev, isLoading: true, error: null, translatedText: '', pronunciationGuide: '' }));
    setIsOfflineResult(false);
    setShowOfflineSuggestions(false);
    setShowGuide(false);

    if (!isOnline) {
      setTimeout(() => {
        const offlineResult = offlineTranslate(text, state.sourceLanguage, state.targetLanguage);
        if (offlineResult) {
          setState(prev => ({ ...prev, translatedText: offlineResult, isLoading: false }));
          setIsOfflineResult(true);
        } else {
          setShowOfflineSuggestions(true);
          setState(prev => ({ 
            ...prev, 
            isLoading: false, 
            error: "Basic offline translation is limited. Try reconnecting for advanced AI translation or explore common phrases below." 
          }));
        }
      }, 500);
      return;
    }

    const sentences = splitIntoSentences(text);
    
    // Single sentence translation
    if (sentences.length <= 1) {
      setIsSequentialMode(false);
      try {
        const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
        const response = await ai.models.generateContent({
          model: 'gemini-3-flash-preview',
          contents: `Translate from ${state.sourceLanguage} to ${state.targetLanguage}: "${text}"`,
          config: { temperature: 0.2 }
        });
        const translated = response.text || '';
        setState(prev => ({ ...prev, translatedText: translated, isLoading: false }));
        saveToHistory(text, translated);
        if (isAutoPlayEnabled && translated) handleSpeak(translated);
      } catch (err: any) {
        setState(prev => ({ ...prev, isLoading: false, error: parseApiError(err) }));
      }
      return;
    }

    // Chunked concurrent translation
    setIsSequentialMode(true);
    const initialJobs: SentenceJob[] = sentences.map(s => ({ source: s, translated: '', status: 'pending' }));
    setSentenceJobs(initialJobs);

    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
    const pool = [...sentences.entries()];
    
    const translateSentence = async (index: number, content: string) => {
      setSentenceJobs(prev => {
        const next = [...prev];
        next[index] = { ...next[index], status: 'translating' };
        return next;
      });

      try {
        const response = await ai.models.generateContent({
          model: 'gemini-3-flash-preview',
          contents: `Translate this ${state.sourceLanguage} sentence into ${state.targetLanguage}: "${content}"`,
          config: { temperature: 0.1 }
        });
        const result = response.text?.trim() || '';
        setSentenceJobs(prev => {
          const next = [...prev];
          next[index] = { ...next[index], status: 'done', translated: result };
          return next;
        });
        return result;
      } catch (err) {
        setSentenceJobs(prev => {
          const next = [...prev];
          next[index] = { ...next[index], status: 'error' };
          return next;
        });
        return `[Translation Error]`;
      }
    };

    // Process pool with concurrency limit
    const workers = Array(Math.min(CONCURRENCY_LIMIT, sentences.length)).fill(null).map(async () => {
      while (pool.length > 0) {
        const item = pool.shift();
        if (item) {
          await translateSentence(item[0], item[1]);
        }
      }
    });

    await Promise.all(workers);

    // Assembly
    setSentenceJobs(prev => {
      const fullText = prev.map(j => j.translated || '').join(' ').trim();
      setState(s => ({ ...s, translatedText: fullText, isLoading: false }));
      saveToHistory(text, fullText);
      if (isAutoPlayEnabled && fullText) handleSpeak(fullText);
      return prev;
    });
  };

  const toggleLiveInterpreter = async () => {
    if (isLiveMode) {
      stopLiveSession();
      return;
    }

    if (!isOnline) {
      setState(prev => ({ ...prev, error: 'Live Interpretation requires an active connection.' }));
      return;
    }

    setIsLiveMode(true);
    setState(prev => ({ ...prev, sourceText: '', translatedText: '', error: null }));
    setListeningTimeLeft(VOICE_INPUT_LIMIT_SEC);

    listeningIntervalRef.current = window.setInterval(() => {
      setListeningTimeLeft(prev => {
        if (prev <= 1) { stopLiveSession(); return 0; }
        return prev - 1;
      });
    }, 1000);

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      outputAudioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      
      const systemInstruction = `You are a real-time translator. Translate everything the user says from ${state.sourceLanguage} to ${state.targetLanguage}.
      - Speak the translation immediately in ${state.targetLanguage}.
      - Do not add conversational filler.
      - Provide text transcriptions for both input and output.`;

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: selectedVoice } } },
          systemInstruction,
        },
        callbacks: {
          onopen: () => {
            const source = audioCtxRef.current!.createMediaStreamSource(stream);
            const scriptProcessor = audioCtxRef.current!.createScriptProcessor(4096, 1, 1);
            
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmBlob = createBlob(inputData, 16000);
              
              // Volume analysis
              let sum = 0;
              for(let i=0; i<inputData.length; i++) sum += Math.abs(inputData[i]);
              setMicLevel(Math.min(100, (sum / inputData.length) * 1000));

              sessionPromise.then(s => s.sendRealtimeInput({ media: pcmBlob }));
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(audioCtxRef.current!.destination);
          },
          onmessage: async (m: LiveServerMessage) => {
            const audioData = m.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (audioData) {
              const outCtx = outputAudioCtxRef.current!;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, outCtx.currentTime);
              const audioBuffer = await decodeAudioData(decode(audioData), outCtx, 24000, 1);
              const source = outCtx.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(outCtx.destination);
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += audioBuffer.duration;
            }

            if (m.serverContent?.inputTranscription) {
              setState(prev => ({ ...prev, sourceText: prev.sourceText + ' ' + m.serverContent!.inputTranscription!.text }));
            }
            if (m.serverContent?.outputTranscription) {
              setState(prev => ({ ...prev, translatedText: prev.translatedText + ' ' + m.serverContent!.outputTranscription!.text }));
            }
          },
          onerror: (e) => { console.error('Live Error:', e); stopLiveSession(); },
          onclose: () => stopLiveSession(),
        }
      });
      sessionPromiseRef.current = sessionPromise;
    } catch (err) {
      console.error('Mic Access Error:', err);
      stopLiveSession();
      setState(prev => ({ ...prev, error: 'Microphone access denied or service unavailable.' }));
    }
  };

  const stopLiveSession = () => {
    setIsLiveMode(false);
    setMicLevel(0);
    if (listeningIntervalRef.current) clearInterval(listeningIntervalRef.current);
    streamRef.current?.getTracks().forEach(t => t.stop());
    audioCtxRef.current?.close().catch(() => {});
    outputAudioCtxRef.current?.close().catch(() => {});
    sessionPromiseRef.current?.then(s => s.close()).catch(() => {});
    
    if (state.sourceText && state.translatedText) {
      saveToHistory(state.sourceText, state.translatedText);
    }
  };

  const completedJobsCount = sentenceJobs.filter(j => j.status === 'done' || j.status === 'error').length;
  const progressPercent = sentenceJobs.length > 0 ? (completedJobsCount / sentenceJobs.length) * 100 : 0;

  return (
    <div className="space-y-6">
      <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center space-x-2 flex-1 min-w-[320px]">
          <div className="relative flex-1">
            <select
              ref={languageSelectRef}
              value={state.sourceLanguage}
              onChange={(e) => { setIsAutoDetect(false); setState(prev => ({ ...prev, sourceLanguage: e.target.value as Language })); }}
              className={`w-full bg-slate-50 border rounded-lg px-3 py-2 text-sm font-semibold focus:ring-2 focus:ring-indigo-500 outline-none cursor-pointer transition-all ${isAutoDetect ? 'border-indigo-400' : 'border-slate-300'}`}
            >
              {ALL_LANGUAGES.map(lang => <option key={`src-${lang}`} value={lang}>{lang}</option>)}
            </select>
            {isAutoDetect && (lastDetectedLanguage || isDetecting) && !isLiveMode && (
              <div className="absolute -top-7 left-0 animate-in slide-in-from-bottom-2 duration-300">
                <div className="flex items-center space-x-1.5 bg-indigo-600/95 backdrop-blur-sm text-white text-[9px] font-black px-2 py-0.5 rounded shadow-lg uppercase tracking-wider">
                  {isDetecting ? <i className="fa-solid fa-wand-magic-sparkles animate-pulse"></i> : <i className="fa-solid fa-sparkles"></i>}
                  <span>{isDetecting ? 'Analyzing...' : `Detected: ${lastDetectedLanguage}`}</span>
                  {!isDetecting && <button onClick={handleCorrectDetection} className="ml-1.5 pl-1.5 border-l border-indigo-400 hover:text-indigo-200">Wrong?</button>}
                </div>
              </div>
            )}
          </div>
          <button
            onClick={() => { setIsAutoDetect(false); setState(prev => ({ ...prev, sourceLanguage: prev.targetLanguage, targetLanguage: prev.sourceLanguage })); }}
            className="w-10 h-10 rounded-full hover:bg-indigo-50 text-slate-400 hover:text-indigo-600 transition-all flex items-center justify-center border border-slate-200 bg-white active:scale-90"
          >
            <i className="fa-solid fa-right-left text-xs"></i>
          </button>
          <select
            value={state.targetLanguage}
            onChange={(e) => setState(prev => ({ ...prev, targetLanguage: e.target.value as Language }))}
            className="flex-1 bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-sm font-semibold focus:ring-2 focus:ring-indigo-500 outline-none cursor-pointer"
          >
            {ALL_LANGUAGES.map(lang => <option key={`trg-${lang}`} value={lang}>{lang}</option>)}
          </select>
        </div>

        <div className="flex items-center space-x-2">
          <div className="flex bg-slate-100 p-1 rounded-xl border border-slate-200">
            <button onClick={() => setIsAutoDetect(true)} className={`px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-tight transition-all flex items-center space-x-1.5 ${isAutoDetect ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
              <i className="fa-solid fa-wand-sparkles"></i><span>Auto</span>
            </button>
            <button onClick={() => setIsAutoDetect(false)} className={`px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-tight transition-all flex items-center space-x-1.5 ${!isAutoDetect ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
              <i className="fa-solid fa-hand"></i><span>Manual</span>
            </button>
          </div>
          <button onClick={() => setIsAutoPlayEnabled(!isAutoPlayEnabled)} className={`w-10 h-10 rounded-lg flex items-center justify-center transition-all ${isAutoPlayEnabled ? 'bg-indigo-600 text-white shadow-inner' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}>
            <i className={`fa-solid ${isAutoPlayEnabled ? 'fa-volume-high' : 'fa-volume-xmark'}`}></i>
          </button>
          <button onClick={() => setIsVoicePanelOpen(!isVoicePanelOpen)} className={`w-10 h-10 rounded-lg flex items-center justify-center transition-all relative ${isVoicePanelOpen ? 'bg-indigo-600 text-white shadow-inner' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}>
            <i className="fa-solid fa-sliders"></i>
            {isAutoPlayEnabled && !isVoicePanelOpen && <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 bg-indigo-500 rounded-full border border-white"></span>}
          </button>
          <button onClick={() => setShowHistory(!showHistory)} className={`w-10 h-10 rounded-lg flex items-center justify-center transition-all ${showHistory ? 'bg-indigo-600 text-white shadow-inner' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}>
            <i className="fa-solid fa-clock-rotate-left"></i>
          </button>
        </div>
      </div>

      {isVoicePanelOpen && (
        <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-xl animate-in slide-in-from-top-2">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="space-y-2">
              <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Voice Profile</label>
              <select value={selectedVoice} onChange={(e) => setSelectedVoice(e.target.value)} className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-xs font-semibold">
                {AVAILABLE_VOICES.map(v => <option key={v.id} value={v.id}>{v.label} ({v.desc})</option>)}
              </select>
            </div>
            <div className="space-y-2">
              <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Speed: {speechRate}x</label>
              <input type="range" min="0.5" max="2.0" step="0.1" value={speechRate} onChange={(e) => setSpeechRate(parseFloat(e.target.value))} className="w-full h-1.5 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-indigo-600" />
            </div>
            <div className="flex items-center justify-center pt-2">
              <label className="flex items-center space-x-3 cursor-pointer group">
                <span className="text-xs text-slate-600 font-bold group-hover:text-indigo-600 transition-colors">Speak Automatically</span>
                <input type="checkbox" checked={isAutoPlayEnabled} onChange={(e) => setIsAutoPlayEnabled(e.target.checked)} className="w-4 h-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" />
              </label>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Source Panel */}
        <div className={`bg-white rounded-3xl border shadow-sm overflow-hidden flex flex-col min-h-[420px] transition-all duration-500 ${isLiveMode ? 'border-indigo-500 shadow-indigo-100 ring-4 ring-indigo-500/10' : 'border-slate-200'}`}>
          <div className="p-4 border-b flex items-center justify-between bg-slate-50/50">
            <div className="flex items-center space-x-2">
              <span className="text-xs font-bold text-slate-500 uppercase tracking-widest">{state.sourceLanguage}</span>
              {isLiveMode && (
                <div className="flex items-center space-x-2 bg-indigo-100 px-2 py-0.5 rounded-full animate-pulse">
                  <div className="w-1.5 h-1.5 bg-indigo-600 rounded-full"></div>
                  <span className="text-[9px] font-black text-indigo-700 uppercase">Live Interpreter Active</span>
                </div>
              )}
            </div>
          </div>
          <div className="flex-1 p-6 relative">
            <textarea 
              value={state.sourceText} 
              onChange={(e) => setState(prev => ({ ...prev, sourceText: e.target.value }))} 
              placeholder={isLiveMode ? "Speak now..." : "Enter text to translate..."} 
              readOnly={isLiveMode}
              className={`w-full h-full text-lg text-slate-800 placeholder:text-slate-300 resize-none outline-none bg-transparent leading-relaxed ${isLiveMode ? 'italic' : ''}`} 
            />
            {isLiveMode && (
              <div className="absolute bottom-6 right-6 flex items-end space-x-1 h-8">
                {[...Array(5)].map((_, i) => (
                  <div key={i} className="w-1 bg-indigo-400 rounded-full transition-all duration-100" style={{ height: `${Math.max(20, Math.random() * micLevel)}%` }}></div>
                ))}
              </div>
            )}
          </div>
          <div className="p-4 bg-slate-50 border-t flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <button onClick={() => setState(prev => ({ ...prev, sourceText: '' }))} className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-red-500 transition-colors"><i className="fa-solid fa-trash-can text-sm"></i></button>
              <button 
                onClick={toggleLiveInterpreter} 
                className={`flex items-center space-x-2 px-5 py-2 rounded-full text-xs font-black uppercase tracking-wider transition-all shadow-sm ${
                  isLiveMode 
                  ? 'bg-red-600 text-white animate-pulse hover:bg-red-700' 
                  : 'bg-indigo-600 text-white hover:bg-indigo-700 hover:scale-105 active:scale-95'
                }`}
              >
                <i className={`fa-solid ${isLiveMode ? 'fa-stop-circle' : 'fa-microphone-lines'}`}></i>
                <span>{isLiveMode ? `Stop (${listeningTimeLeft}s)` : 'Live Interpreter'}</span>
              </button>
            </div>
            {!isLiveMode && (
              <button 
                onClick={handleTranslate} 
                disabled={state.isLoading || !state.sourceText.trim()} 
                className="px-8 py-3 rounded-xl font-bold text-sm transition-all shadow-lg active:scale-95 disabled:opacity-50 flex items-center gradient-bg text-white"
              >
                {state.isLoading ? <i className="fa-solid fa-circle-notch fa-spin mr-2"></i> : <i className="fa-solid fa-language mr-2"></i>}
                {splitIntoSentences(state.sourceText).length > 1 ? 'Translate All' : 'Translate'}
              </button>
            )}
          </div>
        </div>

        {/* Output Panel */}
        <div className="bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden flex flex-col min-h-[420px]">
          <div className="p-4 border-b flex items-center justify-between bg-slate-50/50">
            <div className="flex items-center space-x-2">
              <span className="text-xs font-bold text-slate-500 uppercase tracking-widest">{state.targetLanguage}</span>
              {isSequentialMode && state.isLoading && (
                 <span className="bg-indigo-600 text-white text-[9px] font-black px-2 py-0.5 rounded flex items-center space-x-1 animate-pulse">
                  <i className="fa-solid fa-layer-group text-[7px]"></i><span>FAST CHUNKED MODE</span>
                </span>
              )}
            </div>
          </div>
          
          {isSequentialMode && state.isLoading && (
            <div className="h-1 w-full bg-slate-100 overflow-hidden">
              <div 
                className="h-full gradient-bg transition-all duration-500 ease-out" 
                style={{ width: `${progressPercent}%` }}
              ></div>
            </div>
          )}

          <div className="flex-1 p-6 overflow-y-auto">
            {state.isLoading && isSequentialMode ? (
               <div className="space-y-4 animate-in fade-in">
                  <div className="flex items-center justify-between mb-4">
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">
                      Processing Sentences ({completedJobsCount}/{sentenceJobs.length})
                    </p>
                    <span className="text-[10px] font-bold text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded-full">{Math.round(progressPercent)}% COMPLETE</span>
                  </div>
                  <div className="space-y-3">
                    {sentenceJobs.map((job, idx) => (
                      <div key={idx} className={`p-4 rounded-2xl border transition-all duration-300 ${
                        job.status === 'translating' ? 'bg-indigo-50 border-indigo-100 shadow-sm scale-[1.01]' : 
                        job.status === 'done' ? 'bg-slate-50 border-slate-100 opacity-80' : 
                        job.status === 'error' ? 'bg-red-50 border-red-100' : 'bg-white border-transparent opacity-30'
                      }`}>
                        <div className="flex items-start justify-between">
                          <p className="text-sm text-slate-700 font-medium line-clamp-2 pr-4">{job.source}</p>
                          <div className="flex-shrink-0 mt-0.5">
                            {job.status === 'translating' && <i className="fa-solid fa-circle-notch fa-spin text-indigo-500 text-xs"></i>}
                            {job.status === 'done' && <i className="fa-solid fa-check-circle text-emerald-500 text-xs"></i>}
                            {job.status === 'error' && <i className="fa-solid fa-circle-exclamation text-red-500 text-xs"></i>}
                          </div>
                        </div>
                        {job.translated && (
                          <p className="text-xs text-indigo-600 mt-2 pt-2 border-t border-indigo-100/50 italic font-medium animate-in slide-in-from-left-2">{job.translated}</p>
                        )}
                      </div>
                    ))}
                  </div>
               </div>
            ) : (state.isLoading && !isSequentialMode) ? (
               <div className="h-full flex flex-col items-center justify-center space-y-4">
                 <div className="w-16 h-1 bg-slate-100 rounded-full overflow-hidden"><div className="w-full h-full gradient-bg animate-loading-bar"></div></div>
                 <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Single Pass Translation...</p>
               </div>
            ) : state.translatedText ? (
              <div className="space-y-6 animate-in fade-in duration-500">
                <p className="text-2xl text-indigo-950 leading-relaxed font-medium tracking-tight whitespace-pre-wrap">{state.translatedText}</p>
                {showGuide && (
                  <div className="bg-indigo-50/50 p-5 rounded-2xl border border-indigo-100 animate-in slide-in-from-top-4">
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center space-x-2"><span className="bg-indigo-600 text-white text-[9px] font-black px-2 py-0.5 rounded">IPA</span><span className="text-[10px] font-bold text-indigo-400 uppercase tracking-widest">Phonetic Assist</span></div>
                      <button onClick={() => setShowGuide(false)} className="text-indigo-300 hover:text-indigo-500"><i className="fa-solid fa-times text-xs"></i></button>
                    </div>
                    {isGeneratingGuide ? <div className="space-y-2"><div className="h-3 bg-indigo-100/50 rounded animate-pulse w-full"></div><div className="h-3 bg-indigo-100/50 rounded animate-pulse w-2/3"></div></div> : <p className="text-sm font-mono text-slate-600 italic">{state.pronunciationGuide || 'Guide unavailable'}</p>}
                  </div>
                )}
              </div>
            ) : state.error && !isOnline ? (
              <div className="h-full flex flex-col items-center justify-center text-center p-6 space-y-6 animate-in zoom-in-95">
                 <div className="w-20 h-20 bg-amber-50 text-amber-500 rounded-full flex items-center justify-center shadow-inner">
                    <i className="fa-solid fa-book-open text-3xl"></i>
                 </div>
                 <div className="space-y-3">
                   <h4 className="font-extrabold text-slate-800 text-lg">Translation Unavailable Offline</h4>
                   <p className="text-sm text-slate-500 leading-relaxed max-w-xs mx-auto">{state.error}</p>
                   <div className="bg-slate-50 p-4 rounded-xl border border-slate-100 text-left space-y-2 max-w-xs mx-auto">
                      <p className="text-[10px] font-black uppercase text-slate-400 tracking-wider flex items-center">
                        <i className="fa-solid fa-lightbulb mr-2 text-amber-500"></i>Next Steps
                      </p>
                      <ul className="text-xs text-slate-600 space-y-1.5 list-disc list-inside px-1">
                        <li>Try shorter, basic words</li>
                        <li>Check your network connection</li>
                        <li>Switch to an online network for full AI power</li>
                      </ul>
                   </div>
                 </div>
                 {showOfflineSuggestions && (
                   <div className="space-y-3 w-full animate-in fade-in slide-in-from-bottom-4">
                      <p className="text-[10px] font-black text-indigo-500 uppercase tracking-widest">Try a Common Phrase</p>
                      <div className="flex flex-wrap justify-center gap-2 max-w-md mx-auto">
                        {getOfflineSuggestions().map(phrase => (
                          <button 
                            key={`suggest-${phrase}`} 
                            onClick={() => { setState(prev => ({ ...prev, sourceText: phrase })); handleTranslate(); }}
                            className="px-3 py-2 bg-white hover:bg-indigo-600 text-slate-600 hover:text-white rounded-xl text-xs font-bold border border-slate-200 shadow-sm transition-all active:scale-95"
                          >
                            {phrase}
                          </button>
                        ))}
                      </div>
                   </div>
                 )}
              </div>
            ) : (
              <div className="h-full flex flex-col items-center justify-center text-slate-200">
                <i className="fa-solid fa-language text-6xl mb-4 opacity-10"></i>
                <p className="text-sm font-bold tracking-widest uppercase text-slate-300">Awaiting input</p>
              </div>
            )}
          </div>
          
          <div className="p-4 bg-slate-50 border-t flex items-center space-x-2">
            {state.translatedText && !isLiveMode && (
              <>
                <button onClick={() => handleSpeak(state.translatedText)} disabled={!isOnline} className={`w-11 h-11 rounded-xl flex items-center justify-center transition-all ${isSpeaking ? 'bg-indigo-600 text-white shadow-lg' : 'bg-white border border-slate-200 text-slate-500 hover:bg-slate-100'}`}><i className={`fa-solid ${isSpeaking ? 'fa-stop' : 'fa-volume-high'} text-lg`}></i></button>
                <button onClick={handleGenerateGuide} disabled={!isOnline} className={`px-5 h-11 rounded-xl flex items-center justify-center space-x-2 transition-all border font-bold text-[10px] uppercase tracking-wider ${showGuide ? 'bg-indigo-50 border-indigo-200 text-indigo-600' : 'bg-white border-slate-200 text-slate-500 hover:bg-slate-100 shadow-sm'}`}><i className="fa-solid fa-spell-check text-xs"></i><span>How to Say</span></button>
                <button onClick={() => navigator.clipboard.writeText(state.translatedText)} className="w-11 h-11 rounded-xl bg-white border border-slate-200 text-slate-500 hover:bg-slate-100 flex items-center justify-center transition-all"><i className="fa-solid fa-copy"></i></button>
              </>
            )}
          </div>
        </div>
      </div>

      {state.error && isOnline && (
        <div className="bg-red-50 border border-red-100 p-4 rounded-2xl flex items-start text-red-600 text-sm animate-in slide-in-from-top-1 shadow-sm">
          <i className="fa-solid fa-triangle-exclamation mr-3 mt-1 text-red-400"></i>
          <p className="flex-1 font-medium">{state.error}</p>
          <button onClick={() => setState(prev => ({ ...prev, error: null }))} className="text-red-400 hover:text-red-600 ml-4 transition-colors"><i className="fa-solid fa-xmark"></i></button>
        </div>
      )}
    </div>
  );
};

export default TextTranslator;
