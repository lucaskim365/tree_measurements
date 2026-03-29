/**
 * app-3p.js — 3점 단일 프레임 측정 컨트롤러
 *
 * 상태 머신:
 *   SCANNING  → QR 코드를 찾는 중
 *   FRAMING   → QR 발견, f/d 보정 수집, 사용자가 뒤로 물러남
 *   MEASURING → 프레임 고정 후 3점 터치 수집
 *   DONE      → 계산 완료, result.html 이동
 *
 * 사용하는 외부 모듈:
 *   Camera (../js/camera.js 상위)  → 카메라 관리
 *   Homography (homography.js)     → 수학 계산
 *   jsQR (../../js/jsqr.min.js)    → QR 감지
 */

/* ── DOM 유틸 ── */
const $ = id => document.getElementById(id);

/* ── 상수 ── */
const DETECT_W = 640, DETECT_H = 480;
const F_EMA_ALPHA       = 0.2;   // EMA 감쇠
const F_MIN_SAMPLES     = 8;     // 프레임 고정에 필요한 최소 샘플
const F_OUTLIER_DELTA   = 80;    // 이상치 임계값 (px)
const F_BUFFER_MAX      = 30;    // 버퍼 최대 크기
const QR_SMALL_THRESH   = 80;    // px 이하이면 신뢰도 낮음

const PHASE_LABELS = ['꼭대기를 터치하세요 (1/3)', '밑동을 터치하세요 (2/3)', '수관 끝을 터치하세요 (3/3)'];
const POINT_LABELS = ['①꼭대기', '②밑동', '③수관끝'];

/* ── 상태 변수 ── */
let state = 'scanning';

let fBuffer = [];     // f 샘플 버퍼
let fEma    = null;   // EMA f
let dCurrent = 0;     // 현재 거리 (m)
let qrLostSince = 0;  // QR 소실 시작 시각

let fLock    = null;       // 잠금 초점거리
let dLock    = null;       // 잠금 거리
let rCapture = null;       // 잠금 R_device_to_world

let orientation = { alpha: 0, beta: 90, gamma: 0 };
let orientReady = false;

let worldPoints  = [];   // 세계 좌표 [{x,y,z}]
let screenPoints = [];   // 화면 좌표 [{sx,sy}]

let gps = null;

/* ── 내부 캔버스 & RAF ── */
let detectCanvas, detectCtx;
let rafId = null;
let toastTimer = null;

/* ════════════════════════════════
   초기화
   ════════════════════════════════ */
window.addEventListener('DOMContentLoaded', async () => {
    detectCanvas = document.createElement('canvas');
    detectCanvas.width  = DETECT_W;
    detectCanvas.height = DETECT_H;
    detectCtx = detectCanvas.getContext('2d', { willReadFrequently: true });

    setupUI();
    setState('scanning');
    setupOrientation();
    setupGPS();
    await startCamera();
});

window.addEventListener('beforeunload', () => {
    Camera.stop();
    if (rafId) cancelAnimationFrame(rafId);
});

/* ════════════════════════════════
   카메라
   ════════════════════════════════ */
async function startCamera() {
    try {
        await Camera.init($('cameraVideo'));
        $('cameraVideo').style.display = 'block';
        $('loadingScreen').classList.add('hidden');
        startRAF();
    } catch (err) {
        showError('카메라 접근 실패: ' + (err.message || err));
    }
}

/* ════════════════════════════════
   RAF 루프 — QR 감지 & 오버레이
   ════════════════════════════════ */
function startRAF() {
    function loop() {
        rafId = requestAnimationFrame(loop);
        const video = $('cameraVideo');
        if (!video || video.readyState < 2 || !video.videoWidth) return;

        detectCtx.drawImage(video, 0, 0, DETECT_W, DETECT_H);
        const imgData = detectCtx.getImageData(0, 0, DETECT_W, DETECT_H);

        let code = null;
        try {
            code = jsQR(imgData.data, DETECT_W, DETECT_H, { inversionAttempts: 'attemptBoth' });
        } catch (_) {}

        if (code) {
            qrLostSince = 0;
            handleQR(code, video.videoWidth, video.videoHeight);
        } else {
            handleNoQR();
        }
    }
    loop();
}

