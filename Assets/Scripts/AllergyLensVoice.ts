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

const ALLERGY_PHRASES = [
  /(?:i am|i'm|im|we are|we're|he is|she is)?\s*(?:also\s+)?allergic to\s+(.+)/,
  /(?:i|we)\s+(?:can'?t|cannot|don'?t|do not)\s+(?:eat|have|take)\s+(.+)/,
  /^(?:no|avoid|add|without|not|never)\s+(.+)/,
]
const FILLER = /^(the|a|an|any|some|please|also|and|to|eat|all|any kind of|kind of|sort of|type of|anything with|things with|stuff with)\s+/

/**
 * "I'm allergic to mango", "no coriander", "I can't eat okra" → "mango" / "coriander" / "okra".
 * Returns the thing named (1–3 words, lowercase) or null when the sentence is not about a food to avoid.
 */
export function parseAllergyPhrase(transcript: string): string | null {
  // Light normalisation only: the dish matcher's doubled-letter collapsing would turn "allergic" into "alergic".
  const text = transcript.toLowerCase().replace(/[^a-z0-9'\s]/g, " ").replace(/\s+/g, " ").trim()
  if (text.length === 0) return null
  for (const re of ALLERGY_PHRASES) {
    const m = text.match(re)
    if (!m) continue
    let item = m[1].trim()
    for (let i = 0; i < 3; i++) item = item.replace(FILLER, "")
    item = item.replace(/\s+(please|thanks|thank you|too|as well|either)$/, "").trim()
    const words = item.split(" ").filter((w) => w.length > 0).slice(0, 3)
    if (words.length === 0) return null
    return words.join(" ")
  }
  return null
}

/**
 * Thin speech-to-text wrapper. Construct once; start/stop as the panel opens and menus come
 * and go. On the glasses it uses the SPECS ASR module. In the Lens Studio preview it uses
 * VoiceML instead (`useVoiceML`), because starting ASR inside the 5.23.2 preview crashes
 * Lens Studio; VoiceML is what Snapchat Lenses use there and takes the preview's mic button.
 */
export class VoiceListener {
  private asr: AsrModule | null = null
  private vml: VoiceMLModule | null = null
  private vmlEnabled = false
  private vmlListening = false
  private active = false
  private failed = false

  constructor(private onFinalTranscript: (text: string) => void, private useVoiceML: boolean = false) {}

  get isListening(): boolean {
    return this.active
  }

  start(): void {
    if (this.active || this.failed) return
    if (this.useVoiceML) {
      this.startVoiceML()
      return
    }
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
    if (!this.active) return
    this.active = false
    try {
      if (this.vml) {
        if (this.vmlListening) this.vml.stopListening()
        this.vmlListening = false
      } else if (this.asr) {
        this.asr.stopTranscribing()
      }
      print("AllergyLens: voice stopped")
    } catch (e) {
      print(`AllergyLens: voice stop failed (${e})`)
    }
  }

  // ── VoiceML (Lens Studio preview) ────────────────────────────────────────
  private startVoiceML(): void {
    try {
      if (!this.vml) {
        this.vml = require("LensStudio:VoiceMLModule") as VoiceMLModule
        this.vml.onListeningEnabled.add(() => {
          this.vmlEnabled = true
          if (this.active) this.vmlListen()
        })
        this.vml.onListeningUpdate.add((e: VoiceML.ListeningUpdateEventArgs) => {
          if (e.isFinalTranscription && e.transcription && e.transcription.trim().length > 0) this.onFinalTranscript(e.transcription)
        })
        this.vml.onListeningError.add((e: VoiceML.ListeningErrorEventArgs) => {
          const any = e as unknown as {error?: string; description?: string}
          print(`AllergyLens: voice (VoiceML) error ${any.error ?? ""} ${any.description ?? ""}`)
        })
      }
      this.active = true
      // Listening is allowed once the module reports the mic is enabled; try now as well in
      // case that already happened before we subscribed.
      this.vmlListen()
    } catch (e) {
      this.failed = true
      this.active = false
      print(`AllergyLens: voice unavailable in the preview (${e}); pinch still works`)
    }
  }

  private vmlListen(): void {
    if (!this.vml || this.vmlListening) return
    try {
      const options = VoiceML.ListeningOptions.create()
      options.shouldReturnAsrTranscription = true
      options.shouldReturnInterimAsrTranscription = false
      this.vml.startListening(options)
      this.vmlListening = true
      print(`AllergyLens: voice listening (VoiceML, preview mic${this.vmlEnabled ? "" : ", waiting for the mic"}) — say a toggle, a mood, "I'm allergic to …" or "done"`)
    } catch (e) {
      print(`AllergyLens: VoiceML startListening failed (${e})`)
    }
  }
}
