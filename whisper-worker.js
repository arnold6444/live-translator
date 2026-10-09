// Whisper를 백그라운드에서 돌려 화면이 멈추지 않게 함. 요청은 한 번에 하나씩 순서대로 처리.
import { loadASR } from './whisper-core.js';

let engine = null;
let chain = Promise.resolve();

postMessage({ type: 'caps', gpu: !!self.navigator?.gpu });

self.onmessage = ({ data }) => {
  chain = chain
    .then(() => handle(data))
    .catch(err => postMessage({ type: 'error', id: data.id, message: String(err?.message || err) }));
};

async function handle(data) {
  if (data.type === 'load') {
    engine = await loadASR({
      model: data.model,
      onProgress: (p, total) => postMessage({ type: 'progress', p, total }),
    });
    postMessage({ type: 'ready', device: engine.device, model: engine.model });
  } else if (data.type === 'transcribe') {
    if (!engine) throw new Error('음성 모델이 준비되지 않았어요');
    const r = await engine.transcribe(data.audio, data.langs);
    postMessage({ type: 'result', id: data.id, ...r });
  }
}
