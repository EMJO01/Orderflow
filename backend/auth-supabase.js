const supabase = require('./db');
const {
  initAuthCreds,
  BufferJSON,
  makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');
const pino = require('pino');

async function useSupabaseAuthState(vendorId) {
  let creds;
  let keyData = {};

  // ── Load from Supabase ───────────────────────────────────────────────────
  try {
    const { data, error } = await supabase
      .from('whatsapp_sessions')
      .select('creds, keys')
      .eq('vendor_id', String(vendorId))
      .single();

    if (!error && data?.creds) {
      creds   = JSON.parse(JSON.stringify(data.creds), BufferJSON.reviver);
      keyData = JSON.parse(JSON.stringify(data.keys || {}), BufferJSON.reviver);
      console.log(`[Auth] ✅ Session loaded for vendor ${vendorId}`);
    } else {
      creds = initAuthCreds();
      console.log(`[Auth] No session for vendor ${vendorId} — fresh start`);
    }
  } catch (e) {
    creds = initAuthCreds();
    console.log(`[Auth] No session for vendor ${vendorId} — fresh start`);
  }

  // ── Raw key store (plain object, persisted to Supabase) ──────────────────
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

  // ── Save to Supabase ─────────────────────────────────────────────────────
  const saveState = async () => {
    try {
      await supabase
        .from('whatsapp_sessions')
        .upsert({
          vendor_id:  String(vendorId),
          creds:      JSON.parse(JSON.stringify(creds,    BufferJSON.replacer)),
          keys:       JSON.parse(JSON.stringify(keyData,  BufferJSON.replacer)),
          updated_at: new Date().toISOString()
        }, { onConflict: 'vendor_id' });
    } catch (e) {
      console.error(`[Auth] Save failed for vendor ${vendorId}:`, e.message);
    }
  };

  // ── Wrap with Baileys' own cacheable store (handles Signal crypto) ────────
  const logger = pino({ level: 'silent' });
  const keys   = makeCacheableSignalKeyStore(rawKeys, logger);

  return {
    state:     { creds, keys },
    saveCreds: saveState
  };
}

module.exports = { useSupabaseAuthState };