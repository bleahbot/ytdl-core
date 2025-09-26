const querystring = require("querystring");  
const Cache = require("./cache");  
const utils = require("./utils");  
const vm = require("vm");  
const fs = require("fs");  

// Debug flag (set true to enable debug logging)
let DEBUG = false;  
exports.setDebug = (v) => { DEBUG = !!v };

// Debug wrapper for console.log
function debugLog(...args) {  
  if (DEBUG) console.log(...args);  
}  

// Store last player bodies (up to 3)
let __lastPlayerBodies = [];  

// Save player body into memory (keeps only the last 3)
function __recordPlayerBody(url, body) {  
  __lastPlayerBodies.unshift({ url, body });  
  if (__lastPlayerBodies.length > 3) __lastPlayerBodies.pop();  
}  

// Dump last player body to a debug file for inspection
async function dumpLastPlayer() {  
  const latest = __lastPlayerBodies[0];  
  if (!latest || !latest.body) return;  
  const name = `player-script.js`;  
  const saved = utils.saveDebugFile(name, latest.body);  
  console.warn(
    `\x1b[33m[warn]\x1B[0m Error when parsing player-script.js, maybe YouTube made a change.\n` +
    `Please report this issue with the ${saved}\n` +
    `file on \x1b[33mhttps://github.com/bleahbot/ytdl-core/issues\x1B[0m.\n` +
    `Player script ${saved} saved on project root.`
  );  
  return saved;  
}  

// Export record and dump functions
exports.__recordPlayerBody = __recordPlayerBody;  
exports.dumpLastPlayer = dumpLastPlayer;  

// Cache instance for player functions
exports.cache = new Cache();  

exports.getFunctions = (html5playerfile, options) =>  
  exports.cache.getOrSet(html5playerfile, async () => {  
    debugLog(`[getFunctions] Fetching player: ${html5playerfile}`);  
    const body = await utils.request(html5playerfile, options);  

    try { exports.__recordPlayerBody(html5playerfile, body); } catch (_) {}  
    debugLog(`[getFunctions] Player fetched, length=${body && body.length}`);  

    const functions = exports.extractFunctions(body);  
    debugLog(`[getFunctions] Extracted ${functions ? functions.length : 0} function block(s)`);  

    if (!functions || !functions.length) {  
      debugLog(`[getFunctions] ERROR: Could not extract functions from player: ${html5playerfile}`);  
      throw new Error("Could not extract functions");  
    }  

    exports.cache.set(html5playerfile, functions);  
    debugLog(`[getFunctions] Cached functions for: ${html5playerfile}`);  
    return functions;  
  });  

// Regex lists used to locate decipher/n-transform/helper objects in the player source
const DECIPHER_REGEXPS = [  
  `function(?: \\w+)?\\s*\\(((?:\\w+,)*\\w+)\\)\\s*\\{[\\s\\S]+?return (?:\\w+\\.)?join\\.call\\(\\1, ""\\)\\}`,  
  `\\w+\\.prototype\\.get=function\\(\\){return this\\.j\\}`,  
  `function(?: \\w+)?\\s*\\((?:\\w+,)*\\w+\\)\\s*\\{[\\s\\S]+?\\.join\\(""\\)\\}`,  
];  

const HELPER_OBJECT_REGEXPS = [  
  `var \\w+=\\{.+?\\};`,  
  `var \\w+=\\{.+?\\};`,  
  `var \\w+=\\{.+?\\};`,  
];  

const N_TRANSFORM_REGEXPS = [  
  `function\\(\\w\\)\\{[\\s\\S]+?\\}`,  
  `\\w\\[i\\]=\\w\\[(\\w%\\w\\.length)\\]`,  
  `\\w=\\w\\.split\\(""\\);`,  
];  

exports.extractFunctions = body => {  
  const functions = [];  

  for (const regex of DECIPHER_REGEXPS) {  
    try {  
      const match = body.match(new RegExp(regex, "s"));  
      if (match) {  
        debugLog(`[extractFunctions] DECIPHER matched: ${regex.slice(0, 40)}...`);  
        functions.push(match[0]);  
        break;  
      } else {  
        debugLog(`[extractFunctions] DECIPHER no match for: ${regex.slice(0, 40)}...`);  
      }  
    } catch (err) {  
      debugLog(`[extractFunctions] DECIPHER regex error: ${err && err.message}`);  
    }  
  }  

  for (const regex of HELPER_OBJECT_REGEXPS) {  
    try {  
      const match = body.match(new RegExp(regex, "gs"));  
      if (match) {  
        debugLog(`[extractFunctions] HELPERS matched ${match.length} block(s) with: ${regex.slice(0, 40)}...`);  
        functions.push(...match);  
        break;  
      } else {  
        debugLog(`[extractFunctions] HELPERS no match for: ${regex.slice(0, 40)}...`);  
      }  
    } catch (err) {  
      debugLog(`[extractFunctions] HELPERS regex error: ${err && err.message}`);  
    }  
  }  

  for (const regex of N_TRANSFORM_REGEXPS) {  
    try {  
      const match = body.match(new RegExp(regex, "s"));  
      if (match) {  
        debugLog(`[extractFunctions] N-TRANSFORM matched: ${regex.slice(0, 40)}...`);  
        functions.push(match[0]);  
        break;  
      } else {  
        debugLog(`[extractFunctions] N-TRANSFORM no match for: ${regex.slice(0, 40)}...`);  
      }  
    } catch (err) {  
      debugLog(`[extractFunctions] N-TRANSFORM regex error: ${err && err.message}`);  
    }  
  }  

  debugLog(`[extractFunctions] Total collected blocks: ${functions.length}`);  
  return functions;  
};  

