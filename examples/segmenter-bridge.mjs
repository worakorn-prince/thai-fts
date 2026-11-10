/**
 * Plugging an external Thai segmenter into thai-fts
 * =================================================
 *
 * thai-fts segments Thai text with `Intl.Segmenter` (ICU) out of the box.
 * For general / legal / literary out-of-vocabulary text you may get higher
 * accuracy from a dictionary or statistical segmenter such as **attacut**
 * (wasm) or **PyThaiNLP** (`newmm`). Both can be wired in through the
 * public seam `setThaiSegmenter()` — the object must implement:
 *
 *   { segment(text: string): Iterable<{ segment: string, isWordLike?: boolean }> }
 *
 * `wordTokens()`, `segmentForIndex()` and query building all route through it,
 * so index-time and query-time segmentation stay symmetric.
 *
 * This example is NOT shipped in the npm package (see `files` in
 * package.json). Run it with:
 *
 *   node examples/segmenter-bridge.mjs
 *
 * Zero npm dependencies; `fetch` is the Node 18+ global.
 */

import {
  setThaiSegmenter,
  getThaiSegmenterInfo,
  wordTokens,
  THAI_DEFAULT_WORDS,
} from "thai-fts";

// ---------------------------------------------------------------------------
// 1) HTTP bridge to a local PyThaiNLP service
// ---------------------------------------------------------------------------
//
// Start a tiny local service first (any framework works; snippet below uses
// python + http.server for zero pip deps beyond PyThaiNLP itself):
//
//   # pythainlp-bridge.py
//   import json
//   from http.server import HTTPServer, BaseHTTPRequestHandler
//   from pythainlp import word_tokenize  # pip install pythainlp
//
//   class H(BaseHTTPRequestHandler):
//       def do_POST(self):
//           body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
//           tokens = word_tokenize(body.get("text", ""), engine="newmm")
//           payload = json.dumps(tokens).encode()
//           self.send_response(200)
//           self.send_header("Content-Type", "application/json")
//           self.end_headers()
//           self.wfile.write(payload)
//       def log_message(self, *args):
//           pass  # quiet
//
//   HTTPServer(("127.0.0.1", 8765), H).serve_forever()
//
// Then point this example at it (or remove the skip).

const PYTHAINLP_URL = "http://127.0.0.1:8765";

/** Wrap an HTTP tokenizing service into the thai-fts segmenter interface. */
function pythainlpBridge(url = PYTHAINLP_URL) {
  return {
    segment(text) {
      // Synchronous interface, so this must be called from a context where a
      // prior fetch primed the cache — see the async wrapper below. The
      // simplest production shape is a small in-process LRU around fetch():
      // index-time you can also pre-tokenize and cache by text hash.
      return syncCache.get(text) ?? [{ segment: text, isWordLike: true }];
    },
  };
}

/**
 * Practical async wrapper: fetch tokens once per unique text and hand them to
 * a synchronous stub segmenter. (Indexing is batched anyway — tokenizing the
 * corpus up front, storing tokens, then calling setThaiSegmenter with a
 * lookup object is the zero-jitter pattern.)
 */
const syncCache = new Map();

async function primeCache(texts, url = PYTHAINLP_URL) {
  for (const text of texts) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error(`PyThaiNLP bridge HTTP ${res.status}`);
    const tokens = await res.json();
    syncCache.set(
      text,
      tokens.map((segment) => ({ segment, isWordLike: /\p{L}/u.test(segment) }))
    );
  }
}

// ---------------------------------------------------------------------------
// 2) Synchronous stub (offline / tests / attacut-wasm once loaded)
// ---------------------------------------------------------------------------
// A stub that groups the input around the built-in dictionary words — the
// same shape an in-process wasm segmenter (attacut) would provide once you
// load its wasm module.

function dictionaryStub(words = THAI_DEFAULT_WORDS) {
  const sorted = [...new Set(words)].sort((a, b) => b.length - a.length);
  return {
    segment(text) {
      const out = [];
      let rest = text;
      while (rest.length > 0) {
        const hit = sorted.find((w) => rest.startsWith(w));
        if (hit) {
          out.push({ segment: hit, isWordLike: true });
          rest = rest.slice(hit.length);
        } else {
          // carry non-word characters through as single records
          out.push({ segment: rest[0], isWordLike: false });
          rest = rest.slice(1);
        }
      }
      return out;
    },
  };
}

// --- demo ------------------------------------------------------------------
console.log("before:", getThaiSegmenterInfo());
console.log(
  "intl tokens:",
  wordTokens("ผมต้องติดตั้งโปรแกรมบนเซิร์ฟเวอร์ใหม่")
);

setThaiSegmenter(dictionaryStub());
console.log("after:", getThaiSegmenterInfo());
console.log(
  "stub tokens:",
  wordTokens("ผมต้องติดตั้งโปรแกรมบนเซิร์ฟเวอร์ใหม่")
);

// Restore auto-detection (Intl.Segmenter on full-icu runtimes).
setThaiSegmenter(null);
console.log("restored:", getThaiSegmenterInfo());

// To use the PyThaiNLP bridge end-to-end (service running on :8765):
//
//   await primeCache(["ผมต้องติดตั้งโปรแกรม"]);
//   setThaiSegmenter(pythainlpBridge());
//   console.log(wordTokens("ผมต้องติดตั้งโปรแกรม"));
