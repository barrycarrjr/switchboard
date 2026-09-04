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

/**
 * Recognize a lane that could not authenticate, conservatively, from CLI output.
 *
 * This is a different kind of failure from a limit and it is worth being precise about
 * why. A limit means the account is real and simply spent: the work started and stopped.
 * An authentication failure means the run never began, because the lane's sign-in is
 * missing, expired, or refused. Nothing was consumed and nothing was produced.
 *
 * The signatures are specific phrases rather than single words on purpose. Classification
 * reads the child's stdout as well as its stderr, so a lone "unauthorized" would also
 * match an agent describing an unauthorized request in somebody else's code, and a run
 * that merely mentioned the word would be started over on a second account. Only a
 * non-zero exit is ever classified, which keeps the cost of a wrong guess to a run that
 * had already failed.
 */
export function isAuthError(output) {
  if (!output || typeof output !== 'string') return false;

  const text = output.toLowerCase();

  const authSignatures = [
    'failed to authenticate',
    'authentication failed',
    'authentication_error',
    'oauth session expired',
    'oauth token expired',
    'session expired and could not be refreshed',
    'credentials have expired',
    'invalid api key',
    'invalid x-api-key',
    'invalid bearer token',
    'no credentials found',
    'not logged in',
    'please run /login',
    'please run `claude setup-token`',
    '401 unauthorized',
    'unauthorized (401)'
  ];

  if (authSignatures.some(sig => text.includes(sig))) {
    return true;
  }

  // The same conservatism the 429 rule uses: a bare 401 inside prose, a path or a line
  // number is not a verdict. Only one in a status or HTTP context is.
  if (/\b(?:status(?: code)?|http|error)[\s:]*401\b/.test(text)) {
    return true;
  }

  return false;
}

/**
 * How a finished run should be treated: 'limit', 'auth' or 'other'.
 *
 * A successful run is never classified, and the limit reading is taken first so that an
 * exhausted account which also mentions its sign-in keeps the meaning it has always had.
 * Callers use this to decide whether to move to the next lane; keeping the decision here,
 * rather than in the run loop, is what makes it testable without spawning a harness.
 */
export function classifyRunFailure(code, output) {
  if (code === 0) return 'other';
  if (isLimitError(output)) return 'limit';
  if (isAuthError(output)) return 'auth';
  return 'other';
}
