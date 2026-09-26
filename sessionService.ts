import { pool } from './db';

export interface TelemetrySample {
  timestampMs: number;
  pulseRate: number;
  breathingRate: number;
  hrvRmssd?: number;
  focusScore: number;
  isStable: boolean;
  expression: string;
}

export class SessionService {
  /**
   * 1. Create a new practice session
   */
  static async createSession(userId: string, projectId: string) {
    const res = await pool.query(
      `INSERT INTO sessions (user_id, project_id) 
       VALUES ($1, $2) 
       RETURNING id, created_at`,
      [userId, projectId]
    );
    return res.rows[0];
  }

  /**
   * 2. High-Speed Batch Insert for Presage Telemetry
   * Ingests hundreds of raw time-series samples in a single SQL query.
   */
  static async insertTelemetryBatch(sessionId: string, sessionStartTime: Date, samples: TelemetrySample[]) {
    if (!samples.length) return;

    const values: any[] = [];
    const rows = samples.map((s, idx) => {
      // Calculate absolute timestamp from session start + offset
      const sampleTime = new Date(sessionStartTime.getTime() + s.timestampMs);
      const offset = idx * 9;
      values.push(
        sampleTime,
        sessionId,
        s.timestampMs,
        s.pulseRate || null,
        s.breathingRate || null,
        s.hrvRmssd || null,
        s.focusScore || null,
        s.isStable ?? true,
        s.expression || 'neutral'
      );
      return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9})`;
    });

    const query = `
      INSERT INTO presage_telemetry 
      (time, session_id, timestamp_ms, pulse_rate, breathing_rate, hrv_rmssd, focus_score, is_stable, expression)
      VALUES ${rows.join(', ')}
    `;

    await pool.query(query, values);
  }

  /**
   * 3. TigerData Native Aggregation: Downsample to 1-second buckets
   * Computes clean graph data directly inside the DB engine and saves it to the session.
   */
  static async finalizeSessionGraph(sessionId: string) {
    // Uses TigerData/TimescaleDB time_bucket for analytics
    const query = `
      SELECT 
        time_bucket('1 second', time) AS bucket_time,
        ROUND(AVG(pulse_rate)) AS avg_pulse,
        ROUND(AVG(breathing_rate)) AS avg_breathing,
        ROUND(AVG(focus_score)) AS avg_focus,
        ROUND(AVG(hrv_rmssd), 2) AS avg_hrv,
        MODE() WITHIN GROUP (ORDER BY expression) AS dominant_expression
      FROM presage_telemetry
      WHERE session_id = $1 AND is_stable = true
      GROUP BY bucket_time
      ORDER BY bucket_time ASC;
    `;

    const result = await pool.query(query, [sessionId]);

    // Format for frontend Recharts / Chart.js
    const graphSeries = result.rows.map((row, index) => ({
      second: index,
      pulse: Number(row.avg_pulse),
      breathing: Number(row.avg_breathing),
      focus: Number(row.avg_focus),
      hrv: Number(row.avg_hrv),
      expression: row.dominant_expression,
    }));

    // Update the session row with the pre-compiled graph data
    await pool.query(
      `UPDATE sessions 
       SET graph_data = $1::jsonb 
       WHERE id = $2`,
      [JSON.stringify(graphSeries), sessionId]
    );

    return graphSeries;
  }

  /**
   * 4. Enforce 10-Video Limit and Retrieve Historical Trajectory
   * Gets the last 10 practice attempts for the user dashboard & Gemini trend analysis.
   */
  static async getUserRecentSessions(userId: string, limit = 10) {
    const query = `
      SELECT 
        id, 
        duration_secs, 
        overall_score, 
        stage, 
        wpm, 
        filler_count, 
        graph_data, 
        created_at 
      FROM sessions
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT $2;
    `;
    const res = await pool.query(query, [userId, limit]);
    return res.rows;
  }
}