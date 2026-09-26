// Session review page: a test harness for the flag -> clip pipeline, not the
// final design. One card per clip: its thumbnail (click to play), the flags it
// covers with their time ranges and evidence, and each flag's explanation
// ("Analysis pending" until the explainer fills it in).

import type { CaptureHostBridge } from '../../capture/bridge';
import type { Clip, Flag, FlagType } from '../../shared/flags';
import type { FlagsBridge } from '../../shared/flags-bridge';
import type { Session } from '../../shared/session-types';

const TYPE_LABEL: Record<FlagType, string> = {
  high_hr: 'High pulse',
  low_eye_contact: 'Low eye contact',
  fast_pace: 'Fast pace',
  slow_pace: 'Slow pace',
  tense_expression: 'Tense expression',
  manual: 'Flagged moment',
};

/** Session time as m:ss.s */
export function formatTime(ms: number): string {
  const tenths = Math.round(Math.max(0, ms) / 100);
  const minutes = Math.floor(tenths / 600);
  return `${minutes}:${((tenths - minutes * 600) / 10).toFixed(1).padStart(4, '0')}`;
}

const formatRange = (startMs: number, endMs: number): string => `${formatTime(startMs)} – ${formatTime(endMs)}`;
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export interface ReviewElements {
  session: HTMLSelectElement;
  detect: HTMLButtonElement;
  clips: HTMLButtonElement;
  status: HTMLElement;
  empty: HTMLElement;
  cards: HTMLElement;
}

export interface ReviewPage {
  /** Refreshes the session list and shows `sessionId` (default: the selected or newest session). */
  open(sessionId?: string): Promise<void>;
}

