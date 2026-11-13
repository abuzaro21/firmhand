// Builds the ~90 s FIRMHAND film from the REAL capture (film/capture.mjs) and the synthetic narration (film/tts.py).
// Editing is cuts and restrained crops of one continuous session. No UI is faked and no footage is sped up.
// The ending is the logo reveal (film/logo.mjs). Captions are burned into the picture, and are also muxed as a soft
// track for players that can turn them off.
// Output: film/out/firmhand-film.mp4 (1920x1080, 30 fps, H.264 + AAC) and film/firmhand-film.srt
// Usage: python film/tts.py && node film/capture.mjs && node film/build.mjs
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';

const F = (p) => new URL(p, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const OUT = F('./out/'), TMP = F('./out/build/');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const W = 1920, H = 1080, FPS = 30, LEAD = 0.3, TAIL = 0.4;
const json = (p) => JSON.parse(readFileSync(F(p), 'utf8'));
const voice = json('./out/audio/durations.json');
const text = Object.fromEntries(json('./narration.json').map((n) => [n.id, n.text]));
const marks = json('./out/raw/session.json');
const ff = (args, cwd) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'inherit', cwd });
const ENC = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-an'];

// ------------------------------------------------------------------ edit decision list
// box = [x, y, width] crop of the 1920x1080 capture (16:9), scaled back to full frame. Crops are kept restrained so
// the whole interface stays legible; they only tighten on the column the narration is about.
const shots = [
  { id: 'title', clip: marks.title, box: [0, 0, 1920], voice: 'title', noOut: true },
  { id: 'agents', clip: marks.agents, box: [0, 0, 1920], voice: 'agents', noIn: true },
  { id: 'approval', clip: marks.approval, box: [0, 0, 1920], voice: 'approval' },
  { id: 'shock', clip: marks.shock, box: [0, 0, 1920], voice: 'shock' },
  { id: 'crash', clip: marks.crash, box: [0, 0, 1920], voice: 'crash' },
  { id: 'recover', clip: marks.recover, box: [0, 0, 1920], voice: 'recover' },
  { id: 'kpi', clip: marks.kpi, box: [0, 0, 1920], voice: 'kpi' },
  { id: 'proof', clip: marks.proof, box: [0, 0, 1920], voice: 'proof' },
  { id: 'end', logo: true, voice: 'end', len: +(voice.end + LEAD + 6.0).toFixed(2) },
];
let t = 0;
const timeline = [], segs = [];
for (const s of shots) {
  const len = s.len ?? +(voice[s.voice] + LEAD + TAIL).toFixed(3);
  const out = `${TMP}${String(segs.length).padStart(2, '0')}-${s.id}.mp4`;
  const fade = [s.noIn ? '' : 'fade=t=in:st=0:d=0.25', s.noOut ? '' : `fade=t=out:st=${(len - 0.25).toFixed(2)}:d=0.25`].filter(Boolean).join(',') || 'null';
  if (s.logo) {
    execFileSync(process.execPath, [F('./logo.mjs'), String(len)], { stdio: 'inherit' });
    ff(['-framerate', String(FPS), '-i', F('./out/logo/%04d.png'), '-vf', 'fade=t=in:st=0:d=0.4', ...ENC, out]);
  } else {
    const [x, y, w] = s.box, h = Math.round((w * 9) / 16);
    ff(['-ss', s.clip.toFixed(2), '-t', String(len), '-i', F('./out/raw/session.webm'), '-vf', `fps=${FPS},crop=${w}:${h}:${x}:${y},scale=${W}:${H}:flags=lanczos,tpad=stop_mode=clone:stop_duration=2,trim=duration=${len},${fade}`, ...ENC, out]);
  }
  if (s.voice) timeline.push({ id: s.voice, at: t + LEAD });
  segs.push(out);
  t += len;
}
const total = +t.toFixed(3);
writeFileSync(`${TMP}list.txt`, segs.map((p) => `file '${p}'`).join('\n'));
ff(['-f', 'concat', '-safe', '0', '-i', `${TMP}list.txt`, '-c', 'copy', `${TMP}video.mp4`]);

