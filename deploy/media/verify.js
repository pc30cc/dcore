// Signature check of media links (the `hmac` scheme of the API's CDN signer):
//
//   <base>/<object key>?exp=<unix seconds>&sig=<base64url HMAC-SHA256(key, "<path>\n<exp>")>
//
// Runs in nginx (njs, `js_set $media_ok verify.ok`) and in Node (tests); it
// uses only what both provide. The key comes from CDN_SIGNING_KEY (nginx
// passes it through with `env CDN_SIGNING_KEY;`).
import crypto from 'crypto';

const KEY_PATH = /^\/[A-Za-z0-9._/-]{1,512}$/;
const SIG = /^[A-Za-z0-9_-]{43}$/;
const EXP = /^[0-9]{1,12}$/;
// Links are valid until the end of the next UTC day; anything further out
// was not made by the signer.
const MAX_AHEAD_S = 3 * 86400;

function digest(key, text) {
  return crypto.createHmac('sha256', key).update(text).digest('base64url');
}

/** "1" when the request's path and query carry a valid, unexpired signature, else "0". */
function check(path, exp, sig, key, nowMs) {
  if (typeof key !== 'string' || key.length < 16) return '0';
  if (typeof path !== 'string' || !KEY_PATH.test(path)) return '0';
  if (path.split('/').some((s, i) => i > 0 && (s === '' || s === '.' || s === '..'))) return '0';
  if (typeof exp !== 'string' || !EXP.test(exp) || typeof sig !== 'string' || !SIG.test(sig)) return '0';
  const expS = Number(exp);
  const nowS = nowMs / 1000;
  if (expS <= nowS || expS > nowS + MAX_AHEAD_S) return '0';
  const expected = digest(key, `${path}\n${exp}`);
  // Compares digests of both values, so the time taken says nothing about
  // how much of the signature matched.
  return digest(key, expected) === digest(key, sig) ? '1' : '0';
}

function ok(r) {
  const env = typeof process !== 'undefined' && process.env ? process.env : {};
  return check(r.uri, r.args.exp, r.args.sig, env.CDN_SIGNING_KEY, Date.now());
}

export default { ok, check };
