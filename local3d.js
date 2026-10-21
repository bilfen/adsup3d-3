// local3d.js — Yerel 3D motor (sunucu yok, kota yok, anahtar yok)
// Akış: transformers.js (WebGPU varsa /yoksa WASM) ile
//   1) depth-anything-v2-small → derinlik haritası
//   2) Xenova/modnet → ön plan maskesi (arka plan kesilir)
//   3) three.js ile maskeli, renkli (texture = görselin kendisi) rölyef mesh
//   4) GLTFExporter ile .glb blob üretir → app.js aynı akışta gösterir/indirir.
// İlk kullanımda model dosyaları indirilir (~26 MB) ve tarayıcı önbelleğine alınır.

import * as THREE from "three";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";

const TJS = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1";

let tjs = null,
  depthPipe = null,
  cutPipe = null;

export function local3dProgress(cb) {
  _progressLog = cb || null;
}
let _progressLog = null;

async function loadTJS() {
  if (tjs) return tjs;
  tjs = await import(/* @vite-ignore */ TJS);
  return tjs;
}

function notify(msg) {
  if (_progressLog) _progressLog(msg);
}

async function getDepthPipe() {
  if (depthPipe) return depthPipe;
  const { pipeline } = await loadTJS();
  const MODEL = "onnx-community/depth-anything-v2-small";
  const opts = {
    progress_callback: (p) => {
      if (p && p.status === "progress") notify(`Yerel motor: ${Math.round(p.loaded / 1e6)}/${p.total ? Math.round(p.total / 1e6) + " MB" : "?"} — ${p.file || ""}`);
    }
  };
  if (navigator.gpu) {
    for (const dtype of ["q4f16", "fp16"]) {
      try {
        depthPipe = await pipeline("depth-estimation", MODEL, { ...opts, device: "webgpu", dtype });
        notify("Yerel motor: WebGPU hazır (" + dtype + ")");
        return depthPipe;
      } catch (e) { /* sıradaki dtype */ }
    }
    notify("WebGPU kullanılamadı — WASM'a geçiliyor (biraz yavaş)");
  }
  for (const dtype of ["q8", "fp32"]) {
    try {
      depthPipe = await pipeline("depth-estimation", MODEL, { ...opts, device: "wasm", dtype });
      notify("Yerel motor: WASM hazır (" + dtype + ")");
      return depthPipe;
    } catch (e) { /* sıradaki dtype */ }
  }
  throw new Error("Yerel derinlik modeli yüklenemedi");
}

async function getCutPipe() {
  if (cutPipe) return cutPipe;
  const { pipeline } = await loadTJS();
  const opts = {
    progress_callback: (p) => {
      if (p && p.status === "progress") notify(`Yerel motor: kesme modeli ${Math.round(p.loaded / 1e6)}/${p.total ? Math.round(p.total / 1e6) + " MB" : "?"}`);
    }
  };
  if (navigator.gpu) {
    try {
      cutPipe = await pipeline("background-removal", "Xenova/modnet", { ...opts, device: "webgpu", dtype: "fp16" });
      return cutPipe;
    } catch (e) { /* wasm'a düş */ }
  }
  cutPipe = await pipeline("background-removal", "Xenova/modnet", { ...opts, device: "wasm", dtype: "q8" });
  return cutPipe;
}

