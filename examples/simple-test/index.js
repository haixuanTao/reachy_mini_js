import init, {
  start_fk_stream,
  connect,
  disconnect,
  torque_off,
  torque_on,
  replay_recording,
  stop,
  forward_kinematics,
  inverse_kinematics,
  // Video Stream
  connect_video_stream,
  disconnect_video_stream,
  is_using_camera_fallback,
  read_video_frame,
  capture_camera_frame,
  get_latest_video_frame,
  // Audio Stream
  connect_audio_stream,
  disconnect_audio_stream,
  is_using_microphone_fallback,
  read_audio_chunk,
  get_latest_audio_chunk,
} from 'https://unpkg.com/reachy-mini@0.6.0/index.js';

// WebSerial helpers (required by WASM for WebSerial fallback)
let cachedPort = null;

window.requestSerialPort = async function(forceNew = false) {
  if (cachedPort && !forceNew) {
    console.log('Using cached serial port');
    return cachedPort;
  }

  console.log('Using native WebSerial');
  if (!('serial' in navigator)) {
    throw new Error('WebSerial not available. Use Chrome/Edge, or provide a WebSocket address.');
  }

  const port = await navigator.serial.requestPort();
  await port.open({ baudRate: 1000000 });
  cachedPort = port;
  return port;
};

window.closeSerialPort = async function() {
  if (cachedPort) {
    try {
      await cachedPort.close();
    } catch (e) {
      console.warn('Error closing port:', e);
    }
    cachedPort = null;
  }
};

// Initialize WASM
await init();

// Expose WASM functions to window
window.connect = connect;
window.disconnect = disconnect;
window.enableTorque = torque_on;
window.disableTorque = torque_off;
window.read_pose = start_fk_stream;
window.replay = replay_recording;
window.record = start_fk_stream;  // Recording happens during FK stream
window.stop = stop;
window.forward_kinematics = forward_kinematics;
window.inverse_kinematics = inverse_kinematics;

// ============ Video Stream ============
let videoFrameLoop = null;

window.startVideoStream = async function() {
  await connect_video_stream();
  const isFallback = is_using_camera_fallback();
  const videoPreview = document.getElementById('video-preview');
  const videoContainer = document.getElementById('video-container');

  if (videoContainer) {
    videoContainer.style.display = 'block';
  }

  videoFrameLoop = setInterval(async () => {
    try {
      let frame = isFallback ? await capture_camera_frame() : await read_video_frame();
      if (!frame) frame = get_latest_video_frame();

      if (frame && videoPreview) {
        const blob = new Blob([frame], { type: 'image/jpeg' });
        const url = URL.createObjectURL(blob);
        if (videoPreview.dataset.lastUrl) URL.revokeObjectURL(videoPreview.dataset.lastUrl);
        videoPreview.dataset.lastUrl = url;
        videoPreview.src = url;
      }
    } catch (err) {
      console.error("Video frame error:", err);
    }
  }, 33);

  return isFallback ? 'camera' : 'websocket';
};

window.stopVideoStream = function() {
  if (videoFrameLoop) {
    clearInterval(videoFrameLoop);
    videoFrameLoop = null;
  }
  disconnect_video_stream();

  const videoPreview = document.getElementById('video-preview');
  const videoContainer = document.getElementById('video-container');
  if (videoPreview && videoPreview.dataset.lastUrl) {
    URL.revokeObjectURL(videoPreview.dataset.lastUrl);
    videoPreview.src = '';
  }
  if (videoContainer) videoContainer.style.display = 'none';
};

// ============ Audio Stream ============
let audioReadLoop = null;

window.startAudioStream = async function() {
  await connect_audio_stream();
  const isFallback = is_using_microphone_fallback();

  audioReadLoop = setInterval(async () => {
    try {
      const audio = await read_audio_chunk();
      if (audio) {
        const level = Math.sqrt(audio.reduce((sum, s) => sum + s * s, 0) / audio.length);
        const indicator = document.getElementById('audio-level');
        if (indicator) indicator.style.width = `${Math.min(100, level * 500)}%`;
      }
    } catch (err) {}
  }, 100);

  return isFallback ? 'microphone' : 'websocket';
};

window.stopAudioStream = function() {
  if (audioReadLoop) {
    clearInterval(audioReadLoop);
    audioReadLoop = null;
  }
  disconnect_audio_stream();
  const indicator = document.getElementById('audio-level');
  if (indicator) indicator.style.width = '0%';
};

// Enable connect toggle once WASM is loaded
const toggleConnect = document.getElementById('toggle-connect');
if (toggleConnect) {
  toggleConnect.disabled = false;
}

console.log('WASM module loaded');
