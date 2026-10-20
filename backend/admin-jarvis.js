// admin-jarvis.js — adds a "Jarvis" page to admin.html without touching the rest of that file.
// Add one script tag with src="admin-jarvis.js" to admin.html, at the very end of the body
// (after the main script block, right before the closing body tag).
// It also makes "Activate plan" available for ecommerce vendors (both products now share one paid plan)
// and draws the WhatsApp QR in the browser, so the pairing code is never sent to a third party.
(function () {
  const QR_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
  let qrReady = null;
  function loadQrLib() {
    if (window.QRCode) return Promise.resolve();
    if (!qrReady) qrReady = new Promise((ok, fail) => {
      const s = document.createElement('script');
      s.src = QR_SRC; s.onload = ok; s.onerror = () => fail(new Error('Could not load the QR library'));
      document.head.appendChild(s);
    });
    return qrReady;
  }

  // ── nav item + page ─────────────────────────────────
  const notifierNav = document.querySelector('[data-page="notifier"]');
  const nav = document.createElement('button');
  nav.className = 'nav-item';
  nav.setAttribute('data-page', 'jarvis');
  nav.setAttribute('onclick', "showPage('jarvis',this)");
  nav.textContent = '🤖 Jarvis';
  notifierNav.insertAdjacentElement('afterend', nav);

  const page = document.createElement('div');
  page.className = 'page';
  page.id = 'page-jarvis';
  page.innerHTML = `
    <div class="section-header"><div class="section-title">Jarvis (admin assistant)</div></div>
    <div class="notif-box">
      <p style="font-size:13px;color:var(--muted);line-height:1.6;margin-bottom:18px;">
        Connect the WhatsApp number you set aside for admin use only. This is a separate connection from the
        Notifier. Once it is connected, message it from your own number to ask about signups, expiries and
        revenue, or to approve a vendor. Only numbers listed in <code>JARVIS_ALLOWED_NUMBERS</code> on Render get a reply.
      </p>
      <div class="notif-status"><div class="notif-dot2" id="jarvis-dot"></div><span id="jarvis-status-text">Checking status...</span></div>
      <div id="jarvis-action"></div>
      <div id="jarvis-qr"></div>
    </div>
    <div class="notif-box" style="margin-top:16px">
      <div class="section-title" style="margin-bottom:8px">Try Jarvis here</div>
      <p style="font-size:13px;color:var(--muted);line-height:1.6;margin-bottom:12px;">
        Works without WhatsApp. Anything that changes data still waits for you to type YES.
      </p>
      <input class="search" id="jarvis-test-input" style="width:100%;margin-bottom:10px" placeholder="e.g. how many signups this week?" aria-label="Message for Jarvis">
      <button class="btn btn-approve" id="jarvis-test-btn">Send</button>
      <div id="jarvis-test-out" style="white-space:pre-wrap;font-size:13.5px;line-height:1.6;margin-top:14px"></div>
    </div>`;
  document.getElementById('page-notifier').insertAdjacentElement('afterend', page);
  titles.jarvis = 'Jarvis';

  // ── status / connect ────────────────────────────────
  let qrPoll = null, statusPoll = null;
  const stopPolling = () => {
    if (qrPoll) { clearInterval(qrPoll); qrPoll = null; }
    if (statusPoll) { clearInterval(statusPoll); statusPoll = null; }
  };

  function setConnected(connected) {
    document.getElementById('jarvis-dot').classList.toggle('on', connected);
    document.getElementById('jarvis-status-text').textContent =
      connected ? 'Connected. Jarvis is listening on WhatsApp.' : 'Not connected.';
    if (connected) {
      stopPolling();
      document.getElementById('jarvis-qr').innerHTML = '';
      document.getElementById('jarvis-action').innerHTML = '';
    } else {
      document.getElementById('jarvis-action').innerHTML =
        '<button class="btn btn-approve" id="jarvis-connect-btn">📱 Connect admin number</button>';
      document.getElementById('jarvis-connect-btn').onclick = connectJarvis;
    }
  }

  async function checkStatus() {
    try { setConnected((await api('/admin/jarvis/status')).connected); }
    catch (e) { document.getElementById('jarvis-status-text').textContent = 'Could not check status.'; }
  }

  async function connectJarvis() {
    const qrBox = document.getElementById('jarvis-qr');
    document.getElementById('jarvis-action').innerHTML = '';
    qrBox.innerHTML = '<div class="qr-loading">Starting connection...</div>';
    try { await api('/admin/jarvis/connect', { method: 'POST' }); } catch (e) {}
    try { await loadQrLib(); } catch (e) { qrBox.innerHTML = '<div class="qr-loading">⚠️ ' + esc(e.message) + '</div>'; return; }

    let shown = false, tries = 0;
    stopPolling();
    qrPoll = setInterval(async () => {
      tries++;
      try {
        const data = await api('/admin/jarvis/qr-image');
        if (data.status === 'ready' && data.qr && !shown) {
          shown = true;
          qrBox.innerHTML = '<div class="qr-box"><div id="jarvis-qr-canvas"></div></div>' +
            '<p style="font-size:12px;color:var(--muted);margin-top:10px;">On the admin-only phone: WhatsApp → Linked devices → Link a device, then scan. The code expires in about 60 seconds.</p>';
          new QRCode(document.getElementById('jarvis-qr-canvas'), { text: data.qr, width: 220, height: 220 });
        }
      } catch (e) {}
      if (tries > 60) {
        stopPolling();
        if (!shown) qrBox.innerHTML = '<div class="qr-loading">⚠️ Timed out. <button class="btn" id="jarvis-retry">Try again</button></div>',
          document.getElementById('jarvis-retry').onclick = connectJarvis;
      }
    }, 2000);
    statusPoll = setInterval(async () => {
      try { if ((await api('/admin/jarvis/status')).connected) { setConnected(true); toast('✓ Jarvis connected'); } } catch (e) {}
    }, 3000);
  }

  // ── test box ────────────────────────────────────────
  async function sendTest() {
    const input = document.getElementById('jarvis-test-input'), out = document.getElementById('jarvis-test-out');
    const btn = document.getElementById('jarvis-test-btn'), text = input.value.trim();
    if (!text) return;
    btn.disabled = true; out.textContent = 'Thinking...';
    try {
      const data = await api('/admin/jarvis/test', { method: 'POST', body: { text } });
      out.textContent = data.reply || '(no reply)';
      input.value = '';
    } catch (e) { out.textContent = '⚠️ ' + e.message; }
    finally { btn.disabled = false; }
  }
  document.getElementById('jarvis-test-btn').onclick = sendTest;
  document.getElementById('jarvis-test-input').addEventListener('keydown', e => { if (e.key === 'Enter') sendTest(); });

  // ── hook into page switching ────────────────────────
  const baseShowPage = window.showPage;
  window.showPage = function (p, el) {
    baseShowPage(p, el);
    if (p === 'jarvis') checkStatus(); else stopPolling();
  };

  // ── Activate plan for both products (one paid plan now) ──
  const planBtn = id => `<button class="btn btn-plan" onclick="activatePlan(${+id},this)">Activate plan</button>`;
  const baseRowHTML = window.rowHTML;
  window.rowHTML = function (v) {
    const html = baseRowHTML(v);
    return html.includes('Activate plan') ? html : html.replace(/<\/div><\/div>\s*$/, planBtn(v.id) + '</div></div>');
  };
  window.activatePlan = async function (id, btn) {
    const v = vendors.find(x => x.id === id);
    if (!confirm(`Confirm the bank transfer from ${v ? v.business_name : 'this vendor'} was received? This activates the monthly service for 30 days.`)) return;
    if (btn) btn.disabled = true;
    try {
      await api(`/admin/vendors/${id}/activate-plan`, { method: 'PUT', body: { plan: 'pro' } });
      toast('✓ Service activated for 30 days');
      await loadAll();
    } catch (e) {
      toast('⚠️ ' + e.message, true);
      if (btn) btn.disabled = false;
    }
  };
})();
