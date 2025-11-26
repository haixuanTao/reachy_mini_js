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

function isAndroid() {
  return /android/i.test(navigator.userAgent);
}

function isMobile() {
  return /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent);
}

/**
 * Request a serial port that works on both desktop and Android
 * 
 * @param {'auto' | 'native' | 'polyfill'} mode - Force a specific mode or auto-detect
 * @returns {Promise<SerialPort>}
 */
export async function requestSerialPort(mode = 'auto') {
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
    
    // Mark it so Rust can check if needed
    port._isPolyfill = true;
    return port;
  }

  // Desktop: native WebSerial
  console.log('Using native WebSerial (desktop)');
  
  if (!('serial' in navigator)) {
    throw new Error('WebSerial not available on this browser');
  }
  
  const port = await navigator.serial.requestPort();
  port._isPolyfill = false;
  return port;
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
  };
}

// Expose to window for WASM
window.requestSerialPort = requestSerialPort;
window.getSerialCapabilities = getSerialCapabilities;