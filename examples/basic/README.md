---
title: Reachy Mini Basic Example
emoji: 📊
colorFrom: green
colorTo: green
sdk: static
tags:
  - reachy_mini
  - reachy_mini_js_app
license: apache-2.0
short_description: Basic standalone HTML example for Reachy Mini
pinned: false
---

# Basic Example

A simple, **standalone** single-file HTML example demonstrating core Reachy Mini functionality.

**No npm install required!** Uses the published package directly from CDN (unpkg).

## Quick Start

1. **Download `index.html`** (just this one file!)

2. **Start a local server** (required for ES modules):

   ```bash
   # Using Python
   python3 -m http.server 8080

   # Or using npx
   npx http-server -p 8080

   # Or using npm start
   npm start
   ```

3. **Open in browser**:

   ```
   http://127.0.0.1:8080/index.html
   ```

4. **Connect your robot**:

   - Ensure Reachy Mini is connected via USB, OR
   - Start the WebSocket server on `ws://127.0.0.1:8000`

5. **Click "Connect to Robot"** and start controlling!

## How It Works

The example loads `reachy-mini` directly from unpkg CDN:

```javascript
import init, { ... } from 'https://unpkg.com/reachy-mini@0.5.2/index.js';
```

No build tools, no npm install, just one HTML file!

## What This Example Shows

- ✅ Connecting to Reachy Mini (WebSerial or WebSocket)
- ✅ Enabling/disabling motor torque
- ✅ Forward kinematics (joint angles → pose)
- ✅ Inverse kinematics (pose → joint angles)
- ✅ Recording and replaying movements
- ✅ Real-time console output

## Browser Requirements

- Chrome 89+ or Edge 89+ (for WebSerial support)
- Must be served over HTTP/HTTPS (file:// won't work due to ES modules)

## Troubleshooting

**"Failed to resolve module specifier"**

- Make sure you ran `npm install` from the project root
- Verify you're accessing via a web server (not file://)

**"WebSerial not available"**

- Use Chrome or Edge browser
- Check that you're on HTTPS or 127.0.0.1

**"Connection failed"**

- Check USB connection
- Try unplugging/replugging the adapter
- If using WebSocket, ensure server is running on port 8000

## Next Steps

Check out the other examples:

- `examples/simple-test/` - Full-featured control interface
- `examples/blockly/` - Visual programming interface
