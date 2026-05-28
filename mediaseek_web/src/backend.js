import fs from "fs";
import path from "path";
import os from "os";
import { File2Beats } from "beat_this/inference";

let file2beats = null;

async function getFile2Beats() {
  if (!file2beats) {
    const device = await getDevice();
    file2beats = new File2Beats({
      checkpoint_path: "final0",
      device: device,
      dbn: false
    });
  }
  return file2beats;
}

async function getDevice() {
  try {
    const { deviceType } = await import("torch");
    if (deviceType === "cuda") {
      return "cuda";
    }
  } catch {
  }
  return "cpu";
}

export async function analyzeBeats(audioPath) {
  const analyzer = await getFile2Beats();

  const result = await analyzer(audioPath);

  const beats = Array.from(result.beats || []);
  const downbeats = Array.from(result.downbeats || []);

  const bpm = calculateBPM(beats);
  const duration = await getAudioDuration(audioPath);

  const beatsData = beats.map((time, index) => ({
    time: parseFloat(time.toFixed(3)),
    index: index + 1,
    type: "beat"
  }));

  const downbeatsData = downbeats.map((time, index) => ({
    time: parseFloat(time.toFixed(3)),
    index: index + 1,
    type: "downbeat"
  }));

  const allBeats = [...beatsData].sort((a, b) => a.time - b.time);

  return {
    beats: beatsData,
    downbeats: downbeatsData,
    allBeats: allBeats,
    bpm: bpm,
    duration: duration,
    beatCount: beats.length,
    downbeatCount: downbeats.length,
    firstBeat: beats.length > 0 ? parseFloat(beats[0].toFixed(3)) : null,
    firstDownbeat: downbeats.length > 0 ? parseFloat(downbeats[0].toFixed(3)) : null,
    timeline: generateTimeline(beats, downbeats)
  };
}

function calculateBPM(beats) {
  if (beats.length < 2) return null;

  const intervals = [];
  for (let i = 1; i < Math.min(beats.length, 20); i++) {
    intervals.push(beats[i] - beats[i - 1]);
  }

  const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
  const bpm = 60.0 / avgInterval;

  if (bpm < 40 || bpm > 300) return null;

  return Math.round(bpm * 10) / 10;
}

async function getAudioDuration(audioPath) {
  try {
    const { getAudioDuration } = await import("beat_this/preprocessing");
    const duration = await getAudioDuration(audioPath);
    return duration;
  } catch {
    return 0;
  }
}

function generateTimeline(beats, downbeats) {
  const timeline = [];
  const downbeatSet = new Set(downbeats.map(t => parseFloat(t.toFixed(3))));

  for (const beat of beats) {
    const time = parseFloat(beat.toFixed(3));
    timeline.push({
      time: time,
      type: downbeatSet.has(time) ? "downbeat" : "beat"
    });
  }

  return timeline;
}

export async function saveBeatsFile(beats, downbeats, outputPath) {
  const lines = [];

  for (const beat of beats) {
    lines.push(`${beat.toFixed(3)}\t0`);
  }

  for (const downbeat of downbeats) {
    lines.push(`${downbeat.toFixed(3)}\t1`);
  }

  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(outputPath, lines.join("\n"));
}