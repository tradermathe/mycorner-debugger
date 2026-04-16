// MyCorner Debugger — Firebase-connected debug viewer
// Loads sessions from RTDB, streams video from Storage, renders overlays + charts

// === Firebase Init ===
firebase.initializeApp({
  apiKey: "AIzaSyC6B7rqq7ACJllABmPD8K6dEmYl2B3X3uY",
  authDomain: "mycorner-bee6a.firebaseapp.com",
  databaseURL: "https://mycorner-bee6a-default-rtdb.firebaseio.com",
  projectId: "mycorner-bee6a",
  storageBucket: "mycorner-bee6a.firebasestorage.app",
});

const db = firebase.database();
const storage = firebase.storage();

// === Constants ===
const JOINT_NAMES = ['Nose','L Shoulder','R Shoulder','L Elbow','R Elbow','L Wrist','R Wrist','L Hip','R Hip','L Knee','R Knee','L Ankle','R Ankle'];
const BONES = [[0,1],[0,2],[1,3],[3,5],[2,4],[4,6],[1,7],[2,8],[7,9],[9,11],[8,10],[10,12],[7,8],[1,2]];
const STAGE_COLORS = ['#555','#ca8a04','#a16207','#22c55e','#f97316','#ef4444'];
const STAGE_NAMES = ['Conf filtered','Temporal filtered','Sanity filtered','Valid OK','Violation cleaned','Violation counted'];
const PUNCH_COLORS = {
  'jab_head': '#4FC3F7', 'jab_body': '#4FC3F7',
  'cross_head': '#FF7043', 'cross_body': '#FF7043',
  'lead_hook_head': '#66BB6A', 'rear_hook_head': '#66BB6A',
  'lead_uppercut_head': '#AB47BC', 'rear_uppercut_head': '#AB47BC',
  'lead_bodyshot': '#FFD54F', 'rear_bodyshot': '#FFD54F',
};

// === State ===
let D = null; // debug data for current round
let currentFrame = 0;
let charts = {};

// === Session List ===
db.ref('sessions').on('value', (snap) => {
  const sessions = snap.val();
  const list = document.getElementById('session-list');
  if (!sessions) { list.innerHTML = '<div class="loading">No sessions yet</div>'; return; }

  // Sort by newest first
  const entries = Object.entries(sessions)
    .filter(([, v]) => v && typeof v === 'object')
    .sort((a, b) => {
      const ta = a[1].meta?.createdAt || 0;
      const tb = b[1].meta?.createdAt || 0;
      return tb - ta;
    });

  list.innerHTML = '';
  for (const [sid, session] of entries) {
    const meta = session.meta || {};
    const rounds = session.rounds || {};
    const roundKeys = Object.keys(rounds).filter(k => rounds[k] && typeof rounds[k] === 'object');
    const date = meta.createdAt ? new Date(meta.createdAt).toLocaleString() : 'Unknown date';
    const status = meta.status || 'unknown';

    const item = document.createElement('div');
    item.className = 'session-item';
    item.innerHTML = `
      <div class="session-date">${date}</div>
      <div class="session-meta">${roundKeys.length} round(s) · ${status}</div>
      <div class="session-rounds" style="display:none;"></div>
    `;

    // Toggle rounds on click
    item.addEventListener('click', (e) => {
      if (e.target.closest('.round-item')) return;
      const roundsDiv = item.querySelector('.session-rounds');
      const wasOpen = roundsDiv.style.display !== 'none';
      // Close all
      list.querySelectorAll('.session-rounds').forEach(r => r.style.display = 'none');
      list.querySelectorAll('.session-item').forEach(r => r.classList.remove('active'));
      if (!wasOpen) {
        roundsDiv.style.display = 'block';
        item.classList.add('active');
      }
    });

    // Add round items
    const roundsDiv = item.querySelector('.session-rounds');
    for (const rn of roundKeys.sort((a, b) => Number(a) - Number(b))) {
      const rd = rounds[rn];
      const rstatus = rd.status || 'unknown';
      const ri = document.createElement('div');
      ri.className = 'round-item';
      ri.innerHTML = `<span>Round ${rn}</span><span class="round-status ${rstatus}">${rstatus}</span>`;
      ri.addEventListener('click', () => {
        list.querySelectorAll('.round-item').forEach(r => r.classList.remove('active'));
        ri.classList.add('active');
        loadRound(sid, rn);
      });
      roundsDiv.appendChild(ri);
    }

    list.appendChild(item);
  }
});

