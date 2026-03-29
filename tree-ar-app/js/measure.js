/**
 * measure.js — Phase 2: 높이 + 수관폭 측정 모듈
 *
 * 측정 모드:
 *   height — 꼭대기~밑동 수직 거리 (높이)
 *   width  — 좌~우 수평 거리 (수관폭)
 *
 * 측정 원리:
 *   h = d × (Δpx / f)
 *   d: 카메라-마커 거리 (AR.js 3D 포즈 또는 마커 픽셀 크기 추정)
 *   Δpx: 두 터치 점의 y축(높이) 또는 x축(폭) 픽셀 차이
 *   f: 추정 초점거리 (px)
 */

const Measure = (() => {
    let points = [];
    let mode = 'height'; // 'height' | 'width'

    const DEFAULT_FOCAL_LENGTH = 800;

    let videoWidth = 1280;
    let videoHeight = 720;
    let displayWidth = 0;
    let displayHeight = 0;

    // GPS 좌표 캐시
    let lastGPS = null;
    // watchPosition ID (메모리 누수 방지용)
    let watchId = null;

    /**
     * 초기화
     */
    function init(opts) {
        videoWidth = opts.videoWidth || 1280;
        videoHeight = opts.videoHeight || 720;
        displayWidth = opts.displayWidth || window.innerWidth;
        displayHeight = opts.displayHeight || window.innerHeight;

        // GPS 위치 추적 시작
        startGPSTracking();
    }

    /**
     * GPS 위치 추적 시작
     */
    function startGPSTracking() {
        if (!navigator.geolocation) {
            console.warn('[Measure] Geolocation API 미지원');
            return;
        }

        // 초기 위치 취득
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                lastGPS = {
                    lat: pos.coords.latitude,
                    lng: pos.coords.longitude,
                    accuracy: pos.coords.accuracy,
                    altitude: pos.coords.altitude,
                    timestamp: pos.timestamp,
                };
                console.log('[Measure] GPS 취득:', lastGPS);
            },
            (err) => console.warn('[Measure] GPS 실패:', err.message),
            { enableHighAccuracy: true, timeout: 10000 }
        );

        // 지속적 추적 (위치 변경 시 업데이트)
        watchId = navigator.geolocation.watchPosition(
            (pos) => {
                lastGPS = {
                    lat: pos.coords.latitude,
                    lng: pos.coords.longitude,
                    accuracy: pos.coords.accuracy,
                    altitude: pos.coords.altitude,
                    timestamp: pos.timestamp,
                };
            },
            () => { /* 무시 */ },
            { enableHighAccuracy: true, maximumAge: 30000 }
        );
    }

    /**
     * 현재 GPS 위치 반환
     */
    function getGPS() {
        return lastGPS;
    }

    /**
     * 측정 모드 변경
     * @param {'height'|'width'} newMode
     */
    function setMode(newMode) {
        if (newMode === 'height' || newMode === 'width') {
            mode = newMode;
            points = [];
            console.log(`[Measure] 모드 변경: ${mode}`);
        }
    }

    /**
     * 현재 모드
     */
    function getMode() {
        return mode;
    }

    /**
     * 터치 포인트 추가 (화면 좌표)
     */
    function addPoint(screenX, screenY) {
        if (points.length >= 2) {
            points = [];
        }

        const point = {
            screenX,
            screenY,
            videoX: (screenX / displayWidth) * videoWidth,
            videoY: (screenY / displayHeight) * videoHeight,
            timestamp: Date.now(),
        };

        points.push(point);

        return { index: points.length - 1, point };
    }

    /**
     * 높이 또는 폭 계산 (현재 모드에 따라)
     * @param {number} distance - 카메라-나무 거리 (m)
     * @param {number} focalLength - 초점거리 (px)
     * @returns {Object|null}
     */
    function calculate(distance, focalLength = DEFAULT_FOCAL_LENGTH) {
        if (points.length < 2) return null;

        const p1 = points[0];
        const p2 = points[1];

        // 비디오 좌표계 기준 차이
        const deltaPixelY = Math.abs(p2.videoY - p1.videoY);
        const deltaPixelX = Math.abs(p2.videoX - p1.videoX);

        // 현재 모드에 따라 주요 측정값 결정
        let primaryValue, secondaryValue;

        if (mode === 'height') {
            primaryValue = distance * (deltaPixelY / focalLength);   // 높이
            secondaryValue = distance * (deltaPixelX / focalLength); // 폭 (보조)
        } else {
            primaryValue = distance * (deltaPixelX / focalLength);   // 폭
            secondaryValue = distance * (deltaPixelY / focalLength); // 높이 (보조)
        }

        return {
            mode: mode,
            height: mode === 'height'
                ? Math.round(primaryValue * 100) / 100
                : Math.round(secondaryValue * 100) / 100,
            width: mode === 'width'
                ? Math.round(primaryValue * 100) / 100
                : Math.round(secondaryValue * 100) / 100,
            primary: Math.round(primaryValue * 100) / 100,
            distance: Math.round(distance * 100) / 100,
            gps: lastGPS,
            pixelDeltaY: deltaPixelY,
            pixelDeltaX: deltaPixelX,
            points: [...points],
        };
    }

    /**
     * 하위호환: calculateHeight
     */
    function calculateHeight(distance, focalLength) {
        const prevMode = mode;
        mode = 'height';
        const result = calculate(distance, focalLength);
        mode = prevMode;
        return result;
    }

    /**
     * GPS 추적 중단 (beforeunload 시 호출)
     */
    function stop() {
        if (watchId !== null) {
            navigator.geolocation.clearWatch(watchId);
            watchId = null;
        }
    }

    /**
     * 포인트 초기화
     */
    function reset() {
        points = [];
    }

    function getPoints() {
        return [...points];
    }

    function updateDisplaySize(w, h) {
        displayWidth = w;
        displayHeight = h;
    }

    return {
        init,
        setMode,
        getMode,
        addPoint,
        calculate,
        calculateHeight,
        reset,
        stop,
        getPoints,
        getGPS,
        updateDisplaySize,
    };
})();