/* ════════════════════════════════
   QR 처리
   ════════════════════════════════ */
function handleQR(code, vw, vh) {
    if (state !== 'scanning' && state !== 'framing') return;

    const res = Homography.processQR(code, vw, vh);

    if (!res) {
        // 너무 작음 — 현재 값 유지
        updateStatusBadge('warning', '너무 가까움 — 뒤로 물러나세요');
        drawQROutline(code, vw, vh, '#f0a500');
        return;
    }

    const { f, d } = res;
    dCurrent = d;

    // f 이상치 필터 & 버퍼 업데이트
    const fAvg = fBuffer.length > 0
        ? fBuffer.reduce((s,v)=>s+v,0) / fBuffer.length
        : f;

    if (fBuffer.length === 0 || Math.abs(f - fAvg) < F_OUTLIER_DELTA) {
        fBuffer.push(f);
        if (fBuffer.length > F_BUFFER_MAX) fBuffer.shift();
        fEma = fEma === null ? f : F_EMA_ALPHA*f + (1-F_EMA_ALPHA)*fEma;
    }

    if (state === 'scanning') setState('framing');
    updateFramingUI();
    drawQROutline(code, vw, vh, '#6c8cff');
}

function handleNoQR() {
    if (state !== 'framing') return;
    if (!qrLostSince) qrLostSince = Date.now();

    clearOverlay();
    const sec = ((Date.now() - qrLostSince) / 1000).toFixed(0);
    updateStatusBadge('lost', `QR 소실 (${sec}s) — 마지막 값 유지`);
}

/* ════════════════════════════════
   프레임 고정
   ════════════════════════════════ */
function lockFrame() {
    if (fBuffer.length < F_MIN_SAMPLES) {
        showToast(`아직 보정 중입니다 (${fBuffer.length}/${F_MIN_SAMPLES}). QR 코드를 더 비춰주세요.`);
        return;
    }

    fLock    = fBuffer.reduce((s,v)=>s+v,0) / fBuffer.length;
    dLock    = dCurrent;
    rCapture = Homography.buildDeviceToWorld(
        orientation.alpha, orientation.beta, orientation.gamma
    );

    clearOverlay();
    setState('measuring');
    showToast(`보정 완료 — f ${fLock.toFixed(0)}px · d ${dLock.toFixed(2)}m`);
}

/* ════════════════════════════════
   터치 핸들러
   ════════════════════════════════ */
function onTouch(e) {
    if (state !== 'measuring') return;
    if (worldPoints.length >= 3) return;

    e.preventDefault();
    const sx = e.clientX, sy = e.clientY;

    const { vx, vy } = screenToVideo(sx, sy);
    const video = $('cameraVideo');
    const vw = video.videoWidth  || DETECT_W;
    const vh = video.videoHeight || DETECT_H;

    const pt = Homography.intersectTreePlane(
        vx, vy, fLock, vw/2, vh/2, rCapture, dLock
    );

    if (!pt) {
        showToast('계산 실패 — 다시 터치하세요');
        return;
    }

    worldPoints.push(pt);
    screenPoints.push({ sx, sy });

    addTouchDot(sx, sy, worldPoints.length);
    updateMeasuringUI();

    if (worldPoints.length === 3) {
        setTimeout(computeResult, 250);
    }
}

/* ── 화면 → 비디오 픽셀 (object-fit: cover 보정) ── */
function screenToVideo(sx, sy) {
    const video = $('cameraVideo');
    const vw = video.videoWidth  || DETECT_W;
    const vh = video.videoHeight || DETECT_H;
    const sw = window.innerWidth, sh = window.innerHeight;

    const scale = Math.max(sw/vw, sh/vh);
    const ox = (sw - vw*scale) / 2;
    const oy = (sh - vh*scale) / 2;

    return { vx: (sx-ox)/scale, vy: (sy-oy)/scale };
}

