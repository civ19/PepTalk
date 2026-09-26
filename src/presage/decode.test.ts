import { describe, expect, it } from 'vitest';
import { presage } from '@smartspectra/node-sdk/messages';
import { decodePacket } from './decode';

const { Metrics, ExpressionType } = presage.smartspectra;
const T = 1_790_436_333_686_821; // realistic epoch µs (exceeds 2^32, exercises Long handling)

function encode(payload: Parameters<typeof Metrics.create>[0]): Uint8Array {
  return Metrics.encode(Metrics.create(payload)).finish();
}

describe('decodePacket', () => {
  it('narrows a real SDK protobuf payload into typed readings', () => {
    const buf = encode({
      cardio: {
        pulseRate: [{ value: 72.5, confidence: 88, stable: true, timestamp: T }],
        hrv: [{ rmssd: 41, sdnn: 50, meanNn: 830, baevsky: 95, confidence: 60, stable: true, timestamp: T }],
        arterialPressureTrace: [{ value: 1, confidence: 90, stable: true, timestamp: T }],
      },
      breathing: { rate: [{ value: 14, confidence: 50, stable: true, timestamp: T }] },
      face: {
        blinking: [{ detected: true, stable: true, timestamp: T }, { detected: false, stable: true, timestamp: T + 33_000 }],
        talking: [{ detected: true, stable: true, timestamp: T }],
        expression: [
          {
            stable: true,
            timestamp: T,
            scores: [
              { type: ExpressionType.HAPPY, confidence: 70 },
              { type: ExpressionType.NEUTRAL, confidence: 25 },
            ],
          },
        ],
        landmarks: [{ value: Array.from({ length: 478 }, (_, i) => ({ x: i, y: i + 1 })), stable: true, timestamp: T }],
      },
    });

    const r = decodePacket(buf);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = r.packet;
    expect(p.pulse).toEqual([{ tUs: T, value: 72.5, confidence: 88, stable: true }]);
    expect(p.hrv[0]).toMatchObject({ tUs: T, rmssdMs: 41, sdnnMs: 50, meanNnMs: 830, baevsky: 95, confidence: 60 });
    expect(p.breathing[0]).toMatchObject({ value: 14, confidence: 50 });
    expect(p.blinking.map((b) => b.detected)).toEqual([true, false]);
    expect(p.talking[0]?.detected).toBe(true);
    expect(p.expressions[0]).toMatchObject({ top: 'happy', topConfidence: 70, scores: { happy: 70, neutral: 25 } });
    expect(p.landmarks?.points).toHaveLength(478);
    expect(p.landmarks?.points[1]).toEqual({ x: 1, y: 2 });
    expect(p.groups).toEqual({ face: true, cardio: true, breathing: true });
    // The pressure trace is never surfaced.
    expect(JSON.stringify(p)).not.toMatch(/pressure/i);
  });

  it('reports empty groups for an empty payload', () => {
    const r = decodePacket(encode({}));
    expect(r.ok && r.packet.groups).toEqual({ face: false, cardio: false, breathing: false });
  });

  it('fails soft on garbage bytes', () => {
    const r = decodePacket(new Uint8Array([0xff, 0xff, 0xff, 0xff]));
    expect(r.ok).toBe(false);
  });
});