export function setupReview(ui: ReviewElements, flagsApi: FlagsBridge | undefined, captureApi: CaptureHostBridge | undefined): ReviewPage {
  let sessionId: string | null = null;
  let flags: Flag[] = [];
  let clips: Clip[] = [];
  const cardByClip = new Map<string, HTMLElement>();
  // Ignores list() results that arrive after the user picked another session.
  let loadToken = 0;
  let reloadTimer: number | null = null;
  let busy = false;

  const setStatus = (text: string, kind: 'info' | 'error' = 'info'): void => {
    ui.status.textContent = text;
    ui.status.dataset['kind'] = kind;
  };

  const setBusy = (on: boolean): void => {
    busy = on;
    ui.detect.disabled = on || !sessionId;
    ui.clips.disabled = on || !sessionId;
    ui.session.disabled = on;
  };

  function mediaFor(clip: Clip): HTMLElement {
    if (!flagsApi) return el('div', 'media note', 'Preload bridge missing');
    if (clip.status === 'pending') return el('div', 'media note', 'Cutting clip…');
    if (clip.status === 'error') return el('div', 'media note error', `Clip failed: ${clip.error ?? 'unknown error'}`);
    const api = flagsApi;
    const button = el('button', 'media thumb');
    button.type = 'button';
    button.title = 'Play clip';
    const img = el('img');
    img.alt = '';
    img.src = api.thumbUrl(clip);
    button.append(img, el('span', 'play', '▶'));
    button.addEventListener('click', () => {
      const video = el('video', 'media');
      video.controls = true;
      video.autoplay = true;
      video.playsInline = true;
      video.preload = 'auto';
      video.src = api.clipUrl(clip);
      video.dataset['clipId'] = clip.id;
      button.replaceWith(video);
    });
    return button;
  }

  function flagItem(flag: Flag): HTMLElement {
    const li = el('li', 'flag');
    const head = el('div', 'flag-head');
    const chip = el('span', 'chip', TYPE_LABEL[flag.type] ?? flag.type);
    chip.dataset['severity'] = flag.severity;
    chip.title = `${flag.severity} severity`;
    head.append(chip, el('span', 'range', formatRange(flag.startMs, flag.endMs)), el('span', 'source', flag.source));
    li.append(head);
    const evidence = Object.entries(flag.evidence);
    if (evidence.length) {
      const dl = el('dl', 'evidence');
      for (const [k, v] of evidence) {
        const row = el('div');
        row.append(el('dt', undefined, k), el('dd', undefined, String(v)));
        dl.append(row);
      }
      li.append(dl);
    }
    if (flag.explanation) {
      const p = el('p', 'explanation');
      p.append(el('strong', undefined, flag.explanation.summary), ` ${flag.explanation.suggestion}`);
      li.append(p);
    } else {
      li.append(el('p', 'explanation pending', 'Analysis pending'));
    }
    return li;
  }

  function buildCard(clip: Clip | null, cardFlags: Flag[]): HTMLElement {
    const card = el('article', 'card');
    card.dataset['status'] = clip?.status ?? 'none';
    const media = clip ? mediaFor(clip) : el('div', 'media note', 'No clip yet: press Generate clips');
    const body = el('div', 'card-body');
    if (clip) {
      body.append(el('div', 'clip-range', `Clip ${formatRange(clip.startMs, clip.endMs)} · ${((clip.endMs - clip.startMs) / 1000).toFixed(1)} s`));
    }
    const list = el('ul', 'flags');
    list.append(...cardFlags.map(flagItem));
    body.append(list);
    card.append(media, body);
    return card;
  }

  function render(): void {
    cardByClip.clear();
    ui.cards.replaceChildren();
    ui.empty.hidden = flags.length > 0 || !sessionId;
    ui.empty.textContent = 'No flags in this session. Press F (or "Flag this moment") while recording, or run the detectors.';
    const byId = new Map(flags.map((f) => [f.id, f]));
    const clipIds = new Set(clips.map((c) => c.id));
    for (const clip of [...clips].sort((a, b) => a.startMs - b.startMs)) {
      const cardFlags = clip.flagIds.map((id) => byId.get(id)).filter((f): f is Flag => f !== undefined);
      const card = buildCard(clip, cardFlags);
      cardByClip.set(clip.id, card);
      ui.cards.append(card);
    }
    // Flags that no clip covers yet.
    for (const flag of flags.filter((f) => f.clipId === undefined || !clipIds.has(f.clipId))) ui.cards.append(buildCard(null, [flag]));
  }

  async function reload(): Promise<void> {
    if (!flagsApi || !sessionId) return;
    const token = ++loadToken;
    const id = sessionId;
    const result = await flagsApi.list(id);
    if (token !== loadToken || id !== sessionId) return;
    flags = result.flags;
    clips = result.clips;
    render();
  }

  const scheduleReload = (): void => {
    if (reloadTimer !== null) return;
    reloadTimer = window.setTimeout(() => {
      reloadTimer = null;
      reload().catch((err: unknown) => setStatus(`Could not load flags: ${errorText(err)}`, 'error'));
    }, 150);
  };

  function summary(): string {
    const ready = clips.filter((c) => c.status === 'ready').length;
    const failed = clips.filter((c) => c.status === 'error').length;
    return `${flags.length} flag(s), ${clips.length} clip(s)${clips.length ? `: ${ready} ready` : ''}${failed ? `, ${failed} failed` : ''}.`;
  }

  async function generate(): Promise<void> {
    if (!flagsApi || !sessionId) return;
    setBusy(true);
    setStatus('Cutting clips…');
    try {
      await flagsApi.generateClips(sessionId);
      await reload();
      setStatus(summary());
    } catch (err) {
      setStatus(`Generate clips failed: ${errorText(err)}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function detect(): Promise<void> {
    if (!flagsApi || !sessionId) return;
    setBusy(true);
    setStatus('Running detectors…');
    try {
      const found = await flagsApi.runDetectors(sessionId);
      await reload();
      setStatus(`Detectors found ${found.length} flag(s).`);
    } catch (err) {
      setStatus(`Detectors failed: ${errorText(err)}`, 'error');
      setBusy(false);
      return;
    }
    setBusy(false);
    await generate();
  }

  async function show(id: string): Promise<void> {
    sessionId = id;
    flags = [];
    clips = [];
    render();
    setBusy(busy);
    setStatus('Loading…');
    try {
      await reload();
    } catch (err) {
      setStatus(`Could not load flags: ${errorText(err)}`, 'error');
      return;
    }
    setStatus(summary());
    // Cut whatever is missing (e.g. flags added while recording, or clips left pending when the app quit).
    const needsClips = flags.some((f) => f.clipId === undefined) || clips.some((c) => c.status !== 'ready');
    if (needsClips && !busy) await generate();
  }

  flagsApi?.onClipUpdate((clip) => {
    if (clip.sessionId !== sessionId) return;
    const i = clips.findIndex((c) => c.id === clip.id);
    const known = clips[i];
    const card = cardByClip.get(clip.id);
    if (!known || !card) {
      // A new plan (flags changed): show it.
      scheduleReload();
      return;
    }
    if (known.status === clip.status && known.error === clip.error) return;
    clips[i] = clip;
    const byId = new Map(flags.map((f) => [f.id, f]));
    const next = buildCard(clip, clip.flagIds.map((id) => byId.get(id)).filter((f): f is Flag => f !== undefined));
    card.replaceWith(next);
    cardByClip.set(clip.id, next);
  });

  ui.session.addEventListener('change', () => {
    if (ui.session.value) void show(ui.session.value);
  });
  ui.detect.addEventListener('click', () => void detect());
  ui.clips.addEventListener('click', () => void generate());
  setBusy(false);

  function sessionLabel(s: Session): string {
    const when = new Date(s.startedAtIso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const length = s.durationMs !== null ? `${(s.durationMs / 1000).toFixed(1)} s` : s.status;
    return `${when} · ${length} · ${s.id.slice(0, 8)}`;
  }

  return {
    async open(requested) {
      if (!flagsApi || !captureApi) {
        setStatus('Preload bridge missing: window.flags / window.captureHost are unavailable.', 'error');
        return;
      }
      let sessions: Session[];
      try {
        sessions = (await captureApi.listSessions()).filter((s) => s.recordingPath !== null);
      } catch (err) {
        setStatus(`Could not list sessions: ${errorText(err)}`, 'error');
        return;
      }
      const keep = requested ?? sessionId ?? sessions[0]?.id ?? null;
      ui.session.replaceChildren(
        ...sessions.map((s) => {
          const option = el('option', undefined, sessionLabel(s));
          option.value = s.id;
          return option;
        }),
      );
      if (!keep || !sessions.some((s) => s.id === keep)) {
        sessionId = null;
        flags = [];
        clips = [];
        render();
        setBusy(false);
        setStatus(sessions.length ? '' : 'No recorded sessions yet.');
        return;
      }
      ui.session.value = keep;
      if (keep !== sessionId || !busy) await show(keep);
    },
  };
}
