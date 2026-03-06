/**
 * detector.js — Phase 2: AR.js + js-aruco 하이브리드 마커 검출
 *
 * AR.js (A-Frame 통합): Hiro/Custom .patt 패턴 마커 검출
 * js-aruco: ArUco 바이너리 마커 검출 (폴백)
 *
 * 두 라이브러리를 공통 인터페이스로 통합하여 앱에 제공한다.
 */

const Detector = (() => {
    let markerSize = 0.20; // 20cm
    let isInitialized = false;

    // 검출된 마커 상태
    let activeMarker = null;
    let markerDistance = 0;
    let markerVisible = false;

    // 콜백
    let callbacks = { onFound: null, onLost: null };

    // A-Frame 마커 엔티티 참조
    let hiroMarkerEl = null;
    let customMarkerEl = null;

    // js-aruco 검출기 (ArUco 폴백)
    let arucoDetector = null;
    let arucoCanvas = null;
    let arucoCtx = null;

    /**
     * 초기화 — A-Frame 마커 이벤트 바인딩 + js-aruco 셋업
     */
    function init(options = {}) {
        markerSize = options.markerSize || 0.20;
        callbacks.onFound = options.onFound || null;
        callbacks.onLost = options.onLost || null;

        // A-Frame 마커 이벤트 바인딩
        setupAFrameMarkers();

        // js-aruco 폴백 셋업
        setupAruco();

        isInitialized = true;
        console.log('[Detector] Phase 2 초기화 완료 (AR.js + js-aruco)');
    }

    /**
     * A-Frame 마커 이벤트 셋업
     */
    function setupAFrameMarkers() {
        hiroMarkerEl = document.getElementById('hiroMarker');
        customMarkerEl = document.getElementById('customMarker');

        const markers = [hiroMarkerEl, customMarkerEl].filter(Boolean);

        markers.forEach((markerEl, idx) => {
            const markerType = idx === 0 ? 'hiro' : 'custom';

            markerEl.addEventListener('markerFound', () => {
                console.log(`[Detector] AR.js 마커 검출: ${markerType}`);
                markerVisible = true;

                // 마커의 3D 위치에서 거리 계산
                const pos = new THREE.Vector3();
                markerEl.object3D.getWorldPosition(pos);
                markerDistance = pos.length(); // 카메라(원점)로부터 거리

                activeMarker = {
                    id: idx,
                    type: markerType,
                    source: 'arjs',
                    distance: markerDistance,
                    position: { x: pos.x, y: pos.y, z: pos.z },
                    confidence: 0.95,
                    markerEl: markerEl,
                };

                if (callbacks.onFound) callbacks.onFound(activeMarker);
            });

            markerEl.addEventListener('markerLost', () => {
                console.log(`[Detector] AR.js 마커 소실: ${markerType}`);
                markerVisible = false;

                // 약간의 딜레이 후 소실 처리 (순간적 소실 방지)
                setTimeout(() => {
                    if (!markerVisible) {
                        activeMarker = null;
                        if (callbacks.onLost) callbacks.onLost();
                    }
                }, 500);
            });
        });
    }

    /**
     * js-aruco 폴백 셋업
     * ArUco 마커 검출을 위한 캔버스 + 검출기 초기화
     */
    function setupAruco() {
        try {
            // js-aruco2가 로드되었는지 확인
            if (typeof AR !== 'undefined' && AR.Detector) {
                arucoDetector = new AR.Detector();
                arucoCanvas = document.createElement('canvas');
                arucoCanvas.width = 320;
                arucoCanvas.height = 240;
                arucoCtx = arucoCanvas.getContext('2d', { willReadFrequently: true });
                console.log('[Detector] js-aruco 폴백 준비 완료');
            } else {
                console.log('[Detector] js-aruco 미로드 — AR.js 단독 모드');
            }
        } catch (e) {
            console.warn('[Detector] js-aruco 초기화 실패:', e);
        }
    }

    /**
     * js-aruco로 비디오 프레임 검출 (폴백용)
     * AR.js가 마커를 못 찾을 때 ArUco 마커 검출 시도
     */
    function detectAruco(videoElement) {
        if (!arucoDetector || !videoElement || markerVisible) return null;

        try {
            arucoCtx.drawImage(videoElement, 0, 0, 320, 240);
            const imageData = arucoCtx.getImageData(0, 0, 320, 240);
            const markers = arucoDetector.detect(imageData);

            if (markers.length > 0) {
                const m = markers[0];
                const corners = m.corners;

                // 코너로부터 픽셀 크기 추정
                const dx = corners[1].x - corners[0].x;
                const dy = corners[1].y - corners[0].y;
                const pixelSize = Math.sqrt(dx * dx + dy * dy);

                // 거리 추정
                const focalLength = 280; // 320px 해상도 기준 추정 초점거리
                const dist = (focalLength * markerSize) / pixelSize;

                activeMarker = {
                    id: m.id,
                    type: 'aruco',
                    source: 'js-aruco',
                    distance: dist,
                    corners: corners,
                    pixelSize: pixelSize,
                    confidence: 0.85,
                };

                markerVisible = true;
                if (callbacks.onFound) callbacks.onFound(activeMarker);
                return activeMarker;
            }
        } catch (e) {
            // 조용히 실패
        }
        return null;
    }

    /**
     * 마커로부터 거리를 실시간 업데이트 (AR.js 기반)
     * RAF 루프에서 호출
     */
    function updateDistance() {
        if (!markerVisible || !activeMarker || !activeMarker.markerEl) return;

        try {
            const pos = new THREE.Vector3();
            activeMarker.markerEl.object3D.getWorldPosition(pos);
            markerDistance = pos.length();
            activeMarker.distance = markerDistance;
        } catch (e) {
            // markerEl이 없는 경우 (ArUco 등)
        }
    }

    /**
     * 거리 추정 (공식: d = f × S / p)
     * AR.js 활성 시 3D 포즈 기반 거리 사용
     */
    function estimateDistance(pixelSize, focalLength = 800) {
        // AR.js가 활성이면 3D 포즈 거리를 우선 사용
        if (markerVisible && activeMarker && activeMarker.source === 'arjs') {
            return activeMarker.distance;
        }
        // 폴백: 픽셀 기반 거리 추정
        if (pixelSize <= 0) return Infinity;
        return (focalLength * markerSize) / pixelSize;
    }

    /**
     * 현재 활성 마커 반환
     */
    function getActiveMarker() {
        return activeMarker;
    }

    /**
     * 현재 거리
     */
    function getDistance() {
        return markerDistance;
    }

    /**
     * 마커 가시성
     */
    function isVisible() {
        return markerVisible;
    }

    function getMarkerSize() {
        return markerSize;
    }

    // 하위 호환을 위한 별칭
    function getLastDetection() {
        return activeMarker;
    }

    return {
        init,
        detectAruco,
        updateDistance,
        estimateDistance,
        getActiveMarker,
        getLastDetection,
        getDistance,
        isVisible,
        getMarkerSize,
    };
})();
