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

    // QR 인식 시점에 잠금 — 카메라를 움직여도 유지됨
    let lockedQRData  = null;  // 나무 ID 등
    let lockedDistance = 0;    // 거리 (m)

    // 2단계 측정 흐름: height → width
    let measurePhase = 'height'; // 'height' | 'width'
    let heightResult = null;     // 높이 측정 결과 임시 저장

    // QR 가이드 스캔 라인 애니메이션
    let scanLineY = 0;
    let scanLineDir = 1;

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
        // file:// 프로토콜 경고 (canvas SecurityError 유발 가능)
        if (location.protocol === 'file:') {
            showToast('⚠️ 로컬 파일 실행 중 — 서버 실행을 권장합니다');
            console.warn('[App] file:// 프로토콜: canvas.getImageData 차단 가능. localhost로 실행하세요.');
        }

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

        // 다음 버튼 (높이 측정 완료 → 폭 측정으로)
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

        // 종료 버튼 (폭 측정 완료 → 결과화면)
        $('endBtn').addEventListener('click', () => {
            const widthMeasurement = getCurrentMeasurement();
            if (widthMeasurement && heightResult) {
                goToResult({
                    height: heightResult.primary,
                    width: widthMeasurement.primary,
                    distance: heightResult.distance,
                    gps: widthMeasurement.gps || heightResult.gps,
                });
            } else if (widthMeasurement) {
                goToResult({
                    height: null,
                    width: widthMeasurement.primary,
                    distance: widthMeasurement.distance,
                    gps: widthMeasurement.gps,
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
            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;
            Measure.updateDisplaySize(window.innerWidth, window.innerHeight);
        });
    }

    // ===== Update Loop =====
    function startUpdateLoop(videoEl) {
        let frameCount = 0;
        function tick() {
            // QR 감지: 3프레임마다 1회 (약 20fps) — 안정성과 성능의 균형
            if (++frameCount % 3 === 0) {
                Detector.detectQR(videoEl);
            }

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

    // ===== QR Guide Frame =====
    function drawQRGuide() {
        const found = (currentState === State.READY);
        const cw = canvas.width;
        const ch = canvas.height;

        // 가이드 박스: 화면 중앙, 짧은 변 기준 65%
        const size = Math.min(cw, ch) * 0.65;
        const gx = (cw - size) / 2;
        const gy = (ch - size) / 2;
        const arm = size * 0.15;   // 코너 선 길이
        const r = 12;              // 코너 라운딩

        // 배경 어둠: 가이드 박스 바깥 반투명 검정
        ctx.save();
        ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
        ctx.fillRect(0, 0, cw, ch);
        // 가이드 박스 영역을 투명하게 클리어
        ctx.clearRect(gx, gy, size, size);
        ctx.restore();

        // 코너 색상: 미인식=흰색, 인식=초록
        const color = found ? '#4ade80' : '#ffffff';
        const glow  = found ? 'rgba(74, 222, 128, 0.7)' : 'rgba(255,255,255,0.4)';

        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = found ? 4 : 3;
        ctx.shadowColor = glow;
        ctx.shadowBlur = 10;
        ctx.lineCap = 'round';

        // 4개 코너 ㄱ자 선 그리기
        const corners = [
            { x: gx,        y: gy,        dx: 1,  dy: 1  },  // 좌상
            { x: gx + size, y: gy,        dx: -1, dy: 1  },  // 우상
            { x: gx,        y: gy + size, dx: 1,  dy: -1 },  // 좌하
            { x: gx + size, y: gy + size, dx: -1, dy: -1 },  // 우하
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

        // 미인식 상태: 스캔 라인 애니메이션
        if (!found) {
            const speed = size * 0.008;
            scanLineY += speed * scanLineDir;
            if (scanLineY >= size) { scanLineY = size; scanLineDir = -1; }
            if (scanLineY <= 0)    { scanLineY = 0;    scanLineDir =  1; }

            const ly = gy + scanLineY;
            const grad = ctx.createLinearGradient(gx, ly, gx + size, ly);
            grad.addColorStop(0,    'rgba(255,255,255,0)');
            grad.addColorStop(0.4,  'rgba(255,255,255,0.6)');
            grad.addColorStop(0.5,  'rgba(255,255,255,0.9)');
            grad.addColorStop(0.6,  'rgba(255,255,255,0.6)');
            grad.addColorStop(1,    'rgba(255,255,255,0)');
            ctx.strokeStyle = grad;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(gx, ly);
            ctx.lineTo(gx + size, ly);
            ctx.stroke();
        }

        // 가이드 하단 안내 텍스트
        ctx.fillStyle = found ? '#4ade80' : 'rgba(255,255,255,0.85)';
        ctx.font = 'bold 14px Inter, Noto Sans KR, sans-serif';
        ctx.textAlign = 'center';
        ctx.shadowColor = 'rgba(0,0,0,0.8)';
        ctx.shadowBlur = 6;
        const hint = found ? '✅ QR 인식 완료' : 'QR 코드를 가이드 안에 맞추세요';
        ctx.fillText(hint, cw / 2, gy + size + 26);
        ctx.textAlign = 'left';
        ctx.restore();
    }

    // ===== Overlay Drawing =====
    function drawOverlay() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // SCANNING / READY 상태에서 QR 가이드 프레임 표시
        if (currentState === State.SCANNING || currentState === State.READY) {
            drawQRGuide();
        }

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
        // 거리·QR 데이터 잠금 (카메라를 움직여도 유지)
        lockedDistance = marker.distance;
        lockedQRData   = marker.qrData;

        $('statusBadge').className = 'status-badge status-ready';
        $('statusText').textContent = `QR 인식 (${marker.id})`;
        $('captureBtn').disabled = false;

        // QR 나무 정보 패널 표시
        const qd = marker.qrData;
        $('treeInfoId').textContent = `🌳 ${qd.id || 'QR 마커'}`;
        const metaParts = [];
        if (qd.species)  metaParts.push(`수종: ${qd.species}`);
        if (qd.location) metaParts.push(`위치: ${qd.location}`);
        if (qd.planted)  metaParts.push(`식재: ${qd.planted}`);
        $('treeInfoMeta').textContent = metaParts.join('  ·  ');
        $('treeInfoPanel').classList.add('visible');

        $('guideText').textContent = '꼭대기 → 밑동 순서로 터치하세요';

        if (currentState === State.SCANNING) {
            setState(State.READY);
            showToast(`✅ QR 인식! ID: ${qd.id || '—'}  거리: ${lockedDistance.toFixed(2)}m`);
        }
    }

    function onMarkerLost() {
        // READY·MEASURING·DONE 상태에서는 QR이 안 보여도 무시
        // 이미 거리·ID가 잠금되어 있으므로 계속 측정 가능
        if (currentState !== State.SCANNING) return;

        $('statusBadge').className = 'status-badge status-scanning';
        $('statusText').textContent = 'QR 코드 검색 중...';
        $('distanceInfo').classList.remove('visible');
        $('treeInfoPanel').classList.remove('visible');
        $('guideText').textContent = 'QR 코드를 카메라에 비추세요';
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
                $('measureValue').textContent = measurement.primary.toFixed(2);

                if (measurePhase === 'height') {
                    heightResult = measurement;
                    $('guideText').textContent = '높이 측정 완료! 다음을 눌러 폭을 측정하세요';
                    $('measureLabel').textContent = '높이 (m)';
                    $('measurementDisplay').classList.add('active');
                    showToast(`📏 높이: ${measurement.primary.toFixed(2)}m`);
                    $('nextBtn').style.display = '';
                } else {
                    $('guideText').textContent = '폭 측정 완료! 종료를 눌러 결과를 확인하세요';
                    $('measureLabel').textContent = '폭 (m)';
                    $('measurementDisplay').classList.add('active');
                    showToast(`↔️ 폭: ${measurement.primary.toFixed(2)}m`);
                    $('endBtn').style.display = '';
                }
            }
        }
    }

    function getCurrentMeasurement() {
        // 잠금된 거리 사용 (QR이 화면에 없어도 측정 가능)
        let distance = lockedDistance;
        let usedDefault = false;

        if (!distance || distance <= 0 || distance > 50) {
            distance = 5;
            usedDefault = true;
        }

        const fov = 60;
        const focalLength = (window.innerWidth / 2) / Math.tan((fov / 2) * Math.PI / 180);
        const result = Measure.calculate(distance, focalLength);

        if (result && usedDefault) {
            showToast('⚠️ QR 거리 미확인 — 기본값 5m 사용');
        }

        return result;
    }

    // ===== Result =====
    function goToResult(combined) {
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

        const qrData = lockedQRData;

        const payload = {
            height: combined.height,
            width: combined.width,
            distance: combined.distance,
            gps: combined.gps || Measure.getGPS(),
            treeData: qrData,
            treeId: qrData ? qrData.id : null,
            imageData: imageData,
            timestamp: Date.now(),
        };

        // sessionStorage 저장 (imageData로 인한 QuotaExceededError 방어)
        try {
            sessionStorage.setItem('measurementResult', JSON.stringify(payload));
        } catch (e) {
            // 용량 초과 시 이미지 제외 후 재시도
            console.warn('[App] sessionStorage 용량 초과, imageData 제외 후 재시도:', e);
            payload.imageData = null;
            try {
                sessionStorage.setItem('measurementResult', JSON.stringify(payload));
            } catch (e2) {
                console.error('[App] sessionStorage 저장 실패:', e2);
            }
        }

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
