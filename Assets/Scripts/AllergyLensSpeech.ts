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
}

export type SpeechLine = keyof typeof CLIPS

export class AllergyLensSpeech {
  private players = new Map<SpeechLine, AudioComponent>()
  private current: AudioComponent | null = null
  private _muted = false

  constructor(private host: SceneObject, private volume: number = 1.0) {}

  get muted(): boolean {
    return this._muted
  }

  /** "quiet" / "mute" → true; "speak" → false. The muted line itself is still spoken once so the user knows. */
  setMuted(muted: boolean): void {
    if (muted && !this._muted) {
      this._muted = false
      this.say("muted")
    }
    this._muted = muted
    if (muted) this.stop()
  }

  /** Play one line; whatever was still playing stops first (one voice, never two). */
  say(line: SpeechLine): void {
    if (this._muted) return
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
    print(`AllergyLens: says "${line}"`)
  }

  stop(): void {
    if (this.current && this.current.isPlaying()) this.current.stop(false)
    this.current = null
  }
}
