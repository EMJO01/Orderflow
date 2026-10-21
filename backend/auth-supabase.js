const crypto = require('crypto');
const supabase = require('./db');
const {
  initAuthCreds,
  BufferJSON,
  makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');
const pino = require('pino');

// ─────────────────────────────────────────────────────────────────────────────
// WhatsApp session storage with encryption at rest.
//
// A WhatsApp session is the full login for a vendor's number: whoever can read it can take that
// number over. So the session is encrypted with AES-256-GCM before it goes into Supabase, and
// only this server (which holds SESSION_ENCRYPTION_KEY) can read it. A leaked database, backup or
// Supabase dashboard login then exposes only ciphertext.
//
//   SESSION_ENCRYPTION_KEY       current key, 32+ random characters (generate one, see SECURITY_NOTES)
//   SESSION_ENCRYPTION_KEY_OLD   optional: the previous key, only while rotating
//
// Rules this file follows:
//  - Key set: every save is encrypted. Old plaintext rows still load, then are re-saved encrypted.
//  - Key missing: behaves exactly as before (plaintext) and warns loudly, so a missing env var can
//    never take every vendor offline.
//  - Wrong or missing key for an already-encrypted row: connecting FAILS with a clear message. It
//    never starts a fresh session, because that would overwrite a good session with an empty one.
//  - Each row is bound to its vendor id, so rows swapped between vendors will not decrypt.
// ─────────────────────────────────────────────────────────────────────────────

const ENC_VERSION = 'v1';
let warnedPlaintext = false;

const deriveKey = secret => crypto.createHash('sha256').update(String(secret)).digest();

function encryptionKeys() {
  const read = name => {
    const v = process.env[name];
    if (!v) return null;
    if (v.length < 32) { console.error(`[Auth] ${name} is shorter than 32 characters, so it was ignored`); return null; }
    return deriveKey(v);
  };
  return { current: read('SESSION_ENCRYPTION_KEY'), old: read('SESSION_ENCRYPTION_KEY_OLD') };
}

const isEncrypted = v => !!v && typeof v === 'object' && v.enc === ENC_VERSION;
const aad = vendorId => Buffer.from(`wa-session:${vendorId}`);

function encrypt(obj, key, vendorId) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad(vendorId));
  const data = Buffer.concat([cipher.update(JSON.stringify(obj, BufferJSON.replacer), 'utf8'), cipher.final()]);
  return { enc: ENC_VERSION, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

// Returns { value, usedOldKey }. Throws if no key can open it.
function decrypt(blob, keys, vendorId) {
  const candidates = [['current', keys.current], ['old', keys.old]].filter(([, k]) => k);
  if (!candidates.length) throw new Error('This session is encrypted but SESSION_ENCRYPTION_KEY is not set');
  for (const [which, key] of candidates) {
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'base64'));
      decipher.setAAD(aad(vendorId));
      decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
      const plain = Buffer.concat([decipher.update(Buffer.from(blob.data, 'base64')), decipher.final()]).toString('utf8');
      return { value: JSON.parse(plain, BufferJSON.reviver), usedOldKey: which === 'old' };
    } catch (e) { /* try the next key */ }
  }
  throw new Error('Could not decrypt this session. Check SESSION_ENCRYPTION_KEY (it may be wrong or changed)');
}

const reviveLegacy = v => JSON.parse(JSON.stringify(v), BufferJSON.reviver);

async function useSupabaseAuthState(vendorId) {
  const keys = encryptionKeys();
  let creds;
  let keyData = {};
  let resave = false; // a legacy plaintext row, or one opened with the old key, gets re-saved with the current key

  // maybeSingle: "no row yet" is normal for a new vendor, but any real database error must not be
  // mistaken for it (that would start a fresh session and overwrite a good one).
  const { data, error } = await supabase
    .from('whatsapp_sessions')
    .select('creds, keys')
    .eq('vendor_id', String(vendorId))
    .maybeSingle();
  if (error) throw new Error(`Could not read the saved session for vendor ${vendorId}: ${error.message}`);

  if (data?.creds) {
    if (isEncrypted(data.creds)) {
      const c = decrypt(data.creds, keys, vendorId);
      creds = c.value;
      resave = c.usedOldKey;
      if (isEncrypted(data.keys)) {
        const k = decrypt(data.keys, keys, vendorId);
        keyData = k.value;
        resave = resave || k.usedOldKey;
      } else {
        keyData = reviveLegacy(data.keys || {});
      }
    } else {
      creds = reviveLegacy(data.creds);
      keyData = reviveLegacy(data.keys || {});
      resave = !!keys.current; // migrate to encrypted as soon as a key exists
    }
    console.log(`[Auth] ✅ Session loaded for vendor ${vendorId}`);
  } else {
    creds = initAuthCreds();
    console.log(`[Auth] No session for vendor ${vendorId} — fresh start`);
  }

  const saveState = async () => {
    try {
      let credsOut, keysOut;
      if (keys.current) {
        credsOut = encrypt(creds, keys.current, vendorId);
        keysOut  = encrypt(keyData, keys.current, vendorId);
      } else {
        if (!warnedPlaintext) {
          warnedPlaintext = true;
          console.warn('[Auth] ⚠️ SESSION_ENCRYPTION_KEY is not set: WhatsApp sessions are being stored UNENCRYPTED.');
        }
        credsOut = JSON.parse(JSON.stringify(creds,   BufferJSON.replacer));
        keysOut  = JSON.parse(JSON.stringify(keyData, BufferJSON.replacer));
      }
      const { error: upErr } = await supabase
        .from('whatsapp_sessions')
        .upsert({
          vendor_id:  String(vendorId),
          creds:      credsOut,
          keys:       keysOut,
          updated_at: new Date().toISOString()
        }, { onConflict: 'vendor_id' });
      if (upErr) throw new Error(upErr.message);
      console.log(`[Auth] ✅ Session saved for vendor ${vendorId}${keys.current ? ' (encrypted)' : ''}`);
    } catch (e) {
      console.error(`[Auth] Save failed for vendor ${vendorId}:`, e.message);
    }
  };

  const rawKeys = {
    get: async (type, ids) => {
      const result = {};
      for (const id of ids) {
        const val = keyData[type]?.[id];
        if (val !== undefined) result[id] = val;
      }
      return result;
    },
    set: async (data) => {
      for (const [type, values] of Object.entries(data)) {
        if (!keyData[type]) keyData[type] = {};
        for (const [id, val] of Object.entries(values || {})) {
          if (val === null || val === undefined) {
            delete keyData[type][id];
          } else {
            keyData[type][id] = val;
          }
        }
      }
      await saveState();
    }
  };

  const logger = pino({ level: 'silent' });
  const signalKeys = makeCacheableSignalKeyStore(rawKeys, logger);

  if (resave) {
    console.log(`[Auth] Re-saving the session for vendor ${vendorId} with the current encryption key`);
    await saveState();
  }

  return {
    state:     { creds, keys: signalKeys },
    saveCreds: saveState
  };
}

module.exports = { useSupabaseAuthState };