import { SerialPort as PolyfillSerialPort } from 'web-serial-polyfill';

// USB filter for Reachy Mini - adjust VID/PID if needed
const USB_FILTERS = [
  { vendorId: 0x2341 },  // Arduino
  { vendorId: 0x0403 },  // FTDI
  { vendorId: 0x10c4 },  // CP210x
  { vendorId: 0x1a86 },  // CH340
];

export async function requestSerialPort() {
  // Desktop: native WebSerial
  if ('serial' in navigator) {
    console.log('Using native WebSerial');
    return await navigator.serial.requestPort();
  }
  
  // Android: WebUSB + polyfill
  if ('usb' in navigator) {
    console.log('Using WebUSB polyfill');
    const device = await navigator.usb.requestDevice({ filters: USB_FILTERS });
    return new PolyfillSerialPort(device);
  }
  
  throw new Error('Neither WebSerial nor WebUSB available');
}

// Make it available globally for WASM
window.requestSerialPort = requestSerialPort;