/**
 * Thin wrapper around the Web Speech API — STT (dictation) + TTS (read aloud).
 *
 * Why Web Speech API, not OpenAI Whisper / Azure / a local model:
 *   - It's free and baked into Chromium, which means WebView2 on Windows and
 *     every major browser get it for zero setup. Matches Flaude's "local-only,
 *     no server" spine.
 *   - No API key, no network config, no extra binary to ship.
 *   - Quality is "replace typing" level for zh-CN + en-US — not Whisper-crisp,
 *     but it's the right starting rung.
 *
 * Known quirks we've accepted here:
 *   - SpeechRecognition under Chromium actually does POST audio to Google's
 *     servers (the API is local-looking but not local-executing). Fine for us
 *     for now; flagged in onboarding.
 *   - The constructor is still only available under the `webkit-` prefix on
 *     Chromium — we probe both.
 *   - `speechSynthesis` voice list is empty on first call, then populates
 *     async. We don't need a specific voice, so we just ride the default.
 *
 * The file is intentionally side-effect-light: a small module-scope registry
 * of "who's currently speaking" so the MessageActions bar can render per-
 * message state without every assistant message subscribing to its own event.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// Capability probes
// ---------------------------------------------------------------------------

interface WindowWithSpeech extends Window {
  SpeechRecognition?: SpeechRecognitionCtor;
  webkitSpeechRecognition?: SpeechRecognitionCtor;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionInstance;

// Minimal subset of the DOM SpeechRecognition interface we use. TypeScript's
// lib.dom.d.ts doesn't include it (still experimental), so we type the bits
// we touch and leave the rest as `any` to keep out of the way.
interface SpeechRecognitionInstance {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((ev: SpeechRecognitionEvent) => void) | null;
  onerror: ((ev: { error: string }) => void) | null;
  onend: (() => void) | null;
}
interface SpeechRecognitionEvent {
  resultIndex: number;
  results: ArrayLike<{
    isFinal: boolean;
    0: { transcript: string };
  }>;
}

export function hasSpeechRecognition(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as WindowWithSpeech;
  return typeof w.SpeechRecognition === 'function' || typeof w.webkitSpeechRecognition === 'function';
}

export function hasSpeechSynthesis(): boolean {
  return typeof window !== 'undefined' && typeof window.speechSynthesis !== 'undefined';
}

// ---------------------------------------------------------------------------
// TTS — module-scope singleton so Speak buttons on different messages can
// coordinate (only one message speaks at a time).
// ---------------------------------------------------------------------------

let currentlySpeakingId: string | null = null;
const speakingListeners = new Set<(id: string | null) => void>();

function setSpeakingId(id: string | null) {
  currentlySpeakingId = id;
  for (const fn of speakingListeners) fn(id);
}

/**
 * Speak `text` aloud, tagged with `id` so UI can show "this message is
 * playing". Calling again with a different id cancels the prior utterance —
 * this matches the user's mental model (you wouldn't expect two messages to
 * read simultaneously).
 */
export function speak(id: string, text: string, opts?: { lang?: string; rate?: number }): void {
  if (!hasSpeechSynthesis()) return;
  window.speechSynthesis.cancel(); // stop any prior utterance
  const u = new SpeechSynthesisUtterance(text);
  u.lang = opts?.lang ?? 'zh-CN';
  u.rate = opts?.rate ?? 1.0;
  const clear = () => {
    // Only clear if we're still the current speaker — another speak() could
    // have swapped us out synchronously, and we don't want a late onend from
    // the dead utterance to wipe the new one's state.
    if (currentlySpeakingId === id) setSpeakingId(null);
  };
  u.onend = clear;
  u.onerror = clear;
  setSpeakingId(id);
  window.speechSynthesis.speak(u);
}

export function stopSpeaking(): void {
  if (!hasSpeechSynthesis()) return;
  window.speechSynthesis.cancel();
  setSpeakingId(null);
}

/** Subscribe to "currently speaking" state. Returns the id, or null. */
export function useSpeakingId(): string | null {
  const [id, setId] = useState<string | null>(currentlySpeakingId);
  useEffect(() => {
    speakingListeners.add(setId);
    return () => {
      speakingListeners.delete(setId);
    };
  }, []);
  return id;
}

// ---------------------------------------------------------------------------
// STT — a hook that owns one recognizer per component using it.
// ---------------------------------------------------------------------------

export interface UseSpeechRecognitionOpts {
  /** BCP-47 language tag. Defaults to 'zh-CN'. */
  lang?: string;
  /**
   * Called on every transcript tick. `isFinal=true` means this chunk is
   * committed (the user paused long enough); `false` means a streaming
   * preview that will be replaced by a final chunk shortly.
   *
   * Callers typically use the interim form for live feedback (grey text in
   * the composer) and commit on final.
   */
  onResult: (transcript: string, isFinal: boolean) => void;
}

export function useSpeechRecognition({ lang = 'zh-CN', onResult }: UseSpeechRecognitionOpts) {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recRef = useRef<SpeechRecognitionInstance | null>(null);
  // Keep latest callback in a ref — we don't want to re-construct the
  // recognizer every time the parent re-renders with a new closure.
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;

  const ensure = useCallback((): SpeechRecognitionInstance | null => {
    if (recRef.current) return recRef.current;
    const w = window as WindowWithSpeech;
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Ctor) return null;
    const rec = new Ctor();
    rec.lang = lang;
    // `continuous = true` lets the user speak in bursts without the API
    // cutting them off on the first pause. They tap stop to commit.
    rec.continuous = true;
    // Streaming partial transcripts gives the textarea live greyed-out
    // preview text so the user knows dictation is happening.
    rec.interimResults = true;
    rec.onresult = (e) => {
      let interim = '';
      let final = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) final += r[0].transcript;
        else interim += r[0].transcript;
      }
      if (final) onResultRef.current(final, true);
      else if (interim) onResultRef.current(interim, false);
    };
    rec.onerror = (e) => {
      // Common values: 'no-speech', 'network', 'not-allowed' (mic denied),
      // 'audio-capture' (no mic). Surface as-is — UI can translate if it wants.
      setError(e.error || 'unknown');
      setListening(false);
    };
    rec.onend = () => setListening(false);
    recRef.current = rec;
    return rec;
  }, [lang]);

  const start = useCallback(() => {
    const rec = ensure();
    if (!rec) {
      setError('not-supported');
      return;
    }
    setError(null);
    try {
      rec.start();
      setListening(true);
    } catch (e) {
      // `InvalidStateError` happens if .start() is called while already
      // active — benign, means the user double-clicked. Clearing the flag
      // keeps the UI honest.
      const msg = (e as Error).message ?? 'start-failed';
      if (!/InvalidStateError/i.test(msg)) setError(msg);
    }
  }, [ensure]);

  const stop = useCallback(() => {
    recRef.current?.stop();
    setListening(false);
  }, []);

  // Clean up on unmount — otherwise a mounted-then-unmounted composer would
  // leak a live recognizer holding the mic.
  useEffect(() => {
    return () => {
      recRef.current?.stop();
    };
  }, []);

  return { listening, error, start, stop, supported: hasSpeechRecognition() };
}
