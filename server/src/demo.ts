/**
 * Demo mode: a small catalog of procedurally generated WAV tracks, rendered
 * in memory at startup. Lets the whole app run end-to-end with zero
 * credentials and zero network access.
 */
import type { PlaylistSummary, Track } from '@shared';

const SAMPLE_RATE = 44100;
const BEATS_PER_BAR = 4;

type Wave = 'sine' | 'soft' | 'triangle' | 'pulse';

interface SongSpec {
  bpm: number;
  bars: number;
  /** One chord per bar, cycled. Note names like 'C4', 'F#3', 'Bb2'. */
  chords: string[][];
  /** Lead/arp waveform. */
  wave: Wave;
  stereo: boolean;
  /** 2 = eighth-note arpeggio, 4 = sixteenths. */
  arpStepsPerBeat: number;
}

interface SongDef {
  id: string;
  title: string;
  artist: string;
  album: string | null;
  spec: SongSpec;
}

const SONGS: SongDef[] = [
  {
    id: 'demo-1',
    title: 'Sunrise in C',
    artist: 'The Demo Daemons',
    album: 'Placeholder Paradise',
    spec: {
      bpm: 112,
      bars: 12,
      wave: 'soft',
      stereo: true,
      arpStepsPerBeat: 2,
      chords: [
        ['C4', 'E4', 'G4'],
        ['A3', 'C4', 'E4'],
        ['F3', 'A3', 'C4'],
        ['G3', 'B3', 'D4'],
      ],
    },
  },
  {
    id: 'demo-2',
    title: 'Cassette Sky',
    artist: 'Winona & The Amps',
    album: 'Rewind Forever',
    spec: {
      bpm: 92,
      bars: 10,
      wave: 'triangle',
      stereo: true,
      arpStepsPerBeat: 2,
      chords: [
        ['A3', 'C4', 'E4'],
        ['F3', 'A3', 'C4'],
        ['C4', 'E4', 'G4'],
        ['G3', 'B3', 'D4'],
      ],
    },
  },
  {
    id: 'demo-3',
    title: 'Dial-Up Dreams',
    artist: 'Modem Choir',
    album: 'Handshake Hymns',
    spec: {
      bpm: 76,
      bars: 8,
      wave: 'sine',
      stereo: false,
      arpStepsPerBeat: 2,
      chords: [
        ['D3', 'F3', 'A3', 'C4'],
        ['Bb2', 'D3', 'F3', 'A3'],
        ['F3', 'A3', 'C4', 'E4'],
        ['C3', 'E3', 'G3', 'Bb3'],
      ],
    },
  },
  {
    id: 'demo-4',
    title: 'Pixel Rain',
    artist: '8-Bit Bakery',
    album: 'Chiptune Snacks',
    spec: {
      bpm: 132,
      bars: 14,
      wave: 'pulse',
      stereo: true,
      arpStepsPerBeat: 4,
      chords: [
        ['E4', 'G4', 'B4'],
        ['C4', 'E4', 'G4'],
        ['G4', 'B4', 'D5'],
        ['D4', 'F#4', 'A4'],
      ],
    },
  },
  {
    id: 'demo-5',
    title: 'Midnight Vector',
    artist: 'Vector Foxes',
    album: null,
    spec: {
      bpm: 100,
      bars: 11,
      wave: 'soft',
      stereo: true,
      arpStepsPerBeat: 2,
      chords: [
        ['D4', 'F4', 'A4'],
        ['Bb3', 'D4', 'F4'],
        ['G3', 'Bb3', 'D4'],
        ['A3', 'C#4', 'E4'],
      ],
    },
  },
  {
    id: 'demo-6',
    title: 'Coffee & Sine Waves',
    artist: 'Oscillator Café',
    album: 'Late Night Frequencies',
    spec: {
      bpm: 84,
      bars: 9,
      wave: 'sine',
      stereo: false,
      arpStepsPerBeat: 2,
      chords: [
        ['G3', 'B3', 'D4'],
        ['E3', 'G3', 'B3'],
        ['C4', 'E4', 'G4'],
        ['D4', 'F#4', 'A4'],
      ],
    },
  },
];

// ---------------------------------------------------------------------------
// Synthesis
// ---------------------------------------------------------------------------

const NOTE_INDEX: Record<string, number> = {
  C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4,
  F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11,
};

