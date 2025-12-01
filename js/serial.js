import { SerialPort as PolyfillSerialPort } from 'web-serial-polyfill';

// USB filters for Reachy Mini - adjust VID/PID as needed
const USB_FILTERS = [
  { vendorId: 0x2341 },  // Arduino
  { vendorId: 0x0403 },  // FTDI
  { vendorId: 0x10c4 },  // CP210x
  { vendorId: 0x1a86 },  // CH340
  { vendorId: 0x239A },  // Adafruit
  { vendorId: 0x2E8A },  // Raspberry Pi Pico
];

// Cached port instance
let cachedPort = null;

function isAndroid() {
  return /android/i.test(navigator.userAgent);
}

function isMobile() {
  return /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent);
}

/**
 * Request a serial port that works on both desktop and Android
 * Returns cached port if already connected
 * 
 * @param {'auto' | 'native' | 'polyfill'} mode - Force a specific mode or auto-detect
 * @param {boolean} forceNew - Force requesting a new port even if one is cached
 * @returns {Promise<SerialPort>}
 */
export async function requestSerialPort(mode = 'auto', forceNew = false) {
  // Return cached port if available and not forcing new
  if (cachedPort && !forceNew) {
    console.log('Using cached serial port');
    return cachedPort;
  }

  const usePolyfill = 
    mode === 'polyfill' || 
    (mode === 'auto' && isAndroid());

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

  // Desktop: native WebSerial
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

/**
 * Get the currently cached port (or null if none)
 */
export function getCachedPort() {
  return cachedPort;
}

/**
 * Clear the cached port
 */
export function clearCachedPort() {
  cachedPort = null;
}

/**
 * Close and clear the cached port
 */
export async function closeSerialPort() {
  if (cachedPort) {
    try {
      await cachedPort.close();
    } catch (e) {
      console.warn('Error closing port:', e);
    }
    cachedPort = null;
  }
}

/**
 * Check what serial methods are available
 */
export function getSerialCapabilities() {
  return {
    hasNativeSerial: 'serial' in navigator,
    hasWebUSB: 'usb' in navigator,
    isAndroid: isAndroid(),
    isMobile: isMobile(),
    recommendedMode: isAndroid() ? 'polyfill' : 'native',
    hasActivePort: cachedPort !== null,
  };
}
export function isOpen() {
  return cachedPort !== null;
}


// Expose to window for WASM
window.requestSerialPort = requestSerialPort;
window.getSerialCapabilities = getSerialCapabilities;
window.getCachedPort = getCachedPort;
window.clearCachedPort = clearCachedPort;
window.closeSerialPort = closeSerialPort;
window.isOpen = isOpen;