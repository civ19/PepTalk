import type { CoachingReport } from "../gemini/coachingService";
import type { SqlClient } from "./database";

export class CoachingFeedbackRepository {
  constructor(private readonly db: SqlClient) {}

  async save(
    id: string,
    sessionId: string,
    projectId: string,
    report: CoachingReport,
    rawResponse: string,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO coaching_feedback (id, session_id, project_id, report, raw_response)
       VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, $5)`,
      [id, sessionId, projectId, JSON.stringify(report), rawResponse],
    );
  }
}

export type CoachingFeedbackStore = Pick<CoachingFeedbackRepository, "save">;
