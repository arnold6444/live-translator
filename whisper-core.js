// Whisper 음성인식 — 기기 안에서 실행(무료), 말한 언어를 소리로 판별.
// 워커(whisper-worker.js)와 페이지 양쪽에서 쓸 수 있게 분리.
// transformers.min.js: 음성 엔진(onnxruntime)까지 한 파일에 묶인 빌드 (번들러 없이 바로 import 가능)
import { pipeline, env, Tensor } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1/dist/transformers.min.js';

env.allowLocalModels = false;

export async function loadASR({ model, onProgress }) {
  let gpu = false;
  let f16 = false;
  if (globalThis.navigator?.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) {
        gpu = true;
        f16 = adapter.features.has('shader-f16');
      }
    } catch {}
  }
  // GPU가 없으면 큰 모델은 너무 느림 → 작은 모델로
  if (!gpu) model = model.replace('whisper-small', 'whisper-base');
  // 측정 결과: 소리 분석(인코더)은 GPU, 글자 만들기(디코더)는 CPU가 가장 빠름 (GPU만 쓸 때보다 약 4배)
  const device = gpu ? { encoder_model: 'webgpu', decoder_model_merged: 'wasm' } : 'wasm';
  const dtype = { encoder_model: gpu ? (f16 ? 'fp16' : 'fp32') : 'q8', decoder_model_merged: 'q8' };

  const files = {};
  const asr = await pipeline('automatic-speech-recognition', model, {
    device,
    dtype,
    progress_callback: p => {
      if (p.status !== 'progress' || !p.total) return;
      files[p.file] = [p.loaded, p.total];
      let loaded = 0;
      let total = 0;
      for (const [l, t] of Object.values(files)) { loaded += l; total += t; }
      onProgress?.(loaded / total, total);
    },
  });
  const gc = asr.model.generation_config;

  // 후보 언어 중 이 소리가 어느 언어인지: Whisper 첫 토큰(언어 토큰) 점수 비교
  // (이 라이브러리는 언어를 비워 두면 판별하지 않고 영어로 처리함)
  async function detect(audio, langs) {
    const { input_features } = await asr.processor(audio);
    const start = new Tensor('int64', BigInt64Array.from([BigInt(gc.decoder_start_token_id)]), [1, 1]);
    const out = await asr.model({ input_features, decoder_input_ids: start });
    const logits = out.logits.data;
    let best = langs[0];
    let bestScore = -Infinity;
    for (const lang of langs) {
      const id = gc.lang_to_id[`<|${lang}|>`];
      if (id != null && logits[id] > bestScore) { best = lang; bestScore = logits[id]; }
    }
    for (const t of Object.values(out)) t?.dispose?.();
    return best;
  }

  await asr(new Float32Array(16000), { language: 'en', task: 'transcribe' }); // 첫 실행 준비

  return {
    device: gpu ? 'webgpu' : 'wasm',
    model,
    async transcribe(audio, langs) {
      const cands = [...new Set(langs)].filter(l => gc.lang_to_id[`<|${l}|>`] != null);
      const language = cands.length > 1 ? await detect(audio, cands) : (cands[0] || 'en');
      const out = await asr(audio, { language, task: 'transcribe' });
      return { text: (out.text || '').trim(), language };
    },
  };
}
