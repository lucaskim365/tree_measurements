/**
 * measure.js — 측정 계산 모듈
 * 터치 포인트 2개를 기반으로 높이를 계산한다.
 *
 * 측정 원리:
 *   - 마커에서 카메라까지 거리 d를 마커 픽셀 크기로 추정
 *   - 화면상 두 점의 y좌표 차이 → 실제 세계의 높이 차이로 변환
 *   - h = d × (Δpx / f)  (f: 초점거리)
 */

const Measure = (() => {
    // 터치 포인트 저장
    let points = [];

    // 추정 초점거리 (px) — 일반적인 모바일 카메라 기준
    const DEFAULT_FOCAL_LENGTH = 800;

    // 화면/비디오 크기 매핑
    let videoWidth = 1280;
    let videoHeight = 720;
    let displayWidth = 0;
    let displayHeight = 0;

    /**
     * 초기화
     * @param {Object} opts
     * @param {number} opts.videoWidth
     * @param {number} opts.videoHeight
     * @param {number} opts.displayWidth - 화면에 보이는 비디오 너비
     * @param {number} opts.displayHeight - 화면에 보이는 비디오 높이
     */
    function init(opts) {
        videoWidth = opts.videoWidth || 1280;
        videoHeight = opts.videoHeight || 720;
        displayWidth = opts.displayWidth || window.innerWidth;
        displayHeight = opts.displayHeight || window.innerHeight;
    }

    /**
     * 터치 포인트 추가 (화면 좌표)
     * @param {number} screenX - 화면 x 좌표
     * @param {number} screenY - 화면 y 좌표
     * @returns {{ index: number, point: Object }} 추가된 포인트 정보
     */
    function addPoint(screenX, screenY) {
        if (points.length >= 2) {
            // 3번째 이상은 리셋 후 시작
            points = [];
        }

        const point = {
            screenX,
            screenY,
            // 화면 좌표를 비디오 좌표로 변환
            videoX: (screenX / displayWidth) * videoWidth,
            videoY: (screenY / displayHeight) * videoHeight,
            timestamp: Date.now(),
        };

        points.push(point);

        return {
            index: points.length - 1,
            point,
        };
    }

    /**
     * 현재 포인트들로 높이 계산
     * @param {number} distance - 카메라-나무 거리 (미터)
     * @param {number} focalLength - 카메라 초점거리 (px)
     * @returns {Object|null} { height, distance, points }
     */
    function calculateHeight(distance, focalLength = DEFAULT_FOCAL_LENGTH) {
        if (points.length < 2) return null;

        const p1 = points[0];
        const p2 = points[1];

        // 비디오 좌표 기준 y축 픽셀 차이
        const deltaPixelY = Math.abs(p2.videoY - p1.videoY);

        // 실제 높이 = 거리 × (픽셀 차이 / 초점거리)
        const height = distance * (deltaPixelY / focalLength);

        // x축 차이 → 폭 추정 (보너스)
        const deltaPixelX = Math.abs(p2.videoX - p1.videoX);
        const width = distance * (deltaPixelX / focalLength);

        return {
            height: Math.round(height * 100) / 100,
            width: Math.round(width * 100) / 100,
            distance: Math.round(distance * 100) / 100,
            pixelDeltaY: deltaPixelY,
            pixelDeltaX: deltaPixelX,
            points: [...points],
        };
    }

    /**
     * 삼각측량 기반 높이 계산 (마커 없이 사용자 거리 입력 시)
     * h = d × tan(θ_top) - d × tan(θ_bottom) + eyeHeight
     * @param {number} distance - 나무까지 거리 (m)
     * @param {number} angleTop - 꼭대기 기울기 (도)
     * @param {number} angleBottom - 밑동 기울기 (도)
     * @param {number} eyeHeight - 사용자 눈높이 (m, 기본 1.6)
     * @returns {number} 높이 (m)
     */
    function calculateByTriangulation(distance, angleTop, angleBottom, eyeHeight = 1.6) {
        const radTop = (angleTop * Math.PI) / 180;
        const radBottom = (angleBottom * Math.PI) / 180;

        const height =
            distance * Math.tan(radTop) -
            distance * Math.tan(radBottom);

        return Math.round(Math.abs(height) * 100) / 100;
    }

    /**
     * 포인트 초기화
     */
    function reset() {
        points = [];
    }

    /**
     * 현재 포인트 목록 반환
     */
    function getPoints() {
        return [...points];
    }

    /**
     * 화면 크기 업데이트 (리사이즈 시)
     */
    function updateDisplaySize(w, h) {
        displayWidth = w;
        displayHeight = h;
    }

    return {
        init,
        addPoint,
        calculateHeight,
        calculateByTriangulation,
        reset,
        getPoints,
        updateDisplaySize,
    };
})();
