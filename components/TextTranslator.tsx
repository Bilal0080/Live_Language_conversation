
import React, { useState, useRef, useEffect, useMemo } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage } from '@google/genai';
import { Language, TranslationState, HistoryItem, ALL_LANGUAGES } from '../types';
import { decode, decodeAudioData, createBlob } from '../utils/audioUtils';
import { parseApiError } from '../utils/errorUtils';

const SAMPLE_RATES = [
  { value: 16000, label: '16kHz (Standard)' },
  { value: 24000, label: '24kHz (High)' },
  { value: 44100, label: '44.1kHz (CD)' },
  { value: 48000, label: '48kHz (Pro)' },
];

const AVAILABLE_VOICES = [
  { id: 'Zephyr', label: 'Zephyr', desc: 'Balanced & Natural' },
  { id: 'Puck', label: 'Puck', desc: 'Bright & Energetic' },
  { id: 'Charon', label: 'Charon', desc: 'Deep & Authoritative' },
  { id: 'Kore', label: 'Kore', desc: 'Clear & Soft' },
  { id: 'Fenrir', label: 'Fenrir', desc: 'Warm & Solid' },
];

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

  const [isListening, setIsListening] = useState(false);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [historySearchQuery, setHistorySearchQuery] = useState('');
  
  const [voiceSampleRate, setVoiceSampleRate] = useState<number>(() => {
    const saved = localStorage.getItem('lingua_voice_sample_rate');
    return saved ? parseInt(saved, 10) : 16000;
  });
  
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
  const [isAutoDetect, setIsAutoDetect] = useState(false);
  const [isDetecting, setIsDetecting] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isGeneratingGuide, setIsGeneratingGuide] = useState(false);
  const [showGuide, setShowGuide] = useState(false);

  const [isBatchMode, setIsBatchMode] = useState(false);
  const [batchProgress, setBatchProgress] = useState({ current: 0, total: 0 });
  const [isBatchActive, setIsBatchActive] = useState(false);
  const [isBatchPaused, setIsBatchPaused] = useState(false);
  
  const audioCtxRef = useRef<AudioContext | null>(null);
  const ttsAudioCtxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sessionPromiseRef = useRef<Promise<any> | null>(null);
  const detectionTimerRef = useRef<number | null>(null);
  const isBatchCancelledRef = useRef(false);
  const isBatchPausedRef = useRef(false);
  const ttsSourceRef = useRef<AudioBufferSourceNode | null>(null);

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
    localStorage.setItem('lingua_voice_sample_rate', voiceSampleRate.toString());
  }, [voiceSampleRate]);

  useEffect(() => {
    localStorage.setItem('lingua_speech_rate', speechRate.toString());
  }, [speechRate]);

  useEffect(() => {
    localStorage.setItem('lingua_selected_voice', selectedVoice);
  }, [selectedVoice]);

  useEffect(() => {
    localStorage.setItem('lingua_auto_play', isAutoPlayEnabled.toString());
  }, [isAutoPlayEnabled]);

  const filteredHistory = useMemo(() => {
    if (!historySearchQuery.trim()) return history;
    const query = historySearchQuery.toLowerCase();
    return history.filter(item => 
      item.sourceText.toLowerCase().includes(query) || 
      item.translatedText.toLowerCase().includes(query)
    );
  }, [history, historySearchQuery]);

  useEffect(() => {
    if (!isAutoDetect || !state.sourceText.trim() || state.sourceText.length < 5) {
      setIsDetecting(false);
      return;
    }

    if (detectionTimerRef.current) {
      window.clearTimeout(detectionTimerRef.current);
    }

    detectionTimerRef.current = window.setTimeout(async () => {
      setIsDetecting(true);
      try {
        const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
        const response = await ai.models.generateContent({
          model: 'gemini-3-flash-preview',
          contents: `Identify the language of the following text. Respond ONLY with exactly one word from this list: ${ALL_LANGUAGES.join(', ')}. If you are uncertain, respond with the most likely one. \n\nText: ${state.sourceText.substring(0, 200)}`,
          config: {
            temperature: 0,
            topP: 1,
          }
        });

        const detected = response.text?.trim() as Language;
        if (detected && ALL_LANGUAGES.includes(detected) && detected !== state.sourceLanguage) {
          setState(prev => ({ ...prev, sourceLanguage: detected }));
        }
      } catch (err) {
        console.error('Language detection failed:', err);
      } finally {
        setIsDetecting(false);
      }
    }, 1000);

    return () => {
      if (detectionTimerRef.current) window.clearTimeout(detectionTimerRef.current);
    };
  }, [state.sourceText, isAutoDetect, state.sourceLanguage]);

  const handleTranslate = async () => {
    if (!state.sourceText.trim()) return;

    if (isBatchMode) {
      startBatchTranslation();
      return;
    }

    setState(prev => ({ ...prev, isLoading: true, error: null, translatedText: '', pronunciationGuide: '' }));
    setShowGuide(false);

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: `Translate the following ${state.sourceLanguage} text into ${state.targetLanguage}. Output ONLY the translated text.\n\nText: ${state.sourceText}`,
        config: {
          temperature: 0.3,
          topP: 1,
        }
      });

      const translated = response.text || '';
      setState(prev => ({
        ...prev,
        translatedText: translated,
        isLoading: false
      }));

      saveToHistory(state.sourceText, translated);

      if (isAutoPlayEnabled && translated) {
        handleSpeak(translated);
      }
    } catch (err: any) {
      console.error(err);
      setState(prev => ({
        ...prev,
        isLoading: false,
        error: parseApiError(err)
      }));
    }
  };

  const handleGenerateGuide = async () => {
    if (!state.translatedText || isGeneratingGuide) return;
    
    setIsGeneratingGuide(true);
    setShowGuide(true);
    setState(prev => ({ ...prev, error: null }));
    
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
      
      let formatInstructions = 'IPA (International Phonetic Alphabet)';
      if (state.targetLanguage === 'Chinese') formatInstructions = 'Pinyin with tone marks';
      else if (state.targetLanguage === 'Japanese') formatInstructions = 'Romaji';
      else if (state.targetLanguage === 'Korean') formatInstructions = 'Revised Romanization';
      else if (state.targetLanguage === 'Urdu') formatInstructions = 'Romanized Urdu (Transliteration)';
      else formatInstructions = 'IPA (International Phonetic Alphabet)';
      
      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: `Generate a clear pronunciation guide for this ${state.targetLanguage} text: "${state.translatedText}". 
          Use ${formatInstructions}. 
          Output ONLY the guide text, no headers or extra explanation. If it's a long text, maintain the structure.`,
        config: { temperature: 0.1 }
      });

      setState(prev => ({ ...prev, pronunciationGuide: response.text || '' }));
    } catch (err) {
      console.error('Failed to generate pronunciation guide:', err);
      setState(prev => ({ ...prev, error: parseApiError(err) }));
    } finally {
      setIsGeneratingGuide(false);
    }
  };

  const handleSpeak = async (textToSpeak?: string) => {
    const text = textToSpeak || state.translatedText;
    
    if (isSpeaking) {
      stopSpeaking();
      if (!textToSpeak) return; 
    }

    if (!text) return;

    setIsSpeaking(true);
    setState(prev => ({ ...prev, error: null }));
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash-preview-tts',
        contents: [{ parts: [{ text: `Please read this ${state.targetLanguage} text naturally: ${text}` }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: selectedVoice },
            },
          },
        },
      });

      const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (base64Audio) {
        if (!ttsAudioCtxRef.current) {
          ttsAudioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
        }
        const ctx = ttsAudioCtxRef.current;
        if (ctx.state === 'suspended') await ctx.resume();

        const audioBuffer = await decodeAudioData(decode(base64Audio), ctx, 24000, 1);
        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;
        
        source.playbackRate.value = speechRate;
        
        source.connect(ctx.destination);
        source.onended = () => {
          setIsSpeaking(false);
          ttsSourceRef.current = null;
        };

        ttsSourceRef.current = source;
        source.start();
      } else {
        setIsSpeaking(false);
        throw new Error("No audio data returned from the service.");
      }
    } catch (err) {
      console.error('TTS failed:', err);
      setIsSpeaking(false);
      setState(prev => ({ ...prev, error: parseApiError(err) }));
    }
  };

  const stopSpeaking = () => {
    if (ttsSourceRef.current) {
      try {
        ttsSourceRef.current.stop();
      } catch (e) {}
      ttsSourceRef.current = null;
    }
    setIsSpeaking(false);
  };

  const startBatchTranslation = async () => {
    const sentences = state.sourceText.match(/[^.!?。！？\n]+[.!?。！？\n]*/g) || [state.sourceText];
    if (sentences.length === 0) return;

    setIsBatchActive(true);
    setIsBatchPaused(false);
    isBatchPausedRef.current = false;
    isBatchCancelledRef.current = false;
    setBatchProgress({ current: 0, total: sentences.length });
    setState(prev => ({ ...prev, translatedText: '', isLoading: true, error: null, pronunciationGuide: '' }));
    setShowGuide(false);

    let currentResult = '';
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });

    for (let i = 0; i < sentences.length; i++) {
      if (isBatchCancelledRef.current) break;

      while (isBatchPausedRef.current && !isBatchCancelledRef.current) {
        await new Promise(r => setTimeout(r, 500));
      }
      if (isBatchCancelledRef.current) break;

      try {
        const response = await ai.models.generateContent({
          model: 'gemini-3-flash-preview',
          contents: `Translate this single sentence from ${state.sourceLanguage} to ${state.targetLanguage}: "${sentences[i].trim()}"`,
          config: { temperature: 0.1 }
        });

        const translatedSentence = response.text || '';
        currentResult += translatedSentence + ' ';
        
        setBatchProgress({ current: i + 1, total: sentences.length });
        setState(prev => ({ ...prev, translatedText: currentResult.trim() }));
      } catch (err) {
        console.error('Batch error at sentence', i, err);
        setState(prev => ({ ...prev, error: `Batch processing failed at sentence ${i+1}: ${parseApiError(err)}` }));
        break;
      }
    }

    if (!isBatchCancelledRef.current && !state.error) {
      saveToHistory(state.sourceText, currentResult.trim());
      if (isAutoPlayEnabled && currentResult.trim()) {
        handleSpeak(currentResult.trim());
      }
    }

    setIsBatchActive(false);
    setState(prev => ({ ...prev, isLoading: false }));
  };

  const togglePauseBatch = () => {
    const newVal = !isBatchPaused;
    setIsBatchPaused(newVal);
    isBatchPausedRef.current = newVal;
  };

  const cancelBatch = () => {
    isBatchCancelledRef.current = true;
    setIsBatchActive(false);
    setIsBatchPaused(false);
    isBatchPausedRef.current = false;
    setState(prev => ({ ...prev, isLoading: false }));
  };

  const saveToHistory = (source: string, translated: string) => {
    const newItem: HistoryItem = {
      id: crypto.randomUUID(),
      sourceText: source,
      translatedText: translated,
      sourceLanguage: state.sourceLanguage,
      targetLanguage: state.targetLanguage,
      timestamp: Date.now(),
      voice: selectedVoice,
      speechRate: speechRate,
    };
    setHistory(prev => [newItem, ...prev].slice(0, 50));
  };

  const swapLanguages = () => {
    setIsAutoDetect(false);
    setState(prev => ({
      ...prev,
      sourceLanguage: prev.targetLanguage,
      targetLanguage: prev.sourceLanguage,
      sourceText: prev.translatedText,
      translatedText: prev.sourceText,
      pronunciationGuide: '',
      error: null
    }));
    setShowGuide(false);
  };

  const startListening = async () => {
    if (isListening) {
      stopListening();
      return;
    }

    setState(prev => ({ ...prev, error: null }));
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const rate = voiceSampleRate;
      audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: rate });
      
      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {},
          systemInstruction: `You are a transcription assistant. The user is speaking ${state.sourceLanguage}. Transcribe their speech accurately. Do not respond with audio.`,
        },
        callbacks: {
          onopen: () => {
            setIsListening(true);
            const source = audioCtxRef.current!.createMediaStreamSource(stream);
            const scriptProcessor = audioCtxRef.current!.createScriptProcessor(4096, 1, 1);
            
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmBlob = createBlob(inputData, rate);
              sessionPromise.then((session) => {
                session.sendRealtimeInput({ media: pcmBlob });
              });
            };

            source.connect(scriptProcessor);
            scriptProcessor.connect(audioCtxRef.current!.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            if (message.serverContent?.inputTranscription) {
              const text = message.serverContent.inputTranscription.text;
              setState(prev => ({
                ...prev,
                sourceText: prev.sourceText + text
              }));
            }
          },
          onerror: (e) => {
            console.error('Transcription error:', e);
            setState(prev => ({ ...prev, error: `Transcription failed: ${parseApiError(e)}` }));
            stopListening();
          },
          onclose: () => {
            stopListening();
          }
        }
      });

      sessionPromiseRef.current = sessionPromise;
    } catch (err) {
      console.error('Failed to start transcription:', err);
      setState(prev => ({ ...prev, error: parseApiError(err) }));
      stopListening();
    }
  };

  const stopListening = () => {
    setIsListening(false);
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close();
      audioCtxRef.current = null;
    }
    if (sessionPromiseRef.current) {
      sessionPromiseRef.current.then(session => session.close());
      sessionPromiseRef.current = null;
    }
  };

  const selectHistoryItem = (item: HistoryItem) => {
    setIsAutoDetect(false);
    setState({
      sourceText: item.sourceText,
      translatedText: item.translatedText,
      sourceLanguage: item.sourceLanguage,
      targetLanguage: item.targetLanguage,
      isLoading: false,
      error: null,
      pronunciationGuide: '',
    });

    if (item.voice) {
      setSelectedVoice(item.voice);
    }
    if (item.speechRate !== undefined) {
      setSpeechRate(item.speechRate);
    }

    setShowGuide(false);
    setShowHistory(false);
    setHistorySearchQuery('');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const deleteHistoryItem = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setHistory(prev => prev.filter(item => item.id !== id));
  };

  const clearHistory = () => {
    if (window.confirm('Are you sure you want to clear your translation history?')) {
      setHistory([]);
    }
  };

  useEffect(() => {
    return () => {
      stopListening();
      stopSpeaking();
      if (detectionTimerRef.current) window.clearTimeout(detectionTimerRef.current);
      if (ttsAudioCtxRef.current) ttsAudioCtxRef.current.close();
    };
  }, []);

  const progressPercent = batchProgress.total > 0 
    ? Math.round((batchProgress.current / batchProgress.total) * 100) 
    : 0;

  return (
    <div className="space-y-6 relative">
      <div className="bg-white rounded-2xl shadow-xl overflow-hidden border border-slate-200">
        <div className="p-4 bg-slate-50 border-b flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-center space-x-2">
            <div className="flex items-center">
              <select 
                value={state.sourceLanguage}
                onChange={(e) => {
                  setIsAutoDetect(false);
                  setState(prev => ({ ...prev, sourceLanguage: e.target.value as Language }));
                }}
                className={`bg-white border border-slate-300 rounded-l-lg px-3 py-2 text-sm font-medium focus:ring-2 focus:ring-indigo-500 outline-none cursor-pointer hover:border-indigo-300 transition-colors ${isAutoDetect ? 'border-indigo-500 bg-indigo-50/30' : ''}`}
              >
                {ALL_LANGUAGES.map(lang => (
                  <option key={`source-${lang}`} value={lang}>{lang}</option>
                ))}
              </select>
              <button
                onClick={() => setIsAutoDetect(!isAutoDetect)}
                className={`px-3 py-2 border-y border-r border-slate-300 rounded-r-lg text-[10px] font-bold uppercase transition-all flex items-center space-x-1.5 ${
                  isAutoDetect 
                  ? 'bg-indigo-600 text-white border-indigo-600' 
                  : 'bg-white text-slate-400 hover:bg-slate-50'
                }`}
                title="Toggle Auto-detect Language"
              >
                {isDetecting ? (
                  <i className="fa-solid fa-wand-sparkles animate-pulse"></i>
                ) : (
                  <i className="fa-solid fa-magnifying-glass"></i>
                )}
                <span>Auto</span>
              </button>
            </div>
            
            <button 
              onClick={swapLanguages}
              className="w-10 h-10 rounded-full hover:bg-indigo-50 text-slate-400 hover:text-indigo-600 transition-all flex items-center justify-center border border-slate-200 bg-white shadow-sm active:scale-95"
              title="Swap Languages"
            >
              <i className="fa-solid fa-right-left text-sm"></i>
            </button>

            <select 
              value={state.targetLanguage}
              onChange={(e) => setState(prev => ({ ...prev, targetLanguage: e.target.value as Language }))}
              className="bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm font-medium focus:ring-2 focus:ring-indigo-500 outline-none cursor-pointer hover:border-indigo-300 transition-colors"
            >
              {ALL_LANGUAGES.map(lang => (
                <option key={`target-${lang}`} value={lang}>{lang}</option>
              ))}
            </select>
          </div>

          <div className="flex items-center space-x-2">
            <button
              onClick={() => setIsBatchMode(!isBatchMode)}
              className={`px-3 py-2 rounded-lg text-xs font-bold transition-all border ${
                isBatchMode ? 'bg-amber-50 text-amber-600 border-amber-200' : 'bg-slate-100 text-slate-500 border-transparent hover:bg-slate-200'
              }`}
              title="Sentence-by-Sentence Mode"
            >
              <i className="fa-solid fa-list-ol mr-2"></i>
              Step-by-Step
            </button>
            
            <button
              onClick={() => setIsVoicePanelOpen(!isVoicePanelOpen)}
              className={`w-10 h-10 rounded-lg flex items-center justify-center transition-all ${
                isVoicePanelOpen ? 'bg-indigo-600 text-white shadow-md' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
              }`}
              title="Voice & Audio Settings"
            >
              <i className="fa-solid fa-gear"></i>
            </button>

            <button
              onClick={() => setShowHistory(!showHistory)}
              className={`w-10 h-10 rounded-lg flex items-center justify-center transition-all ${
                showHistory ? 'bg-indigo-600 text-white shadow-md' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
              }`}
              title="View History"
            >
              <i className="fa-solid fa-clock-rotate-left"></i>
            </button>
            
            <button 
              onClick={handleTranslate}
              disabled={state.isLoading || !state.sourceText.trim() || isBatchActive}
              className="bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white px-6 py-2 rounded-lg font-bold shadow-md transition-all flex items-center justify-center min-w-[140px]"
            >
              {state.isLoading && !isBatchActive ? (
                <i className="fa-solid fa-circle-notch fa-spin mr-2"></i>
              ) : (
                <i className="fa-solid fa-wand-magic-sparkle mr-2"></i>
              )}
              Translate
            </button>
          </div>
        </div>

        {isVoicePanelOpen && (
          <div className="bg-white border-b border-slate-200 p-6 animate-in slide-in-from-top-2 duration-300">
            <div className="max-w-4xl mx-auto">
              <div className="flex items-center justify-between mb-6">
                <h4 className="text-sm font-bold text-slate-800 flex items-center">
                  <i className="fa-solid fa-sliders mr-2 text-indigo-500"></i>
                  Voice & Audio Preferences
                </h4>
                <button 
                  onClick={() => setIsVoicePanelOpen(false)}
                  className="text-slate-400 hover:text-slate-600 transition-colors"
                >
                  <i className="fa-solid fa-times"></i>
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
                <div className="space-y-3">
                  <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Voice Character</p>
                  <div className="flex flex-col space-y-1">
                    {AVAILABLE_VOICES.map((voice) => (
                      <button
                        key={voice.id}
                        onClick={() => setSelectedVoice(voice.id)}
                        className={`w-full text-left px-4 py-2 rounded-xl text-xs transition-all flex items-center justify-between ${
                          selectedVoice === voice.id 
                          ? 'bg-indigo-600 text-white shadow-md font-bold' 
                          : 'bg-slate-50 text-slate-600 hover:bg-slate-100 border border-transparent'
                        }`}
                      >
                        <div className="flex flex-col">
                          <span>{voice.label}</span>
                          <span className={`text-[9px] opacity-70 ${selectedVoice === voice.id ? 'text-indigo-100' : 'text-slate-400'}`}>
                            {voice.desc}
                          </span>
                        </div>
                        {selectedVoice === voice.id && <i className="fa-solid fa-check text-[10px]"></i>}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-6">
                  <div>
                    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-3">Speech Rate</p>
                    <div className="bg-slate-50 p-4 rounded-2xl border border-slate-100">
                      <div className="flex items-center justify-between mb-2">
                        <i className="fa-solid fa-gauge-high text-xs text-slate-400"></i>
                        <span className="text-xs font-bold text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded">{speechRate.toFixed(1)}x</span>
                      </div>
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

                  <div>
                    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-3">Behavior</p>
                    <label className="flex items-center justify-between p-3 bg-slate-50 rounded-xl border border-slate-100 cursor-pointer hover:bg-slate-100 transition-colors">
                      <div className="flex items-center space-x-3">
                        <i className="fa-solid fa-play-circle text-indigo-500"></i>
                        <span className="text-xs font-semibold text-slate-700">Auto-play Translation</span>
                      </div>
                      <div className="relative">
                        <input 
                          type="checkbox" 
                          className="sr-only" 
                          checked={isAutoPlayEnabled} 
                          onChange={() => setIsAutoPlayEnabled(!isAutoPlayEnabled)}
                        />
                        <div className={`block w-8 h-5 rounded-full transition-colors ${isAutoPlayEnabled ? 'bg-indigo-600' : 'bg-slate-300'}`}></div>
                        <div className={`dot absolute left-1 top-1 bg-white w-3 h-3 rounded-full transition-transform ${isAutoPlayEnabled ? 'translate-x-3' : ''}`}></div>
                      </div>
                    </label>
                  </div>
                </div>

                <div className="space-y-3">
                  <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Audio Quality (Sample Rate)</p>
                  <div className="grid grid-cols-1 gap-1.5">
                    {SAMPLE_RATES.map((rate) => (
                      <button
                        key={rate.value}
                        onClick={() => setVoiceSampleRate(rate.value)}
                        className={`text-left px-4 py-2.5 rounded-xl text-xs font-medium transition-all flex items-center justify-between ${
                          voiceSampleRate === rate.value 
                          ? 'bg-indigo-50 text-indigo-700 border-indigo-200 border shadow-sm' 
                          : 'bg-white text-slate-500 border-slate-200 border hover:bg-slate-50'
                        }`}
                      >
                        <span>{rate.label}</span>
                        {voiceSampleRate === rate.value && <i className="fa-solid fa-circle-check text-[10px]"></i>}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {isBatchActive && (
          <div className="bg-indigo-50 px-6 py-4 border-b border-indigo-100 animate-in fade-in slide-in-from-top-2">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center space-x-4">
                <div className="text-indigo-700 font-bold text-sm">
                  {isBatchPaused ? 'Paused' : 'Translating'}: Sentence {batchProgress.current} of {batchProgress.total}
                </div>
                <div className="flex bg-indigo-100 rounded-full h-2 w-48 overflow-hidden">
                  <div 
                    className="bg-indigo-600 h-full transition-all duration-500 ease-out"
                    style={{ width: `${progressPercent}%` }}
                  ></div>
                </div>
                <div className="text-indigo-600 font-bold text-xs">{progressPercent}%</div>
              </div>
              <div className="flex items-center space-x-2">
                <button 
                  onClick={togglePauseBatch}
                  className="px-4 py-1.5 bg-white border border-indigo-200 text-indigo-600 rounded-lg text-xs font-bold hover:bg-indigo-100 transition-colors flex items-center"
                >
                  <i className={`fa-solid ${isBatchPaused ? 'fa-play' : 'fa-pause'} mr-2`}></i>
                  {isBatchPaused ? 'Resume' : 'Pause'}
                </button>
                <button 
                  onClick={cancelBatch}
                  className="px-4 py-1.5 bg-red-50 text-red-600 border border-red-100 rounded-lg text-xs font-bold hover:bg-red-100 transition-colors flex items-center"
                >
                  <i className="fa-solid fa-xmark mr-2"></i>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="grid md:grid-cols-2 divide-y md:divide-y-0 md:divide-x border-slate-200">
          <div className="p-6 relative">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center space-x-2">
                <label className="block text-xs font-bold text-slate-400 uppercase tracking-wider">Source Text ({state.sourceLanguage})</label>
                {isDetecting && (
                  <span className="flex items-center text-[10px] text-indigo-500 animate-pulse font-bold">
                    <i className="fa-solid fa-ellipsis fa-fade mr-1"></i>
                    Detecting...
                  </span>
                )}
              </div>
              
              <div className="flex items-center space-x-2">
                <button
                  onClick={startListening}
                  className={`flex items-center space-x-2 px-3 py-1 rounded-full text-xs font-bold transition-all ${
                    isListening 
                    ? 'bg-red-100 text-red-600 animate-pulse border border-red-200' 
                    : 'bg-indigo-50 text-indigo-600 hover:bg-indigo-100 border border-indigo-100'
                  }`}
                  title={isListening ? "Stop Listening" : "Voice Input"}
                >
                  <i className={`fa-solid ${isListening ? 'fa-stop' : 'fa-microphone'}`}></i>
                  <span>{isListening ? 'Listening...' : 'Voice Input'}</span>
                </button>
              </div>
            </div>
            <textarea
              className="w-full h-48 md:h-64 bg-transparent resize-none focus:outline-none text-lg text-slate-700 placeholder:text-slate-300"
              placeholder={`Enter ${state.sourceLanguage} text...`}
              value={state.sourceText}
              onChange={(e) => setState(prev => ({ ...prev, sourceText: e.target.value }))}
            />
          </div>
          <div className="p-6 bg-slate-50/50 flex flex-col">
            <div className="flex items-center justify-between mb-2">
              <label className="block text-xs font-bold text-slate-400 uppercase tracking-wider">Translation ({state.targetLanguage})</label>
              
              {state.translatedText && (
                <div className="flex items-center space-x-2">
                  <button
                    onClick={handleGenerateGuide}
                    className={`flex items-center space-x-2 px-3 py-1 rounded-full text-xs font-bold transition-all shadow-sm ${
                      showGuide 
                      ? 'bg-indigo-50 text-indigo-600 border border-indigo-200' 
                      : 'bg-white text-slate-500 border border-slate-200 hover:bg-slate-50'
                    }`}
                    title="Pronunciation Guide"
                  >
                    <i className="fa-solid fa-spell-check"></i>
                    <span>Guide</span>
                  </button>

                  <button
                    onClick={() => handleSpeak()}
                    className={`flex items-center space-x-2 px-3 py-1 rounded-full text-xs font-bold transition-all shadow-sm ${
                      isSpeaking 
                      ? 'bg-indigo-600 text-white animate-pulse' 
                      : 'bg-white text-indigo-600 border border-indigo-100 hover:bg-indigo-50'
                    }`}
                    title={isSpeaking ? "Stop Pronunciation" : "Listen to Translation"}
                  >
                    <i className={`fa-solid ${isSpeaking ? 'fa-stop' : 'fa-volume-high'}`}></i>
                    <span>{isSpeaking ? 'Playing...' : 'Pronounce'}</span>
                  </button>
                </div>
              )}
            </div>
            
            <div className="flex-1 overflow-y-auto min-h-[120px] max-h-48 mb-4">
              <div className="text-lg text-slate-800 leading-relaxed">
                {state.translatedText || (
                  <span className="text-slate-300 italic">Translation will appear here...</span>
                )}
              </div>
            </div>

            {showGuide && (
              <div className="bg-indigo-50 border border-indigo-100 rounded-2xl p-4 animate-in fade-in slide-in-from-bottom-2 duration-300 shadow-sm mb-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center space-x-2">
                    <div className="bg-indigo-600 text-white text-[10px] font-black px-2 py-0.5 rounded uppercase tracking-tighter">
                      Guide
                    </div>
                    <span className="text-[10px] font-bold text-indigo-400 uppercase tracking-widest">
                      {state.targetLanguage === 'Chinese' ? 'Pinyin' : 
                       state.targetLanguage === 'Japanese' ? 'Romaji' : 
                       state.targetLanguage === 'Korean' ? 'Romanization' : 'Phonetic IPA'}
                    </span>
                  </div>
                  <div className="flex items-center space-x-2">
                    {state.pronunciationGuide && (
                      <button 
                        onClick={() => {
                          navigator.clipboard.writeText(state.pronunciationGuide || '');
                          const btn = document.getElementById('guide-copy-btn');
                          if (btn) btn.innerHTML = '<i class="fa-solid fa-check"></i>';
                          setTimeout(() => { if (btn) btn.innerHTML = '<i class="fa-regular fa-copy"></i>'; }, 2000);
                        }}
                        id="guide-copy-btn"
                        className="text-[10px] text-indigo-400 hover:text-indigo-600 transition-colors bg-white w-6 h-6 rounded-full flex items-center justify-center border border-indigo-50 shadow-sm"
                        title="Copy Guide"
                      >
                        <i className="fa-regular fa-copy"></i>
                      </button>
                    )}
                    <button 
                      onClick={() => setShowGuide(false)}
                      className="text-indigo-300 hover:text-indigo-500 transition-colors"
                    >
                      <i className="fa-solid fa-xmark text-xs"></i>
                    </button>
                  </div>
                </div>
                <div className="font-mono text-indigo-800 text-sm leading-relaxed bg-white/50 p-3 rounded-xl border border-indigo-50/50">
                  {isGeneratingGuide ? (
                    <div className="flex items-center space-x-3 text-indigo-300 italic animate-pulse">
                      <i className="fa-solid fa-wand-sparkles fa-spin text-xs"></i>
                      <span>Synthesizing guide...</span>
                    </div>
                  ) : (
                    state.pronunciationGuide || <span className="text-indigo-200">No guide generated.</span>
                  )}
                </div>
              </div>
            )}

            {state.error && (
              <div className="mt-4 p-4 bg-red-50 text-red-600 rounded-xl text-sm flex items-start border border-red-100 animate-in shake duration-300">
                <i className="fa-solid fa-circle-exclamation mr-3 mt-0.5 text-red-400"></i>
                <div className="flex-1">
                  <p className="font-bold mb-0.5">Translation Error</p>
                  <p>{state.error}</p>
                </div>
                <button onClick={() => setState(prev => ({ ...prev, error: null }))} className="ml-2 text-red-400 hover:text-red-600 transition-colors">
                  <i className="fa-solid fa-xmark"></i>
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {showHistory && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" onClick={() => setShowHistory(false)}></div>
          <div className="relative w-full max-w-md bg-white h-full shadow-2xl flex flex-col animate-in slide-in-from-right duration-300">
            <div className="p-6 border-b border-slate-100 flex items-center justify-between bg-slate-50">
              <h3 className="text-xl font-bold text-slate-800 flex items-center">
                <i className="fa-solid fa-clock-rotate-left mr-3 text-indigo-600"></i>
                Recent Translations
              </h3>
              <button 
                onClick={() => {
                  setShowHistory(false);
                  setHistorySearchQuery('');
                }}
                className="w-10 h-10 rounded-full hover:bg-slate-200 text-slate-400 transition-colors flex items-center justify-center"
              >
                <i className="fa-solid fa-xmark text-lg"></i>
              </button>
            </div>

            <div className="px-6 py-4 border-b border-slate-100 bg-white">
              <div className="relative group">
                <i className="fa-solid fa-magnifying-glass absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-indigo-500 transition-colors"></i>
                <input 
                  type="text"
                  placeholder="Search history..."
                  value={historySearchQuery}
                  onChange={(e) => setHistorySearchQuery(e.target.value)}
                  className="w-full pl-10 pr-10 py-2 bg-slate-100 border-none rounded-xl text-sm focus:ring-2 focus:ring-indigo-500 outline-none transition-all placeholder:text-slate-400"
                />
                {historySearchQuery && (
                  <button 
                    onClick={() => setHistorySearchQuery('')}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 transition-colors"
                  >
                    <i className="fa-solid fa-circle-xmark"></i>
                  </button>
                )}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {history.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-slate-300 space-y-4 py-20">
                  <i className="fa-solid fa-folder-open text-5xl opacity-20"></i>
                  <p className="text-center font-medium">No history yet</p>
                  <p className="text-sm">Your translations will appear here.</p>
                </div>
              ) : filteredHistory.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-slate-300 space-y-4 py-20">
                  <i className="fa-solid fa-magnifying-glass text-5xl opacity-20"></i>
                  <p className="text-center font-medium">No matches found</p>
                  <p className="text-sm">Try searching for something else.</p>
                </div>
              ) : (
                filteredHistory.map((item) => (
                  <div 
                    key={item.id}
                    onClick={() => selectHistoryItem(item)}
                    className="group bg-white border border-slate-200 rounded-xl p-4 cursor-pointer hover:border-indigo-400 hover:shadow-md transition-all relative overflow-hidden"
                  >
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center space-x-2 text-[10px] font-bold uppercase tracking-wider text-indigo-600">
                        <span>{item.sourceLanguage}</span>
                        <i className="fa-solid fa-arrow-right text-[8px] text-slate-300"></i>
                        <span>{item.targetLanguage}</span>
                      </div>
                      <button 
                        onClick={(e) => deleteHistoryItem(item.id, e)}
                        className="opacity-0 group-hover:opacity-100 w-7 h-7 rounded-full bg-red-50 text-red-400 hover:bg-red-100 hover:text-red-600 transition-all flex items-center justify-center"
                      >
                        <i className="fa-solid fa-trash-can text-xs"></i>
                      </button>
                    </div>
                    <p className="text-slate-700 text-sm line-clamp-2 font-medium mb-1">{item.sourceText}</p>
                    <p className="text-slate-400 text-xs line-clamp-2 italic">{item.translatedText}</p>
                    <div className="mt-2 text-[10px] text-slate-300">
                      {new Date(item.timestamp).toLocaleString()}
                    </div>
                  </div>
                ))
              )}
            </div>

            {history.length > 0 && (
              <div className="p-4 border-t border-slate-100">
                <button 
                  onClick={clearHistory}
                  className="w-full py-3 bg-slate-50 hover:bg-red-50 hover:text-red-600 text-slate-500 rounded-xl text-sm font-bold transition-all border border-slate-100 flex items-center justify-center space-x-2"
                >
                  <i className="fa-solid fa-trash-can"></i>
                  <span>Clear All History</span>
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default TextTranslator;
