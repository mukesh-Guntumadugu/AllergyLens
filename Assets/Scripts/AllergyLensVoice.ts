// AllergyLensVoice — "say the dish name" as a secondary way to pick a line (pinch stays
// primary). Owns: the fuzzy dish-name matcher (pure, unit-tested) and a thin wrapper
// around the Specs ASR module that listens only while Main says a menu is in view.
// Any ASR error is swallowed with one log line and never affects the rest of the Lens.

import {DishDef} from "./AllergyLensMenuData"

/** Lowercase, strip punctuation, collapse repeated letters ("naan" → "nan") and whitespace. */
export function normalizeSpeech(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/([a-z])\1+/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
}

function tokens(s: string): string[] {
  return normalizeSpeech(s).split(" ").filter((t) => t.length > 0)
}

/**
 * Fuzzy match of a transcript against the page's dish names: the transcript contains the
 * (normalised) dish name, or ≥ 60 % of the name's tokens appear in the transcript. Ties go
 * to the dish with the most matched tokens, then the longer name.
 */
export function matchDishByVoice(transcript: string, dishes: DishDef[]): DishDef | null {
  const text = normalizeSpeech(transcript)
  if (text.length === 0) return null
  const spoken = new Set(tokens(text))
  let best: DishDef | null = null
  let bestScore = 0
  let bestHits = 0
  for (const dish of dishes) {
    const name = normalizeSpeech(dish.name)
    const nameTokens = tokens(name)
    if (nameTokens.length === 0) continue
    let hits = 0
    for (const t of nameTokens) if (spoken.has(t)) hits++
    const contains = text.indexOf(name) >= 0
    const score = contains ? 1 : hits / nameTokens.length
    if (score < 0.6) continue
    if (score > bestScore || (score === bestScore && (hits > bestHits || (hits === bestHits && best !== null && nameTokens.length > tokens(best.name).length)))) {
      best = dish
      bestScore = score
      bestHits = hits
    }
  }
  return best
}

/** Thin ASR session wrapper. Construct once; start/stop as menus come and go. */
export class VoiceListener {
  private asr: AsrModule | null = null
  private active = false
  private failed = false

  constructor(private onFinalTranscript: (text: string) => void) {}

  get isListening(): boolean {
    return this.active
  }

  start(): void {
    if (this.active || this.failed) return
    try {
      if (!this.asr) this.asr = require("LensStudio:AsrModule") as AsrModule
      const options = AsrModule.AsrTranscriptionOptions.create()
      options.silenceUntilTerminationMs = 900
      options.mode = AsrModule.AsrMode.Balanced
      options.onTranscriptionUpdateEvent.add((e: AsrModule.TranscriptionUpdateEvent) => {
        if (e.isFinal && e.text && e.text.trim().length > 0) this.onFinalTranscript(e.text)
      })
      options.onTranscriptionErrorEvent.add((code: AsrModule.AsrStatusCode) => {
        this.failed = true
        this.active = false
        print(`AllergyLens: voice unavailable (ASR error ${code}); pinch still works`)
      })
      this.asr.startTranscribing(options)
      this.active = true
      print("AllergyLens: voice listening (say a dish name)")
    } catch (e) {
      this.failed = true
      this.active = false
      print(`AllergyLens: voice unavailable (${e}); pinch still works`)
    }
  }

  stop(): void {
    if (!this.active || !this.asr) return
    this.active = false
    try {
      this.asr.stopTranscribing()
      print("AllergyLens: voice stopped")
    } catch (e) {
      print(`AllergyLens: voice stop failed (${e})`)
    }
  }
}
