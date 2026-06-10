const supabase = require('./db');

async function useSupabaseAuthState(vendorId) {
  // Load existing session from Supabase
  let creds = {};
  let keys  = {};

  try {
    const { data } = await supabase
      .from('whatsapp_sessions')
      .select('creds, keys')
      .eq('vendor_id', String(vendorId))
      .single();

    if (data) {
      creds = data.creds || {};
      keys  = data.keys  || {};
      console.log(`[Auth] Loaded session for vendor ${vendorId}`);
    } else {
      console.log(`[Auth] No session found for vendor ${vendorId} — fresh start`);
    }
  } catch (e) {
    console.log(`[Auth] No existing session for vendor ${vendorId}`);
  }

  const state = { creds, keys };

  const saveCreds = async () => {
    try {
      await supabase
        .from('whatsapp_sessions')
        .upsert({
          vendor_id:  String(vendorId),
          creds:      state.creds,
          keys:       state.keys,
          updated_at: new Date().toISOString()
        }, { onConflict: 'vendor_id' });
    } catch (e) {
      console.error(`[Auth] Failed to save session for vendor ${vendorId}:`, e.message);
    }
  };

  return { state, saveCreds };
}

module.exports = { useSupabaseAuthState };