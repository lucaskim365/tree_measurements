/**
 * app.js — Phase 3: jsQR 기반 메인 컨트롤러
 *
 * 아키텍처:
 *   Camera.js   → getUserMedia 카메라 스트림
 *   Detector.js → jsQR QR 코드 감지 + 거리 추정
 *   Measure.js  → 높이/폭 계산 + GPS
 *   Canvas      → 2D 오버레이 (측정 라인, 포인트)
 */

(function () {
    'use strict';

    // ===== State Machine =====
    const State = {
        LOADING: 'loading',
        SCANNING: 'scanning',
        READY: 'ready',
        MEASURING: 'measuring',
        DONE: 'done',
        ERROR: 'error',
    };

    let currentState = State.LOADING;
    let canvas, ctx;
    let animFrameId = null;
    let torchOn = false;

    const $ = (id) => document.getElementById(id);

    // ===== Boot =====
    document.addEventListener('DOMContentLoaded', () => {
        $('retryBtn').addEventListener('click', () => window.location.reload());

        const videoEl = $('cameraVideo');

        // 카메라 직접 초기화 (A-Frame 의존성 제거)
        Camera.init(videoEl)
            .then(() => onCameraReady(videoEl))
            .catch((err) => {
                if (err.name === 'NotAllowedError') {
                    showError('카메라 권한이 거부되었습니다. 브라우저 설정에서 카메라를 허용해 주세요.');
                } else {
                    showError(`카메라 초기화 실패: ${err.message}`);
                }
            });

        // 20초 타임아웃
        setTimeout(() => {
            if (currentState === State.LOADING) {
                showError('카메라 로딩 시간 초과. 권한 또는 연결을 확인하세요.');
            }
        }, 20000);
    });

    // ===== Camera Ready =====
    function onCameraReady(videoEl) {
        console.log('[App] 카메라 초기화 완료');

        $('loadingScreen').classList.add('hidden');
        videoEl.style.display = '';

        // 오버레이 캔버스 셋업
        canvas = $('overlayCanvas');
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
        ctx = canvas.getContext('2d');

        // 실제 비디오 해상도로 Measure 초기화
        const res = Camera.getResolution();
        Measure.init({
            videoWidth: res.width || window.innerWidth,
            videoHeight: res.height || window.innerHeight,
            displayWidth: window.innerWidth,
            displayHeight: window.innerHeight,
        });

        // Detector 초기화
        Detector.init({
            markerSize: 0.20,
            onFound: onMarkerFound,
            onLost: onMarkerLost,
        });

        bindEvents();
        startUpdateLoop(videoEl);

        setState(State.SCANNING);
        showToast('📷 카메라 활성화 — QR 코드를 비추세요');
    }

    // ===== Events =====
    function bindEvents() {
        // 캡처 버튼 (화면 중앙 포인트)
        $('captureBtn').addEventListener('click', (e) => {
            e.stopPropagation();
            addTouchPoint(window.innerWidth / 2, window.innerHeight / 2);
        });

        // 화면 클릭으로 포인트 추가
        document.addEventListener('click', (e) => {
            if (e.target.closest('.ar-controls') ||
                e.target.closest('.ar-status-bar') ||
                e.target.closest('.mode-toggle') ||
                e.target.closest('.overlay-screen')) return;

            if (currentState === State.READY || currentState === State.MEASURING) {
                addTouchPoint(e.clientX, e.clientY);
            }
        });

        // 터치 이벤트
        document.addEventListener('touchstart', (e) => {
            if (e.target.closest('.ar-controls') ||
                e.target.closest('.ar-status-bar') ||
                e.target.closest('.mode-toggle') ||
                e.target.closest('.overlay-screen')) return;

            if (currentState === State.READY || currentState === State.MEASURING) {
                const touch = e.touches[0];
                addTouchPoint(touch.clientX, touch.clientY);
                e.preventDefault();
            }
        }, { passive: false });

        // 측정 모드 토글 (높이/폭)
        const modeToggle = $('modeToggle');
        modeToggle.addEventListener('click', (e) => {
            const btn = e.target.closest('.mode-btn');
            if (!btn) return;

            const newMode = btn.dataset.mode;
            modeToggle.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            Measure.setMode(newMode);
            resetMeasurement();

            $('measureLabel').textContent = newMode === 'height' ? '높이 (m)' : '폭 (m)';
            showToast(newMode === 'height' ? '📏 높이 측정 모드' : '↔️ 수관폭 측정 모드');
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
            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;
            Measure.updateDisplaySize(window.innerWidth, window.innerHeight);
        });
    }

    // ===== Update Loop =====
    function startUpdateLoop(videoEl) {
        function tick() {
            // QR 코드 감지 (매 프레임)
            Detector.detectQR(videoEl);

            // 거리 표시 업데이트
            if (Detector.isVisible()) {
                const dist = Detector.getDistance();
                if (dist > 0 && dist < 50) {
                    $('distanceInfo').classList.add('visible');
                    $('distanceValue').textContent = dist.toFixed(2);
                }
            } else {
                $('distanceInfo').classList.remove('visible');
            }

            // 오버레이 그리기
            drawOverlay();

            animFrameId = requestAnimationFrame(tick);
        }
        animFrameId = requestAnimationFrame(tick);
    }

    // ===== Overlay Drawing =====
    function drawOverlay() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        const points = Measure.getPoints();
        if (points.length === 0) return;

        const mode = Measure.getMode();

        // 포인트 그리기
        points.forEach((p, i) => {
            const x = p.screenX;
            const y = p.screenY;

            ctx.beginPath();
            ctx.arc(x, y, 12, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(74, 222, 128, 0.2)';
            ctx.fill();
            ctx.strokeStyle = '#4ade80';
            ctx.lineWidth = 2;
            ctx.stroke();

            ctx.beginPath();
            ctx.arc(x, y, 4, 0, Math.PI * 2);
            ctx.fillStyle = '#4ade80';
            ctx.fill();

            ctx.fillStyle = '#fff';
            ctx.font = 'bold 13px Inter, Noto Sans KR, sans-serif';
            ctx.shadowColor = 'rgba(0,0,0,0.8)';
            ctx.shadowBlur = 4;
            if (mode === 'height') {
                ctx.fillText(i === 0 ? '꼭대기' : '밑동', x + 16, y + 4);
            } else {
                ctx.fillText(i === 0 ? '왼쪽' : '오른쪽', x + 16, y + 4);
            }
            ctx.shadowBlur = 0;
        });

        // 두 점 사이 라인 및 치수
        if (points.length === 2) {
            const x1 = points[0].screenX, y1 = points[0].screenY;
            const x2 = points[1].screenX, y2 = points[1].screenY;

            ctx.setLineDash([8, 5]);
            ctx.strokeStyle = '#4ade80';
            ctx.lineWidth = 2;
            ctx.shadowColor = 'rgba(74, 222, 128, 0.5)';
            ctx.shadowBlur = 6;
            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.shadowBlur = 0;

            // 중간 치수 라벨
            const measurement = getCurrentMeasurement();
            if (measurement) {
                const mx = (x1 + x2) / 2 + 16;
                const my = (y1 + y2) / 2;
                const val = measurement.primary;
                const label = mode === 'height' ? `높이: ${val}m` : `폭: ${val}m`;

                ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
                const textWidth = ctx.measureText(label).width;
                ctx.fillRect(mx - 6, my - 16, textWidth + 12, 24);

                ctx.fillStyle = '#4ade80';
                ctx.font = 'bold 14px Inter, Noto Sans KR, sans-serif';
                ctx.fillText(label, mx, my);
            }
        }
    }

    // ===== Marker Events =====
    function onMarkerFound(marker) {
        $('statusBadge').className = 'status-badge status-ready';
        $('statusText').textContent = `QR 인식 (${marker.id})`;
        $('captureBtn').disabled = false;

        // QR 나무 정보 패널 표시
        const qd = marker.qrData;
        const panel = $('treeInfoPanel');
        $('treeInfoId').textContent = `🌳 ${qd.id || 'QR 마커'}`;

        const metaParts = [];
        if (qd.species) metaParts.push(`수종: ${qd.species}`);
        if (qd.location) metaParts.push(`위치: ${qd.location}`);
        if (qd.planted) metaParts.push(`식재: ${qd.planted}`);
        $('treeInfoMeta').textContent = metaParts.join('  ·  ');
        panel.classList.add('visible');

        const mode = Measure.getMode();
        $('guideText').textContent = mode === 'height'
            ? '꼭대기 → 밑동 순서로 터치하세요'
            : '왼쪽 → 오른쪽 순서로 터치하세요';

        if (currentState === State.SCANNING) {
            setState(State.READY);
            showToast(`✅ QR 인식! ${qd.species ? qd.species + ' · ' : ''}ID: ${qd.id || '—'}`);
        }
    }

    function onMarkerLost() {
        $('statusBadge').className = 'status-badge status-scanning';
        $('statusText').textContent = 'QR 코드 검색 중...';
        $('distanceInfo').classList.remove('visible');
        $('treeInfoPanel').classList.remove('visible');

        if (currentState === State.READY) {
            $('guideText').textContent = 'QR 코드를 카메라에 비추세요';
        }
    }

    // ===== Touch Point Handling =====
    function addTouchPoint(screenX, screenY) {
        const { index } = Measure.addPoint(screenX, screenY);

        const container = $('touchPointsContainer');
        const mode = Measure.getMode();

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
        dot.className = 'touch-point';
        dot.style.left = screenX + 'px';
        dot.style.top = screenY + 'px';
        container.appendChild(dot);

        if (index === 1) {
            setState(State.DONE);
            const measurement = getCurrentMeasurement();

            if (measurement) {
                $('guideText').textContent = '측정 완료!';
                $('measureValue').textContent = measurement.primary.toFixed(2);
                $('measureLabel').textContent = mode === 'height' ? '높이 (m)' : '폭 (m)';
                $('measurementDisplay').classList.add('active');

                const label = mode === 'height' ? '높이' : '폭';
                showToast(`📏 ${label}: ${measurement.primary.toFixed(2)}m`);

                setTimeout(() => goToResult(measurement), 2500);
            }
        }
    }

    function getCurrentMeasurement() {
        let distance = Detector.getDistance();
        let usedDefault = false;

        if (!distance || distance <= 0 || distance > 50) {
            distance = 5;
            usedDefault = true;
        }

        // FOV 기반 초점거리 추정
        const fov = 60; // 일반 스마트폰 수평 FOV 추정값
        const focalLength = (window.innerWidth / 2) / Math.tan((fov / 2) * Math.PI / 180);

        const result = Measure.calculate(distance, focalLength);

        if (result && usedDefault) {
            showToast('⚠️ QR 거리 미확인 — 기본값 5m 사용');
        }

        return result;
    }

    // ===== Result =====
    function goToResult(measurement) {
        // 현재 화면 캡처
        let imageData = null;
        try {
            const captureCanvas = document.createElement('canvas');
            captureCanvas.width = window.innerWidth;
            captureCanvas.height = window.innerHeight;
            const captureCtx = captureCanvas.getContext('2d');
            captureCtx.drawImage($('cameraVideo'), 0, 0, captureCanvas.width, captureCanvas.height);
            // 측정 오버레이도 합성
            captureCtx.drawImage(canvas, 0, 0);
            imageData = captureCanvas.toDataURL('image/jpeg', 0.85);
        } catch (e) {
            console.warn('[App] 화면 캡처 실패:', e);
        }

        const gps = Measure.getGPS();
        const qrData = Detector.getQRData();

        sessionStorage.setItem('measurementResult', JSON.stringify({
            height: measurement.height,
            width: measurement.width,
            distance: measurement.distance,
            mode: measurement.mode,
            primary: measurement.primary,
            gps: gps,
            treeData: qrData,
            treeId: qrData ? qrData.id : null,
            imageData: imageData,
            timestamp: Date.now(),
        }));

        if (animFrameId) cancelAnimationFrame(animFrameId);
        Measure.stop();
        window.location.href = 'result.html';
    }

    // ===== State =====
    function setState(s) {
        currentState = s;
        console.log(`[App] State → ${s}`);
    }

    function resetMeasurement() {
        Measure.reset();
        $('touchPointsContainer').innerHTML = '';
        $('measurementDisplay').classList.remove('active');

        const mode = Measure.getMode();
        if (Detector.isVisible()) {
            setState(State.READY);
            $('guideText').textContent = mode === 'height'
                ? '꼭대기 → 밑동 순서로 터치하세요'
                : '왼쪽 → 오른쪽 순서로 터치하세요';
        } else {
            setState(State.SCANNING);
            $('guideText').textContent = 'QR 코드를 카메라에 비추세요';
        }
    }

    // ===== Error =====
    function showError(msg) {
        setState(State.ERROR);
        $('loadingTitle').textContent = '오류 발생';
        $('loadingText').textContent = msg;
        const spinner = $('loadingScreen').querySelector('.spinner');
        if (spinner) spinner.style.display = 'none';
        $('retryBtn').style.display = 'inline-flex';
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
        // 측정 중 이탈 시 브라우저 경고
        if (currentState === State.MEASURING) {
            e.preventDefault();
            e.returnValue = '';
        }
        if (animFrameId) cancelAnimationFrame(animFrameId);
        Measure.stop(); // GPS watchPosition 해제
    });
})();
