<!-- ANALYTICS PAGE — replace the existing analytics page div in dashboard.html -->

<!-- Add Chart.js in <head> before closing </head> tag -->
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>

<!-- Replace the ANALYTICS PAGE div with this -->
<div class="content" id="page-analytics" style="display:none;">

  <!-- Summary Cards -->
  <div class="stats" style="margin-bottom:24px;">
    <div class="stat-card green">
      <div class="stat-label">Total Revenue</div>
      <div class="stat-value" id="an-revenue">₦0</div>
      <div class="stat-change">All time</div>
    </div>
    <div class="stat-card blue">
      <div class="stat-label">Total Orders</div>
      <div class="stat-value" id="an-orders">0</div>
      <div class="stat-change">All time</div>
    </div>
    <div class="stat-card orange">
      <div class="stat-label">Conversations</div>
      <div class="stat-value" id="an-convs">0</div>
      <div class="stat-change">All time</div>
    </div>
    <div class="stat-card purple">
      <div class="stat-label">Conversion Rate</div>
      <div class="stat-value" id="an-rate">0%</div>
      <div class="stat-change">Chats → Orders</div>
    </div>
  </div>

  <!-- Revenue Chart -->
  <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:20px 24px;margin-bottom:20px;">
    <div class="section-title" style="margin-bottom:16px;">💰 Revenue — Last 7 Days</div>
    <canvas id="chart-revenue" height="80"></canvas>
  </div>

  <!-- Conversion Chart -->
  <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:20px 24px;margin-bottom:20px;">
    <div class="section-title" style="margin-bottom:16px;">💬 Conversations vs Orders — Last 7 Days</div>
    <canvas id="chart-conversion" height="80"></canvas>
  </div>

  <!-- Bottom row -->
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;">

    <!-- Top Products -->
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:20px 24px;">
      <div class="section-title" style="margin-bottom:16px;">🏆 Top Products</div>
      <div id="an-top-products"><div class="loading">Loading...</div></div>
    </div>

    <!-- Orders by Status -->
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:20px 24px;">
      <div class="section-title" style="margin-bottom:16px;">📦 Orders by Status</div>
      <canvas id="chart-status" height="160"></canvas>
    </div>

  </div>
</div>

<!-- Analytics JS — add this inside the <script> tag in dashboard.html -->
<script>
// ── ANALYTICS ─────────────────────────────────────────────────────────────────

let revenueChart, conversionChart, statusChart;

async function loadAnalytics() {
  if (!vendor) return;
  const id = vendor.id;

  try {
    const [summary, revenue, conversion, topProducts, orderStatus] = await Promise.all([
      fetch(`${API}/analytics/summary?vendor_id=${id}`).then(r => r.json()),
      fetch(`${API}/analytics/revenue?vendor_id=${id}`).then(r => r.json()),
      fetch(`${API}/analytics/conversion?vendor_id=${id}`).then(r => r.json()),
      fetch(`${API}/analytics/top-products?vendor_id=${id}`).then(r => r.json()),
      fetch(`${API}/analytics/order-status?vendor_id=${id}`).then(r => r.json()),
    ]);

    const currency = getCurrency();

    // Summary cards
    document.getElementById('an-revenue').textContent = currency + Number(summary.totalRevenue || 0).toLocaleString();
    document.getElementById('an-orders').textContent  = summary.totalOrders || 0;
    document.getElementById('an-convs').textContent   = summary.totalConvs  || 0;
    document.getElementById('an-rate').textContent    = (summary.convRate   || '0.0') + '%';

    // Revenue chart
    if (revenueChart) revenueChart.destroy();
    revenueChart = new Chart(document.getElementById('chart-revenue'), {
      type: 'bar',
      data: {
        labels:   revenue.map(d => d.date),
        datasets: [{
          label:           'Revenue',
          data:            revenue.map(d => d.revenue),
          backgroundColor: 'rgba(37,211,102,0.3)',
          borderColor:     '#25D366',
          borderWidth:     2,
          borderRadius:    6
        }]
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: '#888480' }, grid: { color: 'rgba(255,255,255,0.05)' } },
          y: { ticks: { color: '#888480', callback: v => currency + v.toLocaleString() }, grid: { color: 'rgba(255,255,255,0.05)' } }
        }
      }
    });

    // Conversion chart
    if (conversionChart) conversionChart.destroy();
    conversionChart = new Chart(document.getElementById('chart-conversion'), {
      type: 'line',
      data: {
        labels:   conversion.map(d => d.date),
        datasets: [
          {
            label:       'Conversations',
            data:        conversion.map(d => d.conversations),
            borderColor: '#4A9EFF',
            backgroundColor: 'rgba(74,158,255,0.1)',
            tension:     0.4,
            fill:        true,
            pointRadius: 4
          },
          {
            label:       'Orders',
            data:        conversion.map(d => d.orders),
            borderColor: '#25D366',
            backgroundColor: 'rgba(37,211,102,0.1)',
            tension:     0.4,
            fill:        true,
            pointRadius: 4
          }
        ]
      },
      options: {
        responsive: true,
        plugins: { legend: { labels: { color: '#F0EDE8', font: { size: 12 } } } },
        scales: {
          x: { ticks: { color: '#888480' }, grid: { color: 'rgba(255,255,255,0.05)' } },
          y: { ticks: { color: '#888480' }, grid: { color: 'rgba(255,255,255,0.05)' }, beginAtZero: true }
        }
      }
    });

    // Top products
    const topEl = document.getElementById('an-top-products');
    if (!topProducts.length) {
      topEl.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:16px 0;">No orders yet</div>';
    } else {
      const max = topProducts[0].orders;
      topEl.innerHTML = topProducts.map((p, i) => `
        <div style="margin-bottom:14px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px;">
            <div style="font-size:13px;font-weight:500;">${i+1}. ${p.name}</div>
            <div style="font-size:12px;color:var(--muted);">${p.orders} order${p.orders!==1?'s':''} · ${currency}${Number(p.revenue).toLocaleString()}</div>
          </div>
          <div style="height:6px;background:var(--surface2);border-radius:4px;overflow:hidden;">
            <div style="height:100%;width:${(p.orders/max*100).toFixed(0)}%;background:var(--accent);border-radius:4px;"></div>
          </div>
        </div>`).join('');
    }

    // Status donut
    if (statusChart) statusChart.destroy();
    const statusData = [orderStatus.pending, orderStatus.confirmed, orderStatus.delivered, orderStatus.cancelled];
    const hasData = statusData.some(v => v > 0);
    statusChart = new Chart(document.getElementById('chart-status'), {
      type: 'doughnut',
      data: {
        labels:   ['Pending', 'Confirmed', 'Delivered', 'Cancelled'],
        datasets: [{
          data:            hasData ? statusData : [1, 0, 0, 0],
          backgroundColor: ['#FF6B35','#4A9EFF','#25D366','#FF4444'],
          borderWidth:     0,
          hoverOffset:     4
        }]
      },
      options: {
        responsive: true,
        cutout: '65%',
        plugins: {
          legend: { position: 'bottom', labels: { color: '#F0EDE8', font: { size: 12 }, padding: 12 } }
        }
      }
    });

  } catch(e) {
    console.error('Analytics load error:', e);
  }
}
</script>