// Ana giriş: File/Blob → renkli .glb Blob
export async function generateLocal3D(file) {
  notify("Yerel 3D motor başlatılıyor (tarayızda, sunucu yok)…");
  const { RawImage } = await loadTJS();
  const img = await RawImage.fromBlob(file);

  const [depthPipeP, cutPipeP] = [getDepthPipe(), getCutPipe()];
  const cutOut = await (await cutPipeP)(img);
  const cutRaw = Array.isArray(cutOut) ? cutOut[0] : cutOut;   // RGBA RawImage (ön plan)
  if (!cutRaw || !cutRaw.width) throw new Error("Ön plan kesme başarısız");
  const cut = cutRaw;
  const depthRes = await (await depthPipeP)(img); // { predicted_depth, depth: RawImage(1ch) }
  let depthImg = depthRes.depth;

  // Derinliği kesme görüntüsünün boyutuna hizala
  const W = cut.width, H = cut.height;
  if (depthImg.width !== W || depthImg.height !== H) depthImg = depthImg.resize(W, H);

  const maskData = cut.data;     // RGBA
  const dData = depthImg.data;   // 1 kanal

  // Ön plan yoğunluğu: alpha>~45 piksel, arka plan alpha ~0
  // Maske yumuşatma: basit 1-adım box blur alpha kanalına
  const softA = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4 + 3;
      let a = maskData[i];
      if (x > 0) a += maskData[i - 4];
      if (x < W - 1) a += maskData[i + 4];
      if (y > 0) a += maskData[i - 4 * W];
      if (y < H - 1) a += maskData[i + 4 * W];
      softA[y * W + x] = a / 5;
    }
  }

  // Konu bbox
  let x0 = W, y0 = H, x1 = 0, y1 = 0;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (softA[y * W + x] > 90) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
  if (x1 <= x0 || y1 <= y0) throw new Error("Ön plan bulunamadı — görselde ana nesne belirgin mi?");
  // kenar payı
  const padX = Math.max(4, Math.round((x1 - x0) * 0.03));
  const padY = Math.max(4, Math.round((y1 - y0) * 0.03));
  x0 = Math.max(0, x0 - padX); y0 = Math.max(0, y0 - padY);
  x1 = Math.min(W - 1, x1 + padX); y1 = Math.min(H - 1, y1 + padY);

  // Konu derinlik aralığı (dışarıyı yok say)
  let dMin = 1e9, dMax = -1e9;
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++)
      if (softA[y * W + x] > 150) {
        const d = dData[y * W + x];
        if (d < dMin) dMin = d;
        if (d > dMax) dMax = d;
      }
  if (!(dMax > dMin)) { dMin = 0; dMax = 255; }

  // Grid mesh
  const N = 150; // 150×150 grid → hızlı ve yeterli
  const bw = x1 - x0, bh = y1 - y0;
  const relH = 0.55; // wçz rölyef yüksekliği (birim: genişlik=1)
  const pos = [], uv = [], idx = [], alphaCols = new Float32Array((N + 1) * (N + 1));

  const sample = (data, channels, px, py) => {
    const cx = Math.max(0, Math.min(W - 1, px)), cy = Math.max(0, Math.min(H - 1, py));
    const i = (cy * W + cx) * channels;
    return data[i];
  };

  let vi = 0;
  for (let j = 0; j <= N; j++) {
    for (let i2 = 0; i2 <= N; i2++) {
      const fx = x0 + (i2 / N) * bw;
      const fy = y0 + (j / N) * bh;
      const cx = Math.round(fx), cy = Math.round(fy);
      // 3×3 alpha ortalaması (hücre düzleştirme)
      let a = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const ok = cy + dy >= 0 && cy + dy < H && cx + dx >= 0 && cx + dx < W;
          if (ok) { a += softA[(cy + dy) * W + (cx + dx)]; n++; }
        }
      a /= n; alphaCols[j * (N + 1) + i2] = a;

      const dRaw = sample(dData, 1, cx, cy);
      // depth-anything: daha büyük değer = daha yakın → rölyef şişkinliği için t kullan
      const t = Math.max(0, Math.min(1, (dRaw - dMin) / (dMax - dMin)));
      pos.push(
        (fx / W - (x0 + x1) / (2 * W)) * 1.0,          // x: konu merkezli, genişlik 1
        -(fy / H - (y0 + y1) / (2 * H)) * (bh / bw),   // y: en-boy oranına göre
        t * relH                                        // z: derinlik rölyefi
      );
      uv.push(fx / W, 1 - fy / H);
      vi++;
    }
  }

  // Yüzler: 4 köşesi de ön plan olan hücreler
  for (let j = 0; j < N; j++) {
    for (let i2 = 0; i2 < N; i2++) {
      const a1 = alphaCols[j * (N + 1) + i2], a2 = alphaCols[j * (N + 1) + i2 + 1],
        a3 = alphaCols[(j + 1) * (N + 1) + i2], a4 = alphaCols[(j + 1) * (N + 1) + i2 + 1];
      if (a1 > 120 && a2 > 120 && a3 > 120 && a4 > 120) {
        const tl = j * (N + 1) + i2, tr = tl + 1, bl = (j + 1) * (N + 1) + i2, br = bl + 1;
        idx.push(tl, bl, tr, tr, bl, br);
      }
    }
  }
  if (!idx.length) throw new Error("Mesh yüzü oluşamadı — daha sade arka planlı görsel deneyin");

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();

  // Texture: RGBA kesme görüntüsü
  const texCanvas = cut.toCanvas();
  const tex = new THREE.CanvasTexture(texCanvas);
  tex.colorSpace = THREE.SRGBColorSpace;

  const mat = new THREE.MeshStandardMaterial({
    map: tex,
    transparent: true,
    alphaTest: 0.4,
    side: THREE.DoubleSide,
    roughness: 0.85,
    metalness: 0.0,
    emissive: 0xffffff,
    emissiveIntensity: 0.18,
    emissiveMap: tex
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "local_relief";

  const group = new THREE.Group();
  group.add(mesh);

  // GLB blob
  const glb = await new Promise((resolve, reject) => {
    new GLTFExporter().parse(
      group,
      (r) => resolve(new Blob([r], { type: "model/gltf-binary" })),
      (e) => reject(e),
      { binary: true }
    );
  });
  notify("Yerel 3D model hazır (renkli, texture'lı)");
  return glb;
}

export default { generateLocal3D, local3dProgress };
