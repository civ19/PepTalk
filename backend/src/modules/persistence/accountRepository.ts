import type { SqlClient } from "./database";

export interface AccountProfile {
  name: string;
  email: string;
  picture: string;
}

export interface StoredProject {
  id: string;
  name: string;
  category: string;
  createdAt: string;
  contextNotes?: string;
  files?: unknown[];
}

export interface StoredPreparation {
  id: string;
  projectId: string;
  createdAt: string;
  [key: string]: unknown;
}

export class AccountRepository {
  constructor(private readonly db: SqlClient) {}

  async load(sub: string) {
    const [user, projects, preparations] = await Promise.all([
      this.db.query(
        "SELECT display_name, email, picture_url FROM app_users WHERE auth_subject=$1",
        [sub],
      ),
      this.db.query(
        "SELECT details FROM practice_projects WHERE user_sub=$1 ORDER BY created_at DESC",
        [sub],
      ),
      this.db.query(
        "SELECT details FROM preparations WHERE user_sub=$1 ORDER BY created_at DESC",
        [sub],
      ),
    ]);
    const row = user.rows[0];
    return {
      profile: row
        ? { name: row.display_name, email: row.email, picture: row.picture_url }
        : null,
      projects: projects.rows.map((item) => item.details as StoredProject),
      preparations: preparations.rows.map(
        (item) => item.details as StoredPreparation,
      ),
    };
  }

  async saveProfile(sub: string, profile: AccountProfile) {
    await this.db.query(
      `INSERT INTO app_users(auth_subject,display_name,email,picture_url) VALUES($1,$2,$3,$4)
       ON CONFLICT(auth_subject) DO UPDATE SET display_name=EXCLUDED.display_name,
       email=EXCLUDED.email,picture_url=EXCLUDED.picture_url,updated_at=now()`,
      [sub, profile.name, profile.email, profile.picture],
    );
  }

  async saveProject(sub: string, project: StoredProject) {
    const result = await this.db.query(
      `INSERT INTO practice_projects(user_sub,id,details,created_at) VALUES($1,$2,$3::jsonb,$4::timestamptz)
       ON CONFLICT(user_sub,id) DO UPDATE SET details=EXCLUDED.details,updated_at=now()
       RETURNING id`,
      [sub, project.id, JSON.stringify(project), project.createdAt],
    );
    return result.rows.length > 0;
  }

  async deleteProject(sub: string, id: string) {
    await this.db.query(
      "DELETE FROM practice_projects WHERE user_sub=$1 AND id=$2",
      [sub, id],
    );
  }

  async savePreparation(sub: string, preparation: StoredPreparation) {
    const result = await this.db.query(
      `INSERT INTO preparations(user_sub,id,project_id,details,created_at)
       SELECT $1,$2,$3,$4::jsonb,$5::timestamptz
       WHERE EXISTS(SELECT 1 FROM practice_projects WHERE user_sub=$1 AND id=$3)
       ON CONFLICT(user_sub,id) DO UPDATE SET project_id=EXCLUDED.project_id,
       details=EXCLUDED.details,updated_at=now() RETURNING id`,
      [
        sub,
        preparation.id,
        preparation.projectId,
        JSON.stringify(preparation),
        preparation.createdAt,
      ],
    );
    return result.rows.length > 0;
  }

  async deletePreparation(sub: string, id: string) {
    await this.db.query(
      "DELETE FROM preparations WHERE user_sub=$1 AND id=$2",
      [sub, id],
    );
  }
}

export type AccountStore = Pick<
  AccountRepository,
  | "load"
  | "saveProfile"
  | "saveProject"
  | "deleteProject"
  | "savePreparation"
  | "deletePreparation"
>;
