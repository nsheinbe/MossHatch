import type { VoiceProfile } from "@mosshatch/core";

/**
 * Voice seams for the launcher (docs/LAUNCHER.md "Voice next"). Nothing here is wired to a provider, and the page never asks for the
 * microphone: Permissions-Policy denies `microphone=()` site-wide and stays that way until voice ships behind its own decision.
 * The conversation already runs through these shapes, so a speech provider drops in without touching the UI:
 *   - SpeechToText turns the owner's speech into the same text the input box sends (a final transcript per utterance).
 *   - TextToSpeech speaks the creature's streamed text in its species voice and reports loudness for the glow.
 *   - AmplitudeSource is what drives the creature's glow: today `TokenAmplitude` (from streamed words), next an audio analyser.
 */

export interface SpeechToText {
  /** Start listening after an explicit press; resolves when the provider is ready. Must only be called from a user gesture. */
  start(opts: { lang: string; onPartial(text: string): void; onFinal(text: string): void; onError(code: SpeechErrorCode): void }): Promise<void>;
  stop(): void;
  readonly listening: boolean;
}

export interface TextToSpeech {
  /** Speak a piece of the creature's reply as it streams; pieces queue in order. */
  speak(piece: string, voice: VoiceProfile): void;
  /** Stop at once (the owner interrupts, closes the panel, or turns sound off). */
  cancel(): void;
  /** Loudness of what is playing, for the glow. */
  readonly amplitude: AmplitudeSource;
}

export type SpeechErrorCode = "not_allowed" | "no_speech" | "network" | "unsupported";

/** 0..1 loudness, read once per animation frame. */
export interface AmplitudeSource {
  level(nowMs: number): number;
}
