/**
 * app.js — Phase 2: A-Frame + AR.js 통합 메인 컨트롤러
 *
 * 아키텍처:
 *   A-Frame AR.js → 마커 검출 + 3D 포즈 추정
 *   Detector.js   → 이벤트 래핑 + js-aruco 폴백
 *   Measure.js    → 높이/폭 계산 + GPS
 *   Canvas        → 2D 오버레이 (측정 라인, 포인트)
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

    const $ = (id) => document.getElementById(id);

    // ===== Boot =====
    document.addEventListener('DOMContentLoaded', () => {
        const retryBtn = $('retryBtn');

        retryBtn.addEventListener('click', () => {
            window.location.reload();
        });

        // A-Frame 씬 로드 대기
        const scene = $('arScene');

        if (!scene) {
            showError('A-Frame 씬을 찾을 수 없습니다.');
            return;
        }

        // A-Frame이 준비되면 시작
        if (scene.hasLoaded) {
            onSceneReady();
        } else {
            scene.addEventListener('loaded', onSceneReady);
        }

        // 타임아웃 (20초 내 로드 실패 시)
        setTimeout(() => {
            if (currentState === State.LOADING) {
                showError('AR 엔진 로딩 시간 초과. 인터넷 연결을 확인하세요.');
            }
        }, 20000);
    });

    // ===== Scene Ready =====
    function onSceneReady() {
        console.log('[App] A-Frame 씬 로드 완료');

        // 로딩 오버레이 숨기기
        $('loadingScreen').classList.add('hidden');
        $('arScene').style.display = '';

        // 오버레이 캔버스 셋업
        canvas = $('overlayCanvas');
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
        ctx = canvas.getContext('2d');

        // Measure 초기화
        Measure.init({
            videoWidth: window.innerWidth,  // A-Frame은 전체 화면 사용
            videoHeight: window.innerHeight,
            displayWidth: window.innerWidth,
            displayHeight: window.innerHeight,
        });

        // Detector 초기화 (A-Frame 마커 이벤트 바인딩)
        Detector.init({
            markerSize: 0.20,
            onFound: onMarkerFound,
            onLost: onMarkerLost,
        });

        // 이벤트 바인딩
        bindEvents();

        // 업데이트 루프 시작
        startUpdateLoop();

        setState(State.SCANNING);
        showToast('📷 카메라 활성화 — 마커를 비추세요');
    }

    // ===== Events =====
    function bindEvents() {
        // 캡처 버튼 (중앙 포인트)
        $('captureBtn').addEventListener('click', (e) => {
            e.stopPropagation();
            addTouchPoint(window.innerWidth / 2, window.innerHeight / 2);
        });

        // 화면 터치로 포인트
        document.addEventListener('click', (e) => {
            if (e.target.closest('.ar-controls') ||
                e.target.closest('.ar-status-bar') ||
                e.target.closest('.mode-toggle') ||
                e.target.closest('.overlay-screen') ||
                e.target.closest('a-scene')) return;

            if (currentState === State.READY || currentState === State.MEASURING) {
                addTouchPoint(e.clientX, e.clientY);
            }
        });

        // 화면 터치 (터치 이벤트 직접 처리)
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

        // 모드 토글 (높이/폭)
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

        // 토치
        $('torchBtn').addEventListener('click', async () => {
            try {
                // A-Frame의 비디오 트랙에 접근
                const videoEl = document.querySelector('video');
                if (videoEl && videoEl.srcObject) {
                    const track = videoEl.srcObject.getVideoTracks()[0];
                    if (track) {
                        const caps = track.getCapabilities();
                        if (caps.torch) {
                            const settings = track.getSettings();
                            const on = !settings.torch;
                            await track.applyConstraints({ advanced: [{ torch: on }] });
                            $('torchBtn').textContent = on ? '💡' : '🔦';
                            showToast(on ? '💡 플래시 켜짐' : '🔦 플래시 꺼짐');
                            return;
                        }
                    }
                }
                showToast('이 기기는 플래시를 지원하지 않습니다');
            } catch (e) {
                showToast('플래시를 사용할 수 없습니다');
            }
        });

        // 리셋
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
    function startUpdateLoop() {
        function tick() {
            // 1. AR.js 거리 업데이트
            Detector.updateDistance();

            // 2. 거리 표시 업데이트
            if (Detector.isVisible()) {
                const dist = Detector.getDistance();
                if (dist > 0 && dist < 50) {
                    $('distanceInfo').classList.add('visible');
                    $('distanceValue').textContent = dist.toFixed(2);
                }
            } else {
                $('distanceInfo').classList.remove('visible');
            }

            // 3. js-aruco 폴백 (AR.js가 못 잡을 때)
            if (!Detector.isVisible()) {
                const videoEl = document.querySelector('video');
                if (videoEl) {
                    Detector.detectAruco(videoEl);
                }
            }

            // 4. 오버레이 그리기
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

            // 외곽 원
            ctx.beginPath();
            ctx.arc(x, y, 12, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(74, 222, 128, 0.2)';
            ctx.fill();
            ctx.strokeStyle = '#4ade80';
            ctx.lineWidth = 2;
            ctx.stroke();

            // 내부 점
            ctx.beginPath();
            ctx.arc(x, y, 4, 0, Math.PI * 2);
            ctx.fillStyle = '#4ade80';
            ctx.fill();

            // 라벨
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

            // 측정 라인
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

            // 치수 라벨 (라인 중간)
            const measurement = getCurrentMeasurement();
            if (measurement) {
                const mx = (x1 + x2) / 2 + 16;
                const my = (y1 + y2) / 2;
                const val = measurement.primary;
                const label = mode === 'height' ? `높이: ${val}m` : `폭: ${val}m`;

                // 배경
                ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
                const textWidth = ctx.measureText(label).width;
                ctx.fillRect(mx - 6, my - 16, textWidth + 12, 24);

                // 텍스트
                ctx.fillStyle = '#4ade80';
                ctx.font = 'bold 14px Inter, Noto Sans KR, sans-serif';
                ctx.fillText(label, mx, my);
            }
        }
    }

    // ===== Marker Events =====
    function onMarkerFound(marker) {
        const statusBadge = $('statusBadge');
        statusBadge.className = 'status-badge status-ready';

        const source = marker.source === 'arjs' ? 'AR.js' : 'ArUco';
        const type = marker.type === 'hiro' ? 'Hiro' : marker.type === 'custom' ? 'Custom' : `#${marker.id}`;
        $('statusText').textContent = `${type} 마커 (${source})`;

        $('captureBtn').disabled = false;

        const mode = Measure.getMode();
        if (mode === 'height') {
            $('guideText').textContent = '꼭대기 → 밑동 순서로 터치하세요';
        } else {
            $('guideText').textContent = '왼쪽 → 오른쪽 순서로 터치하세요';
        }

        if (currentState === State.SCANNING) {
            setState(State.READY);
            showToast(`✅ ${type} 마커 인식! (${source})`);
        }
    }

    function onMarkerLost() {
        $('statusBadge').className = 'status-badge status-scanning';
        $('statusText').textContent = '마커 검색 중...';
        $('distanceInfo').classList.remove('visible');

        if (currentState === State.READY) {
            $('guideText').textContent = '마커를 카메라에 비추세요';
        }
    }

    // ===== Touch Point Handling =====
    function addTouchPoint(screenX, screenY) {
        const { index } = Measure.addPoint(screenX, screenY);

        // HTML 터치 포인트 마커
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

        // 포인트 DOM
        const dot = document.createElement('div');
        dot.className = 'touch-point';
        dot.style.left = screenX + 'px';
        dot.style.top = screenY + 'px';
        container.appendChild(dot);

        if (index === 1) {
            // 측정 완료
            setState(State.DONE);
            const measurement = getCurrentMeasurement();

            if (measurement) {
                $('guideText').textContent = '측정 완료!';
                $('measureValue').textContent = measurement.primary.toFixed(2);
                $('measureLabel').textContent = mode === 'height' ? '높이 (m)' : '폭 (m)';
                $('measurementDisplay').classList.add('active');

                const label = mode === 'height' ? '높이' : '폭';
                showToast(`📏 ${label}: ${measurement.primary.toFixed(2)}m`);

                // 2.5초 후 결과 페이지로
                setTimeout(() => goToResult(measurement), 2500);
            }
        }
    }

    function getCurrentMeasurement() {
        let distance = Detector.getDistance();

        // 거리가 비정상이면 기본값 사용
        if (!distance || distance <= 0 || distance > 50) {
            distance = 5;
        }

        // 초점거리 추정: A-Frame 카메라 FOV 기반
        const fov = 45; // degrees (추정)
        const focalLength = (window.innerHeight / 2) / Math.tan((fov / 2) * Math.PI / 180);

        return Measure.calculate(distance, focalLength);
    }

    // ===== Result =====
    function goToResult(measurement) {
        // 현재 화면 캡처
        let imageData = null;
        try {
            const arCanvas = document.querySelector('a-scene canvas');
            if (arCanvas) {
                imageData = arCanvas.toDataURL('image/jpeg', 0.85);
            }
        } catch (e) {
            console.warn('[App] 화면 캡처 실패:', e);
        }

        // GPS 포함
        const gps = Measure.getGPS();

        sessionStorage.setItem('measurementResult', JSON.stringify({
            height: measurement.height,
            width: measurement.width,
            distance: measurement.distance,
            mode: measurement.mode,
            primary: measurement.primary,
            gps: gps,
            imageData: imageData,
            timestamp: Date.now(),
        }));

        if (animFrameId) cancelAnimationFrame(animFrameId);
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
            $('guideText').textContent = '마커를 카메라에 비추세요';
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
    window.addEventListener('beforeunload', () => {
        if (animFrameId) cancelAnimationFrame(animFrameId);
    });
})();
