import init, {
    get_head_pose,
    connect,
    disconnect,
    torque_off,
    torque_on,
    start_fk_stream,
    replay,
    stop,
    forward_kinematics,
    inverse_kinematics,
    // Video Stream
    connect_video_stream,
    disconnect_video_stream,
    is_video_stream_connected,
    is_using_camera_fallback,
    read_video_frame,
    capture_camera_frame,
    get_latest_video_frame,
    // Audio Stream
    connect_audio_stream,
    disconnect_audio_stream,
    is_audio_stream_connected,
    is_using_microphone_fallback,
    read_audio_chunk,
    get_latest_audio_chunk,
    send_audio_chunk,
} from "../pkg/index.js";
import { SerialPort as PolyfillSerialPort } from 'web-serial-polyfill';

// Initialize WASM (serial helpers auto-exposed to window!)
await init();

import("../pkg/index.js").catch(console.error);

// Expose WASM functions to window
window.connect = connect;
window.disconnect = disconnect;
window.enableTorque = torque_on;
window.disableTorque = torque_off;
window.read_pose = get_head_pose;
window.replay = replay;
window.record = start_fk_stream;
window.stop = stop;
window.forward_kinematics = forward_kinematics;
window.inverse_kinematics = inverse_kinematics;

// ============ Video Stream ============
let videoStreamActive = false;
let videoFrameLoop = null;

window.startVideoStream = async function() {
    await connect_video_stream();
    videoStreamActive = true;

    const isFallback = is_using_camera_fallback();
    const videoPreview = document.getElementById('video-preview');
    const videoContainer = document.getElementById('video-container');

    if (videoContainer) {
        videoContainer.style.display = 'block';
    }

    // Start frame capture loop
    videoFrameLoop = setInterval(async () => {
        try {
            let frame = null;

            if (isFallback) {
                frame = await capture_camera_frame();
            } else {
                frame = await read_video_frame();
            }

            if (!frame) {
                frame = get_latest_video_frame();
            }

            if (frame && videoPreview) {
                const blob = new Blob([frame], { type: 'image/jpeg' });
                const url = URL.createObjectURL(blob);

                if (videoPreview.dataset.lastUrl) {
                    URL.revokeObjectURL(videoPreview.dataset.lastUrl);
                }
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
    videoStreamActive = false;

    const videoPreview = document.getElementById('video-preview');
    const videoContainer = document.getElementById('video-container');

    if (videoPreview && videoPreview.dataset.lastUrl) {
        URL.revokeObjectURL(videoPreview.dataset.lastUrl);
        videoPreview.src = '';
    }

    if (videoContainer) {
        videoContainer.style.display = 'none';
    }
};

// ============ Audio Stream ============
let audioStreamActive = false;
let audioReadLoop = null;

window.startAudioStream = async function() {
    await connect_audio_stream();
    audioStreamActive = true;

    const isFallback = is_using_microphone_fallback();

    audioReadLoop = setInterval(async () => {
        try {
            const audio = await read_audio_chunk();
            if (audio) {
                const level = calculateAudioLevel(audio);
                updateAudioLevelIndicator(level);
            }
        } catch (err) {
            // Ignore read errors
        }
    }, 100);

    return isFallback ? 'microphone' : 'websocket';
};

window.stopAudioStream = function() {
    if (audioReadLoop) {
        clearInterval(audioReadLoop);
        audioReadLoop = null;
    }

    disconnect_audio_stream();
    audioStreamActive = false;

    updateAudioLevelIndicator(0);
};

function calculateAudioLevel(samples) {
    if (!samples || samples.length === 0) return 0;
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
        sum += samples[i] * samples[i];
    }
    return Math.sqrt(sum / samples.length);
}

function updateAudioLevelIndicator(level) {
    const indicator = document.getElementById('audio-level');
    if (indicator) {
        const percentage = Math.min(100, level * 500);
        indicator.style.width = `${percentage}%`;
    }
}

// ============ Serial Port Helper ============

const USB_FILTERS = [
  { vendorId: 0x2341 },  // Arduino
  { vendorId: 0x0403 },  // FTDI
  { vendorId: 0x10c4 },  // CP210x
  { vendorId: 0x1a86 },  // CH340
  { vendorId: 0x239A },  // Adafruit
  { vendorId: 0x2E8A },  // Raspberry Pi Pico
];

let cachedPort = null;

function isAndroid() {
  return /android/i.test(navigator.userAgent);
}

async function requestSerialPort(mode = 'auto', forceNew = false) {
  if (cachedPort && !forceNew) {
    console.log('Using cached serial port');
    return cachedPort;
  }

  const usePolyfill = mode === 'polyfill' || (mode === 'auto' && isAndroid());

  if (usePolyfill) {
    console.log('Using WebUSB polyfill (Android/mobile USB)');
    if (!('usb' in navigator)) {
      throw new Error('WebUSB not available on this browser');
    }
    const device = await navigator.usb.requestDevice({ filters: USB_FILTERS });
    const port = new PolyfillSerialPort(device);
    port._isPolyfill = true;
    await port.open({ baudRate: 1000000 });
    cachedPort = port;
    return port;
  }

  console.log('Using native WebSerial (desktop)');
  if (!('serial' in navigator)) {
    throw new Error('WebSerial not available on this browser');
  }
  const port = await navigator.serial.requestPort();
  await port.open({ baudRate: 1000000 });
  port._isPolyfill = false;
  cachedPort = port;
  return port;
}

async function closeSerialPort() {
  if (cachedPort) {
    try {
      await cachedPort.close();
    } catch (e) {
      console.warn('Error closing port:', e);
    }
    cachedPort = null;
  }
}

// Expose serial functions to window (used by WASM)
window.requestSerialPort = requestSerialPort;
window.closeSerialPort = closeSerialPort;
