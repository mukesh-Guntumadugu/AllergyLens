// AllergyLensSpeech — the Lens's voice. There is no text-to-speech API on SPECS in Lens
// Studio 5.23 (TextToSpeechModule is deprecated), so the fixed prompts are pre-rendered
// once on the Mac (tools/assets/make_speech.sh) and bundled as small MP3s; this class
// plays them. Owns: one AudioComponent per clip and the mute flag. Expects: a host
// SceneObject from Main. Must not decide *when* to speak — Main does.

const CLIPS = {
  welcome: requireAsset("../Audio/Speech/welcome.mp3") as AudioTrackAsset,
  step_allergies: requireAsset("../Audio/Speech/step_allergies.mp3") as AudioTrackAsset,
  more: requireAsset("../Audio/Speech/more.mp3") as AudioTrackAsset,
  step_religious: requireAsset("../Audio/Speech/step_religious.mp3") as AudioTrackAsset,
  step_diet: requireAsset("../Audio/Speech/step_diet.mp3") as AudioTrackAsset,
  saved: requireAsset("../Audio/Speech/saved.mp3") as AudioTrackAsset,
  reopened: requireAsset("../Audio/Speech/reopened.mp3") as AudioTrackAsset,
  heard_nothing: requireAsset("../Audio/Speech/heard_nothing.mp3") as AudioTrackAsset,
  menu_found: requireAsset("../Audio/Speech/menu_found.mp3") as AudioTrackAsset,
  contains: requireAsset("../Audio/Speech/contains.mp3") as AudioTrackAsset,
  likely_fine: requireAsset("../Audio/Speech/likely_fine.mp3") as AudioTrackAsset,
  safe: requireAsset("../Audio/Speech/safe.mp3") as AudioTrackAsset,
  unknown: requireAsset("../Audio/Speech/unknown.mp3") as AudioTrackAsset,
  muted: requireAsset("../Audio/Speech/muted.mp3") as AudioTrackAsset,
  mic_hint: requireAsset("../Audio/Speech/mic_hint.mp3") as AudioTrackAsset,
  mic_back: requireAsset("../Audio/Speech/mic_back.mp3") as AudioTrackAsset,
}

export type SpeechLine = keyof typeof CLIPS

/** Clip lengths in seconds (ffprobe, see make_speech.sh) and the words each one says — the microphone
 *  hears the Lens's own voice too, so Main ignores transcripts while a clip plays and drops echoes of it. */
const DURATION_S: {[l in SpeechLine]: number} = {
  welcome: 1.6, step_allergies: 5.0, more: 2.3, step_religious: 6.1, step_diet: 5.6, saved: 2.4, reopened: 3.1,
  heard_nothing: 3.8, menu_found: 4.3, contains: 2.1, likely_fine: 2.6, safe: 1.1, unknown: 2.8, muted: 2.7,
  mic_hint: 5.0, mic_back: 1.2,
}
const LINE_TEXT: {[l in SpeechLine]: string} = {
  welcome: "welcome to allergy lens",
  step_allergies: "step one any food allergies say them pinch them or say more for others",
  more: "which other allergies just say them",
  step_religious: "step two anything you avoid for religious or cultural reasons beef pork or alcohol",
  step_diet: "step three any diet vegetarian vegan low sugar or no trans fat",
  saved: "profile saved now look at a menu",
  reopened: "your profile change anything or say done",
  heard_nothing: "sorry i didn't catch that say it again or pinch",
  menu_found: "menu recognised point at a dish to check it pinch for details",
  contains: "this dish has something from your profile",
  likely_fine: "likely fine confirm with the restaurant",
  safe: "looks fine for you",
  unknown: "ingredients not published ask the restaurant",
  muted: "voice off say speak to turn it back on",
  mic_hint: "i can't hear you yet in lens studio turn on the microphone in the preview panel",
  mic_back: "i can hear you now",
}
/** Lines that are never spoken any more: microphone chatter ("I can hear you now") and the mute notice were noise. */
const NEVER_SPOKEN: SpeechLine[] = ["mic_back", "mic_hint", "muted"]
/** Speech-to-text finalises ~1 s after the sound stops; transcripts inside this tail are still the Lens's own voice. */
const ECHO_TAIL_S = 1.6

