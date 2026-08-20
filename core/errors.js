/**
 * Recognize known provider limit errors conservatively from CLI output.
 */
export function isLimitError(output) {
  if (!output || typeof output !== 'string') return false;
  
  const text = output.toLowerCase();
  
  const limitSignatures = [
    'rate limit exceeded',
    'quota exceeded',
    'usage limit reached',
    'exceeded your quota',
    'out of credits',
    'insufficient quota',
    'too many requests'
  ];

  if (limitSignatures.some(sig => text.includes(sig))) {
    return true;
  }

  // Conservatively match 429 in a status code or HTTP context,
  // avoiding plain numbers like a port "localhost:4290" or "429 tokens"
  if (/\b(?:status(?: code)?|http|error)[\s:]*429\b/.test(text)) {
    return true;
  }

  return false;
}