// ------------------------------------------------------------------ narration track
const inputs = timeline.flatMap((v) => ['-i', F(`./out/audio/${v.id}.wav`)]);
const delays = timeline.map((v, i) => `[${i}]aresample=48000,adelay=${Math.round(v.at * 1000)}|${Math.round(v.at * 1000)}[a${i}]`).join(';');
// Original music bed, synthesised here: a soft D-major drone with slow movement, kept well under the voice.
const bed = `aevalsrc='0.5*sin(2*PI*73.42*t)*(0.7+0.3*sin(2*PI*0.06*t))+0.33*sin(2*PI*110*t)*(0.6+0.4*sin(2*PI*0.045*t+1))+0.22*sin(2*PI*146.83*t)*(0.5+0.5*sin(2*PI*0.09*t+2))':s=48000:d=${total},lowpass=f=650,volume=0.05,afade=t=in:d=2,afade=t=out:st=${(total - 3).toFixed(2)}:d=3[bed]`;
const mix = `${delays};${bed};${timeline.map((_, i) => `[a${i}]`).join('')}[bed]amix=inputs=${timeline.length + 1}:normalize=0,apad=whole_dur=${total},loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[a]`;
ff([...inputs, '-filter_complex', mix, '-map', '[a]', '-t', String(total), '-ac', '2', '-c:a', 'pcm_s16le', `${TMP}voice.wav`]);

// ------------------------------------------------------------------ captions: timed to each sentence of the narration
const ts = (s) => { const ms = Math.round(s * 1000); const p = (n, l = 2) => String(n).padStart(l, '0'); return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`; };
const cues = [];
for (const v of timeline) {
  const parts = text[v.id].match(/[^.!?]+[.!?]+/g).map((x) => x.trim());
  const chars = parts.reduce((n, p) => n + p.length, 0);
  let at = v.at;
  for (const p of parts) {
    const d = (voice[v.id] * p.length) / chars;
    const lines = p.length > 52 ? (() => { const mid = p.lastIndexOf(' ', Math.ceil(p.length / 2) + 6); return `${p.slice(0, mid)}\n${p.slice(mid + 1)}`; })() : p;
    cues.push(`${cues.length + 1}\n${ts(at)} --> ${ts(at + d - 0.05)}\n${lines}\n`);
    at += d;
  }
}
const srt = F('./firmhand-film.srt');
writeFileSync(srt, cues.join('\n'));
copyFileSync(srt, `${TMP}captions.srt`);

// Burn the captions in. libass sizes text against a 288-line canvas, so FontSize 10.5 is about 39 px at 1080p.
const style = 'FontName=Segoe UI,FontSize=10.5,PrimaryColour=&H00DFE8EC,OutlineColour=&H00000000,BackColour=&H60000000,BorderStyle=4,Outline=0,Shadow=0,MarginV=16,Bold=0';
ff(['-i', 'video.mp4', '-vf', `subtitles=captions.srt:force_style='${style}'`, ...ENC, 'burned.mp4'], TMP);

const final = `${OUT}firmhand-film.mp4`;
ff(['-i', `${TMP}burned.mp4`, '-i', `${TMP}voice.wav`, '-i', srt, '-map', '0:v', '-map', '1:a', '-map', '2:s', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
  '-c:s', 'mov_text', '-metadata:s:s:0', 'language=eng', '-metadata', 'title=FIRMHAND: a company run by accountable agents', '-movflags', '+faststart', '-t', String(total), final]);
writeFileSync(F('./out/edl.json'), JSON.stringify({ total, shots: shots.map((s) => ({ id: s.id, clip: s.clip ?? null, box: s.box ?? null })), timeline }, null, 2));
console.log(`built ${final} (${total.toFixed(1)} s)`);
