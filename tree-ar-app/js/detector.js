/**
 * detector.js — 마커 검출 모듈 (AR.js + js-aruco 하이브리드)
 * Phase 1에서는 간단한 시각적 마커 검출 시뮬레이션을 구현하고,
 * Phase 2에서 실제 AR.js / js-aruco 라이브러리를 통합한다.
 *
 * 현재(Phase 1): Hiro 마커의 특징(검정 사각 테두리 + 내부 패턴)을
 * 캔버스 이미지 분석으로 검출하는 기본 구조만 구현.
 * 실제 마커 검출은 AR.js 라이브러리가 담당하며,
 * 여기서는 공통 인터페이스를 정의한다.
 */

const Detector = (() => {
    let isInitialized = false;
    let markerSize = 0.20; // 20cm default

    // 마커 상태
    let lastDetected = null;
    let detectionCallbacks = {
        onFound: null,
        onLost: null,
    };

    /**
     * 검출기 초기화
     * @param {Object} options
     * @param {number} options.markerSize - 마커 실제 크기(미터)
     * @param {Function} options.onFound - 마커 검출 시 콜백
     * @param {Function} options.onLost - 마커 소실 시 콜백
     */
    function init(options = {}) {
        markerSize = options.markerSize || 0.20;
        detectionCallbacks.onFound = options.onFound || null;
        detectionCallbacks.onLost = options.onLost || null;
        isInitialized = true;
        console.log(`[Detector] 초기화 완료 (마커 크기: ${markerSize}m)`);
    }

    /**
     * 프레임에서 마커 검출 시도
     * Phase 1에서는 디바이스 방향 센서와 결합된 삼각측량 방식 사용.
     *
     * @param {ImageData} imageData - 비디오 프레임 이미지 데이터
     * @returns {Object|null} 검출 결과 { id, corners, confidence, pixelSize }
     */
    function detect(imageData) {
        if (!isInitialized) return null;

        // Phase 1: 간단한 사각형 검출 (Adaptive Threshold + Contour)
        const result = detectSquareMarker(imageData);

        if (result && result.confidence > 0.4) {
            if (!lastDetected) {
                // 새로 검출
                if (detectionCallbacks.onFound) {
                    detectionCallbacks.onFound(result);
                }
            }
            lastDetected = result;
            return result;
        } else {
            if (lastDetected) {
                // 소실
                if (detectionCallbacks.onLost) {
                    detectionCallbacks.onLost();
                }
            }
            lastDetected = null;
            return null;
        }
    }

    /**
     * 간단한 사각형 마커 검출 (Phase 1)
     * 이미지에서 검은 사각 테두리를 찾아 마커 후보로 판단.
     * 실제 패턴 매칭은 Phase 2에서 AR.js로 대체.
     */
    function detectSquareMarker(imageData) {
        const { width, height, data } = imageData;

        // 그레이스케일 변환된 데이터에서 검은 사각형 영역 탐색
        // 간단한 히스토그램 기반 검출 (프로토타입용)
        let darkPixelCount = 0;
        let darkCenterX = 0;
        let darkCenterY = 0;
        let minX = width, maxX = 0, minY = height, maxY = 0;

        // 샘플링 (성능을 위해 4px 간격)
        const step = 4;
        for (let y = 0; y < height; y += step) {
            for (let x = 0; x < width; x += step) {
                const idx = (y * width + x) * 4;
                const gray = (data[idx] + data[idx + 1] + data[idx + 2]) / 3;

                // 매우 어두운 픽셀 (검정 테두리 후보)
                if (gray < 60) {
                    darkPixelCount++;
                    darkCenterX += x;
                    darkCenterY += y;
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                    if (y < minY) minY = y;
                    if (y > maxY) maxY = y;
                }
            }
        }

        if (darkPixelCount < 50) return null;

        darkCenterX /= darkPixelCount;
        darkCenterY /= darkPixelCount;

        const regionWidth = maxX - minX;
        const regionHeight = maxY - minY;

        // 사각형 비율 확인 (정사각형에 가까운지)
        const aspectRatio = Math.min(regionWidth, regionHeight) /
            Math.max(regionWidth, regionHeight);

        if (aspectRatio < 0.5 || regionWidth < 30 || regionHeight < 30) {
            return null;
        }

        // 검은 영역의 밀도 (테두리 같은 분포인지)
        const expectedArea = regionWidth * regionHeight / (step * step);
        const density = darkPixelCount / expectedArea;

        // 테두리 패턴: 밀도가 0.15~0.5 사이 (속이 비어있는 사각형)
        const isMarkerLike = density > 0.1 && density < 0.6;

        if (!isMarkerLike) return null;

        const confidence = Math.min(0.9, aspectRatio * (1 - Math.abs(density - 0.3)));
        const pixelSize = (regionWidth + regionHeight) / 2;

        return {
            id: 0,
            corners: [
                [minX, minY],
                [maxX, minY],
                [maxX, maxY],
                [minX, maxY],
            ],
            center: { x: darkCenterX, y: darkCenterY },
            confidence: confidence,
            pixelSize: pixelSize,
            regionWidth: regionWidth,
            regionHeight: regionHeight,
        };
    }

    /**
     * 마커 기반 거리 추정
     * d ≈ (f × S) / p
     * @param {number} pixelSize - 마커의 이미지 상 픽셀 크기
     * @param {number} focalLength - 카메라 초점거리(px) - 기본 추정값 사용
     * @returns {number} 거리 (미터)
     */
    function estimateDistance(pixelSize, focalLength = 800) {
        if (pixelSize <= 0) return Infinity;
        return (focalLength * markerSize) / pixelSize;
    }

    /**
     * 현재 마커 상태
     */
    function getLastDetection() {
        return lastDetected;
    }

    function getMarkerSize() {
        return markerSize;
    }

    return {
        init,
        detect,
        estimateDistance,
        getLastDetection,
        getMarkerSize,
    };
})();