// === Load Round ===
async function loadRound(sessionId, roundNum) {
  document.getElementById('empty-state').style.display = 'none';
  document.getElementById('viewer').style.display = 'flex';
  document.getElementById('viewer-title').textContent = `Session ${sessionId.split('_').pop()} — Round ${roundNum}`;
  document.getElementById('viewer-status').textContent = 'Loading...';

  // Destroy existing charts
  Object.values(charts).forEach(c => { try { c.destroy(); } catch(e) {} });
  charts = {};

  try {
    // Load video URL from Storage
    const videoRef = storage.ref(`sessions/${sessionId}/round_${roundNum}.mp4`);
    const videoUrl = await videoRef.getDownloadURL();
    const player = document.getElementById('player');
    player.src = videoUrl;

    // Load debug JSON from Storage
    let debugData = null;
    try {
      const debugRef = storage.ref(`sessions/${sessionId}/round_${roundNum}_debug.json`);
      const debugUrl = await debugRef.getDownloadURL();
      const resp = await fetch(debugUrl);
      debugData = await resp.json();
    } catch (e) {
      console.warn('No debug JSON found, viewer will have limited data:', e.code || e.message);
    }

    D = debugData;
    currentFrame = 0;

    if (D) {
      document.getElementById('frame-total').textContent = D.total_frames;
      document.getElementById('viewer-status').textContent =
        D.summary || `${D.total_frames} frames @ ${D.fps} fps`;
      initOverlays();
      initCharts();
      initThresholds();
    } else {
      document.getElementById('viewer-status').textContent = 'Video only (no debug data)';
    }

    // Wait for video to load
    player.addEventListener('loadedmetadata', () => {
      resizeCanvas();
      seekToFrame(0);
    }, { once: true });

  } catch (e) {
    document.getElementById('viewer-status').textContent = 'Error: ' + (e.code || e.message);
    console.error('Failed to load round:', e);
  }
}

// === Video Controls ===
const player = document.getElementById('player');
const canvas = document.getElementById('skeleton-canvas');
const ctx = canvas.getContext('2d');

function resizeCanvas() {
  const container = document.getElementById('video-container');
  canvas.width = container.clientWidth;
  canvas.height = container.clientHeight;
}
window.addEventListener('resize', resizeCanvas);

function getVideoRect() {
  const container = document.getElementById('video-container');
  const cw = container.clientWidth, ch = container.clientHeight;
  if (!D || !player.videoWidth) return { offsetX: 0, offsetY: 0, renderW: cw, renderH: ch, scaleX: 1, scaleY: 1 };
  const vw = D.video_width || player.videoWidth;
  const vh = D.video_height || player.videoHeight;
  const scale = Math.min(cw / vw, ch / vh);
  const rw = vw * scale, rh = vh * scale;
  return { offsetX: (cw - rw) / 2, offsetY: (ch - rh) / 2, renderW: rw, renderH: rh, scaleX: rw / vw, scaleY: rh / vh };
}

function seekToFrame(f) {
  if (!D) return;
  currentFrame = Math.max(0, Math.min(D.total_frames - 1, f));
  player.currentTime = currentFrame / D.fps;
  updateDisplay();
}

