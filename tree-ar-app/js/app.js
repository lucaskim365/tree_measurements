/**
 * app.js — Touch 측정 모드 컨트롤러
 *
 * 측정 방식: 화면 터치로 꼭대기/밑동(또는 좌/우) 지정
 * 흐름: 높이 측정 → 다음 → 폭 측정 → 종료 → result.html
 */

(function () {
    'use strict';

    const State = {
        LOADING:   'loading',
        SCANNING:  'scanning',
        READY:     'ready',
        MEASURING: 'measuring',
        DONE:      'done',
        ERROR:     'error',
    };

    let currentState = State.LOADING;
    let canvas, ctx;
    let animFrameId  = null;
    let torchOn      = false;
    let cameraTimeout = null;

    // QR 인식 시점에 잠금 — 카메라를 움직여도 유지됨
    let lockedQRData   = null;
    let lockedDistance = 0;

    // 2단계 측정: height → width
    let measurePhase = 'height';
    let heightResult = null;

    // QR 가이드 스캔 라인
    let scanLineY   = 0;
    let scanLineDir = 1;

    const $ = (id) => document.getElementById(id);

    // ===== Boot =====
    document.addEventListener('DOMContentLoaded', () => {
        $('retryBtn').addEventListener('click', () => window.location.reload());

        const videoEl = $('cameraVideo');

        Camera.init(videoEl)
            .then(() => {
                clearTimeout(cameraTimeout);
                onCameraReady(videoEl);
            })
            .catch((err) => {
                clearTimeout(cameraTimeout);
                if (err.name === 'NotAllowedError') {
                    showError('카메라 권한이 거부되었습니다. 브라우저 설정에서 카메라를 허용해 주세요.');
                } else {
                    showError(`카메라 초기화 실패: ${err.message}`);
                }
            });

        cameraTimeout = setTimeout(() => {
            if (currentState === State.LOADING) {
                showError('카메라 로딩 시간 초과. 권한 또는 연결을 확인하세요.');
            }
        }, 20000);
    });

    // ===== Camera Ready =====
    function onCameraReady(videoEl) {
        console.log('[App] 카메라 초기화 완료');
        if (location.protocol === 'file:') {
            showToast('⚠️ 로컬 파일 실행 중 — 서버 실행을 권장합니다');
            console.warn('[App] file:// 프로토콜: canvas.getImageData 차단 가능. localhost로 실행하세요.');
        }

        $('loadingScreen').classList.add('hidden');
        videoEl.style.display = '';

        canvas = $('overlayCanvas');
        canvas.width  = window.innerWidth;
        canvas.height = window.innerHeight;
        ctx = canvas.getContext('2d');

        const res = Camera.getResolution();
        Measure.init({
            videoWidth:   res.width  || window.innerWidth,
            videoHeight:  res.height || window.innerHeight,
            displayWidth:  window.innerWidth,
            displayHeight: window.innerHeight,
        });

        Detector.init({
            markerSize: 0.20,
            onFound: onMarkerFound,
            onLost:  onMarkerLost,
        });

        bindEvents();
        startUpdateLoop(videoEl);

        setState(State.SCANNING);
        showToast('📷 카메라 활성화 — QR 코드를 비추세요');
    }

    // ===== Events =====
    function bindEvents() {
        // 캡처 버튼 — 화면 중앙 포인트 추가
        $('captureBtn').addEventListener('click', (e) => {
            e.stopPropagation();
            $('captureBtn').classList.add('captured');
            setTimeout(() => $('captureBtn').classList.remove('captured'), 300);
            addTouchPoint(window.innerWidth / 2, window.innerHeight / 2);
        });

        // 화면 클릭으로 포인트 추가
        document.addEventListener('click', (e) => {
            if (e.target.closest('.ar-controls') ||
                e.target.closest('.ar-status-bar') ||
                e.target.closest('.overlay-screen')) return;
            if (currentState === State.READY || currentState === State.MEASURING) {
                addTouchPoint(e.clientX, e.clientY);
            }
        });

        // 터치 이벤트
        document.addEventListener('touchstart', (e) => {
            if (e.target.closest('.ar-controls') ||
                e.target.closest('.ar-status-bar') ||
                e.target.closest('.overlay-screen')) return;
            if (currentState === State.READY || currentState === State.MEASURING) {
                const touch = e.touches[0];
                addTouchPoint(touch.clientX, touch.clientY);
                e.preventDefault();
            }
        }, { passive: false });

        // 다음 버튼 (높이 완료 → 폭 측정)
        $('nextBtn').addEventListener('click', () => {
            $('nextBtn').style.display = 'none';
            measurePhase = 'width';
            Measure.setMode('width');
            Measure.reset();
            $('touchPointsContainer').innerHTML = '';
            $('measurementDisplay').classList.remove('active');
            setState(State.READY);
            $('guideText').textContent = '왼쪽 끝을 터치하세요';
            showToast('↔️ 폭 측정 — 왼쪽 → 오른쪽 순서로 터치하세요');
        });

        // 종료 버튼
        $('endBtn').addEventListener('click', () => {
            const widthMeasurement = getCurrentMeasurement();
            if (widthMeasurement && heightResult) {
                goToResult({
                    height:   heightResult.primary,
                    width:    widthMeasurement.primary,
                    distance: heightResult.distance,
                    gps:      widthMeasurement.gps || heightResult.gps,
                });
            } else if (widthMeasurement) {
                goToResult({
                    height:   null,
                    width:    widthMeasurement.primary,
                    distance: widthMeasurement.distance,
                    gps:      widthMeasurement.gps,
                });
            }
        });

        // 손전등
        $('torchBtn').addEventListener('click', async () => {
            try {
                const result = await Camera.toggleTorch();
                if (result === false && !torchOn) {
                    showToast('이 기기는 플래시를 지원하지 않습니다');
                } else {
                    torchOn = result;
                    $('torchBtn').textContent = torchOn ? '💡' : '🔦';
                    showToast(torchOn ? '💡 플래시 켜짐' : '🔦 플래시 꺼짐');
                }
            } catch (e) {
                showToast('플래시를 사용할 수 없습니다');
            }
        });

        // 초기화
        $('resetBtn').addEventListener('click', () => {
            resetMeasurement();
            showToast('↺ 초기화됨');
        });

        // 리사이즈
        window.addEventListener('resize', () => {
            canvas.width  = window.innerWidth;
            canvas.height = window.innerHeight;
            Measure.updateDisplaySize(window.innerWidth, window.innerHeight);
        });
    }

    // ===== Update Loop =====
    function startUpdateLoop(videoEl) {
        let frameCount = 0;
        function tick() {
            if (++frameCount % 3 === 0) {
                Detector.detectQR(videoEl);
            }

            if (Detector.isVisible()) {
                const dist = Detector.getDistance();
                if (dist > 0 && dist < 50) {
                    $('distanceInfo').classList.add('visible');
                    $('distanceValue').textContent = dist.toFixed(2);
                }
            } else {
                $('distanceInfo').classList.remove('visible');
            }

            drawOverlay();
            animFrameId = requestAnimationFrame(tick);
        }
        animFrameId = requestAnimationFrame(tick);
    }

    // ===== QR Guide Frame =====
    function drawQRGuide() {
        const found = (currentState === State.READY);
        const cw = canvas.width;
        const ch = canvas.height;

        const size = Math.min(cw, ch) * 0.65;
        const gx   = (cw - size) / 2;
        const gy   = (ch - size) / 2;
        const arm  = size * 0.15;
        const r    = 12;

        ctx.save();
        ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
        ctx.fillRect(0, 0, cw, ch);
        ctx.clearRect(gx, gy, size, size);
        ctx.restore();

        const color = found ? '#4ade80' : '#ffffff';
        const glow  = found ? 'rgba(74, 222, 128, 0.7)' : 'rgba(255,255,255,0.4)';

        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth   = found ? 4 : 3;
        ctx.shadowColor = glow;
        ctx.shadowBlur  = 10;
        ctx.lineCap     = 'round';

        const corners = [
            { x: gx,        y: gy,        dx:  1, dy:  1 },
            { x: gx + size, y: gy,        dx: -1, dy:  1 },
            { x: gx,        y: gy + size, dx:  1, dy: -1 },
            { x: gx + size, y: gy + size, dx: -1, dy: -1 },
        ];
        corners.forEach(({ x, y, dx, dy }) => {
            ctx.beginPath();
            ctx.moveTo(x + dx * arm, y);
            ctx.lineTo(x + dx * r, y);
            ctx.arcTo(x, y, x, y + dy * r, r);
            ctx.lineTo(x, y + dy * arm);
            ctx.stroke();
        });

        ctx.shadowBlur = 0;

        if (!found) {
            const speed = size * 0.008;
            scanLineY += speed * scanLineDir;
            if (scanLineY >= size) { scanLineY = size; scanLineDir = -1; }
            if (scanLineY <= 0)    { scanLineY = 0;    scanLineDir =  1; }

            const ly   = gy + scanLineY;
            const grad = ctx.createLinearGradient(gx, ly, gx + size, ly);
            grad.addColorStop(0,   'rgba(255,255,255,0)');
            grad.addColorStop(0.4, 'rgba(255,255,255,0.6)');
            grad.addColorStop(0.5, 'rgba(255,255,255,0.9)');
            grad.addColorStop(0.6, 'rgba(255,255,255,0.6)');
            grad.addColorStop(1,   'rgba(255,255,255,0)');
            ctx.strokeStyle = grad;
            ctx.lineWidth   = 2;
            ctx.beginPath();
            ctx.moveTo(gx, ly);
            ctx.lineTo(gx + size, ly);
            ctx.stroke();
        }

        ctx.fillStyle  = found ? '#4ade80' : 'rgba(255,255,255,0.85)';
        ctx.font       = 'bold 14px Inter, Noto Sans KR, sans-serif';
        ctx.textAlign  = 'center';
        ctx.shadowColor = 'rgba(0,0,0,0.8)';
        ctx.shadowBlur  = 6;
        const hint = found ? '✅ QR 인식 완료' : 'QR 코드를 가이드 안에 맞추세요';
        ctx.fillText(hint, cw / 2, gy + size + 26);
        ctx.textAlign  = 'left';
        ctx.restore();
    }

    // ===== Overlay Drawing =====
    function drawOverlay() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        if (currentState === State.SCANNING || currentState === State.READY) {
            drawQRGuide();
        }

        const points = Measure.getPoints();
        if (points.length === 0) return;

        const mode = Measure.getMode();

        // 포인트 그리기
        points.forEach((p, i) => {
            ctx.beginPath();
            ctx.arc(p.screenX, p.screenY, 12, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(74, 222, 128, 0.2)';
            ctx.fill();
            ctx.strokeStyle = '#4ade80';
            ctx.lineWidth   = 2;
            ctx.stroke();

            ctx.beginPath();
            ctx.arc(p.screenX, p.screenY, 4, 0, Math.PI * 2);
            ctx.fillStyle = '#4ade80';
            ctx.fill();

            ctx.fillStyle   = '#fff';
            ctx.font        = 'bold 13px Inter, Noto Sans KR, sans-serif';
            ctx.shadowColor = 'rgba(0,0,0,0.8)';
            ctx.shadowBlur  = 4;
            const label = (mode === 'height')
                ? (i === 0 ? '꼭대기' : '밑동')
                : (i === 0 ? '왼쪽'   : '오른쪽');
            ctx.fillText(label, p.screenX + 16, p.screenY + 4);
            ctx.shadowBlur = 0;
        });

        // 두 점 사이 라인 및 치수
        if (points.length === 2) {
            const x1 = points[0].screenX, y1 = points[0].screenY;
            const x2 = points[1].screenX, y2 = points[1].screenY;

            ctx.setLineDash([8, 5]);
            ctx.strokeStyle = '#4ade80';
            ctx.lineWidth   = 2;
            ctx.shadowColor = 'rgba(74, 222, 128, 0.5)';
            ctx.shadowBlur  = 6;
            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.shadowBlur = 0;

            const measurement = getCurrentMeasurement();
            if (measurement) {
                const mx  = (x1 + x2) / 2 + 16;
                const my  = (y1 + y2) / 2;
                const val = measurement.primary;
                const lbl = mode === 'height' ? `높이: ${val}m` : `폭: ${val}m`;

                ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
                const tw = ctx.measureText(lbl).width;
                ctx.fillRect(mx - 6, my - 16, tw + 12, 24);

                ctx.fillStyle = '#4ade80';
                ctx.font      = 'bold 14px Inter, Noto Sans KR, sans-serif';
                ctx.fillText(lbl, mx, my);
            }
        }
    }

    // ===== Marker Events =====
    function onMarkerFound(marker) {
        lockedDistance = marker.distance;
        lockedQRData   = marker.qrData;

        $('statusBadge').className  = 'status-badge status-ready';
        $('statusText').textContent = `QR 인식 (${marker.id})`;
        $('captureBtn').disabled    = false;

        const qd = marker.qrData;
        $('treeInfoId').textContent = `🌳 ${qd.id || 'QR 마커'}`;
        const metaParts = [];
        if (qd.species)  metaParts.push(`수종: ${qd.species}`);
        if (qd.location) metaParts.push(`위치: ${qd.location}`);
        if (qd.planted)  metaParts.push(`식재: ${qd.planted}`);
        $('treeInfoMeta').textContent = metaParts.join('  ·  ');
        $('treeInfoPanel').classList.add('visible');

        if (currentState === State.SCANNING) {
            setState(State.READY);
            $('guideText').textContent = '꼭대기 → 밑동 순서로 터치하세요';
            showToast(`✅ QR 인식! ID: ${qd.id || '—'}  거리: ${lockedDistance.toFixed(2)}m`);
        }
    }

    function onMarkerLost() {
        if (currentState !== State.SCANNING) return;
        $('statusBadge').className  = 'status-badge status-scanning';
        $('statusText').textContent = 'QR 코드 검색 중...';
        $('distanceInfo').classList.remove('visible');
        $('treeInfoPanel').classList.remove('visible');
        $('guideText').textContent  = 'QR 코드를 카메라에 비추세요';
    }

    // ===== Touch Point =====
    function addTouchPoint(screenX, screenY) {
        const { index } = Measure.addPoint(screenX, screenY);
        const container = $('touchPointsContainer');
        const mode      = Measure.getMode();

        if (index === 0) {
            container.innerHTML = '';
            setState(State.MEASURING);
            if (mode === 'height') {
                $('guideText').textContent = '밑동 위치를 터치하세요';
                showToast('📍 꼭대기 포인트');
            } else {
                $('guideText').textContent = '오른쪽 끝을 터치하세요';
                showToast('📍 왼쪽 포인트');
            }
        }

        const dot = document.createElement('div');
        dot.className    = 'touch-point';
        dot.style.left   = screenX + 'px';
        dot.style.top    = screenY + 'px';
        container.appendChild(dot);

        if (index === 1) {
            setState(State.DONE);
            const measurement = getCurrentMeasurement();
            if (measurement) {
                $('measureValue').textContent = measurement.primary.toFixed(2);

                if (measurePhase === 'height') {
                    heightResult = measurement;
                    $('guideText').textContent  = '높이 측정 완료! 다음을 눌러 폭을 측정하세요';
                    $('measureLabel').textContent = '높이 (m)';
                    $('measurementDisplay').classList.add('active');
                    showToast(`📏 높이: ${measurement.primary.toFixed(2)}m`);
                    $('nextBtn').style.display = '';
                } else {
                    $('guideText').textContent  = '폭 측정 완료! 종료를 눌러 결과를 확인하세요';
                    $('measureLabel').textContent = '폭 (m)';
                    $('measurementDisplay').classList.add('active');
                    showToast(`↔️ 폭: ${measurement.primary.toFixed(2)}m`);
                    $('endBtn').style.display = '';
                }
            }
        }
    }

    // ===== Measurement =====
    function getCurrentMeasurement() {
        let distance   = lockedDistance;
        let usedDefault = false;

        if (!distance || distance <= 0 || distance > 50) {
            distance   = 5;
            usedDefault = true;
        }

        const fov         = 60;
        const focalLength = (window.innerWidth / 2) / Math.tan((fov / 2) * Math.PI / 180);
        const result      = Measure.calculate(distance, focalLength);

        if (result && usedDefault) {
            showToast('⚠️ QR 거리 미확인 — 기본값 5m 사용');
        }

        return result;
    }

    // ===== Result =====
    function goToResult(combined) {
        let imageData = null;
        try {
            const captureCanvas = document.createElement('canvas');
            captureCanvas.width  = window.innerWidth;
            captureCanvas.height = window.innerHeight;
            const captureCtx    = captureCanvas.getContext('2d');
            captureCtx.drawImage($('cameraVideo'), 0, 0, captureCanvas.width, captureCanvas.height);
            captureCtx.drawImage(canvas, 0, 0);
            imageData = captureCanvas.toDataURL('image/jpeg', 0.85);
        } catch (e) {
            console.warn('[App] 화면 캡처 실패:', e);
        }

        const payload = {
            height:    combined.height,
            width:     combined.width,
            distance:  combined.distance,
            gps:       combined.gps || Measure.getGPS(),
            treeData:  lockedQRData,
            treeId:    lockedQRData ? lockedQRData.id : null,
            imageData: imageData,
            timestamp: Date.now(),
        };

        try {
            sessionStorage.setItem('measurementResult', JSON.stringify(payload));
        } catch (e) {
            console.warn('[App] sessionStorage 용량 초과, imageData 제외:', e);
            payload.imageData = null;
            try {
                sessionStorage.setItem('measurementResult', JSON.stringify(payload));
            } catch (e2) {
                console.error('[App] sessionStorage 저장 실패:', e2);
            }
        }

        if (animFrameId) cancelAnimationFrame(animFrameId);
        Measure.stop();
        Camera.stop();
        window.location.href = 'result.html';
    }

    // ===== State =====
    function setState(s) {
        currentState = s;
        console.log(`[App] State → ${s}`);
    }

    function resetMeasurement() {
        Measure.reset();
        Measure.setMode('height');
        lockedDistance = 0;
        lockedQRData   = null;
        measurePhase   = 'height';
        heightResult   = null;
        $('touchPointsContainer').innerHTML = '';
        $('measurementDisplay').classList.remove('active');
        $('treeInfoPanel').classList.remove('visible');
        $('nextBtn').style.display = 'none';
        $('endBtn').style.display  = 'none';

        if (Detector.isVisible()) {
            setState(State.READY);
            $('guideText').textContent = '꼭대기 → 밑동 순서로 터치하세요';
        } else {
            setState(State.SCANNING);
            $('guideText').textContent = 'QR 코드를 카메라에 비추세요';
        }
    }

    // ===== Error =====
    function showError(msg) {
        setState(State.ERROR);
        $('loadingTitle').textContent = '오류 발생';
        $('loadingText').textContent  = msg;
        const spinner = $('loadingScreen').querySelector('.spinner');
        if (spinner) spinner.style.display = 'none';
        $('retryBtn').style.display = 'inline-flex';
        $('loadingScreen').classList.remove('hidden');
    }

    // ===== Toast =====
    function showToast(msg) {
        const toast = $('toast');
        toast.textContent = msg;
        toast.classList.add('show');
        setTimeout(() => toast.classList.remove('show'), 2500);
    }

    // ===== Cleanup =====
    window.addEventListener('beforeunload', (e) => {
        if (currentState === State.MEASURING) {
            e.preventDefault();
            e.returnValue = '';
        }
        if (animFrameId) cancelAnimationFrame(animFrameId);
        Measure.stop();
        Camera.stop();
    });
})();
