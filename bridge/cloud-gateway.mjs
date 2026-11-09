// Official OpenAI API integration. Never forwards the Argon bridge token.
export function openAIProviderFromEnv(env = process.env) {
  const token = env.ARGON_OPENAI_API_KEY || '';
  if (!token) return [];
  if (typeof token !== 'string' || /[\r\n]/.test(token)) {
    throw new Error('ARGON_OPENAI_API_KEY must be a single-line secret');
  }
  // Fixed host/path. Do not accept a user-supplied API origin.
  return [{name:'openai', baseUrl:'https://api.openai.com', token}];
}
