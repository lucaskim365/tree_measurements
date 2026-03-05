/**
 * app.js — 메인 앱 컨트롤러
 * 카메라 → 마커 검출 → 측정 → 결과 플로우 전체를 관리한다.
 */

(function () {
    'use strict';

    // ===== State =====
    const State = {
        IDLE: 'idle',
        LOADING: 'loading',
        SCANNING: 'scanning',
        READY: 'ready',
        MEASURING: 'measuring',
        DONE: 'done',
    };

    let currentState = State.IDLE;
    let animationFrameId = null;
    let canvas, ctx;
    let isMarkerFound = false;
    let markerLostFrames = 0;
    const MARKER_LOST_THRESHOLD = 15; // 15프레임 연속 미검출 시 lost

    // ===== DOM =====
    const $ = (id) => document.getElementById(id);

    // ===== Init =====
    document.addEventListener('DOMContentLoaded', async () => {
        // 이 스크립트는 measure.html에서 실행됨
        const permissionScreen = $('permissionScreen');
        const arContainer = $('arContainer');
        const retryBtn = $('retryPermissionBtn');

        setState(State.LOADING);

        try {
            // 카메라 초기화
            const video = $('cameraVideo');
            await Camera.init(video);

            // 카메라 해상도 가져오기
            const resolution = Camera.getResolution();

            // 캔버스 셋업
            canvas = $('overlayCanvas');
            canvas.width = resolution.width;
            canvas.height = resolution.height;
            ctx = canvas.getContext('2d');

            // 측정 모듈 초기화
            Measure.init({
                videoWidth: resolution.width,
                videoHeight: resolution.height,
                displayWidth: window.innerWidth,
                displayHeight: window.innerHeight,
            });

            // 마커 검출기 초기화
            Detector.init({
                markerSize: 0.20,
                onFound: onMarkerFound,
                onLost: onMarkerLost,
            });

            // Permission 성공 → AR 화면으로 전환
            permissionScreen.style.display = 'none';
            arContainer.style.display = 'block';

            setState(State.SCANNING);

            // 이벤트 바인딩
            bindEvents();

            // RAF 루프 시작
            startDetectionLoop();

        } catch (err) {
            console.error('초기화 실패:', err);
            // 카메라 권한 거부 또는 오류
            const spinner = permissionScreen.querySelector('.spinner');
            if (spinner) spinner.style.display = 'none';
            retryBtn.style.display = 'inline-flex';

            const overlayTitle = permissionScreen.querySelector('.overlay-title');
            const overlayText = permissionScreen.querySelector('.overlay-text');

            if (err.name === 'NotAllowedError') {
                overlayTitle.textContent = '카메라 권한 거부됨';
                overlayText.innerHTML = '브라우저 설정에서 카메라 권한을 허용한 후<br><strong>다시 시도</strong>해 주세요.';
            } else {
                overlayTitle.textContent = '카메라 오류';
                overlayText.textContent = err.message || '카메라에 접근할 수 없습니다.';
            }

            retryBtn.addEventListener('click', () => {
                window.location.reload();
            });
        }
    });

    // ===== Events =====
    function bindEvents() {
        // 캡처 버튼 (포인트 찍기)
        const captureBtn = $('captureBtn');
        captureBtn.addEventListener('click', onCapturePoint);

        // 화면 터치로도 포인트 찍기
        const arContainer = $('arContainer');
        arContainer.addEventListener('click', (e) => {
            // 컨트롤 영역 클릭은 무시
            if (e.target.closest('.ar-controls') || e.target.closest('.ar-status-bar')) return;
            if (currentState === State.READY || currentState === State.MEASURING) {
                addTouchPoint(e.clientX, e.clientY);
            }
        });

        // 토치 버튼
        const torchBtn = $('torchBtn');
        torchBtn.addEventListener('click', async () => {
            try {
                const on = await Camera.toggleTorch();
                torchBtn.textContent = on ? '💡' : '🔦';
                showToast(on ? '플래시 켜짐' : '플래시 꺼짐');
            } catch (e) {
                showToast('플래시를 사용할 수 없습니다');
            }
        });

        // 리셋 버튼
        const resetBtn = $('resetBtn');
        resetBtn.addEventListener('click', () => {
            resetMeasurement();
            showToast('초기화됨');
        });

        // 리사이즈
        window.addEventListener('resize', () => {
            Measure.updateDisplaySize(window.innerWidth, window.innerHeight);
        });
    }

    // ===== Detection Loop (RAF) =====
    function startDetectionLoop() {
        const video = $('cameraVideo');
        const detectionCanvas = document.createElement('canvas');
        const detectionCtx = detectionCanvas.getContext('2d', { willReadFrequently: true });

        // 검출용 해상도 (성능 최적화)
        const DETECT_W = 320;
        const DETECT_H = 240;
        detectionCanvas.width = DETECT_W;
        detectionCanvas.height = DETECT_H;

        function tick() {
            if (video.readyState < 2) {
                animationFrameId = requestAnimationFrame(tick);
                return;
            }

            // 1. 축소 프레임 캡처 (검출용)
            detectionCtx.drawImage(video, 0, 0, DETECT_W, DETECT_H);
            const imageData = detectionCtx.getImageData(0, 0, DETECT_W, DETECT_H);

            // 2. 마커 검출
            const marker = Detector.detect(imageData);

            // 3. 오버레이 그리기
            drawOverlay(marker);

            // 4. 마커 소실 체크
            if (!marker) {
                markerLostFrames++;
                if (markerLostFrames > MARKER_LOST_THRESHOLD && isMarkerFound) {
                    onMarkerLost();
                }
            } else {
                markerLostFrames = 0;
            }

            animationFrameId = requestAnimationFrame(tick);
        }

        animationFrameId = requestAnimationFrame(tick);
    }

    // ===== Overlay Drawing =====
    function drawOverlay(marker) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        if (marker && isMarkerFound) {
            // 마커 윤곽 그리기 (비디오 좌표를 캔버스 좌표로 스케일링)
            const scaleX = canvas.width / 320;
            const scaleY = canvas.height / 240;

            ctx.strokeStyle = '#4ade80';
            ctx.lineWidth = 3;
            ctx.beginPath();
            const corners = marker.corners;
            ctx.moveTo(corners[0][0] * scaleX, corners[0][1] * scaleY);
            for (let i = 1; i < corners.length; i++) {
                ctx.lineTo(corners[i][0] * scaleX, corners[i][1] * scaleY);
            }
            ctx.closePath();
            ctx.stroke();

            // 중심에 십자 표시
            const cx = marker.center.x * scaleX;
            const cy = marker.center.y * scaleY;

            ctx.strokeStyle = 'rgba(74, 222, 128, 0.7)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(cx - 15, cy);
            ctx.lineTo(cx + 15, cy);
            ctx.moveTo(cx, cy - 15);
            ctx.lineTo(cx, cy + 15);
            ctx.stroke();

            // 마커 크기/거리 표시
            const dist = Detector.estimateDistance(marker.pixelSize * scaleX);
            ctx.fillStyle = '#4ade80';
            ctx.font = '14px Inter, sans-serif';
            ctx.fillText(`거리: ${dist.toFixed(1)}m`, cx + 20, cy - 10);
        }

        // 터치 포인트 & 측정 라인 그리기
        const points = Measure.getPoints();
        if (points.length > 0) {
            points.forEach((p, i) => {
                const sx = (p.videoX / canvas.width) * canvas.width;
                const sy = (p.videoY / canvas.height) * canvas.height;

                // 포인트
                ctx.beginPath();
                ctx.arc(sx, sy, 8, 0, Math.PI * 2);
                ctx.fillStyle = 'rgba(74, 222, 128, 0.3)';
                ctx.fill();
                ctx.strokeStyle = '#4ade80';
                ctx.lineWidth = 2;
                ctx.stroke();

                // 중심점
                ctx.beginPath();
                ctx.arc(sx, sy, 3, 0, Math.PI * 2);
                ctx.fillStyle = '#4ade80';
                ctx.fill();

                // 라벨
                ctx.fillStyle = '#fff';
                ctx.font = '12px Inter, sans-serif';
                ctx.fillText(i === 0 ? '꼭대기' : '밑동', sx + 12, sy + 4);
            });

            // 두 점 사이 라인
            if (points.length === 2) {
                const sx1 = (points[0].videoX / canvas.width) * canvas.width;
                const sy1 = (points[0].videoY / canvas.height) * canvas.height;
                const sx2 = (points[1].videoX / canvas.width) * canvas.width;
                const sy2 = (points[1].videoY / canvas.height) * canvas.height;

                // 점선 라인
                ctx.setLineDash([6, 4]);
                ctx.strokeStyle = '#4ade80';
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.moveTo(sx1, sy1);
                ctx.lineTo(sx2, sy2);
                ctx.stroke();
                ctx.setLineDash([]);

                // 거리 라벨 (중간에)
                const mx = (sx1 + sx2) / 2 + 16;
                const my = (sy1 + sy2) / 2;
                const measurement = getCurrentMeasurement();
                if (measurement) {
                    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
                    ctx.fillRect(mx - 4, my - 14, 80, 20);
                    ctx.fillStyle = '#4ade80';
                    ctx.font = 'bold 13px Inter, sans-serif';
                    ctx.fillText(`${measurement.height.toFixed(2)}m`, mx, my);
                }
            }
        }
    }

    // ===== Marker Events =====
    function onMarkerFound(marker) {
        isMarkerFound = true;
        markerLostFrames = 0;

        const statusBadge = $('statusBadge');
        statusBadge.className = 'status-badge status-ready';
        $('statusText').textContent = '마커 인식됨';

        $('captureBtn').disabled = false;
        $('guideText').textContent = '화면을 터치하여 꼭대기 → 밑동 포인트를 찍으세요';

        if (currentState === State.SCANNING) {
            setState(State.READY);
        }

        showToast('✅ 마커 인식 성공!');
    }

    function onMarkerLost() {
        isMarkerFound = false;

        const statusBadge = $('statusBadge');
        statusBadge.className = 'status-badge status-scanning';
        $('statusText').textContent = '마커 검색 중...';

        if (currentState === State.READY) {
            $('guideText').textContent = '마커를 카메라에 비추세요';
        }
        // 측정 중이라면 데이터 유지
    }

    // ===== Touch Point Handling =====
    function onCapturePoint() {
        // 화면 중앙에 포인트 찍기 (크로스헤어 위치)
        addTouchPoint(window.innerWidth / 2, window.innerHeight / 2);
    }

    function addTouchPoint(screenX, screenY) {
        const { index, point } = Measure.addPoint(screenX, screenY);

        // 화면에 터치 포인트 마커 표시
        const container = $('touchPointsContainer');

        if (index === 0) {
            // 첫 번째 포인트 — 이전 것들 제거
            container.innerHTML = '';
            setState(State.MEASURING);
            $('guideText').textContent = '밑동 위치를 터치하세요';
            showToast('📍 꼭대기 포인트');
        }

        // 포인트 DOM 요소 생성
        const dot = document.createElement('div');
        dot.className = 'touch-point';
        dot.style.left = screenX + 'px';
        dot.style.top = screenY + 'px';
        container.appendChild(dot);

        if (index === 1) {
            // 두 번째 포인트 — 높이 계산
            $('guideText').textContent = '측정 완료!';

            const measurement = getCurrentMeasurement();
            if (measurement) {
                // 측정값 표시
                $('heightValue').textContent = measurement.height.toFixed(2);
                $('measurementDisplay').classList.add('active');
                showToast(`📏 높이: ${measurement.height.toFixed(2)}m`);

                // 두 포인트 사이 라인 표시
                drawMeasurementLine(
                    Measure.getPoints()[0],
                    Measure.getPoints()[1],
                    screenX, screenY
                );

                // 2초 후 결과 페이지로 이동
                setTimeout(() => {
                    goToResult(measurement);
                }, 2000);
            }
        }
    }

    function getCurrentMeasurement() {
        const marker = Detector.getLastDetection();
        let distance = 5; // 기본 거리 (마커 미검출 시 fallback)

        if (marker) {
            // 마커 검출 크기로 거리 추정 (320px 기준을 실제 해상도로 환산)
            const resolution = Camera.getResolution();
            const scale = resolution.width / 320;
            distance = Detector.estimateDistance(marker.pixelSize * scale);
        }

        return Measure.calculateHeight(distance);
    }

    function drawMeasurementLine(p1, p2, endX, endY) {
        const container = $('touchPointsContainer');
        const firstPoint = container.querySelector('.touch-point');
        if (!firstPoint) return;

        const startX = parseFloat(firstPoint.style.left);
        const startY = parseFloat(firstPoint.style.top);

        const line = document.createElement('div');
        line.className = 'measurement-line';
        const dy = endY - startY;
        const dx = endX - startX;
        const length = Math.sqrt(dx * dx + dy * dy);
        const angle = Math.atan2(dx, -dy) * (180 / Math.PI);

        line.style.left = startX + 'px';
        line.style.top = startY + 'px';
        line.style.height = length + 'px';
        line.style.transform = `rotate(${angle}deg)`;
        container.appendChild(line);
    }

    // ===== Result =====
    function goToResult(measurement) {
        // 현재 프레임 캡처
        const imageData = Camera.captureFrame();

        // sessionStorage에 결과 저장
        sessionStorage.setItem('measurementResult', JSON.stringify({
            height: measurement.height,
            width: measurement.width,
            distance: measurement.distance,
            imageData: imageData,
            timestamp: Date.now(),
        }));

        // 카메라 해제
        Camera.stop();
        cancelAnimationFrame(animationFrameId);

        // 결과 페이지로 이동
        window.location.href = 'result.html';
    }

    // ===== State Management =====
    function setState(newState) {
        currentState = newState;
        console.log(`[App] State: ${newState}`);
    }

    function resetMeasurement() {
        Measure.reset();
        $('touchPointsContainer').innerHTML = '';
        $('measurementDisplay').classList.remove('active');
        $('guideText').textContent = isMarkerFound
            ? '화면을 터치하여 꼭대기 → 밑동 포인트를 찍으세요'
            : '마커를 카메라에 비추세요';

        if (isMarkerFound) {
            setState(State.READY);
        } else {
            setState(State.SCANNING);
        }
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
        Camera.stop();
        if (animationFrameId) {
            cancelAnimationFrame(animationFrameId);
        }
    });
})();
