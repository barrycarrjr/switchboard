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

  // How Claude Code and Codex word a spent plan today: "You've hit your weekly limit",
  // "You've hit your session limit", "You've reached your usage limit". The older Claude
  // wording ("usage limit reached") is in the list above, and the change from one to the
  // other is why this is here: a run that died on the new sentence was filed as an
  // ambiguous failure and left on the spent lane, with a healthy one right below it. The
  // words between "your" and "limit" may not hold a full stop or a line break, so the
  // match stays inside one sentence, which keeps it a vendor phrase rather than two words
  // an agent happened to print ("You've hit your stride. There is no limit here").
  //
  // Both apostrophes, because the vendors do not agree: Claude Code types a plain one and
  // Codex a typographic one. Read out of the codex 0.155.1 binary, which holds "You’ve hit
  // your usage limit" seven times and the plain spelling not once, so matching only the
  // plain one recognised Claude's sentence and left every spent Codex lane where it was.
  if (/you['’]?ve (?:hit|reached) your [^\n.]{0,40}limit/.test(text)) {
    return true;
  }

  // Claude Code's own machine-readable verdict, printed on a stream-json run before the
  // failure it causes. It survives any rewording of the sentence above.
  if (/"type"\s*:\s*"rate_limit_event"[^\n]*"status"\s*:\s*"rejected"/.test(text)) {
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
 * Recognize a provider or upstream server error, conservatively, from CLI output.
 *
 * This is distinct from a limit (which means the account has exhausted its quota) and
 * an auth failure (which means the credentials could not sign in). A server error means
 * the upstream provider API suffered an internal error, gateway timeout, or temporary
 * overload (such as HTTP 500, 502, 503, 504, or 529).
 *
 * Like auth and limit detection, the signatures are conservative vendor phrases and
 * HTTP-context status codes rather than bare numbers or lone words, so a program or
 * test in user code that happens to print 500 or mention a server error does not trigger
 * a lane hop unless the process actually exited with a non-zero exit code and provider-
 * specific failure phrasing.
 */
export function isServerError(output) {
  if (!output || typeof output !== 'string') return false;

  const text = output.toLowerCase();

  const serverSignatures = [
    'internal server error',
    'bad gateway',
    'service unavailable',
    'gateway timeout',
    'temporarily overloaded',
    'server is overloaded',
    'the server had an error processing your request',
    'the server had an error while processing your request',
    'status.claude.com',
    'status.openai.com'
  ];

  if (serverSignatures.some((sig) => text.includes(sig))) {
    return true;
  }

  // Machine-readable server errors from Claude Code or OpenAI / Codex JSON events
  if (/(?:"type"|"error")\s*:\s*"(?:api_error|server_error|overloaded_error)"/.test(text)) {
    return true;
  }

  if (/(?:"apiErrorStatus"|"status")\s*:\s*(?:50[0234]|529)\b/.test(text)) {
    return true;
  }

  // Conservatively match 500, 502, 503, 504, 529 in a status code or HTTP context,
  // avoiding plain numbers like a port "localhost:5000" or "500 tokens"
  if (/\b(?:status(?: code)?|http|error|api error)[\s:]*(?:50[0234]|529)\b/i.test(text)) {
    return true;
  }

  return false;
}

/**
 * How a finished run should be treated: 'limit', 'auth', 'server' or 'other'.
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
  if (isServerError(output)) return 'server';
  return 'other';
}