/* ════════════════════════════════
   결과 계산
   ════════════════════════════════ */
function computeResult() {
    const [p1, p2, p3] = worldPoints;  // 꼭대기, 밑동, 수관끝

    // 높이: z축 차이 (수직)
    const height = Math.abs(p1.z - p2.z);

    // 수관폭: trunk 중심 y 기준 × 2
    const trunkY = (p1.y + p2.y) / 2;
    const width  = Math.abs(p3.y - trunkY) * 2;

    const payload = {
        mode: '3point',
        height:      Math.round(height * 100) / 100,
        width:       Math.round(width  * 100) / 100,
        distance:    Math.round(dLock  * 100) / 100,
        focalLength: Math.round(fLock),
        gps,
        worldPoints,
        orientationUsed: orientReady,
        timestamp: Date.now(),
    };

    try {
        sessionStorage.setItem('measurementResult', JSON.stringify(payload));
    } catch (_) {
        const slim = { ...payload, worldPoints: undefined };
        sessionStorage.setItem('measurementResult', JSON.stringify(slim));
    }

    Camera.stop();
    if (rafId) cancelAnimationFrame(rafId);
    window.location.href = '../result.html';
}

/* ════════════════════════════════
   리셋
   ════════════════════════════════ */
function resetAll() {
    worldPoints  = [];
    screenPoints = [];
    fBuffer = [];
    fEma    = null;
    fLock = dLock = rCapture = null;
    qrLostSince = 0;
    clearOverlay();
    clearTouchDots();
    setState('scanning');
    startRAF();  // RAF가 중단됐을 수 있으므로 재시작
}

/* ════════════════════════════════
   상태 전환
   ════════════════════════════════ */
function setState(newState) {
    state = newState;

    $('lockBtn').style.display          = 'none';
    $('measurementDisplay').style.display = 'none';
    $('phaseBar').style.display         = 'none';
    $('distanceInfo').style.display     = 'none';
    $('fInfo').style.display            = 'none';

    switch (state) {
        case 'scanning':
            updateStatusBadge('scanning', 'QR 코드 검색 중...');
            $('guideText').textContent = '20×20cm QR 코드를 나무에 가까이 비추세요';
            break;

        case 'framing':
            updateStatusBadge('active', '보정 중...');
            $('guideText').textContent = '전체 나무가 보이도록 뒤로 물러나세요';
            $('lockBtn').style.display      = 'inline-flex';
            $('lockBtn').disabled = true;
            $('distanceInfo').style.display = 'block';
            $('fInfo').style.display        = 'block';
            break;

        case 'measuring':
            updateStatusBadge('active', '측정 중');
            $('measurementDisplay').style.display = 'block';
            $('phaseBar').style.display           = 'flex';
            updateMeasuringUI();
            break;
    }
}

/* ── UI 업데이트 ── */
function updateFramingUI() {
    const ready = fBuffer.length >= F_MIN_SAMPLES;
    $('lockBtn').disabled = !ready;

    if (ready) {
        updateStatusBadge('found', '준비 완료 ✓');
        $('guideText').textContent = '전체 나무가 보이면 [프레임 고정]을 누르세요';
    }

    $('distValue').textContent = dCurrent.toFixed(2) + ' m';
    $('fValue').textContent    = fEma ? fEma.toFixed(0) + ' px' : '—';
    $('fSamples').textContent  = fBuffer.length + '/' + F_MIN_SAMPLES;
}

function updateMeasuringUI() {
    const n = worldPoints.length;
    if (n < 3) {
        $('guideText').textContent = PHASE_LABELS[n];
        $('measureValue').textContent = '—';
        $('measureLabel').textContent = `포인트 ${n}/3`;
    } else {
        $('guideText').textContent = '계산 중...';
    }

    document.querySelectorAll('.phase-dot').forEach((dot, i) => {
        dot.className = 'phase-dot' + (i < n ? ' done' : '');
    });
}