function updateDisplay() {
  document.getElementById('frame-num').textContent = currentFrame;
  if (D) document.getElementById('frame-time').textContent = (currentFrame / D.fps).toFixed(2) + 's';
  if (document.getElementById('tog-skeleton').checked) drawSkeleton(currentFrame);
  else ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (document.getElementById('tog-inspector').checked) updateInspector(currentFrame);
  Object.values(charts).forEach(c => { try { c.update('none'); } catch(e) {} });
}

// Use requestVideoFrameCallback for frame-accurate skeleton sync during playback
if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
  function onVideoFrame(now, metadata) {
    if (!D) { player.requestVideoFrameCallback(onVideoFrame); return; }
    currentFrame = Math.round(metadata.mediaTime * D.fps);
    if (currentFrame >= D.total_frames) currentFrame = D.total_frames - 1;
    updateDisplay();
    player.requestVideoFrameCallback(onVideoFrame);
  }
  player.requestVideoFrameCallback(onVideoFrame);
} else {
  // Fallback for older browsers
  player.addEventListener('timeupdate', () => {
    if (!D) return;
    currentFrame = Math.round(player.currentTime * D.fps);
    if (currentFrame >= D.total_frames) currentFrame = D.total_frames - 1;
    updateDisplay();
  });
}

document.getElementById('btn-play').addEventListener('click', () => {
  if (player.paused) { player.play(); document.getElementById('btn-play').textContent = 'Pause'; }
  else { player.pause(); document.getElementById('btn-play').textContent = 'Play'; }
});
document.getElementById('btn-prev').addEventListener('click', () => { player.pause(); seekToFrame(currentFrame - 1); });
document.getElementById('btn-next').addEventListener('click', () => { player.pause(); seekToFrame(currentFrame + 1); });

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.key === 'ArrowLeft') { player.pause(); seekToFrame(currentFrame - 1); e.preventDefault(); }
  if (e.key === 'ArrowRight') { player.pause(); seekToFrame(currentFrame + 1); e.preventDefault(); }
  if (e.key === ' ') { document.getElementById('btn-play').click(); e.preventDefault(); }
});

