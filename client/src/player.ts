/**
 * Audio engine: <audio> element + playlist state + lazy WebAudio analyser.
 *
 * The AudioContext / MediaElementAudioSourceNode / AnalyserNode graph is
 * created lazily inside playIndex() — i.e. during a user gesture — to satisfy
 * browser autoplay policies. Audio streams same-origin (/api/stream/:id via
 * the vite proxy), so the analyser gets real data without CORS trouble.
 */
import type { Track } from '@shared';
import { errorMessage, streamUrl } from './api';

export type PlaybackState = 'stopped' | 'playing' | 'paused';

/** off → play through and stop; all → wrap the playlist; one → loop this track. */
export type RepeatMode = 'off' | 'all' | 'one';

/** Classic Winamp 10-band graphic-EQ centre frequencies (Hz). */
export const EQ_FREQS = [60, 170, 310, 600, 1000, 3000, 6000, 12000, 14000, 16000];
/** Slider range for the preamp and each band, in dB. */
export const EQ_RANGE_DB = 12;

function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

export interface PlayerEvents {
  timeupdate: () => void;
  statechange: (state: PlaybackState) => void;
  trackchange: (track: Track, index: number) => void;
  ended: () => void;
  error: (message: string) => void;
}

export class Player {
  readonly audio: HTMLAudioElement = new Audio();

  tracks: Track[] = [];
  currentIndex = -1;
  state: PlaybackState = 'stopped';

  /** Winamp-style play modes. */
  repeatMode: RepeatMode = 'off';
  shuffle = false;

  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private panner: StereoPannerNode | null = null;
  private freqData: Uint8Array<ArrayBuffer> | null = null;
  private waveData: Uint8Array<ArrayBuffer> | null = null;
  private pendingBalance = 0;

  // Graphic EQ: a preamp GainNode + one peaking BiquadFilter per EQ_FREQS band.
  // Nodes are built lazily in ensureGraph(); values set before then are stored
  // here and applied when the graph comes up.
  private preampNode: GainNode | null = null;
  private eqBands: BiquadFilterNode[] = [];
  private eqEnabled = true;
  private eqGainsDb: number[] = new Array(EQ_FREQS.length).fill(0);
  private preampDb = 0;
  /** Guards against a double-click loading the same track twice in a row. */
  private lastLoadId = '';
  private lastLoadAt = 0;

  private readonly listeners: { [K in keyof PlayerEvents]: Set<PlayerEvents[K]> } = {
    timeupdate: new Set(),
    statechange: new Set(),
    trackchange: new Set(),
    ended: new Set(),
    error: new Set(),
  };

  constructor() {
    this.audio.preload = 'auto';
    this.audio.volume = 0.8;
    this.audio.addEventListener('timeupdate', () => this.emit('timeupdate'));
    this.audio.addEventListener('durationchange', () => this.emit('timeupdate'));
    this.audio.addEventListener('playing', () => this.setState('playing'));
    this.audio.addEventListener('pause', () => {
      // stop() sets 'stopped' synchronously before this queued event runs, and
      // 'ended' is handled separately — only a real user pause lands here.
      if (this.state === 'playing' && !this.audio.ended) this.setState('paused');
    });
    this.audio.addEventListener('ended', () => {
      this.setState('stopped');
      this.emit('ended');
    });
    this.audio.addEventListener('error', () => {
      if (this.currentIndex < 0) return; // no track loaded — nothing to report
      this.setState('stopped');
      this.emit('error', this.describeMediaError());
    });
  }

  on<K extends keyof PlayerEvents>(event: K, fn: PlayerEvents[K]): void {
    this.listeners[event].add(fn);
  }

  private emit<K extends keyof PlayerEvents>(event: K, ...args: Parameters<PlayerEvents[K]>): void {
    for (const fn of this.listeners[event]) {
      (fn as (...fnArgs: Parameters<PlayerEvents[K]>) => void)(...args);
    }
  }

  private setState(state: PlaybackState): void {
    if (this.state === state) return;
    this.state = state;
    this.emit('statechange', state);
  }

  get currentTrack(): Track | null {
    return this.tracks[this.currentIndex] ?? null;
  }

  /** Real media duration when known, else the catalog durationMs fallback. */
  get durationSeconds(): number {
    const d = this.audio.duration;
    if (Number.isFinite(d) && d > 0) return d;
    const track = this.currentTrack;
    return track ? track.durationMs / 1000 : 0;
  }

  get sampleRateKhz(): number | null {
    return this.ctx ? Math.round(this.ctx.sampleRate / 1000) : null;
  }

  /** Replace the playlist, keeping the currently-loaded track mapped if present. */
  setPlaylist(tracks: Track[]): void {
    const playingId = this.currentTrack?.id ?? null;
    this.tracks = tracks;
    this.currentIndex = playingId === null ? -1 : tracks.findIndex((t) => t.id === playingId);
  }