function updateStatusBadge(type, text) {
    const badge = $('statusBadge');
    const map = {
        scanning: 'status-scanning',
        active:   'status-active',
        found:    'status-found',
        warning:  'status-warning',
        lost:     'status-lost',
    };
    badge.className = 'status-badge ' + (map[type] || 'status-scanning');
    $('statusText').textContent = text;
}

/* ════════════════════════════════
   오버레이 드로잉
   ════════════════════════════════ */
function drawQROutline(code, vw, vh, color) {
    const canvas = $('overlayCanvas');
    const ctx = canvas.getContext('2d');
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const sw = window.innerWidth, sh = window.innerHeight;
    const scale = Math.max(sw/vw, sh/vh);
    const ox = (sw - vw*scale) / 2;
    const oy = (sh - vh*scale) / 2;

    // detection canvas → video → screen 변환
    const scx = vw / DETECT_W, scy = vh / DETECT_H;
    const loc = code.location;
    const corners = [
        loc.topLeftCorner, loc.topRightCorner,
        loc.bottomRightCorner, loc.bottomLeftCorner,
    ];

    ctx.strokeStyle = color;
    ctx.lineWidth   = 3;
    ctx.shadowColor = color;
    ctx.shadowBlur  = 6;
    ctx.beginPath();
    corners.forEach((c, i) => {
        const x = c.x*scx*scale + ox;
        const y = c.y*scy*scale + oy;
        i === 0 ? ctx.moveTo(x,y) : ctx.lineTo(x,y);
    });
    ctx.closePath();
    ctx.stroke();
}

function clearOverlay() {
    const canvas = $('overlayCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function addTouchDot(sx, sy, index) {
    const container = $('touchPointsContainer');
    const div = document.createElement('div');
    div.className = 'touch-dot-3p';
    div.style.left = sx + 'px';
    div.style.top  = sy + 'px';
    div.textContent = POINT_LABELS[index-1];
    container.appendChild(div);
}

function clearTouchDots() {
    $('touchPointsContainer').innerHTML = '';
}

/* ════════════════════════════════
   DeviceOrientation
   ════════════════════════════════ */
function setupOrientation() {
    function attach() {
        window.addEventListener('deviceorientation', e => {
            if (e.beta !== null) {
                orientation.alpha = e.alpha || 0;
                orientation.beta  = e.beta  || 90;
                orientation.gamma = e.gamma || 0;
                orientReady = true;
            }
        });
    }

    if (typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function') {
        // iOS 13+
        const btn = $('orientPermBtn');
        btn.style.display = 'block';
        btn.addEventListener('click', async () => {
            try {
                const res = await DeviceOrientationEvent.requestPermission();
                if (res === 'granted') {
                    attach();
                    btn.style.display = 'none';
                    showToast('기울기 센서 활성화됨');
                }
            } catch(e) {
                btn.style.display = 'none';
                showToast('기울기 권한 거부 — 수평 가정으로 진행');
            }
        });
    } else {
        attach();
    }
}

/* ════════════════════════════════
   GPS
   ════════════════════════════════ */
function setupGPS() {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
        pos => { gps = { lat: pos.coords.latitude, lng: pos.coords.longitude,
                         accuracy: pos.coords.accuracy }; },
        () => {},
        { enableHighAccuracy: true, timeout: 10000 }
    );
}

/* ════════════════════════════════
   UI 설정
   ════════════════════════════════ */
function setupUI() {
    $('lockBtn').addEventListener('click',  lockFrame);
    $('resetBtn').addEventListener('click', resetAll);
    $('torchBtn').addEventListener('click', () => Camera.toggleTorch().catch(()=>{}));

    $('overlayCanvas').addEventListener('pointerdown', onTouch);
    $('overlayCanvas').addEventListener('touchstart',  e => e.preventDefault(), { passive: false });
}

/* ════════════════════════════════
   Toast & Error
   ════════════════════════════════ */
function showToast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}

function showError(msg) {
    $('loadingTitle').textContent = '오류 발생';
    $('loadingText').innerHTML    = msg;
    $('retryBtn').style.display   = 'block';
    $('retryBtn').onclick = () => location.reload();
    $('loadingScreen').classList.remove('hidden');
}