// === Skeleton Overlay ===
function drawSkeleton(fi) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!D || fi >= D.skeleton_frames.length) return;

  const flat = D.skeleton_frames[fi];
  const conf = D.confidences[fi];
  const vr = getVideoRect();

  // Bones
  ctx.lineWidth = 2;
  for (const [a, b] of BONES) {
    const ax = flat[a*2] * vr.scaleX + vr.offsetX, ay = flat[a*2+1] * vr.scaleY + vr.offsetY;
    const bx = flat[b*2] * vr.scaleX + vr.offsetX, by = flat[b*2+1] * vr.scaleY + vr.offsetY;
    if (flat[a*2] === 0 && flat[a*2+1] === 0) continue;
    if (flat[b*2] === 0 && flat[b*2+1] === 0) continue;
    const mc = Math.min(conf[a], conf[b]);
    ctx.strokeStyle = mc > 0.5 ? '#4ade80' : mc > 0.3 ? '#facc15' : '#ef4444';
    ctx.globalAlpha = 0.7;
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
  }

  // Joints
  ctx.globalAlpha = 1;
  for (let j = 0; j < 13; j++) {
    const x = flat[j*2] * vr.scaleX + vr.offsetX;
    const y = flat[j*2+1] * vr.scaleY + vr.offsetY;
    if (flat[j*2] === 0 && flat[j*2+1] === 0) continue;
    const c = conf[j], r = c > 0.5 ? 5 : 3;
    ctx.fillStyle = c > 0.8 ? '#4ade80' : c > 0.5 ? '#facc15' : '#ef4444';
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.stroke();
  }

  // Draw stance width measurement lines (ankle width + torso height normalization)
  const swRule = D.rules?.stance_width;
  const swToggle = document.getElementById('tog-ratio');
  if (swRule && swToggle && swToggle.checked) {
    const swDet = swRule.details || {};
    const swRatio = (swDet.per_frame_sep_ratio || [])[fi];

    const hasAnkles = !(flat[22] === 0 && flat[23] === 0) && !(flat[24] === 0 && flat[25] === 0);
    const hasShoulder = !(flat[2] === 0 && flat[3] === 0) && !(flat[4] === 0 && flat[5] === 0);
    const hasHips = !(flat[14] === 0 && flat[15] === 0) && !(flat[16] === 0 && flat[17] === 0);

    ctx.globalAlpha = 0.9;

    // Torso height: shoulder midpoint -> hip midpoint (normalization line)
    if (hasShoulder && hasHips) {
      const smx = (flat[2] * vr.scaleX + vr.offsetX + flat[4] * vr.scaleX + vr.offsetX) / 2;
      const smy = (flat[3] * vr.scaleY + vr.offsetY + flat[5] * vr.scaleY + vr.offsetY) / 2;
      const hmx = (flat[14] * vr.scaleX + vr.offsetX + flat[16] * vr.scaleX + vr.offsetX) / 2;
      const hmy = (flat[15] * vr.scaleY + vr.offsetY + flat[17] * vr.scaleY + vr.offsetY) / 2;
      ctx.strokeStyle = '#FFD54F'; ctx.lineWidth = 2.5; ctx.setLineDash([6, 4]);
      ctx.beginPath(); ctx.moveTo(smx, smy); ctx.lineTo(hmx, hmy); ctx.stroke();
      ctx.setLineDash([]);
      const tx = (smx + hmx) / 2 + 8, ty = (smy + hmy) / 2;
      ctx.font = 'bold 11px sans-serif';
      ctx.fillStyle = '#000'; ctx.fillText('Torso H', tx + 1, ty + 1);
      ctx.fillStyle = '#FFD54F'; ctx.fillText('Torso H', tx, ty);
    }

    // Ankle-to-ankle width line
    if (hasAnkles) {
      const lax = flat[22] * vr.scaleX + vr.offsetX, lay = flat[23] * vr.scaleY + vr.offsetY;
      const rax = flat[24] * vr.scaleX + vr.offsetX, ray = flat[25] * vr.scaleY + vr.offsetY;
      const threshEl = document.getElementById('stance-thresh');
      const thresh = threshEl ? parseFloat(threshEl.value) : 0.5;
      const isNarrow = swRatio != null && !isNaN(swRatio) && swRatio < thresh;
      const lineColor = isNarrow ? '#ef4444' : '#4FC3F7';

      ctx.strokeStyle = lineColor; ctx.lineWidth = 2.5; ctx.setLineDash([6, 4]);
      ctx.beginPath(); ctx.moveTo(lax, lay); ctx.lineTo(rax, ray); ctx.stroke();
      ctx.setLineDash([]);

      const mx = (lax + rax) / 2, my = (lay + ray) / 2 - 10;
      const label = swRatio != null && !isNaN(swRatio) ? 'Sep: ' + swRatio.toFixed(2) : 'Sep: N/A';
      ctx.font = 'bold 12px sans-serif';
      ctx.fillStyle = '#000'; ctx.fillText(label, mx - 20 + 1, my + 1);
      ctx.fillStyle = lineColor; ctx.fillText(label, mx - 20, my);
    }

    ctx.globalAlpha = 1;
  }
}

function initOverlays() {
  resizeCanvas();
}

