const supabase = require('./db');
const { initAuthCreds, BufferJSON, proto } = require('@whiskeysockets/baileys');

async function useSupabaseAuthState(vendorId) {
  const KEY_MAP = {
    'pre-key':        'preKeys',
    'session':        'sessions',
    'sender-key':     'senderKeys',
    'app-state-sync-key': 'appStateSyncKeys',
    'app-state-sync-version': 'appStateVersions',
    'sender-key-memory': 'senderKeyMemory'
  };

  // Load from Supabase
  let savedCreds = null;
  let savedKeys  = null;

  try {
    const { data } = await supabase
      .from('whatsapp_sessions')
      .select('creds, keys')
      .eq('vendor_id', String(vendorId))
      .single();

    if (data?.creds) {
      savedCreds = JSON.parse(JSON.stringify(data.creds), BufferJSON.reviver);
      savedKeys  = JSON.parse(JSON.stringify(data.keys  || {}), BufferJSON.reviver);
      console.log(`[Auth] Session loaded for vendor ${vendorId}`);
    } else {
      console.log(`[Auth] No session for vendor ${vendorId} — fresh start`);
    }
  } catch (e) {
    console.log(`[Auth] No session for vendor ${vendorId} — fresh start`);
  }

  const creds = savedCreds || initAuthCreds();
  const keys  = savedKeys  || {};

  const saveState = async () => {
    try {
      const credsJson = JSON.parse(JSON.stringify(creds, BufferJSON.replacer));
      const keysJson  = JSON.parse(JSON.stringify(keys,  BufferJSON.replacer));
      await supabase
        .from('whatsapp_sessions')
        .upsert({
          vendor_id:  String(vendorId),
          creds:      credsJson,
          keys:       keysJson,
          updated_at: new Date().toISOString()
        }, { onConflict: 'vendor_id' });
    } catch (e) {
      console.error(`[Auth] Save failed for vendor ${vendorId}:`, e.message);
    }
  };

  return {
    state: {
      creds,
      keys: {
        get: (type, ids) => {
          const keyType = KEY_MAP[type];
          if (!keyType) return {};
          return ids.reduce((dict, id) => {
            const val = keys[keyType]?.[id];
            if (val) dict[id] = val;
            return dict;
          }, {});
        },
        set: async (data) => {
          for (const [type, value] of Object.entries(data)) {
            const keyType = KEY_MAP[type];
            if (!keyType) continue;
            if (!keys[keyType]) keys[keyType] = {};
            Object.assign(keys[keyType], value);
          }
          await saveState();
        }
      }
    },
    saveCreds: saveState
  };
}

module.exports = { useSupabaseAuthState };