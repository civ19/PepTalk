const { SmartSpectraSDK } = require('@smartspectra/node-sdk/renderer');
const { decodeMetrics } = require('@smartspectra/node-sdk/messages');

const preview = document.querySelector('#preview');
const placeholder = document.querySelector('#camera-placeholder');
const heartRate = document.querySelector('#heart-rate');
const breathingRate = document.querySelector('#breathing-rate');
const status = document.querySelector('#status');
const hint = document.querySelector('#hint');
const toggle = document.querySelector('#toggle');
let sdk;
let running = false;

function showSample(element, sample) {
  element.textContent = Number.isFinite(sample?.value) && sample.stable && sample.confidence > 0
    ? sample.value.toFixed(1)
    : '—';
}

async function stop() {
  if (!sdk) return;
  const old = sdk;
  sdk = undefined;
  try {
    await old.stop();
  } finally {
    old.destroy();
    preview.srcObject = null;
    preview.style.display = 'none';
    placeholder.style.display = '';
    heartRate.textContent = '—';
    breathingRate.textContent = '—';
    running = false;
    toggle.textContent = 'Start camera';
    status.textContent = 'Stopped';
  }
}

toggle.addEventListener('click', async () => {
  toggle.disabled = true;
  try {
    if (running) {
      await stop();
      return;
    }
    if (!window.demo?.getApiKey) {
      throw new Error('Camera bridge did not load. Restart the preview app.');
    }
    const apiKey = await window.demo.getApiKey();
    if (!apiKey) throw new Error('Add SMARTSPECTRA_API_KEY to the root .env file.');
    sdk = new SmartSpectraSDK({ apiKey, requestedMetrics: [2, 15] });
    sdk.on('streamAvailable', (stream) => {
      preview.srcObject = stream;
      preview.style.display = 'block';
      placeholder.style.display = 'none';
      void preview.play();
    });
    sdk.on('validationStatus', (_code, _timestamp, message) => {
      hint.textContent = message || '';
    });
    sdk.on('metrics', (buffer) => {
      try {
        const metrics = decodeMetrics(buffer);
        showSample(heartRate, metrics.cardio?.pulseRate?.at(-1));
        showSample(breathingRate, metrics.breathing?.rate?.at(-1));
      } catch (error) {
        status.textContent = `Could not read metrics: ${error.message}`;
      }
    });
    sdk.on('error', (_code, message) => {
      void stop().finally(() => {
        status.textContent = `SDK error: ${message}`;
      });
    });
    status.textContent = 'Starting camera…';
    await sdk.start();
    if (!sdk) return;
    running = true;
    status.textContent = 'Measuring';
    toggle.textContent = 'Stop camera';
  } catch (error) {
    status.textContent = error.message;
    try { await stop(); } catch { /* Keep the original error visible. */ }
    status.textContent = error.message;
  } finally {
    toggle.disabled = false;
  }
});