// === Charts ===
function initCharts() {
  if (!D) return;
  const totalFrames = D.total_frames;
  const maxPts = 2000;
  const step = Math.max(1, Math.floor(totalFrames / maxPts));

  const labels = [];
  for (let i = 0; i < totalFrames; i += step) labels.push(i);

  // Frame line plugin (shared)
  const frameLinePlugin = {
    id: 'frameLine',
    afterDraw(chart) {
      const xScale = chart.scales.x;
      const nearest = labels.reduce((b, v, i) => Math.abs(v - currentFrame) < Math.abs(labels[b] - currentFrame) ? i : b, 0);
      const x = xScale.getPixelForValue(labels[nearest]);
      chart.ctx.save();
      chart.ctx.strokeStyle = '#fff'; chart.ctx.lineWidth = 1;
      chart.ctx.beginPath(); chart.ctx.moveTo(x, chart.chartArea.top); chart.ctx.lineTo(x, chart.chartArea.bottom); chart.ctx.stroke();
      chart.ctx.restore();
    }
  };

  const clickHandler = (chart) => ({
    onClick: (evt) => {
      const pts = chart.getElementsAtEventForMode(evt, 'index', { intersect: false }, false);
      if (pts.length) { player.pause(); seekToFrame(labels[pts[0].index]); }
    }
  });

  // Punch confidence chart — show lead + rear punch probability
  if (D.punch) {
    const leadProbs = D.punch.per_frame_lead_probs || [];
    const rearProbs = D.punch.per_frame_rear_probs || [];
    const leadData = [], rearData = [];
    for (let i = 0; i < totalFrames; i += step) {
      // Punch prob = class 1 + class 2 (everything except idle)
      const lp = leadProbs[i] ? (leadProbs[i][1] || 0) + (leadProbs[i][2] || 0) : 0;
      const rp = rearProbs[i] ? (rearProbs[i][1] || 0) + (rearProbs[i][2] || 0) : 0;
      leadData.push(lp);
      rearData.push(rp);
    }

    charts.punch = new Chart(document.getElementById('punch-chart'), {
      type: 'line',
      data: { labels, datasets: [
        { label: 'Lead (jab/power)', data: leadData, borderColor: '#4FC3F7', borderWidth: 1.5, pointRadius: 0, tension: 0, fill: { target: 'origin', above: 'rgba(79,195,247,0.1)' } },
        { label: 'Rear (cross/power)', data: rearData, borderColor: '#FF7043', borderWidth: 1.5, pointRadius: 0, tension: 0, fill: { target: 'origin', above: 'rgba(255,112,67,0.1)' } },
      ]},
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        plugins: {
          legend: { display: true, labels: { color: '#888', boxWidth: 12, font: { size: 10 } } },
          tooltip: { callbacks: {
            title: (items) => 'Frame ' + labels[items[0].dataIndex],
            label: (item) => {
              const fi = labels[item.dataIndex];
              const lp = leadProbs[fi], rp = rearProbs[fi];
              if (item.datasetIndex === 0) {
                const cls1 = (lp && lp[1] || 0).toFixed(2), cls2 = (lp && lp[2] || 0).toFixed(2);
                return `Lead: straight=${cls1} power=${cls2}`;
              } else {
                const cls1 = (rp && rp[1] || 0).toFixed(2), cls2 = (rp && rp[2] || 0).toFixed(2);
                return `Rear: straight=${cls1} power=${cls2}`;
              }
            }
          }}
        },
        scales: {
          x: { display: false },
          y: { min: 0, max: 1, grid: { color: '#222' }, ticks: { color: '#666', font: { size: 10 } },
               title: { display: true, text: 'Punch Prob', color: '#666', font: { size: 10 } } }
        },
        onClick: (evt) => {
          const pts = charts.punch.getElementsAtEventForMode(evt, 'index', { intersect: false }, false);
          if (pts.length) { player.pause(); seekToFrame(labels[pts[0].index]); }
        }
      },
      plugins: [{
        id: 'punchThreshLine',
        afterDraw(chart) {
          const t = parseFloat(document.getElementById('punch-thresh').value);
          const y = chart.scales.y.getPixelForValue(t);
          chart.ctx.save();
          chart.ctx.strokeStyle = '#ef4444'; chart.ctx.lineWidth = 2; chart.ctx.setLineDash([6, 3]);
          chart.ctx.beginPath(); chart.ctx.moveTo(chart.chartArea.left, y); chart.ctx.lineTo(chart.chartArea.right, y); chart.ctx.stroke();
          chart.ctx.fillStyle = '#ef4444'; chart.ctx.font = '10px sans-serif';
          chart.ctx.fillText('threshold ' + t.toFixed(2), chart.chartArea.left + 4, y - 4);
          chart.ctx.restore();
        }
      }, frameLinePlugin]
    });
  }

  // Punch detection strip
  drawPunchStrip();

  // Stance width ratio chart
  const rule = D.rules?.stance_width;
  const det = rule?.details || {};
  const sepRatio = det.per_frame_sep_ratio || [];
  const confMin = det.per_frame_confidence_min || [];
  const filterStage = det.filter_stage || [];

  if (sepRatio.length > 0) {
    const ratioData = [], confData = [];
    for (let i = 0; i < totalFrames; i += step) {
      const r = sepRatio[i]; ratioData.push(r == null || isNaN(r) ? null : r);
      confData.push(confMin[i] || 0);
    }

    charts.ratio = new Chart(document.getElementById('ratio-chart'), {
      type: 'line',
      data: { labels, datasets: [{ label: 'Sep Ratio', data: ratioData, borderColor: '#60a5fa', borderWidth: 1.5, pointRadius: 0, tension: 0 }] },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        plugins: { legend: { display: false } },
        scales: { x: { display: false }, y: { min: 0, max: 1.5, grid: { color: '#222' }, ticks: { color: '#666', font: { size: 10 } } } },
        onClick: (evt) => { const pts = charts.ratio.getElementsAtEventForMode(evt, 'index', { intersect: false }, false); if (pts.length) { player.pause(); seekToFrame(labels[pts[0].index]); } }
      },
      plugins: [{
        id: 'stanceThreshLine',
        afterDraw(chart) {
          const t = parseFloat(document.getElementById('stance-thresh').value);
          const y = chart.scales.y.getPixelForValue(t);
          chart.ctx.save(); chart.ctx.strokeStyle = '#ef4444'; chart.ctx.lineWidth = 2; chart.ctx.setLineDash([6, 3]);
          chart.ctx.beginPath(); chart.ctx.moveTo(chart.chartArea.left, y); chart.ctx.lineTo(chart.chartArea.right, y); chart.ctx.stroke(); chart.ctx.restore();
        }
      }, frameLinePlugin]
    });

    charts.conf = new Chart(document.getElementById('conf-chart'), {
      type: 'line',
      data: { labels, datasets: [{ label: 'Min Confidence', data: confData, borderColor: '#a78bfa', borderWidth: 1.5, pointRadius: 0, tension: 0 }] },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        plugins: { legend: { display: false } },
        scales: { x: { display: false }, y: { min: 0, max: 1, grid: { color: '#222' }, ticks: { color: '#666', font: { size: 10 } } } },
        onClick: (evt) => { const pts = charts.conf.getElementsAtEventForMode(evt, 'index', { intersect: false }, false); if (pts.length) { player.pause(); seekToFrame(labels[pts[0].index]); } }
      },
      plugins: [frameLinePlugin]
    });

    // Filter strip
    drawFilterStrip(filterStage, totalFrames);
  }
}

