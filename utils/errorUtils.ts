
export function parseApiError(error: any): string {
  const message = error?.message || String(error);

  if (message.includes('429') || message.toLowerCase().includes('too many requests')) {
    return 'Rate limit exceeded. Please wait a moment before trying again.';
  }
  
  if (message.includes('401') || message.toLowerCase().includes('api key')) {
    return 'Invalid API key. Please check your configuration.';
  }

  if (message.includes('403')) {
    return 'Permission denied. Your API key may not have access to this model or region.';
  }

  if (message.includes('500') || message.includes('503')) {
    return 'The translation service is currently busy or unavailable. Please try again later.';
  }

  if (message.toLowerCase().includes('safety') || message.toLowerCase().includes('blocked')) {
    return 'The content was flagged by safety filters and could not be processed.';
  }

  if (message.toLowerCase().includes('network') || message.toLowerCase().includes('fetch')) {
    return 'Network error. Please check your internet connection.';
  }

  if (message.toLowerCase().includes('quota')) {
    return 'Account quota exceeded. Please check your Google AI Studio billing status.';
  }

  return 'An unexpected error occurred: ' + message;
}
