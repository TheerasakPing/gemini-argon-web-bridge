// Public capabilities registry. A site being listed does not grant permission to automate it.
export const BROWSER_SITES = Object.freeze({
  gemini: Object.freeze({
    id:'gemini', url:'https://gemini.google.com/app',
    mode:'browser-extension', model:'gemini-web', browserRelay:true, headless:true,
  }),
  chatgpt: Object.freeze({
    id:'chatgpt', url:'https://chatgpt.com/',
    mode:'manual-browser', model:null, browserRelay:false, headless:false,
    reason:'ChatGPT web output extraction is not supported; use the official OpenAI API connector.',
  }),
});
export const getBrowserSite = id => Object.hasOwn(BROWSER_SITES,id) ? BROWSER_SITES[id] : null;
export const publicBrowserSites = () => Object.values(BROWSER_SITES).map(x=>({...x}));