  /** Append tracks to the end of the playlist (used to extend the wave queue). */
  appendTracks(tracks: Track[]): void {
    this.tracks = this.tracks.concat(tracks);
  }

  /** id of the last track in the playlist — the frontier the wave advances from. */
  get frontierId(): string | null {
    return this.tracks[this.tracks.length - 1]?.id ?? null;
  }

  /** Load and play the track at `index` (wraps around the playlist). */
  playIndex(index: number): void {
    const count = this.tracks.length;
    if (count === 0) {
      this.emit('error', 'playlist is empty — search for tracks first');
      return;
    }
    const wrapped = ((index % count) + count) % count;
    const track = this.tracks[wrapped];
    // Swallow a duplicate trigger for the same track within a double-click
    // window: reloading the src would abort the in-flight play() and stutter.
    const now = performance.now();
    if (track.id === this.lastLoadId && now - this.lastLoadAt < 700) return;
    this.lastLoadId = track.id;
    this.lastLoadAt = now;
    this.currentIndex = wrapped;
    this.ensureGraph(); // user gesture → safe to create the AudioContext here
    this.audio.src = streamUrl(track.id);
    this.emit('trackchange', track, wrapped);
    void this.startPlayback();
  }

  play(): void {
    if (this.state === 'paused') {
      void this.startPlayback();
      return;
    }
    if (this.state === 'playing') {
      this.audio.currentTime = 0; // Winamp behavior: Play while playing restarts
      return;
    }
    this.playIndex(this.currentIndex >= 0 ? this.currentIndex : 0);
  }

  /** Pause toggles: pauses when playing, resumes when paused. */
  pause(): void {
    if (this.state === 'playing') this.audio.pause();
    else if (this.state === 'paused') void this.startPlayback();
  }

  stop(): void {
    this.audio.pause();
    if (this.audio.src) this.audio.currentTime = 0;
    this.lastLoadId = ''; // allow an immediate re-click to replay the track
    this.setState('stopped');
    this.emit('timeupdate');
  }

  next(): void {
    if (this.shuffle && this.tracks.length > 1) {
      this.playIndex(this.randomOtherIndex());
      return;
    }
    this.playIndex(this.currentIndex < 0 ? 0 : this.currentIndex + 1);
  }

  prev(): void {
    if (this.shuffle && this.tracks.length > 1) {
      this.playIndex(this.randomOtherIndex());
      return;
    }
    this.playIndex(this.currentIndex < 0 ? 0 : this.currentIndex - 1);
  }

  /** Restart the current track from 0 — Winamp "repeat 1" / loop-per-track. */
  replayCurrent(): void {
    if (this.currentIndex < 0) return;
    this.audio.currentTime = 0;
    void this.startPlayback();
  }

  private randomOtherIndex(): number {
    const n = this.tracks.length;
    if (n <= 1) return 0;
    let i = this.currentIndex;
    while (i === this.currentIndex) i = Math.floor(Math.random() * n);
    return i;
  }

  /**
   * Decide what plays when a track ends naturally, honoring repeat + shuffle.
   * Returns 'looped' | 'advanced' | 'stopped' so the UI can update status.
   * Wave extension is handled by the UI before this runs.
   */
  handleTrackEnd(): 'looped' | 'advanced' | 'stopped' {
    if (this.repeatMode === 'one') {
      this.replayCurrent();
      return 'looped';
    }
    if (this.shuffle && this.tracks.length > 1) {
      this.playIndex(this.randomOtherIndex());
      return 'advanced';
    }
    const atEnd = this.currentIndex >= this.tracks.length - 1;
    if (!atEnd) {
      this.playIndex(this.currentIndex + 1);
      return 'advanced';
    }
    if (this.repeatMode === 'all' && this.tracks.length > 0) {
      this.playIndex(0);
      return 'advanced';
    }
    return 'stopped';
  }

  seekTo(seconds: number): void {
    const duration = this.durationSeconds;
    if (duration <= 0) return;
    this.audio.currentTime = Math.min(Math.max(seconds, 0), duration);
  }

  setVolume(volume: number): void {
    this.audio.volume = Math.min(Math.max(volume, 0), 1);
  }

  /** -1 (full left) … 0 … +1 (full right). Applied when the graph exists. */
  setBalance(balance: number): void {
    this.pendingBalance = Math.min(Math.max(balance, -1), 1);
    if (this.panner) this.panner.pan.value = this.pendingBalance;
  }

  // --------------------------------------------------------------------- EQ
  private clampDb(db: number): number {
    return Math.min(Math.max(db, -EQ_RANGE_DB), EQ_RANGE_DB);
  }

  /** Set band `index` gain in dB (−12…+12). Applied live when EQ is enabled. */
  setEqBand(index: number, db: number): void {
    if (index < 0 || index >= this.eqGainsDb.length) return;
    const value = this.clampDb(db);
    this.eqGainsDb[index] = value;
    const band = this.eqBands[index];
    if (band && this.eqEnabled) band.gain.value = value;
  }