// === Strips ===
function drawPunchStrip() {
  const c = document.getElementById('punch-strip');
  const ctx2 = c.getContext('2d');
  c.width = c.parentElement.clientWidth; c.height = 24;
  ctx2.fillStyle = '#181818'; ctx2.fillRect(0, 0, c.width, 24);

  if (!D?.punch_detections) return;
  const w = c.width, fps = D.fps, total = D.total_frames;
  const CAT_COLORS = { jab: '#4FC3F7', cross: '#FF7043', power: '#66BB6A' };
  for (const det of D.punch_detections) {
    const x1 = Math.floor(det.start_time * fps / total * w);
    const x2 = Math.ceil(det.end_time * fps / total * w);
    ctx2.fillStyle = CAT_COLORS[det.category] || '#888';
    ctx2.fillRect(x1, 0, Math.max(3, x2 - x1), 24);
    ctx2.fillStyle = '#fff'; ctx2.font = '9px sans-serif';
    const label = (det.hand === 'lead' ? 'L' : 'R') + ' ' + (det.category || det.punch_type);
    ctx2.fillText(label, x1 + 2, 15);
  }

  c.onclick = (e) => {
    const rect = c.getBoundingClientRect();
    seekToFrame(Math.floor((e.clientX - rect.left) / rect.width * D.total_frames));
    player.pause();
  };
}

