/**
 * camera.js — 카메라 스트림 관리
 * getUserMedia를 통해 후면 카메라에 접근하고 스트림을 관리한다.
 */

const Camera = (() => {
  let stream = null;
  let videoElement = null;
  let track = null;

  /**
   * 카메라 초기화 및 스트림 연결
   * @param {HTMLVideoElement} video - 비디오 요소
   * @returns {Promise<MediaStream>}
   */
  async function init(video) {
    videoElement = video;

    const constraints = {
      video: {
        facingMode: 'environment',   // 후면 카메라
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
    };

    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
      videoElement.srcObject = stream;
      track = stream.getVideoTracks()[0];

      // 비디오 메타데이터 로드 대기
      await new Promise((resolve) => {
        videoElement.onloadedmetadata = () => {
          videoElement.play();
          resolve();
        };
      });

      return stream;
    } catch (err) {
      console.error('카메라 접근 실패:', err);
      throw err;
    }
  }

  /**
   * 토치(플래시) 토글
   * @returns {Promise<boolean>} 현재 토치 상태
   */
  async function toggleTorch() {
    if (!track) return false;

    const capabilities = track.getCapabilities();
    if (!capabilities.torch) {
      console.warn('이 기기는 토치를 지원하지 않습니다.');
      return false;
    }

    const settings = track.getSettings();
    const newTorchState = !settings.torch;

    await track.applyConstraints({
      advanced: [{ torch: newTorchState }],
    });

    return newTorchState;
  }

  /**
   * 현재 비디오 해상도 반환
   * @returns {{ width: number, height: number }}
   */
  function getResolution() {
    if (!videoElement) return { width: 640, height: 480 };
    return {
      width: videoElement.videoWidth,
      height: videoElement.videoHeight,
    };
  }

  /**
   * 카메라 스트림 해제
   */
  function stop() {
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
      track = null;
    }
    if (videoElement) {
      videoElement.srcObject = null;
    }
  }

  /**
   * 현재 프레임을 캡처하여 data URL로 반환
   * @returns {string} base64 data URL
   */
  function captureFrame() {
    if (!videoElement) return null;
    const canvas = document.createElement('canvas');
    canvas.width = videoElement.videoWidth;
    canvas.height = videoElement.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(videoElement, 0, 0);
    return canvas.toDataURL('image/jpeg', 0.85);
  }

  return {
    init,
    toggleTorch,
    getResolution,
    stop,
    captureFrame,
  };
})();
