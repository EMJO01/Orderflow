// ─────────────────────────────────────────────────────────────────────────────
// LEGACY — from an early prototype that used Meta's official WhatsApp Cloud API
// (hub.verify_token style). The project now uses Baileys for every vendor, which
// has no concept of this webhook. This file is not wired to anything and does
// nothing except answer verification pings so it doesn't 404/500 if Meta (or
// anything else) still has this URL configured somewhere.
//
// Safe to delete entirely, along with `app.use('/webhook', require('./webhook'));`
// in server.js, once you've confirmed nothing external still points at it.
// The route was previously calling generateReply() and sendWhatsApp() with an
// outdated, single-vendor function signature — it would have crashed with a
// 500 on every real message. It's now inert instead.
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const router = express.Router();

const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || 'rady123';

router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('[webhook] Verification ping received (legacy route, not in active use)');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

router.post('/', (req, res) => {
  // Intentionally a no-op — see note above. Logged so it's visible in Render
  // logs if something is still POSTing here.
  console.log('[webhook] POST received on legacy webhook — ignored, not wired to any vendor.');
  res.sendStatus(200);
});

module.exports = router;