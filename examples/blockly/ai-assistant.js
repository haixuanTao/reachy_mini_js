// ========== AI Assistant Module ==========
// This module handles AI-powered code generation for Blockly

(function() {
    'use strict';

    // ========== Settings ==========
    var aiSettings = {
        provider: 'anthropic',
        endpoint: 'http://localhost:11434',
        apiKey: '',
        model: 'claude-sonnet-4-20250514'
    };

    // Load settings from localStorage
    var savedAISettings = localStorage.getItem('aiSettings');
    if (savedAISettings) {
        try {
            aiSettings = JSON.parse(savedAISettings);
            var providerSelect = document.getElementById('aiProviderSelect');
            if (providerSelect) {
                providerSelect.value = aiSettings.provider;
            }
        } catch (e) {}
    }

    var aiChatHistory = [];

    // ========== Settings UI ==========
    function openAISettings() {
        document.getElementById('settingsProvider').value = aiSettings.provider;
        document.getElementById('settingsEndpoint').value = aiSettings.endpoint;
        document.getElementById('settingsApiKey').value = aiSettings.apiKey;
        document.getElementById('settingsModel').value = aiSettings.model;
        updateSettingsUI();
        document.getElementById('aiSettingsModal').classList.add('show');
    }

    function closeAISettings() {
        document.getElementById('aiSettingsModal').classList.remove('show');
    }

    function updateSettingsUI() {
        var provider = document.getElementById('settingsProvider').value;
        var endpointGroup = document.getElementById('endpointGroup');
        var apiKeyGroup = document.getElementById('apiKeyGroup');
        var modelInput = document.getElementById('settingsModel');

        if (provider === 'ollama') {
            endpointGroup.style.display = 'block';
            apiKeyGroup.style.display = 'none';
            document.getElementById('settingsEndpoint').placeholder = 'http://localhost:11434';
            modelInput.placeholder = 'llama3.2';
        } else if (provider === 'openai') {
            endpointGroup.style.display = 'none';
            apiKeyGroup.style.display = 'block';
            modelInput.placeholder = 'gpt-4o';
        } else if (provider === 'anthropic') {
            endpointGroup.style.display = 'none';
            apiKeyGroup.style.display = 'block';
            modelInput.placeholder = 'claude-sonnet-4-20250514';
        }
    }

    function saveAISettings() {
        aiSettings.provider = document.getElementById('settingsProvider').value;
        aiSettings.endpoint = document.getElementById('settingsEndpoint').value;
        aiSettings.apiKey = document.getElementById('settingsApiKey').value;
        aiSettings.model = document.getElementById('settingsModel').value;
        localStorage.setItem('aiSettings', JSON.stringify(aiSettings));
        document.getElementById('aiProviderSelect').value = aiSettings.provider;
        closeAISettings();
        addAIMessage('Settings saved!', 'system');
    }

    // ========== Chat Messages ==========
    function addAIMessage(content, type) {
        var chat = document.getElementById('aiChat');
        var msg = document.createElement('div');
        msg.className = 'ai-message ' + type;
        msg.textContent = content;
        chat.appendChild(msg);
        chat.scrollTop = chat.scrollHeight;
    }

    function addAICodeMessage(code) {
        var chat = document.getElementById('aiChat');
        var msg = document.createElement('div');
        msg.className = 'ai-message code';
        msg.textContent = code;
        chat.appendChild(msg);
        chat.scrollTop = chat.scrollHeight;
    }

    // ========== Workspace Context ==========
    function getWorkspaceContext() {
        var workspace = window.blocklyWorkspace;
        if (!workspace) {
            return { xml: '', code: '', availableBlocks: '' };
        }

        // Get current blocks as XML
        var xml = Blockly.Xml.workspaceToDom(workspace);
        var xmlText = Blockly.Xml.domToText(xml);

        // Get generated code
        var code = Blockly.JavaScript.workspaceToCode(workspace);

        // Get available block types
        var availableBlocks = [
            'Connection: enable_torque, disable_torque, enable_all, disable_all, check_joints, ping_joint, reboot_joint, reboot_all',
            'Antennas (motors 17-18): set_degrees, get_degrees, move_by',
            'Head (coordinate control): get_head_coordinates, set_head_coordinates',
            'Coordinates: create_coordinates, get_coordinate',
            'Sensing: is_moving, wait_until_stopped, get_load, get_temperature, joint_in_range',
            'Timing: wait, wait_ms, get_time, reset_timer, timer_value',
            'Output: log, log_joint, log_type, alert',
            'Blockly built-ins: controls_if, controls_repeat_ext, controls_whileUntil, controls_for, logic_compare, logic_operation, math_number, math_arithmetic, text, lists_create_with, variables_get, variables_set'
        ];

        return {
            xml: xmlText,
            code: code,
            availableBlocks: availableBlocks.join('\n')
        };
    }

    // ========== System Prompt ==========
    function buildSystemPrompt(context) {
        return 'You are an AI assistant helping users program a robot called Reachy Mini using JavaScript. ' +
            'The code you write will be converted to visual Blockly blocks, so you MUST use only supported syntax.\n\n' +
            'ROBOT ARCHITECTURE:\n' +
            'Reachy Mini has two separate control systems:\n\n' +
            '1. HEAD (motors 11-16): Stewart Platform with 6DOF (x, y, z, roll, pitch, yaw)\n' +
            '   - ALWAYS use coordinate-based control, NEVER control individual head motors!\n' +
            '   - Kinematics conversion happens automatically behind the scenes\n' +
            '   - Coordinates: [x, y, z, roll, pitch, yaw]\n' +
            '     * Position in millimeters:\n' +
            '       - X: forward (+) / backward (-)\n' +
            '       - Y: right (+) / left (-)\n' +
            '       - Z: up (+) / down (-), where Z=0 is neutral position\n' +
            '     * Rotation in degrees:\n' +
            '       - Roll: tilt left/right (rotate around X axis)\n' +
            '       - Pitch: nod up/down (rotate around Y axis)\n' +
            '       - Yaw: turn left/right (rotate around Z axis)\n' +
            '     * Example: [0, 0, 0, 0, 0, 0] = neutral position with no rotation\n' +
            '     * Example: [10, 0, 0, 0, 0, 0] = move forward 10mm\n' +
            '     * Example: [0, 5, 0, 0, 0, 0] = move right 5mm\n' +
            '     * Example: [0, 0, -10, 0, 0, 0] = move down 10mm\n\n' +
            '2. ANTENNAS (motors 17-18): Independent motors that can be controlled directly\n' +
            '   - Motor 17: Left antenna\n' +
            '   - Motor 18: Right antenna\n' +
            '   - Control using degrees (angle position)\n\n' +
            'AVAILABLE FUNCTIONS:\n\n' +
            'HEAD CONTROL (coordinate-based only):\n' +
            '- await Robot.setHeadCoordinates(coords) - set head to coordinates [x, y, z, roll, pitch, yaw]\n' +
            '  ALWAYS create coordinates inline like: [x, y, z, roll, pitch, yaw]\n' +
            '  Example: await Robot.setHeadCoordinates([0, 0, -10, 0, 0, 0]);\n' +
            '  This converts to the "create coordinates" block with labeled fields for children\n' +
            '- await Robot.getHeadCoordinates() - get current head coordinates\n' +
            '  Returns [x, y, z, roll, pitch, yaw]\n' +
            '- To modify coordinates, store in variable first:\n' +
            '  var coords = [x, y, z, roll, pitch, yaw];\n' +
            '  coords[2] = -10; // change z\n' +
            '  await Robot.setHeadCoordinates(coords);\n\n' +
            'ANTENNA CONTROL (direct motor control):\n' +
            '- Robot.setDegrees(motor, degrees) - set antenna angle in degrees\n' +
            '- Robot.getDegrees(motor) - get antenna angle in degrees\n' +
            '- Motors: 17 = left antenna, 18 = right antenna\n\n' +
            'TORQUE (enable/disable motors):\n' +
            '- Robot.setTorque(motor, true/false) - enable/disable single motor (11-18)\n' +
            '- Robot.setTorqueMultiple([11,12,13,14,15,16], true/false) - enable/disable all head motors\n' +
            '- Robot.setTorqueMultiple([11,12,13,14,15,16,17,18], true/false) - enable/disable all motors (head + antennas)\n\n' +
            'STATUS & DIAGNOSTICS:\n' +
            '- Robot.checkAllMotors() - check all motors (11-18)\n' +
            '- Robot.ping(motor) - ping single motor\n' +
            '- Robot.reboot(motor) - reboot single motor\n' +
            '- Robot.rebootAll() - reboot all motors (11-18)\n\n' +
            'SENSING (works with any motor 11-18):\n' +
            '- Robot.isMoving(motor) - check if motor is moving\n' +
            '- Robot.getLoad(motor) - get load/torque (-100 to 100)\n' +
            '- Robot.getTemperature(motor) - get motor temperature\n\n' +
            'TIMING:\n' +
            '- wait(seconds) - wait N seconds (use this for delays!)\n' +
            '- sleep(ms) - wait N milliseconds\n' +
            '- Date.now() - get current time in milliseconds since epoch\n' +
            '  To get current seconds: Math.floor((Date.now() / 1000) % 60)\n' +
            '  To get current minutes: Math.floor((Date.now() / 60000) % 60)\n' +
            '  To get current hours: Math.floor((Date.now() / 3600000) % 24)\n\n' +
            'OUTPUT:\n' +
            '- logConsole(message) - log message to console\n' +
            '- logJoint(motor) - log joint position\n' +
            '- alert(message) - show alert dialog\n\n' +
            'SUPPORTED SYNTAX (use only these!):\n' +
            '- var/let variable declarations: var x = 10;\n' +
            '- for loops: for (var i = 0; i < 10; i++) { ... }\n' +
            '- while loops: while (x < 100) { ... }\n' +
            '- if/else statements: if (x > 10) { ... } else { ... }\n' +
            '- Math operators: +, -, *, /, %\n' +
            '- Math functions: Math.floor(), Math.ceil(), Math.round(), Math.abs(), Math.sqrt()\n' +
            '- Trigonometry - ALL ANGLES ARE IN DEGREES! Keep all angle variables in degrees.\n' +
            '  To use cos/sin/tan, inline the degree-to-radian conversion DIRECTLY in the function call:\n' +
            '    Math.cos(angleDegrees * Math.PI / 180)\n' +
            '    Math.sin(angleDegrees * Math.PI / 180)\n' +
            '    Math.tan(angleDegrees * Math.PI / 180)\n' +
            '  Example: var angle = 90; var x = 10 * Math.cos(angle * Math.PI / 180);\n' +
            '  NEVER create a separate radian variable! Keep everything in degrees!\n' +
            '  WRONG: var angleRad = angle * Math.PI / 180; var x = Math.cos(angleRad);\n' +
            '  CORRECT: var x = Math.cos(angle * Math.PI / 180);\n' +
            '  Inverse functions return radians, convert to degrees inline:\n' +
            '    Math.asin(x) * 180 / Math.PI, Math.acos(x) * 180 / Math.PI, Math.atan(x) * 180 / Math.PI\n' +
            '- Math constants: Math.PI (represents 180 degrees, use Math.PI / 180 to convert degrees to radians)\n' +
            '- Comparisons: <, >, <=, >=, ==, !=\n' +
            '- Logic: &&, ||, !\n' +
            '- String concatenation: "text " + variable\n' +
            '- Arrays: [1, 2, 3], arr.length, arr[i], arr[i] = value\n\n' +
            'NEVER USE THESE (will break the converter!):\n' +
            '- function declarations (NEVER write "function myFunc() {}" - inline the code instead!)\n' +
            '- setTimeout, setInterval (use for/while loops with wait() instead)\n' +
            '- arrow functions (no () => {})\n' +
            '- new Date(), date.getSeconds() etc. (use Date.now() with math instead - see TIMING section)\n' +
            '- template literals (no `${var}`)\n' +
            '- console.log (use logConsole instead)\n' +
            '- JSON.stringify\n' +
            '- callbacks or closures\n\n' +
            'NOTE: You can use "await" with Robot functions - it will be automatically stripped during conversion.\n\n' +
            'EXAMPLE 1 - Move head down and back to neutral:\n' +
            'Robot.setTorqueMultiple([11,12,13,14,15,16], true);\n' +
            'for (var i = 0; i < 3; i++) {\n' +
            '  await Robot.setHeadCoordinates([0, 0, -10, 0, 0, 0]);\n' +
            '  wait(0.5);\n' +
            '  await Robot.setHeadCoordinates([0, 0, 0, 0, 0, 0]);\n' +
            '  wait(0.5);\n' +
            '}\n\n' +
            'EXAMPLE 2 - Move antennas back and forth:\n' +
            'Robot.setTorqueMultiple([17,18], true);\n' +
            'for (var i = 0; i < 3; i++) {\n' +
            '  Robot.setDegrees(17, 45);\n' +
            '  Robot.setDegrees(18, -45);\n' +
            '  wait(0.5);\n' +
            '  Robot.setDegrees(17, -45);\n' +
            '  Robot.setDegrees(18, 45);\n' +
            '  wait(0.5);\n' +
            '}\n\n' +
            'Current workspace code:\n' + context.code + '\n\n' +
            'IMPORTANT: Always respond with working JavaScript code in a ```javascript``` code block. Keep it simple and use only supported syntax.';
    }

    // ========== Main Send Function ==========
    async function sendAIMessage() {
        var input = document.getElementById('aiInput');
        var userMessage = input.value.trim();
        if (!userMessage) return;

        input.value = '';
        addAIMessage(userMessage, 'user');

        var sendBtn = document.getElementById('aiSendBtn');
        sendBtn.disabled = true;
        sendBtn.textContent = '...';

        // Show thinking animation
        var thinkingEl = document.createElement('div');
        thinkingEl.className = 'ai-thinking';
        thinkingEl.innerHTML = '<div class="ai-thinking-dots"><span></span><span></span><span></span></div><span>Thinking...</span>';
        var chat = document.getElementById('aiChat');
        chat.appendChild(thinkingEl);
        chat.scrollTop = chat.scrollHeight;

        try {
            var context = getWorkspaceContext();
            var systemPrompt = buildSystemPrompt(context);

            aiChatHistory.push({ role: 'user', content: userMessage });
            var response = await callLLM(systemPrompt, aiChatHistory);
            aiChatHistory.push({ role: 'assistant', content: response });

            // Check if response contains JavaScript code
            var jsMatch = response.match(/```javascript\s*([\s\S]*?)```/) || response.match(/```js\s*([\s\S]*?)```/) || response.match(/```\s*([\s\S]*?)```/);
            if (jsMatch) {
                var jsCode = jsMatch[1].trim();

                // Show the generated code
                addAIMessage('Generated code:', 'assistant');
                addAICodeMessage(jsCode);

                // Use the jsToBlocks function from the main app
                var result = window.jsToBlocks(jsCode);

                if (result.success) {
                    addAIMessage('Workspace updated!', 'assistant');
                    var explanation = response.replace(/```[\s\S]*?```/g, '').trim();
                    if (explanation) {
                        addAIMessage(explanation, 'assistant');
                    }
                } else {
                    // Send error back to AI for retry
                    addAIMessage('Parse error: ' + result.error, 'error');
                    addAIMessage('Asking AI to fix...', 'system');
                    var errorMsg = 'Your JavaScript had an error: ' + result.error + '\n\nPlease fix the code. Use only the allowed functions: Robot.setDegrees(), Robot.getDegrees(), Robot.setTorque(), Robot.setTorqueMultiple(), logConsole(), wait(), etc. For head control, use coordinate arrays [x,y,z,roll,pitch,yaw].';
                    aiChatHistory.push({ role: 'user', content: errorMsg });

                    var retryResponse = await callLLM(systemPrompt, aiChatHistory);
                    aiChatHistory.push({ role: 'assistant', content: retryResponse });

                    var retryMatch = retryResponse.match(/```javascript\s*([\s\S]*?)```/) || retryResponse.match(/```js\s*([\s\S]*?)```/) || retryResponse.match(/```\s*([\s\S]*?)```/);
                    if (retryMatch) {
                        var retryCode = retryMatch[1].trim();
                        addAIMessage('Retry code:', 'assistant');
                        addAICodeMessage(retryCode);

                        var retryResult = window.jsToBlocks(retryCode);
                        if (retryResult.success) {
                            addAIMessage('Workspace updated!', 'assistant');
                        } else {
                            addAIMessage('Still could not parse: ' + retryResult.error, 'error');
                        }
                    } else {
                        addAIMessage(retryResponse, 'assistant');
                    }
                }
            } else {
                addAIMessage(response, 'assistant');
            }
        } catch (e) {
            addAIMessage('Error: ' + e.message, 'error');
        } finally {
            // Remove thinking animation
            if (thinkingEl && thinkingEl.parentNode) {
                thinkingEl.parentNode.removeChild(thinkingEl);
            }
            sendBtn.disabled = false;
            sendBtn.textContent = 'Send';
        }
    }

    // ========== LLM API Calls ==========
    async function callLLM(systemPrompt, messages) {
        var provider = aiSettings.provider;

        if (provider === 'ollama') {
            return await callOllama(systemPrompt, messages);
        } else if (provider === 'openai') {
            return await callOpenAI(systemPrompt, messages);
        } else if (provider === 'anthropic') {
            return await callAnthropic(systemPrompt, messages);
        }
        throw new Error('Unknown provider: ' + provider);
    }

    async function callOllama(systemPrompt, messages) {
        var endpoint = aiSettings.endpoint || 'http://localhost:11434';
        var model = aiSettings.model || 'llama3.2';

        var ollamaMessages = [{ role: 'system', content: systemPrompt }];
        messages.forEach(function(m) {
            ollamaMessages.push({ role: m.role, content: m.content });
        });

        var response = await fetch(endpoint + '/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: model,
                messages: ollamaMessages,
                stream: false
            })
        });

        if (!response.ok) {
            throw new Error('Ollama error: ' + response.status);
        }

        var data = await response.json();
        return data.message.content;
    }

    async function callOpenAI(systemPrompt, messages) {
        var model = aiSettings.model || 'gpt-4o';
        var apiKey = aiSettings.apiKey;

        if (!apiKey) {
            throw new Error('OpenAI API key not configured. Click Settings to add it.');
        }

        var openaiMessages = [{ role: 'system', content: systemPrompt }];
        messages.forEach(function(m) {
            openaiMessages.push({ role: m.role, content: m.content });
        });

        var response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + apiKey
            },
            body: JSON.stringify({
                model: model,
                messages: openaiMessages
            })
        });

        if (!response.ok) {
            var errorData = await response.json();
            throw new Error('OpenAI error: ' + (errorData.error?.message || response.status));
        }

        var data = await response.json();
        return data.choices[0].message.content;
    }

    async function callAnthropic(systemPrompt, messages) {
        var model = aiSettings.model || 'claude-sonnet-4-20250514';
        var apiKey = aiSettings.apiKey;

        if (!apiKey) {
            throw new Error('Anthropic API key not configured. Click Settings to add it.');
        }

        // Anthropic format: system is separate, messages alternate user/assistant
        var anthropicMessages = messages.map(function(m) {
            return { role: m.role, content: m.content };
        });

        var response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
                'anthropic-dangerous-direct-browser-access': 'true'
            },
            body: JSON.stringify({
                model: model,
                max_tokens: 4096,
                system: systemPrompt,
                messages: anthropicMessages
            })
        });

        if (!response.ok) {
            var errorData = await response.json();
            throw new Error('Anthropic error: ' + (errorData.error?.message || response.status));
        }

        var data = await response.json();
        return data.content[0].text;
    }

    // ========== Initialize Event Listeners ==========
    function initAIAssistant() {
        // Sync dropdown with settings
        var providerSelect = document.getElementById('aiProviderSelect');
        if (providerSelect) {
            providerSelect.addEventListener('change', function() {
                aiSettings.provider = this.value;
                localStorage.setItem('aiSettings', JSON.stringify(aiSettings));
            });
        }

        // Settings provider change updates UI
        var settingsProvider = document.getElementById('settingsProvider');
        if (settingsProvider) {
            settingsProvider.addEventListener('change', updateSettingsUI);
        }

        // Enter key sends message
        var aiInput = document.getElementById('aiInput');
        if (aiInput) {
            aiInput.addEventListener('keypress', function(e) {
                if (e.key === 'Enter') {
                    sendAIMessage();
                }
            });
        }
    }

    // Initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initAIAssistant);
    } else {
        initAIAssistant();
    }

    // ========== Expose to Global Scope ==========
    window.openAISettings = openAISettings;
    window.closeAISettings = closeAISettings;
    window.updateSettingsUI = updateSettingsUI;
    window.saveAISettings = saveAISettings;
    window.sendAIMessage = sendAIMessage;

})();
