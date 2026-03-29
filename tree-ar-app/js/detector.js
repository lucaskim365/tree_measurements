/**
 * detector.js — Phase 3: jsQR 기반 QR 코드 감지
 *
 * jsQR 라이브러리로 카메라 프레임에서 QR 코드를 감지한다.
 * - QR 코드 4개 코너 좌표로 카메라-마커 거리 추정
 * - QR 데이터(JSON) 파싱 → 나무 ID, 수종, 관리정보 추출
 * - 감지 캔버스 640×480 고정 (성능 최적화)
 *
 * QR 데이터 형식 (JSON):
 *   { "id": "TREE-001", "species": "소나무", "planted": "2010-03",
 *     "location": "A구역", "manager": "산림청", "size": 20 }
 *   size: 마커 실물 크기 (cm), 생략 시 기본 20cm 사용
 *   JSON이 아닌 경우 raw 문자열을 id로 처리
 *
 * 거리 추정 공식: d = f × S / p
 *   f: 초점거리 (px, 감지 캔버스 기준 추정값)
 *   S: 마커 실물 크기 (m)
 *   p: QR 상단 변의 픽셀 길이
 */

const Detector = (() => {
    const DETECT_WIDTH = 640;
    const DETECT_HEIGHT = 480;
    // 640px 너비, 수평 FOV ~60° 기준 추정 초점거리
    const FOCAL_LENGTH = 554;

    let markerSize = 0.20; // 기본 20cm
    let isInitialized = false;

    let activeMarker = null;
    let markerDistance = 0;
    let markerVisible = false;
    let qrData = null;

    let callbacks = { onFound: null, onLost: null };

    // 감지용 오프스크린 캔버스
    let detectionCanvas = null;
    let detectionCtx = null;

    // 마커 소실 디바운스 타이머
    let lostTimer = null;

    /**
     * 초기화
     */
    function init(options = {}) {
        markerSize = options.markerSize || 0.20;
        callbacks.onFound = options.onFound || null;
        callbacks.onLost = options.onLost || null;

        detectionCanvas = document.createElement('canvas');
        detectionCanvas.width = DETECT_WIDTH;
        detectionCanvas.height = DETECT_HEIGHT;
        detectionCtx = detectionCanvas.getContext('2d', { willReadFrequently: true });

        isInitialized = true;
        console.log('[Detector] jsQR 초기화 완료 (640×480 감지 캔버스)');
    }

    /**
     * 비디오 프레임에서 QR 코드 감지
     * app.js의 RAF 루프에서 매 프레임 호출
     * @param {HTMLVideoElement} videoElement
     * @returns {Object|null} 감지된 마커 정보
     */
    function detectQR(videoElement) {
        if (!isInitialized || !videoElement) return null;
        if (videoElement.readyState < 2) return null;
        if (typeof jsQR === 'undefined') {
            console.warn('[Detector] jsQR 라이브러리가 로드되지 않았습니다.');
            return null;
        }

        try {
            detectionCtx.drawImage(videoElement, 0, 0, DETECT_WIDTH, DETECT_HEIGHT);
            const imageData = detectionCtx.getImageData(0, 0, DETECT_WIDTH, DETECT_HEIGHT);
            const code = jsQR(imageData.data, imageData.width, imageData.height, {
                inversionAttempts: 'dontInvert',
            });

            if (code) {
                // 소실 타이머 취소
                if (lostTimer) {
                    clearTimeout(lostTimer);
                    lostTimer = null;
                }

                // QR 데이터 파싱
                // 형식 A (파이프 ASCII): id|planted|size  ← 기본 형식
                // 형식 B (JSON):        {"id":...}        ← 구버전 호환
                let parsed = null;
                try {
                    if (code.data.startsWith('{')) {
                        // JSON 형식 (구버전 호환)
                        const raw = JSON.parse(code.data);
                        parsed = { id: raw.id || raw.id };
                        if (raw.species  || raw.sp)  parsed.species  = raw.species  || raw.sp;
                        if (raw.planted  || raw.dt)  parsed.planted  = raw.planted  || raw.dt;
                        if (raw.location || raw.loc) parsed.location = raw.location || raw.loc;
                        if (raw.manager  || raw.mgr) parsed.manager  = raw.manager  || raw.mgr;
                        if (raw.size     || raw.sz)  parsed.size     = raw.size     || raw.sz;
                    } else {
                        // 파이프 형식: id|planted|size
                        const p = code.data.split('|');
                        parsed = { id: p[0] };
                        if (p[1]) parsed.planted = p[1];
                        if (p[2]) parsed.size    = parseInt(p[2]) || 20;
                    }
                    // 마커 크기 업데이트 (cm → m)
                    if (parsed.size && typeof parsed.size === 'number') {
                        markerSize = parsed.size / 100;
                    }
                } catch (_) {
                    parsed = { id: code.data };
                }
                qrData = parsed;

                // 거리 추정: QR 상단 변의 픽셀 길이 사용
                const loc = code.location;
                const dx = loc.topRightCorner.x - loc.topLeftCorner.x;
                const dy = loc.topRightCorner.y - loc.topLeftCorner.y;
                const pixelSizeDetect = Math.sqrt(dx * dx + dy * dy);

                // 감지 캔버스 → 실제 비디오 해상도 스케일 보정
                const realWidth = videoElement.videoWidth || DETECT_WIDTH;
                const scaleX = realWidth / DETECT_WIDTH;
                const pixelSizeReal = pixelSizeDetect * scaleX;

                let dist = pixelSizeReal > 0
                    ? (FOCAL_LENGTH * scaleX * markerSize) / pixelSizeReal
                    : 2.0;

                // 물리적으로 불가능한 거리 클램핑 (0.3m ~ 30m)
                dist = Math.max(0.3, Math.min(dist, 30));
                markerDistance = dist;

                const wasVisible = markerVisible;
                markerVisible = true;

                activeMarker = {
                    id: parsed.id || 'QR',
                    type: 'qr',
                    source: 'jsqr',
                    distance: markerDistance,
                    corners: [
                        loc.topLeftCorner,
                        loc.topRightCorner,
                        loc.bottomRightCorner,
                        loc.bottomLeftCorner,
                    ],
                    pixelSize: pixelSizeReal,
                    confidence: 0.9,
                    qrData: parsed,
                };

                if (!wasVisible && callbacks.onFound) {
                    callbacks.onFound(activeMarker);
                }

                return activeMarker;

            } else {
                // 이번 프레임에서 QR 미감지 → 디바운스 후 소실 처리
                if (markerVisible && !lostTimer) {
                    lostTimer = setTimeout(() => {
                        markerVisible = false;
                        activeMarker = null;
                        qrData = null;
                        lostTimer = null;
                        if (callbacks.onLost) callbacks.onLost();
                    }, 500);
                }
            }
        } catch (e) {
            // 조용히 실패 (프레임 처리 오류)
        }

        return null;
    }

    /**
     * app.js RAF 루프 호환용 (AR.js 방식의 updateDistance 대체)
     * detectQR에서 이미 거리가 업데이트되므로 여기선 아무 작업 없음
     */
    function updateDistance() {}

    /**
     * 픽셀 크기 기반 거리 추정 (외부 호출용 유틸)
     */
    function estimateDistance(pixelSize) {
        if (markerVisible && activeMarker) return activeMarker.distance;
        if (pixelSize <= 0) return Infinity;
        return (FOCAL_LENGTH * markerSize) / pixelSize;
    }

    function getActiveMarker() { return activeMarker; }
    function getLastDetection() { return activeMarker; }
    function getDistance() { return markerDistance; }
    function isVisible() { return markerVisible; }
    function getMarkerSize() { return markerSize; }

    /**
     * 마지막으로 파싱된 QR 데이터 반환
     * @returns {{ id, species, planted, location, manager, size, ... } | null}
     */
    function getQRData() { return qrData; }

    return {
        init,
        detectQR,
        updateDistance,
        estimateDistance,
        getActiveMarker,
        getLastDetection,
        getDistance,
        isVisible,
        getMarkerSize,
        getQRData,
    };
})();