function drawFilterStrip(filterStage, totalFrames) {
  const c = document.getElementById('filter-strip');
  const ctx2 = c.getContext('2d');
  c.width = c.parentElement.clientWidth; c.height = 24;
  for (let x = 0; x < c.width; x++) {
    const fi = Math.floor(x / c.width * totalFrames);
    ctx2.fillStyle = STAGE_COLORS[filterStage[fi]] || '#222';
    ctx2.fillRect(x, 0, 1, 24);
  }
  c.onclick = (e) => {
    const rect = c.getBoundingClientRect();
    seekToFrame(Math.floor((e.clientX - rect.left) / rect.width * totalFrames));
    player.pause();
  };
}

// === Thresholds ===
function initThresholds() {
  if (!D) return;

  // Punch threshold
  const pSlider = document.getElementById('punch-thresh');
  const pVal = document.getElementById('punch-thresh-val');
  const pCount = document.getElementById('punch-thresh-count');
  if (D.punch) {
    pSlider.value = D.punch.confidence_threshold || 0.3;
    pVal.textContent = parseFloat(pSlider.value).toFixed(2);
  }
  function updatePunchThresh() {
    const t = parseFloat(pSlider.value);
    pVal.textContent = t.toFixed(2);
    if (!D.punch) return;
    const lp = D.punch.per_frame_lead_probs || [];
    const rp = D.punch.per_frame_rear_probs || [];
    let leadCount = 0, rearCount = 0;
    for (let i = 0; i < lp.length; i++) {
      if (lp[i] && (lp[i][1] + lp[i][2]) >= t) leadCount++;
      if (rp[i] && (rp[i][1] + rp[i][2]) >= t) rearCount++;
    }
    pCount.textContent = `${leadCount} lead + ${rearCount} rear frames`;
    if (charts.punch) charts.punch.update('none');
  }
  pSlider.oninput = updatePunchThresh;
  updatePunchThresh();

  // Stance threshold
  const rule = D.rules?.stance_width;
  const det = rule?.details || {};
  const sepRatio = det.per_frame_sep_ratio || [];
  const filterStage = det.filter_stage || [];
  if (sepRatio.length > 0) {
    document.getElementById('stance-thresh-row').style.display = 'flex';
    const sSlider = document.getElementById('stance-thresh');
    const sVal = document.getElementById('stance-thresh-val');
    const sCount = document.getElementById('stance-thresh-count');
    const configThresh = D.config?.stance_width?.params?.narrow_threshold || 0.5;
    sSlider.value = configThresh;
    sVal.textContent = configThresh;

    function updateStanceThresh() {
      const t = parseFloat(sSlider.value);
      sVal.textContent = t.toFixed(2);
      let violations = 0, valid = 0;
      for (let i = 0; i < D.total_frames; i++) {
        if (filterStage[i] >= 3) { valid++; const r = sepRatio[i]; if (r != null && !isNaN(r) && r < t) violations++; }
      }
      const pct = valid > 0 ? (violations / valid * 100).toFixed(1) : 0;
      sCount.textContent = violations + '/' + valid + ' (' + pct + '%)';
      if (charts.ratio) charts.ratio.update('none');
    }
    sSlider.oninput = updateStanceThresh;
    updateStanceThresh();
  }
}