export class AllergyLensSpeech {
  private players = new Map<SpeechLine, AudioComponent>()
  private current: AudioComponent | null = null
  private _muted = false
  private speakingUntil = 0
  private lastLine: SpeechLine | null = null
  private previousLine: SpeechLine | null = null

  constructor(private host: SceneObject, private volume: number = 1.0) {}

  get muted(): boolean {
    return this._muted
  }

  /** "quiet" / "mute" → true; "speak" → false. Silent: no "voice off" announcement (the user asked for one spoken line only). */
  setMuted(muted: boolean, stopCurrent: boolean = true): void {
    this._muted = muted
    if (muted && stopCurrent) this.stop()
  }

  /** Play one line; whatever was still playing stops first (one voice, never two). */
  say(line: SpeechLine): void {
    if (this._muted) return
    if (NEVER_SPOKEN.indexOf(line) >= 0) return
    this.stop()
    let p = this.players.get(line)
    if (!p) {
      try {
        p = this.host.createComponent("Component.AudioComponent") as AudioComponent
        p.audioTrack = CLIPS[line]
        p.volume = this.volume
        this.players.set(line, p)
      } catch (e) {
        print(`AllergyLens: speech "${line}" unavailable (${e})`)
        return
      }
    }
    this.current = p
    p.play(1)
    this.previousLine = this.lastLine
    this.lastLine = line
    this.speakingUntil = getTime() + DURATION_S[line]
    print(`AllergyLens: says "${line}"`)
  }

  /** True while a clip plays and for a short tail after it: the mic is hearing the Lens, not the user. */
  get isSpeaking(): boolean {
    if (this.current && this.current.isPlaying()) return true
    return getTime() < this.speakingUntil + ECHO_TAIL_S
  }

  /**
   * Is this transcript the Lens's own last line coming back through the microphone? More than half
   * of its words appear in that line (a real answer like "vegan" or "no pork" shares at most one word).
   */
  /**
   * The user often answers while the Lens is still talking, and speech-to-text glues both into one
   * transcript ("…which other allergies? Just say them. Olives."). Remove the words of the last two
   * spoken lines and return what the user actually said ("olives"); "" when nothing is left.
   */
  stripEcho(transcript: string): string {
    const said = new Set<string>()
    for (const l of [this.lastLine, this.previousLine]) if (l) for (const w of LINE_TEXT[l].split(" ")) said.add(w)
    const words = transcript.toLowerCase().replace(/[^a-z' ]+/g, " ").split(" ").filter((w) => w.length > 0)
    const removed = words.filter((w) => said.has(w)).length
    // Only call it an echo when the Lens's words are a real share of the transcript.
    if (removed < 3) return transcript
    // While the clip is still sounding, a stray word wedged BETWEEN the Lens's words is the microphone
    // mishearing the clip ("Welcome to Allergy Lab" → "lab"), not the user; what follows the Lens's last
    // word is the user's answer ("… say more for others. Olives." → "olives"). After the clip, keep everything.
    let lastSaid = -1
    words.forEach((w, i) => { if (said.has(w)) lastSaid = i })
    const kept = words.filter((w, i) => !said.has(w) && (i > lastSaid || !this.isSpeaking))
    return kept.join(" ")
  }

  isEcho(transcript: string): boolean {
    if (!this.lastLine) return false
    const said = new Set(LINE_TEXT[this.lastLine].split(" "))
    const words = transcript.toLowerCase().replace(/[^a-z' ]+/g, " ").split(" ").filter((w) => w.length > 0)
    if (words.length === 0) return false
    const hits = words.filter((w) => said.has(w)).length
    return words.length >= 3 && hits / words.length > 0.5
  }

  stop(): void {
    if (this.current && this.current.isPlaying()) this.current.stop(false)
    this.current = null
    this.speakingUntil = Math.min(this.speakingUntil, getTime())
  }
}
