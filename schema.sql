-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. USERS TABLE
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    current_stage VARCHAR(32) DEFAULT 'Critical', -- 'Critical', 'Yellow', 'Green'
    current_score NUMERIC(5,2) DEFAULT 0.0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. PROJECTS TABLE (e.g. "Final Pitch", "Job Interview")
CREATE TABLE IF NOT EXISTS projects (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    mode VARCHAR(32) NOT NULL DEFAULT 'presentation', -- 'presentation' | 'interview'
    system_instructions TEXT,
    target_duration_secs INT DEFAULT 300,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. SESSIONS TABLE (1 row per practice recording)
CREATE TABLE IF NOT EXISTS sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    duration_secs INT DEFAULT 0,
    overall_score NUMERIC(5,2),
    stage VARCHAR(32),
    video_url TEXT,
    transcript TEXT,
    filler_count INT DEFAULT 0,
    wpm NUMERIC(5,2) DEFAULT 0.0,
    -- Pre-calculated 1-second downsampled graph series for instant frontend rendering
    graph_data JSONB DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. PRESAGE TELEMETRY (TigerData Time-Series Hypertable)
CREATE TABLE IF NOT EXISTS presage_telemetry (
    time TIMESTAMPTZ NOT NULL,
    session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    timestamp_ms BIGINT NOT NULL,          -- Offset in ms from start (0, 100, 200...)
    pulse_rate SMALLINT,                   -- Heart Rate (BPM)
    breathing_rate SMALLINT,               -- Breaths per min
    hrv_rmssd NUMERIC(6,2),                -- Heart rate variability
    focus_score SMALLINT,                  -- 0 to 100
    is_stable BOOLEAN DEFAULT TRUE,        -- Warmup/calibration flag
    expression VARCHAR(32) DEFAULT 'neutral'
);

-- Convert to a TigerData Hypertable partitioned by time
-- (TigerData / TimescaleDB hypertable for millisecond-level telemetry)
SELECT create_hypertable('presage_telemetry', 'time', if_not_exists => TRUE);

-- Compound index for instantaneous session lookups
CREATE INDEX IF NOT EXISTS idx_telemetry_session_time 
ON presage_telemetry (session_id, timestamp_ms ASC);

-- 5. AI EVALUATION & FEEDBACK TABLE
CREATE TABLE IF NOT EXISTS ai_evaluations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    question_index INT,
    question TEXT,
    user_answer TEXT,
    is_correct BOOLEAN,
    score INT,
    feedback TEXT,
    spoken_feedback TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);