function noteToFreq(name: string): number {
  const m = /^([A-G][#b]?)(-?\d)$/.exec(name);
  if (!m) throw new Error(`Bad note name: ${name}`);
  const semitone = NOTE_INDEX[m[1] as string];
  if (semitone === undefined) throw new Error(`Bad note name: ${name}`);
  const midi = (Number(m[2]) + 1) * 12 + semitone;
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function osc(wave: Wave, phase: number): number {
  switch (wave) {
    case 'sine':
      return Math.sin(phase);
    case 'soft':
      // Sine with gentle 2nd/3rd harmonics — warm electric-piano-ish tone.
      return (Math.sin(phase) + 0.35 * Math.sin(2 * phase) + 0.15 * Math.sin(3 * phase)) / 1.5;
    case 'triangle':
      return (2 / Math.PI) * Math.asin(Math.sin(phase));
    case 'pulse':
      // Soft-clipped sine — chiptune flavour without harsh aliasing.
      return Math.tanh(2.5 * Math.sin(phase));
  }
}

interface NoteEvent {
  startSec: number;
  durSec: number;
  freq: number;
  amp: number;
  wave: Wave;
  /** -1 (left) .. 1 (right). Ignored for mono renders. */
  pan: number;
  /** true: organ-like hold with fade edges; false: plucky decay. */
  sustained: boolean;
}

/** Up-down arpeggio index: 0 1 2 3 2 1 0 1 2 ... */
function arpIndex(step: number, len: number): number {
  if (len <= 1) return 0;
  const period = len * 2 - 2;
  const k = step % period;
  return k < len ? k : period - k;
}

function buildEvents(spec: SongSpec): NoteEvent[] {
  const events: NoteEvent[] = [];
  const beatSec = 60 / spec.bpm;
  const barSec = BEATS_PER_BAR * beatSec;
  const stepSec = beatSec / spec.arpStepsPerBeat;
  const stepsPerBar = BEATS_PER_BAR * spec.arpStepsPerBeat;

  for (let bar = 0; bar < spec.bars; bar++) {
    const chord = spec.chords[bar % spec.chords.length] as string[];
    const chordFreqs = chord.map(noteToFreq);
    const rootFreq = chordFreqs[0] as number;
    const barStart = bar * barSec;

    // Arpeggio: chord tones plus the octave of the root, up-down pattern.
    const arpFreqs = [...chordFreqs, rootFreq * 2];
    for (let step = 0; step < stepsPerBar; step++) {
      events.push({
        startSec: barStart + step * stepSec,
        durSec: stepSec * 0.92,
        freq: arpFreqs[arpIndex(step, arpFreqs.length)] as number,
        amp: 0.2,
        wave: spec.wave,
        pan: spec.stereo ? (step % 2 === 0 ? -0.35 : 0.35) : 0,
        sustained: false,
      });
    }

    // Bass: root an octave down on beats 1 and 3.
    for (const beat of [0, 2]) {
      events.push({
        startSec: barStart + beat * beatSec,
        durSec: beatSec * 1.7,
        freq: rootFreq / 2,
        amp: 0.3,
        wave: 'sine',
        pan: 0,
        sustained: false,
      });
    }

    // Pad: quiet sustained chord for warmth.
    chordFreqs.forEach((freq, i) => {
      const spread = (i - (chordFreqs.length - 1) / 2) * 0.4;
      events.push({
        startSec: barStart,
        durSec: barSec * 0.98,
        freq,
        amp: 0.05,
        wave: 'sine',
        pan: spec.stereo ? Math.max(-0.6, Math.min(0.6, spread)) : 0,
        sustained: true,
      });
    });
  }
  return events;
}

function renderChannels(spec: SongSpec): Float32Array[] {
  const beatSec = 60 / spec.bpm;
  const totalSec = spec.bars * BEATS_PER_BAR * beatSec + 0.3; // small tail
  const frames = Math.floor(totalSec * SAMPLE_RATE);
  const channels: Float32Array[] = spec.stereo
    ? [new Float32Array(frames), new Float32Array(frames)]
    : [new Float32Array(frames)];

  for (const e of buildEvents(spec)) {
    const start = Math.floor(e.startSec * SAMPLE_RATE);
    const dur = Math.max(1, Math.floor(e.durSec * SAMPLE_RATE));
    const attack = Math.max(1, Math.floor(Math.min(0.012, e.durSec / 4) * SAMPLE_RATE));
    const release = Math.max(1, Math.floor(0.08 * SAMPLE_RATE));
    const omega = (2 * Math.PI * e.freq) / SAMPLE_RATE;
    // Equal-power pan.
    const p = (e.pan + 1) / 2;
    const gainL = spec.stereo ? Math.cos((p * Math.PI) / 2) : 1;
    const gainR = Math.sin((p * Math.PI) / 2);

    for (let i = 0; i < dur && start + i < frames; i++) {
      const env = e.sustained
        ? Math.min(1, i / attack, (dur - i) / release)
        : Math.min(1, i / attack) * Math.pow(1 - i / dur, 1.35);
      const v = osc(e.wave, omega * i) * env * e.amp;
      (channels[0] as Float32Array)[start + i] += v * gainL;
      if (spec.stereo) (channels[1] as Float32Array)[start + i] += v * gainR;
    }
  }

  // Master fade in/out to avoid clicks, then normalize to a safe peak.
  const fadeIn = Math.floor(0.03 * SAMPLE_RATE);
  const fadeOut = Math.floor(0.4 * SAMPLE_RATE);
  let peak = 0;
  for (const ch of channels) {
    for (let i = 0; i < frames; i++) {
      if (i < fadeIn) ch[i] = (ch[i] as number) * (i / fadeIn);
      if (i > frames - fadeOut) ch[i] = (ch[i] as number) * ((frames - i) / fadeOut);
      const a = Math.abs(ch[i] as number);
      if (a > peak) peak = a;
    }
  }
  if (peak > 0) {
    const scale = 0.88 / peak;
    for (const ch of channels) {
      for (let i = 0; i < frames; i++) ch[i] = (ch[i] as number) * scale;
    }
  }
  return channels;
}

function encodeWav(channels: Float32Array[]): Buffer {
  const numCh = channels.length;
  const frames = (channels[0] as Float32Array).length;
  const dataSize = frames * numCh * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(numCh, 22);
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(SAMPLE_RATE * numCh * 2, 28); // byte rate
  buf.writeUInt16LE(numCh * 2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);
  let o = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numCh; c++) {
      const s = Math.max(-1, Math.min(1, (channels[c] as Float32Array)[i] as number));
      buf.writeInt16LE(Math.round(s * 32767), o);
      o += 2;
    }
  }
  return buf;
}

// ---------------------------------------------------------------------------
// Catalog (rendered once at startup)
// ---------------------------------------------------------------------------

export interface DemoEntry {
  track: Track;
  wav: Buffer;
}

const startedAt = Date.now();
const entries: DemoEntry[] = SONGS.map((song) => {
  const channels = renderChannels(song.spec);
  const wav = encodeWav(channels);
  const frames = (channels[0] as Float32Array).length;
  const track: Track = {
    id: song.id,
    title: song.title,
    artist: song.artist,
    album: song.album,
    durationMs: Math.round((frames / SAMPLE_RATE) * 1000),
    bitrateKbps: Math.round((SAMPLE_RATE * 16 * channels.length) / 1000),
  };
  return { track, wav };
});
const byId = new Map(entries.map((e) => [e.track.id, e]));
const totalBytes = entries.reduce((sum, e) => sum + e.wav.length, 0);
console.log(
  `[demo] generated ${entries.length} tracks in ${Date.now() - startedAt}ms ` +
    `(${(totalBytes / 1024 / 1024).toFixed(1)} MB in memory)`,
);

export const demoTracks: Track[] = entries.map((e) => e.track);

export function getDemoEntry(id: string): DemoEntry | undefined {
  return byId.get(id);
}

/** Empty query returns the full catalog (used to pre-fill the playlist). */
export function searchDemoTracks(q: string): Track[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return demoTracks;
  return demoTracks.filter(
    (t) => t.title.toLowerCase().includes(needle) || t.artist.toLowerCase().includes(needle),
  );
}

// ---------------------------------------------------------------------------
// Demo playlists (built from the catalog so /api/playlists works with no token)
// ---------------------------------------------------------------------------

/** The "Chill Selection" subset — the slower, mellower demo tracks. */
const CHILL_IDS = ['demo-3', 'demo-5', 'demo-6'];

/** The playlists offered in demo mode. */
export function demoPlaylists(): PlaylistSummary[] {
  return [
    { id: 'demo-all', title: 'All Demo Tracks', trackCount: demoTracks.length },
    { id: 'demo-chill', title: 'Chill Selection', trackCount: CHILL_IDS.length },
  ];
}

/** Tracks for a demo playlist id, or null if the id is unknown. */
export function demoPlaylistTracks(id: string): Track[] | null {
  if (id === 'demo-all') return demoTracks;
  if (id === 'demo-chill') return demoTracks.filter((t) => CHILL_IDS.includes(t.id));
  return null;
}

/**
 * A simulated "Моя волна" batch drawn from the demo catalog, so the wave
 * feature is usable without credentials. Returns a shuffled run of tracks
 * that never starts with `afterId` (the track that just played), mimicking an
 * endless, always-fresh AI stream.
 */
export function simulatedWave(afterId?: string): Track[] {
  const base = demoTracks.filter((t) => t.id !== afterId);
  const out: Track[] = [];
  const TARGET = 22; // deep queue, like the real wave — repeats the small catalog
  while (out.length < TARGET && base.length > 0) {
    const round = base.slice();
    for (let i = round.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [round[i], round[j]] = [round[j] as Track, round[i] as Track];
    }
    for (const t of round) {
      if (out.length > 0 && out[out.length - 1]?.id === t.id) continue; // no back-to-back repeat
      out.push(t);
      if (out.length >= TARGET) break;
    }
  }
  return out;
}
