
export type Language = 'Japanese' | 'Korean' | 'Chinese' | 'French' | 'Italian' | 'English' | 'Urdu';

export const ALL_LANGUAGES: Language[] = ['Japanese', 'Korean', 'Chinese', 'French', 'Italian', 'English', 'Urdu'];

export interface TranslationState {
  sourceText: string;
  translatedText: string;
  sourceLanguage: Language;
  targetLanguage: Language;
  isLoading: boolean;
  error: string | null;
  pronunciationGuide?: string;
}

export enum AppMode {
  TEXT = 'TEXT',
  VOICE = 'VOICE'
}

export interface Message {
  role: 'user' | 'assistant' | 'model';
  content: string;
  timestamp: Date;
}

export interface HistoryItem {
  id: string;
  sourceText: string;
  translatedText: string;
  sourceLanguage: Language;
  targetLanguage: Language;
  timestamp: number;
  voice?: string;
  speechRate?: number;
}

export interface VoiceHistoryItem {
  id: string;
  timestamp: number;
  messages: Array<{ role: 'user' | 'model'; text: string }>;
  summary?: string; // Short snippet for the list view
}
