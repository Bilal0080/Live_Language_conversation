
import { Language } from '../types';

type PhraseMap = {
  [key: string]: {
    [lang in Language]: string;
  };
};

// Core vocabulary for "pre-downloaded" offline models
const COMMON_PHRASES: PhraseMap = {
  "hello": {
    "English": "Hello",
    "Japanese": "こんにちは",
    "Korean": "안녕하세요",
    "Chinese": "你好",
    "French": "Bonjour",
    "Italian": "Ciao",
    "Urdu": "ہیلو"
  },
  "thank you": {
    "English": "Thank you",
    "Japanese": "ありがとうございます",
    "Korean": "감사합니다",
    "Chinese": "谢谢",
    "French": "Merci",
    "Italian": "Grazie",
    "Urdu": "شکریہ"
  },
  "yes": {
    "English": "Yes",
    "Japanese": "はい",
    "Korean": "네",
    "Chinese": "是",
    "French": "Oui",
    "Italian": "Sì",
    "Urdu": "جی ہاں"
  },
  "no": {
    "English": "No",
    "Japanese": "いいえ",
    "Korean": "아니요",
    "Chinese": "不",
    "French": "Non",
    "Italian": "No",
    "Urdu": "نہیں"
  },
  "where is the bathroom?": {
    "English": "Where is the bathroom?",
    "Japanese": "トイレはどこですか？",
    "Korean": "화장실이 어디예요?",
    "Chinese": "洗手间在哪里？",
    "French": "Où sont les toilettes ?",
    "Italian": "Dov'è il bagno?",
    "Urdu": "باتھ روم کہاں ہے؟"
  },
  "i need help": {
    "English": "I need help",
    "Japanese": "助けが必要です",
    "Korean": "도움이 필요해요",
    "Chinese": "我需要帮助",
    "French": "J'ai besoin d'aide",
    "Italian": "Ho bisogno di aiuto",
    "Urdu": "مجھے مدد چاہیئے"
  },
  "how are you?": {
    "English": "How are you?",
    "Japanese": "お元気ですか？",
    "Korean": "어떻게 지내세요?",
    "Chinese": "你好吗？",
    "French": "Comment allez-vous ?",
    "Italian": "Come stai?",
    "Urdu": "آپ کیسے ہیں؟"
  },
  "goodbye": {
    "English": "Goodbye",
    "Japanese": "さようなら",
    "Korean": "안녕히 가세요",
    "Chinese": "再见",
    "French": "Au revoir",
    "Italian": "Arrivederci",
    "Urdu": "خدا حافظ"
  },
  "water": {
    "English": "Water",
    "Japanese": "水",
    "Korean": "물",
    "Chinese": "水",
    "French": "Eau",
    "Italian": "Acqua",
    "Urdu": "پانی"
  },
  "food": {
    "English": "Food",
    "Japanese": "食べ物",
    "Korean": "음식",
    "Chinese": "食物",
    "French": "Nourriture",
    "Italian": "Cibo",
    "Urdu": "کھانا"
  },
  "excuse me": {
    "English": "Excuse me",
    "Japanese": "すみません",
    "Korean": "실례합니다",
    "Chinese": "对不起",
    "French": "Excusez-moi",
    "Italian": "Scusi",
    "Urdu": "معاف کیجئے گا"
  }
};

/**
 * Attempts to translate text using the offline dictionary.
 * Performs a case-insensitive search.
 */
export function offlineTranslate(text: string, sourceLang: Language, targetLang: Language): string | null {
  const normalizedInput = text.trim().toLowerCase().replace(/[?.,!]/g, '');
  
  // Search the dictionary
  for (const [key, values] of Object.entries(COMMON_PHRASES)) {
    // Check if input matches the key (English) or any of the language values
    const isMatch = key.toLowerCase() === normalizedInput || 
                    Object.values(values).some(v => v.toLowerCase() === normalizedInput);
    
    if (isMatch) {
      return values[targetLang];
    }
  }
  
  return null;
}

/**
 * Returns a list of supported phrases for offline mode suggestions.
 */
export function getOfflineSuggestions(): string[] {
  return Object.keys(COMMON_PHRASES).map(k => k.charAt(0).toUpperCase() + k.slice(1));
}