  /** Preamp level in dB (−12…+12). */
  setPreamp(db: number): void {
    this.preampDb = this.clampDb(db);
    if (this.preampNode && this.eqEnabled) this.preampNode.gain.value = dbToGain(this.preampDb);
  }

  /** Toggle the EQ. Disabled = flat (all bands 0 dB, preamp unity). */
  setEqEnabled(on: boolean): void {
    this.eqEnabled = on;
    this.eqBands.forEach((b, i) => {
      b.gain.value = on ? (this.eqGainsDb[i] as number) : 0;
    });
    if (this.preampNode) this.preampNode.gain.value = on ? dbToGain(this.preampDb) : 1;
  }

  get eqOn(): boolean {
    return this.eqEnabled;
  }

  /** Latest frequency-domain data (0–255 per bin), or null before first play. */
  getFrequencyData(): Uint8Array | null {
    if (!this.analyser || !this.freqData) return null;
    this.analyser.getByteFrequencyData(this.freqData);
    return this.freqData;
  }

  /** Latest time-domain data (128 = silence), or null before first play. */
  getWaveformData(): Uint8Array | null {
    if (!this.analyser || !this.waveData) return null;
    this.analyser.getByteTimeDomainData(this.waveData);
    return this.waveData;
  }

  private ensureGraph(): void {
    if (this.ctx) return;
    let ctx: AudioContext;
    try {
      ctx = new AudioContext();
    } catch (err) {
      // No WebAudio: the <audio> element still plays on its own.
      this.emit('error', `webaudio unavailable — visualizer disabled (${errorMessage(err)})`);
      return;
    }
    this.ctx = ctx;
    try {
      // Build the downstream chain first, attach the media source last, so a
      // failure here can never leave the <audio> element captured but muted.
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.72;
      const panner = ctx.createStereoPanner();
      panner.pan.value = this.pendingBalance;
      analyser.connect(panner);
      panner.connect(ctx.destination);
      const source = ctx.createMediaElementSource(this.audio);
      // EQ chain: source → preamp → 10 peaking filters → analyser.
      const preamp = ctx.createGain();
      preamp.gain.value = this.eqEnabled ? dbToGain(this.preampDb) : 1;
      const bands = EQ_FREQS.map((freq, i) => {
        const bq = ctx.createBiquadFilter();
        bq.type = 'peaking';
        bq.frequency.value = freq;
        bq.Q.value = 1.1; // roughly one octave per band
        bq.gain.value = this.eqEnabled ? (this.eqGainsDb[i] as number) : 0;
        return bq;
      });
      source.connect(preamp);
      let node: AudioNode = preamp;
      for (const b of bands) {
        node.connect(b);
        node = b;
      }
      node.connect(analyser);
      this.preampNode = preamp;
      this.eqBands = bands;
      this.analyser = analyser;
      this.panner = panner;
      this.freqData = new Uint8Array(analyser.frequencyBinCount);
      this.waveData = new Uint8Array(analyser.fftSize);
      // Belt and braces for strict autoplay policies: if the context was born
      // suspended, retry resuming it on any later real user interaction.
      const retryResume = (): void => this.resumeContext();
      document.addEventListener('pointerdown', retryResume, { passive: true });
      document.addEventListener('keydown', retryResume);
    } catch (err) {
      this.analyser = null;
      this.panner = null;
      this.emit('error', `visualizer setup failed: ${errorMessage(err)}`);
    }
  }

  /**
   * Resume a suspended AudioContext WITHOUT awaiting it: when the browser
   * doesn't credit the current gesture, resume() can stay pending forever,
   * and it must never block audio.play().
   */
  private resumeContext(): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'suspended') return;
    ctx.resume().catch((err) => {
      this.emit('error', `audio output blocked by browser: ${errorMessage(err)}`);
    });
  }

  private async startPlayback(): Promise<void> {
    try {
      this.resumeContext();
      await this.audio.play();
    } catch (err) {
      this.setState('stopped');
      this.emit('error', `playback failed: ${errorMessage(err)}`);
    }
  }

  private describeMediaError(): string {
    const err = this.audio.error;
    const track = this.currentTrack;
    const what = track ? `"${track.artist} - ${track.title}"` : 'stream';
    if (!err) return `cannot play ${what}`;
    const reasons: Record<number, string> = {
      [MediaError.MEDIA_ERR_ABORTED]: 'playback aborted',
      [MediaError.MEDIA_ERR_NETWORK]: 'network error while streaming',
      [MediaError.MEDIA_ERR_DECODE]: 'audio decode failed',
      [MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED]: 'stream unavailable or unsupported',
    };
    const reason = reasons[err.code] ?? (err.message || 'unknown media error');
    return `cannot play ${what}: ${reason}`;
  }
}
