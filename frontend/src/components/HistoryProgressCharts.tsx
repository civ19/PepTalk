import { ResponsiveLine } from "@nivo/line";
import type { PracticeSession } from "../types/interview";
import { trendFor, type TrendPoint } from "../utils/trends";

const chartTheme = {
  text: { fill: "#7e8496", fontSize: 11, fontFamily: "DM Sans, sans-serif" },
  axis: {
    domain: { line: { stroke: "#e8eaf0" } },
    ticks: { line: { stroke: "#e8eaf0" } },
  },
  grid: { line: { stroke: "#eff0f4", strokeDasharray: "3 4" } },
  tooltip: {
    container: { background: "#25273c", color: "#fff", fontSize: 12 },
  },
};

function MetricChart({
  points,
  label,
  color,
  maximum,
  unit,
}: {
  points: TrendPoint[];
  label: string;
  color: string;
  maximum: number;
  unit: string;
}) {
  if (!points.length)
    return (
      <div className="chart-empty">
        No measured attempts yet. Finish a run to start this trend.
      </div>
    );
  return (
    <ResponsiveLine
      data={[
        {
          id: label,
          data: points.map((point) => ({
            x: `Run ${point.attempt}`,
            y: Math.round(point.value * 10) / 10,
          })),
        },
      ]}
      margin={{ top: 16, right: 20, bottom: 52, left: 46 }}
      xScale={{ type: "point" }}
      yScale={{ type: "linear", min: 0, max: maximum, stacked: false }}
      curve="monotoneX"
      axisTop={null}
      axisRight={null}
      axisBottom={{
        tickSize: 0,
        tickPadding: 11,
        legend: "PRACTICE ATTEMPT",
        legendPosition: "middle",
        legendOffset: 39,
      }}
      axisLeft={{
        tickSize: 0,
        tickPadding: 8,
        format: (value: number) => `${value}${unit}`,
      }}
      enableGridX={false}
      enableGridY={false}
      colors={[color]}
      lineWidth={3}
      pointSize={9}
      pointColor={{ from: "color" }}
      pointBorderWidth={3}
      pointBorderColor={{ from: "background" }}
      enableArea={points.length > 1}
      areaOpacity={0.12}
      useMesh
      enableSlices="x"
      theme={chartTheme}
      ariaLabel={`${label} across ${points.length} measured attempts`}
    />
  );
}

