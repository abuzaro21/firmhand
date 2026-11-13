# Synthesises the narration (film/narration.json) with Kokoro-82M, an open-weight TTS model (Apache-2.0) run locally on
# the CPU. The voice is synthetic, and the film says so on its end card.
# Output: film/out/audio/<id>.wav (24 kHz mono) and durations.json.
# Usage: film/.venv/Scripts/python film/tts.py   (Python 3.11 venv with: pip install torch "kokoro>=0.9.4" soundfile)
import json, pathlib
import numpy as np, soundfile as sf
from kokoro import KPipeline

here = pathlib.Path(__file__).parent
out = here / 'out' / 'audio'
out.mkdir(parents=True, exist_ok=True)
pipe = KPipeline(lang_code='a', repo_id='hexgrad/Kokoro-82M')
SAY = {'FIRMHAND': 'firm hand'}  # pronunciation only
def say(t):
    for a, b in SAY.items(): t = t.replace(a, b)
    return t
durations = {}
for seg in json.loads((here / 'narration.json').read_text(encoding='utf8')):
    audio = np.concatenate([np.asarray(a) for _, _, a in pipe(say(seg['text']), voice='af_heart', speed=1.05)])
    sf.write(out / f"{seg['id']}.wav", audio, 24000)
    durations[seg['id']] = round(len(audio) / 24000, 3)
    print(seg['id'], durations[seg['id']])
(out / 'durations.json').write_text(json.dumps(durations, indent=2))
print('total', round(sum(durations.values()), 1))
