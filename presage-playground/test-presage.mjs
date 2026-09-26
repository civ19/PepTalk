import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';

// Resolve from this script so Run Code and terminal commands use the same file.
try {
  loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const apiKey = process.env.SMARTSPECTRA_API_KEY?.trim();
if (!apiKey) {
  console.error('Add SMARTSPECTRA_API_KEY=your_key to the root .env file.');
  process.exit(1);
}

let sdk;
let keepAlive;
let stopping = false;

function reportError(error) {
  // Never print the API key, even if an SDK error includes it.
  console.error(String(error?.message ?? error).split(apiKey).join('[redacted]'));
}

async function shutdown(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  console.log('\nStopping camera...');
  try {
    await sdk?.stopAsync();
  } catch (error) {
    reportError(error);
    exitCode = 1;
  } finally {
    try {
      await sdk?.destroy();
    } catch (error) {
      reportError(error);
      exitCode = 1;
    }
    clearInterval(keepAlive);
    process.exitCode = exitCode;
  }
}

try {
  const { SmartSpectraSDK, decodeMetrics } =
    await import('@smartspectra/node-sdk');

  sdk = new SmartSpectraSDK({
    apiKey,
    // SmartSpectra MetricType codes: BREATHING_RATE = 2, PULSE_RATE = 15.
    requestedMetrics: [2, 15],
  });

  let lastHint;
  let lastOutput = 0;
  const format = (sample, unit) => Number.isFinite(sample?.value)
    ? `${sample.value.toFixed(1)} ${unit}${sample.stable ? '' : ' (settling)'}`
    : 'waiting for reading';

  sdk.on('processingStatus', (status) => console.log('Processing status:', status));
  sdk.on('validationStatus', (code, timestamp, hint) => {
    const message = hint || `Validation code: ${code}`;
    if (message !== lastHint) console.log(message);
    lastHint = message;
  });
  sdk.on('metrics', (buffer) => {
    if (stopping || Date.now() - lastOutput < 1000) return;
    try {
      const metrics = decodeMetrics(buffer);
      if (Buffer.isBuffer(metrics)) throw new Error('Unable to decode SDK metrics.');
      console.log(
        `Pulse: ${format(metrics.cardio?.pulseRate?.at(-1), 'bpm')} | ` +
        `Breathing: ${format(metrics.breathing?.rate?.at(-1), 'breaths/min')}`,
      );
      lastOutput = Date.now();
    } catch (error) {
      reportError(error);
      setImmediate(() => void shutdown(1));
    }
  });
  sdk.on('error', (code, message, retryable) => {
    reportError(`SmartSpectra error ${code}: ${message} (retryable: ${retryable})`);
    if (/auth|401|credential|api key/i.test(message)) {
      console.error('Check SMARTSPECTRA_API_KEY in the root .env and its account access.');
    }
    setImmediate(() => void shutdown(1));
  });

  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
  // Native callbacks alone may not keep Node's event loop running.
  keepAlive = setInterval(() => {}, 1000);
  sdk.useCamera();
  sdk.start();
  console.log('Camera started. Sit in good lighting with your face visible.');
  console.log('Waiting for readings. Press Ctrl+C to stop.');
} catch (error) {
  reportError(error);
  await shutdown(1);
}