export default function HistoryProgressCharts({
  sessions,
  projectName,
}: {
  sessions: PracticeSession[];
  projectName: string;
}) {
  const confidence = trendFor(sessions, "confidence");
  const fillers = trendFor(sessions, "fillers");
  const pace = trendFor(sessions, "pace");
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const activity = Array.from({ length: 28 }, (_, index) => {
    const start = new Date(now - (27 - index) * day);
    start.setHours(0, 0, 0, 0);
    const end = start.getTime() + day;
    return sessions.filter((session) => {
      const time = Date.parse(session.createdAt);
      return time >= start.getTime() && time < end;
    }).length;
  });
  const activeDays = activity.filter(Boolean).length;
  const weekRuns = sessions.filter((session) => {
    const time = Date.parse(session.createdAt);
    return Number.isFinite(time) && now - time >= 0 && now - time < 7 * day;
  }).length;
  const averagePace = pace.length
    ? Math.round(
        pace.reduce((sum, point) => sum + point.value, 0) / pace.length,
      )
    : null;
  const latestFillers = fillers.at(-1)?.value ?? null;
  const confidenceDelta =
    confidence.length > 1
      ? Math.round(confidence.at(-1)!.value - confidence[0].value)
      : null;
  const fillerDelta =
    fillers.length > 1
      ? Math.round((fillers.at(-1)!.value - fillers[0].value) * 10) / 10
      : null;
  const fillerMax = Math.max(
    5,
    Math.ceil(Math.max(...fillers.map((point) => point.value), 0) * 1.2),
  );

  return (
    <section
      className="history-progress"
      aria-labelledby="history-progress-title"
    >
      <div className="history-progress-heading">
        <div>
          <span className="section-eyebrow">THE BIGGER PICTURE</span>
          <h2 id="history-progress-title">Progress over time</h2>
          <p>
            Measured attempts in {projectName}. Missing readings and extreme
            spikes are left out; valid attempts stay connected.
          </p>
        </div>
      </div>
      <div className="progress-metric-grid">
        <article className="progress-metric-widget activity-widget">
          <span className="widget-label">PRACTICE RHYTHM</span>
          <strong className="widget-value">
            {activeDays} <small>active days</small>
          </strong>
          <div
            className="activity-heatmap"
            role="img"
            aria-label={`${activeDays} active days over the past four weeks`}
          >
            {activity.map((count, index) => (
              <span
                key={index}
                className={`activity-cell level-${Math.min(3, count)}`}
              />
            ))}
          </div>
          <div className="activity-caption">
            <span>4 weeks ago</span>
            <span>Today</span>
          </div>
        </article>
        <article className="progress-metric-widget goal-widget">
          <span className="widget-label">LAST 7 DAYS</span>
          <div className="goal-content">
            <div
              className="goal-ring"
              style={{
                background: `conic-gradient(#df9a54 0 ${Math.min(100, weekRuns * 20)}%, #f3ede5 ${Math.min(100, weekRuns * 20)}% 100%)`,
              }}
            >
              <span>
                {weekRuns}
                <small>/5</small>
              </span>
            </div>
            <div>
              <strong className="widget-value">
                {weekRuns >= 5 ? "Goal reached" : "Keep going"}
              </strong>
              <span className="widget-caption">practice runs</span>
            </div>
          </div>
          <span className="widget-footnote">
            {weekRuns >= 5
              ? "You reached five runs this week"
              : `${5 - weekRuns} more to reach five runs`}
          </span>
        </article>
        <article className="progress-metric-widget pace-widget">
          <span className="widget-label">SPEAKING PACE</span>
          <strong className="widget-value">
            {averagePace ?? "—"}{" "}
            <small>{averagePace === null ? "no reading" : "WPM average"}</small>
          </strong>
          <span className="widget-footnote">
            {pace.length} measured {pace.length === 1 ? "attempt" : "attempts"}
          </span>
        </article>
        <article className="progress-metric-widget filler-widget">
          <span className="widget-label">FILLER WORD RATE</span>
          <strong className="widget-value">
            {latestFillers === null ? "—" : latestFillers.toFixed(1)}{" "}
            <small>per minute</small>
          </strong>
          <span className="widget-footnote">
            {fillers.length
              ? "Latest measured attempt"
              : "Add a transcript to measure"}
          </span>
        </article>
      </div>
      <div className="history-chart-grid">
        <section
          className="panel history-chart-panel"
          aria-label="Confidence trend chart"
        >
          <div className="history-chart-title">
            <div>
              <span className="section-eyebrow">DELIVERY</span>
              <h3>Confidence estimate</h3>
            </div>
            <strong className="chart-change confidence-change">
              {confidenceDelta === null
                ? "—"
                : `${confidenceDelta > 0 ? "+" : ""}${confidenceDelta} pts`}
            </strong>
          </div>
          <div className="history-chart">
            <MetricChart
              points={confidence}
              label="Confidence estimate"
              color="#5187e0"
              maximum={100}
              unit="%"
            />
          </div>
          <p className="history-chart-note">
            A practice score from available speech and body signals.
          </p>
        </section>
        <section
          className="panel history-chart-panel"
          aria-label="Filler word trend chart"
        >
          <div className="history-chart-title">
            <div>
              <span className="section-eyebrow">SPEAKING HABITS</span>
              <h3>Filler words per minute</h3>
            </div>
            <strong className="chart-change habits-change">
              {fillerDelta === null
                ? "—"
                : `${fillerDelta > 0 ? "+" : ""}${fillerDelta}/min`}
            </strong>
          </div>
          <div className="history-chart">
            <MetricChart
              points={fillers}
              label="Filler words per minute"
              color="#df815e"
              maximum={fillerMax}
              unit=""
            />
          </div>
          <p className="history-chart-note">
            Filler counts divided by recording length.
          </p>
        </section>
      </div>
    </section>
  );
}
