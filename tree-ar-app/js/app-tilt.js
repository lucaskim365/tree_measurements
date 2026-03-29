/**
 * app-tilt.js — 기울기(Tilt) 측정 모드 컨트롤러
 *
 * 측정 방식: DeviceOrientation beta 각도 2회 캡처
 * 공식: h = d × |tan(β₁ − 90°) − tan(β₂ − 90°)|
 * 흐름: QR 인식 → 꼭대기 조준·캡처 → 밑동 조준·캡처 → 결과 저장
 */

(function () {
    'use strict';

    const State = {
        LOADING:   'loading',
        SCANNING:  'scanning',
        READY:     'ready',
        MEASURING: 'measuring',  // 첫 각도 캡처 완료, 두 번째 대기
        DONE:      'done',
        ERROR:     'error',
    };

    let currentState  = State.LOADING;
    let canvas, ctx;
    let animFrameId   = null;
    let torchOn       = false;
    let cameraTimeout = null;

    let currentPitch = 0;    // DeviceOrientation beta (실시간)
    let refPitch     = null; // 첫 번째 캡처 각도 (UI 표시용)

    // QR 인식 시점에 잠금
    let lockedQRData   = null;
    let lockedDistance = 0;

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
                return requestOrientationPermission();
            })
            .then(() => onCameraReady(videoEl))
            .catch((err) => {
                clearTimeout(cameraTimeout);
                if (err.name === 'NotAllowedError') {
                    showError('카메라 권한이 거부되었습니다. 브라우저 설정에서 허용해 주세요.');
                } else if (err.message === 'orientation_denied') {
                    // 기울기 권한만 거부 — 카메라는 정상, 제한 모드로 진행
                    onCameraReady(videoEl);
                    showToast('⚠️ 기울기 센서 권한 없음 — 제한된 기능으로 작동합니다');
                } else {
                    showError(`초기화 실패: ${err.message}`);
                }
            });

        cameraTimeout = setTimeout(() => {
            if (currentState === State.LOADING) {
                showError('카메라 로딩 시간 초과. 권한을 확인하세요.');
            }
        }, 20000);
    });

    // ===== iOS DeviceOrientation 권한 요청 =====
    function requestOrientationPermission() {
        if (typeof DeviceOrientationEvent === 'undefined') return Promise.resolve();
        if (typeof DeviceOrientationEvent.requestPermission !== 'function') return Promise.resolve();

        // iOS 13+: 사용자 제스처 필요
        return new Promise((resolve, reject) => {
            const btn     = $('orientationPermBtn');
            const spinner = $('loadingSpinner');

            $('loadingTitle').textContent = '기울기 센서 허용';
            $('loadingText').innerHTML    =
                '정확한 측정을 위해 기울기 센서 접근이 필요합니다.<br>' +
                '아래 버튼을 눌러 허용해 주세요.';
            if (spinner) spinner.style.display = 'none';
            btn.style.display = '';

            btn.addEventListener('click', () => {
                DeviceOrientationEvent.requestPermission()
                    .then((state) => {
                        btn.style.display = 'none';
                        if (spinner) spinner.style.display = '';
                        $('loadingTitle').textContent = '카메라 초기화 중...';
                        $('loadingText').innerHTML    =
                            '카메라 권한 팝업이 뜨면 <strong>"허용"</strong>을 눌러주세요.';
                        if (state === 'granted') {
                            resolve();
                        } else {
                            reject(new Error('orientation_denied'));
                        }
                    })
                    .catch((e) => reject(e));
            }, { once: true });
        });
    }

    // ===== Camera Ready =====
    function onCameraReady(videoEl) {
        console.log('[App-Tilt] 카메라 초기화 완료');
        if (location.protocol === 'file:') {
            showToast('⚠️ 로컬 파일 실행 중 — 서버 실행을 권장합니다');
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
        Measure.setCaptureMode('tilt');

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
        $('captureBtn').addEventListener('click', (e) => {
            e.stopPropagation();
            $('captureBtn').classList.add('captured');
            setTimeout(() => $('captureBtn').classList.remove('captured'), 300);
            captureAngle();
        });

        $('endBtn').addEventListener('click', () => {
            const measurement = getCurrentMeasurement();
            if (measurement) {
                goToResult({
                    height:   measurement.primary,
                    width:    null,
                    distance: measurement.distance,
                    gps:      measurement.gps,
                });
            }
        });

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

        $('resetBtn').addEventListener('click', () => {
            resetMeasurement();
            showToast('↺ 초기화됨');
        });

        window.addEventListener('resize', () => {
            canvas.width  = window.innerWidth;
            canvas.height = window.innerHeight;
            Measure.updateDisplaySize(window.innerWidth, window.innerHeight);
        });

        // 기울기 센서 이벤트
        window.addEventListener('deviceorientation', (e) => {
            if (e.beta !== null) {
                currentPitch = e.beta;
                updatePitchDisplay();
            }
        }, true);
    }

    // ===== Pitch Display =====
    function updatePitchDisplay() {
        const valEl = $('pitchValue');
        const refEl = $('pitchRef');
        if (!valEl) return;

        valEl.textContent = currentPitch.toFixed(1) + '°';

        if (refEl) {
            refEl.textContent = refPitch !== null
                ? '기준: ' + refPitch.toFixed(1) + '°'
                : '';
        }
    }

    // ===== Angle Capture =====
    function captureAngle() {
        if (currentState !== State.READY && currentState !== State.MEASURING) return;

        const { index } = Measure.addTiltPoint(currentPitch);

        if (index === 0) {
            refPitch = currentPitch;
            setState(State.MEASURING);
            $('guideText').textContent = '밑동을 조준 후 캡처하세요';
            setPhase(1);
            showToast(`📍 꼭대기 캡처 (${currentPitch.toFixed(1)}°)`);
        } else if (index === 1) {
            setState(State.DONE);
            $('captureBtn').disabled = true;

            const measurement = getCurrentMeasurement();
            if (measurement) {
                $('measureValue').textContent = measurement.primary.toFixed(2);
                $('measurementDisplay').classList.add('active');
                $('guideText').textContent    = '측정 완료! 종료를 눌러 저장하세요';
                setPhase(2);
                showToast(`📏 높이: ${measurement.primary.toFixed(2)}m`);
                $('endBtn').style.display = '';
            }
        }
    }

    function setPhase(phase) {
        const d0 = $('phaseDot0');
        const d1 = $('phaseDot1');
        if (!d0 || !d1) return;
        if (phase === 0) {
            d0.className = 'phase-dot active';
            d1.className = 'phase-dot';
        } else if (phase === 1) {
            d0.className = 'phase-dot done';
            d1.className = 'phase-dot active';
        } else {
            d0.className = 'phase-dot done';
            d1.className = 'phase-dot done';
        }
    }

    // ===== Measurement =====
    function getCurrentMeasurement() {
        let distance    = lockedDistance;
        let usedDefault = false;

        if (!distance || distance <= 0 || distance > 50) {
            distance    = 5;
            usedDefault = true;
        }

        const result = Measure.calculateByTilt(distance);

        if (result && usedDefault) {
            showToast('⚠️ QR 거리 미확인 — 기본값 5m 사용');
        }

        return result;
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
        if (currentState !== State.SCANNING) return;

        const cw   = canvas.width;
        const ch   = canvas.height;
        const size = Math.min(cw, ch) * 0.65;
        const gx   = (cw - size) / 2;
        const gy   = (ch - size) / 2;
        const arm  = size * 0.15;
        const r    = 12;

        ctx.save();
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        ctx.fillRect(0, 0, cw, ch);
        ctx.clearRect(gx, gy, size, size);
        ctx.restore();

        ctx.save();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth   = 3;
        ctx.shadowColor = 'rgba(255,255,255,0.4)';
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

        ctx.fillStyle   = 'rgba(255,255,255,0.85)';
        ctx.font        = 'bold 14px Inter, Noto Sans KR, sans-serif';
        ctx.textAlign   = 'center';
        ctx.shadowColor = 'rgba(0,0,0,0.8)';
        ctx.shadowBlur  = 6;
        ctx.fillText('QR 코드를 가이드 안에 맞추세요', cw / 2, gy + size + 26);
        ctx.textAlign  = 'left';
        ctx.restore();
    }

    // ===== Overlay =====
    function drawOverlay() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        drawQRGuide();
        // Tilt 모드: 포인트/라인은 HTML 요소(phase dots, pitch panel)로 처리
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
            $('guideText').textContent = '꼭대기를 조준 후 캡처하세요';
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

    // ===== Result =====
    function goToResult(data) {
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
            console.warn('[App-Tilt] 화면 캡처 실패:', e);
        }

        const payload = {
            height:    data.height,
            width:     data.width,
            distance:  data.distance,
            gps:       data.gps || Measure.getGPS(),
            treeData:  lockedQRData,
            treeId:    lockedQRData ? lockedQRData.id : null,
            imageData: imageData,
            timestamp: Date.now(),
        };

        try {
            sessionStorage.setItem('measurementResult', JSON.stringify(payload));
        } catch (e) {
            console.warn('[App-Tilt] sessionStorage 용량 초과, imageData 제외:', e);
            payload.imageData = null;
            try {
                sessionStorage.setItem('measurementResult', JSON.stringify(payload));
            } catch (e2) {
                console.error('[App-Tilt] sessionStorage 저장 실패:', e2);
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
        console.log(`[App-Tilt] State → ${s}`);
    }

    function resetMeasurement() {
        Measure.reset();
        refPitch       = null;
        lockedDistance = 0;
        lockedQRData   = null;
        $('measurementDisplay').classList.remove('active');
        $('treeInfoPanel').classList.remove('visible');
        $('endBtn').style.display = 'none';
        setPhase(0);
        updatePitchDisplay();

        if (Detector.isVisible()) {
            setState(State.READY);
            $('captureBtn').disabled   = false;
            $('guideText').textContent = '꼭대기를 조준 후 캡처하세요';
        } else {
            setState(State.SCANNING);
            $('captureBtn').disabled   = true;
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
        $('orientationPermBtn').style.display = 'none';
        $('retryBtn').style.display           = 'inline-flex';
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
    window.addEventListener('beforeunload', () => {
        if (animFrameId) cancelAnimationFrame(animFrameId);
        Measure.stop();
        Camera.stop();
    });
})();
