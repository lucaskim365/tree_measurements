/**
 * homography.js — QR 4코너 → 호모그래피 → f, d, R 계산
 *
 * Phase A 구현:
 *   - DLT + Hartley 정규화로 3×3 호모그래피 H 계산
 *   - H에서 초점거리 f 추출 (직교 제약 2개)
 *   - H에서 카메라 회전 R, 이동 t 분해
 *   - DeviceOrientation → R_device_to_world 변환
 *   - 픽셀 광선 → 나무 수직면(x=d) 교점
 */
const Homography = (() => {

    // 20×20cm QR 코너 실세계 좌표 (m, QR 중심=원점, Z=0)
    // 순서: 좌상, 우상, 우하, 좌하 (jsQR location 순서와 동일)
    const QR_WORLD_XY = [
        [-0.10,  0.10],  // topLeft
        [ 0.10,  0.10],  // topRight
        [ 0.10, -0.10],  // bottomRight
        [-0.10, -0.10],  // bottomLeft
    ];

    // 카메라↔기기 좌표 변환: X_cam=+X_dev, Y_cam=-Y_dev, Z_cam=-Z_dev
    const R_CAM_TO_DEV = new Float64Array([1,0,0, 0,-1,0, 0,0,-1]);

    /* ─── 행렬 유틸 ─── */

    function mat3mul(A, B) {
        const C = new Float64Array(9);
        for (let i = 0; i < 3; i++)
            for (let j = 0; j < 3; j++)
                for (let k = 0; k < 3; k++)
                    C[i*3+j] += A[i*3+k] * B[k*3+j];
        return C;
    }

    function mat3inv(M) {
        const [a,b,c,d,e,f,g,h,k] = M;
        const det = a*(e*k-f*h) - b*(d*k-f*g) + c*(d*h-e*g);
        const s = 1/det;
        return new Float64Array([
            (e*k-f*h)*s, (c*h-b*k)*s, (b*f-c*e)*s,
            (f*g-d*k)*s, (a*k-c*g)*s, (c*d-a*f)*s,
            (d*h-e*g)*s, (b*g-a*h)*s, (a*e-b*d)*s,
        ]);
    }

    function mat3vec(M, v) {
        return [
            M[0]*v[0]+M[1]*v[1]+M[2]*v[2],
            M[3]*v[0]+M[4]*v[1]+M[5]*v[2],
            M[6]*v[0]+M[7]*v[1]+M[8]*v[2],
        ];
    }

    function vecNorm(v) { return Math.sqrt(v.reduce((s,x)=>s+x*x, 0)); }

    function vecCross([ax,ay,az],[bx,by,bz]) {
        return [ay*bz-az*by, az*bx-ax*bz, ax*by-ay*bx];
    }

    /* ─── Hartley 정규화 ─── */

    function normalize2D(pts) {
        const n = pts.length;
        let cx = 0, cy = 0;
        for (const [x,y] of pts) { cx += x; cy += y; }
        cx /= n; cy /= n;

        let avgDist = 0;
        for (const [x,y] of pts) avgDist += Math.sqrt((x-cx)**2+(y-cy)**2);
        avgDist /= n;

        const s = Math.SQRT2 / (avgDist || 1);
        const T = new Float64Array([s, 0, -s*cx,  0, s, -s*cy,  0, 0, 1]);
        const pts_n = pts.map(([x,y]) => [s*(x-cx), s*(y-cy)]);
        return { pts_n, T };
    }

    /* ─── Gaussian 소거 (h[8]=1 고정) ─── */

    function solveNullspace(rows) {
        // rows: 8행 × 9열, h[8]=1로 고정하여 8×8 시스템으로 축소
        const M = rows.map(r => [...r.slice(0,8), -r[8]]);

        for (let col = 0; col < 8; col++) {
            let maxRow = col;
            for (let r = col+1; r < 8; r++)
                if (Math.abs(M[r][col]) > Math.abs(M[maxRow][col])) maxRow = r;
            [M[col], M[maxRow]] = [M[maxRow], M[col]];

            const piv = M[col][col];
            if (Math.abs(piv) < 1e-12) continue;

            for (let r = col+1; r < 8; r++) {
                const f = M[r][col] / piv;
                for (let j = col; j <= 8; j++) M[r][j] -= f * M[col][j];
            }
        }

        const h = new Float64Array(9);
        h[8] = 1;
        for (let row = 7; row >= 0; row--) {
            let rhs = M[row][8];
            for (let j = row+1; j < 8; j++) rhs -= M[row][j] * h[j];
            h[row] = rhs / M[row][row];
        }
        return h;
    }

    /* ─── DLT 호모그래피 ─── */

    /**
     * 4점 대응에서 3×3 호모그래피 H 계산 (Hartley 정규화 + DLT)
     * @param {Array<[number,number]>} src - 4개 소스 포인트 (세계 XY, m)
     * @param {Array<[number,number]>} dst - 4개 목적 포인트 (픽셀 UV)
     * @returns {Float64Array} H (행 우선, length=9)
     */
    function computeH(src, dst) {
        const { pts_n: sn, T: T1 } = normalize2D(src);
        const { pts_n: dn, T: T2 } = normalize2D(dst);

        const A = [];
        for (let i = 0; i < 4; i++) {
            const [X,Y] = sn[i], [u,v] = dn[i];
            A.push([-X,-Y,-1,  0, 0, 0, u*X, u*Y, u]);
            A.push([  0, 0, 0, -X,-Y,-1, v*X, v*Y, v]);
        }

        const hn = solveNullspace(A);

        // 비정규화: H_real = T2⁻¹ · H_norm · T1
        const H = mat3mul(mat3mul(mat3inv(T2), hn), T1);

        if (Math.abs(H[8]) > 1e-10) {
            const s = H[8];
            for (let i = 0; i < 9; i++) H[i] /= s;
        }
        return H;
    }

    /* ─── H → 초점거리 f ─── */

    /**
     * H에서 초점거리 f 추출 (cx=W/2, cy=H/2, 정사각형 픽셀 가정)
     * 직교 제약:
     *   (I)  h₁ᵀ·ω·h₂ = 0
     *   (II) h₁ᵀ·ω·h₁ = h₂ᵀ·ω·h₂
     * ω = K⁻ᵀK⁻¹, w = 1/f²
     *
     * @param {Float64Array} H
     * @param {number} cx
     * @param {number} cy
     * @returns {number|null} f (픽셀) 또는 null
     */
    function extractFocal(H, cx, cy) {
        const h1 = [H[0], H[3], H[6]];  // 1열
        const h2 = [H[1], H[4], H[7]];  // 2열

        // K⁻¹ 적용: aᵢ = hᵢ[0]-cx·hᵢ[2], bᵢ = hᵢ[1]-cy·hᵢ[2]
        const a1=h1[0]-cx*h1[2], b1=h1[1]-cy*h1[2];
        const a2=h2[0]-cx*h2[2], b2=h2[1]-cy*h2[2];

        const ws = [];

        // 제약 (I): w = -h1[2]·h2[2] / (a1·a2 + b1·b2)
        const d1 = a1*a2 + b1*b2;
        if (Math.abs(d1) > 1e-8) {
            const w = -h1[2]*h2[2] / d1;
            if (w > 0) ws.push(w);
        }

        // 제약 (II): w = (h2[2]²-h1[2]²) / (a1²+b1²-a2²-b2²)
        const d2 = a1*a1+b1*b1 - a2*a2-b2*b2;
        if (Math.abs(d2) > 1e-8) {
            const w = (h2[2]*h2[2]-h1[2]*h1[2]) / d2;
            if (w > 0) ws.push(w);
        }

        if (ws.length === 0) return null;
        return Math.sqrt(ws.length / ws.reduce((s,w) => s+w, 0));  // 조화평균
    }

    /* ─── H → R, t 분해 ─── */

    /**
     * @param {Float64Array} H
     * @param {number} f
     * @param {number} cx
     * @param {number} cy
     * @returns {{ R: Float64Array, t: Float64Array }}
     */
    function decomposeH(H, f, cx, cy) {
        const Kinv = new Float64Array([1/f,0,-cx/f,  0,1/f,-cy/f,  0,0,1]);
        const KH = mat3mul(Kinv, H);

        const r1 = [KH[0], KH[3], KH[6]];
        const r2 = [KH[1], KH[4], KH[7]];
        const t_raw = [KH[2], KH[5], KH[8]];

        const lam = (vecNorm(r1) + vecNorm(r2)) / 2;
        const r1n = r1.map(v => v/lam);
        const r2n = r2.map(v => v/lam);
        const r3n = vecCross(r1n, r2n);
        const t   = t_raw.map(v => v/lam);

        // R: 열 벡터 [r1|r2|r3] → 행 우선
        const R = new Float64Array([
            r1n[0], r2n[0], r3n[0],
            r1n[1], r2n[1], r3n[1],
            r1n[2], r2n[2], r3n[2],
        ]);
        return { R, t: new Float64Array(t) };
    }

    /* ─── DeviceOrientation → R_device_to_world ─── */

    /**
     * W3C 사양: R_device_to_world = Rz(-α) × Rx(-β) × Ry(γ)
     * @param {number} alpha - yaw  (0~360°)
     * @param {number} beta  - pitch (-180~180°, 수직=90°)
     * @param {number} gamma - roll  (-90~90°)
     * @returns {Float64Array} 3×3 행렬 (행 우선)
     */
    function buildDeviceToWorld(alpha, beta, gamma) {
        const a = alpha * Math.PI/180;
        const b = beta  * Math.PI/180;
        const g = gamma * Math.PI/180;

        const Rz = new Float64Array([
            Math.cos(-a), -Math.sin(-a), 0,
            Math.sin(-a),  Math.cos(-a), 0,
            0, 0, 1
        ]);
        const Rx = new Float64Array([
            1, 0, 0,
            0,  Math.cos(-b), -Math.sin(-b),
            0,  Math.sin(-b),  Math.cos(-b)
        ]);
        const Ry = new Float64Array([
             Math.cos(g), 0, Math.sin(g),
             0, 1, 0,
            -Math.sin(g), 0, Math.cos(g)
        ]);

        return mat3mul(mat3mul(Rz, Rx), Ry);
    }

    /* ─── 광선-평면 교점 ─── */

    /**
     * 픽셀 (u, v) → 나무 수직면 x=d 와의 세계 좌표 교점
     *
     * 변환 순서:
     *   ray_cam → R_CAM_TO_DEV → R_dw → 세계 좌표계
     *   t = d / ray_world.x,  P_world = ray_world × t
     *
     * @param {number} u - 비디오 픽셀 X
     * @param {number} v - 비디오 픽셀 Y
     * @param {number} f - 잠금된 초점거리
     * @param {number} cx - 주점 X (videoW/2)
     * @param {number} cy - 주점 Y (videoH/2)
     * @param {Float64Array} R_dw - buildDeviceToWorld() 결과 (프레임 고정 시점)
     * @param {number} d - 잠금된 거리 (m)
     * @returns {{ x, y, z }|null}
     */
    function intersectTreePlane(u, v, f, cx, cy, R_dw, d) {
        const rxc=(u-cx)/f, ryc=(v-cy)/f, rzc=1;
        const n = Math.sqrt(rxc*rxc + ryc*ryc + rzc*rzc);
        const ray_cam = [rxc/n, ryc/n, rzc/n];

        const ray_dev   = mat3vec(R_CAM_TO_DEV, ray_cam);
        const ray_world = mat3vec(R_dw, ray_dev);

        if (Math.abs(ray_world[0]) < 1e-6) return null;
        const t = d / ray_world[0];

        return { x: ray_world[0]*t, y: ray_world[1]*t, z: ray_world[2]*t };
    }

    /* ─── jsQR 결과 처리 (전체 파이프라인) ─── */

    /**
     * jsQR code → { f, d, R, t, pixelSize }
     * QR 픽셀 크기(detection canvas 기준)가 80px 미만이면 null 반환
     *
     * @param {Object} code - jsQR 반환 객체
     * @param {number} videoW - 카메라 실제 너비
     * @param {number} videoH - 카메라 실제 높이
     * @returns {Object|null}
     */
    function processQR(code, videoW, videoH) {
        const DW = 640, DH = 480;
        const loc = code.location;

        // QR 픽셀 크기 (detection canvas 640×480 기준)
        const dx = loc.topRightCorner.x - loc.topLeftCorner.x;
        const dy = loc.topRightCorner.y - loc.topLeftCorner.y;
        const pixelSizeDet = Math.sqrt(dx*dx + dy*dy);
        if (pixelSizeDet < 80) return null;

        // 코너를 비디오 해상도로 스케일
        const sx = videoW / DW, sy = videoH / DH;
        const corners_vid = [
            [loc.topLeftCorner.x    *sx, loc.topLeftCorner.y    *sy],
            [loc.topRightCorner.x   *sx, loc.topRightCorner.y   *sy],
            [loc.bottomRightCorner.x*sx, loc.bottomRightCorner.y*sy],
            [loc.bottomLeftCorner.x *sx, loc.bottomLeftCorner.y *sy],
        ];

        const cx = videoW/2, cy = videoH/2;
        const H = computeH(QR_WORLD_XY, corners_vid);
        const f = extractFocal(H, cx, cy);
        if (!f || f < 100 || f > 5000) return null;

        const { R, t } = decomposeH(H, f, cx, cy);
        const d = vecNorm([t[0], t[1], t[2]]);
        if (d <= 0 || d > 50) return null;

        return { f, d, R, t, pixelSize: pixelSizeDet };
    }

    return {
        computeH,
        extractFocal,
        decomposeH,
        buildDeviceToWorld,
        intersectTreePlane,
        processQR,
        QR_WORLD_XY,
        R_CAM_TO_DEV,
    };
})();
