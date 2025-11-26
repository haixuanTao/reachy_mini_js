import { test3 } from "../pkg/index.js";

import("../pkg/index.js").catch(console.error);

const button = document.getElementById('btn-connect');
button.addEventListener('click', async function() {
await test3();
});

// Import the serial helper
import './serial.js';