exports.setDownloadURL = (format, decipherProgram, nTransformProgram) => {  
  const decipher = url => {  
    const args = querystring.parse(url);  
    if (!args.s) {  
      debugLog(`[setDownloadURL:decipher] No signature to decipher, returning original url param.`);  
      return args.url;  
    }  

    const components = new URL(decodeURIComponent(args.url));  
    debugLog(`[setDownloadURL:decipher] Deciphering signature for: ${components.origin}${components.pathname}`);  

    const ctx = {};  
    vm.createContext(ctx);  

    const setup = /var\s+decipher\s*=/.test(decipherProgram)  
      ? decipherProgram  
      : `var decipher = (${decipherProgram});`;  

    const script = `${setup}\nvar result = decipher(${JSON.stringify(decodeURIComponent(args.s))});`;  
    vm.runInContext(script, ctx);  

    const key = args.sp || 'sig';  
    components.searchParams.set(key, ctx.result);  

    debugLog(`[setDownloadURL:decipher] Applied ${key}=${String(ctx.result).slice(0, 16)}...`);  
    return components.toString();  
  };  

  const nTransform = url => {  
    const components = new URL(decodeURIComponent(url));  
    const n = components.searchParams.get('n');  
    if (!n || !nTransformProgram) {  
      if (!n) debugLog(`[setDownloadURL:nTransform] No 'n' param found, skipping.`);  
      if (!nTransformProgram) debugLog(`[setDownloadURL:nTransform] No nTransform program provided, skipping.`);  
      return url;  
    }  

    debugLog(`[setDownloadURL:nTransform] Transforming n=${String(n).slice(0, 16)}...`);  
    const ctx = {};  
    vm.createContext(ctx);  

    const setup = /var\s+nTransform\s*=/.test(nTransformProgram)  
      ? nTransformProgram  
      : `var nTransform = (${nTransformProgram});`;  

    const script = `${setup}\nvar result = nTransform(${JSON.stringify(n)});`;  
    vm.runInContext(script, ctx);  

    if (ctx.result) {  
      components.searchParams.set('n', ctx.result);  
      debugLog(`[setDownloadURL:nTransform] Applied n=${String(ctx.result).slice(0, 16)}...`);  
    } else {  
      debugLog(`[setDownloadURL:nTransform] ERROR: nTransform returned falsy result.`);  
    }  
    return components.toString();  
  };  

  const cipher = !format.url;  
  const url = format.url || format.signatureCipher || format.cipher;  

  if (url) {  
    debugLog(`[setDownloadURL] Processing format; cipher=${cipher}, hasUrl=${Boolean(format.url)}`);  
    format.url = nTransform(cipher ? decipher(url) : url);  
    debugLog(`[setDownloadURL] Final URL set (length=${format.url.length})`);  
  } else {  
    debugLog(`[setDownloadURL] ERROR: No URL/cipher fields present on format.`);  
  }  

  delete format.signatureCipher;  
  delete format.cipher;  
};  

exports.decipherFormats = async (formats, html5player, options) => {  
  const decipheredFormats = {};  
  try {  
    debugLog(`[decipherFormats] Start for player: ${html5player} | formats=${formats ? formats.length : 0}`);  

    const [decipherFn, ...helperScripts] = await exports.getFunctions(html5player, options);  
    debugLog(`[decipherFormats] Decipher function acquired. Helpers=${helperScripts.length}`);  

    const nTransformFn = helperScripts.pop();  
    debugLog(`[decipherFormats] nTransform present=${Boolean(nTransformFn)}`);  

    const helpersJoined = (helperScripts || []).join(';\n');  
    const decipherProgram = `${helpersJoined}\nvar decipher = (${decipherFn});`;  
    const nProgram = nTransformFn ? `var nTransform = (${nTransformFn});` : "";  

    formats.forEach(format => {  
      debugLog(`[decipherFormats] Processing itag=${format && format.itag} mime=${format && format.mimeType}`);  
      exports.setDownloadURL(format, decipherProgram, nProgram);  
      if (format.url) {  
        decipheredFormats[format.url] = format;  
        debugLog(`[decipherFormats] OK -> itag=${format.itag} urlLen=${format.url.length}`);  
      } else {  
        debugLog(`[decipherFormats] ERROR -> itag=${format && format.itag} produced no URL`);  
      }  
    });  

    debugLog(`[decipherFormats] Done. Deciphered count=${Object.keys(decipheredFormats).length}`);  
    return decipheredFormats;  
  } catch (e) {  
    debugLog(`[decipherFormats] ERROR: ${e && e.message}`);  
    return {};  
  }  
};  