// === Inspector ===
function updateInspector(fi) {
  if (!D || fi >= D.skeleton_frames.length) return;
  const flat = D.skeleton_frames[fi];
  const conf = D.confidences[fi];

  const rule = D.rules?.stance_width?.details || {};
  const sr = (rule.per_frame_sep_ratio || [])[fi];
  const cm = (rule.per_frame_confidence_min || [])[fi];
  const th = (rule.per_frame_torso_height || [])[fi];
  const stage = (rule.filter_stage || [])[fi];

  // Punch info for this frame
  let punchInfo = '';
  if (D.punch) {
    const lp = (D.punch.per_frame_lead_probs || [])[fi];
    const rp = (D.punch.per_frame_rear_probs || [])[fi];
    if (lp) {
      const lpunch = (lp[1] + lp[2]).toFixed(2);
      punchInfo += `<b>Lead:</b> ${lpunch} (str=${lp[1].toFixed(2)} pwr=${lp[2].toFixed(2)}) &nbsp;`;
    }
    if (rp) {
      const rpunch = (rp[1] + rp[2]).toFixed(2);
      punchInfo += `<b>Rear:</b> ${rpunch} (str=${rp[1].toFixed(2)} pwr=${rp[2].toFixed(2)}) &nbsp;`;
    }
  }

  let rows = '';
  for (let j = 0; j < 13; j++) {
    const c = conf[j];
    const cls = c > 0.8 ? 'conf-high' : c > 0.5 ? 'conf-mid' : 'conf-low';
    rows += `<tr><th>${JOINT_NAMES[j]}</th><td>${flat[j*2].toFixed(1)}</td><td>${flat[j*2+1].toFixed(1)}</td><td class="${cls}">${c.toFixed(3)}</td></tr>`;
  }

  const srD = sr == null || isNaN(sr) ? 'N/A' : sr.toFixed(4);
  const thD = th == null || isNaN(th) ? 'N/A' : th.toFixed(1);

  document.getElementById('inspector-content').innerHTML = `
    <div style="margin-bottom:6px;">
      ${punchInfo}
      <b>Sep Ratio:</b> ${srD} &nbsp; <b>Torso H:</b> ${thD} &nbsp; <b>Min Conf:</b> ${(cm||0).toFixed(3)}
    </div>
    ${stage !== undefined ? `<div style="margin-bottom:6px; padding:2px 8px; border-radius:4px; font-size:11px; display:inline-block; background:${STAGE_COLORS[stage] || '#333'}">${STAGE_NAMES[stage] || 'unknown'}</div>` : ''}
    <table><tr><th>Joint</th><th>X</th><th>Y</th><th>Conf</th></tr>${rows}</table>
  `;
}

// === Toggle handlers ===
function setupToggles() {
  const map = {
    'tog-skeleton': null, // handled in updateDisplay
    'tog-punch-chart': 'punch-chart-wrap',
    'tog-punch-strip': 'punch-strip-wrap',
    'tog-ratio': 'ratio-chart-wrap',
    'tog-conf': 'conf-chart-wrap',
    'tog-filter': 'filter-strip-wrap',
    'tog-inspector': 'inspector',
  };

  // Also show stance threshold row when ratio chart is toggled
  for (const [togId, wrapId] of Object.entries(map)) {
    const tog = document.getElementById(togId);
    tog.addEventListener('change', () => {
      if (wrapId) {
        document.getElementById(wrapId).style.display = tog.checked ? '' : 'none';
      }
      if (togId === 'tog-ratio') {
        document.getElementById('stance-thresh-row').style.display =
          tog.checked && D?.rules?.stance_width ? 'flex' : 'none';
      }
      if (togId === 'tog-skeleton') updateDisplay();
    });
  }
}
setupToggles();

// Redraw strips on resize
window.addEventListener('resize', () => {
  if (D) {
    drawPunchStrip();
    const fs = D.rules?.stance_width?.details?.filter_stage || [];
    if (fs.length) drawFilterStrip(fs, D.total_frames);
  }
});
