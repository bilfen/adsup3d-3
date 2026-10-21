// AD'S UP — Görselden 3D videoya
// Akış: görsel yükle -> Hunyuan3D-2 Space'lerine gönder (renkli önce, beyaz yedek) -> .glb al
//       -> Three.js ile göster -> dönerken MediaRecorder ile kaydet -> WebM indir.

const $ = (id) => document.getElementById(id);
const drop = $("drop"), preview = $("preview"), btnOlustur = $("btnOlustur");
const fileInput = $("fileInput");
const statusEl = $("status"), bar = $("bar"), barFill = $("barFill"), logEl = $("log");
const secViz = $("secViz"), vidList = $("vidList");
const canvas = $("c3d");

import { generateLocal3D, local3dProgress } from "./local3d.js";
local3dProgress((m) => log(m));

const log = (m) => { logEl.style.display = "block"; logEl.textContent += m + "\n"; logEl.scrollTop = 1e9; };
const setStatus = (t, pct) => { statusEl.textContent = t; if (pct != null) { bar.style.display = "block"; barFill.style.width = pct + "%"; } };

// ---------- 1) Görsel seçimi ----------
let file = null;
drop.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => { if (fileInput.files[0]) setFile(fileInput.files[0]); });
["dragover", "dragenter"].forEach((e) =>
  drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.add("over"); }));
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (ev) => {
  ev.preventDefault(); drop.classList.remove("over");
  if (ev.dataTransfer.files[0]) setFile(ev.dataTransfer.files[0]);
});

function setFile(f) {
  if (!f || !f.type.startsWith("image/")) return;
  file = f;
  preview.src = URL.createObjectURL(f);
  preview.style.display = "block";
  btnOlustur.disabled = false;
  setStatus("Görsel hazır: " + f.name);
  log("Görsel seçildi: " + f.name + " (" + Math.round(f.size / 1024) + " KB)");
}

// ---------- 2) Hunyuan3D-2 API ----------
// Ana space GPU kotası dolunca "event: error" döner; yedek Space'ler zincire eklendi.
const SPACES = [
  "https://tencent-hunyuan3d-2.hf.space",   // resmî
  "https://tencent-hunyuan3d-2mv.hf.space"  // resmî MV yedeği (aynı API imzası)
];

async function uploadTo(base, f) {
  const fd = new FormData();
  fd.append("files", f, f.name);
  const r = await fetch(base + "/upload", { method: "POST", body: fd });
  if (!r.ok) throw new Error("Yükleme hatası: HTTP " + r.status);
  const arr = await r.json();
  return { path: arr[0], meta: { _type: "gradio.FileData" }, orig_name: f.name };
}

// Tek bir space+endpoint denemesi: yükle → kuyruğa al → SSE ile sonucu bekle → file value döndür
async function tryEndpoint(base, fn, file, label) {
  const fileObj = await uploadTo(base, file);
  log("Yüklendi → " + base.replace("https://", "").split(".hf")[0] + " | " + fn);
  const join = await fetch(base + "/call/" + fn, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      data: [
        null,                     // caption (yok)
        fileObj,                  // image
        null, null, null, null,   // multiview görselleri (yok)
        30,                       // steps
        5.0,                      // guidance_scale
        Math.floor(Math.random() * 10000), // seed
        256,                      // octree_resolution
        true,                     // arka plan sil (rembg)
        8000,                     // num_chunks
        true                      // randomize seed
      ]
    })
  });
  const j = await join.json();
  if (!join.ok || !j.event_id) throw new Error("Kuyruk hatası: " + JSON.stringify(j).slice(0, 200));

  setStatus(label + " kuyrukta… (bekleme sürer)", 40);

  const sse = new EventSource(base + "/call/" + fn + "/" + j.event_id);
  const result = await new Promise((resolve, reject) => {
    let ticks = 0;
    const timer = setInterval(() => {
      ticks++;
      // yavaş ilerleme: 40 -> 80
      if (ticks % 5 === 0) { let w = parseFloat(barFill.style.width) || 40; w = Math.min(80, w + 3); setStatus(label + "… " + Math.round(w) + "%", w); }
    }, 4000);
    sse.addEventListener("process_generating", (e) => log("…işlem: " + String(e.data || "").slice(0, 120)));
    sse.addEventListener("complete", (e) => {
      clearInterval(timer); sse.close();
      try {
        const chunks = JSON.parse(e.data);
        const arr = Array.isArray(chunks) ? chunks : [chunks];
        // file-benzeri değerleri topla
        const files = [];
        for (const c of arr) {
          const v = c && (c.value || (c.path ? c : null));
          if (v && (v.url || v.path)) files.push(v);
        }
        if (!files.length) { reject(new Error("Sonuç bulunamadı: " + String(e.data).slice(0, 200))); return; }
        // generation_all => [white, textured, html, stats] → texturelıyı seç; shape => ilki
        const pick = fn === "generation_all"
          ? (files.find(v => String(v.path || "").includes("textured") || String(v.orig_name || "").includes("textured")) || files[files.length - 1])
          : files[0];
        resolve(pick);
      } catch (err) { reject(err); }
    });
    sse.addEventListener("error", (e) => { clearInterval(timer); sse.close(); reject(new Error("GPU kota/kapasite reddi (SSE)")); });
  });
  return result;
}

// /file=<path> ile GLB indirme adresleri; magic "glTF" doğrulaması fetchGlb'de
const glbDownloadURLs = (base, result) => {
  const cands = [];
  if (result.path) {
    cands.push(base + "/file=" + result.path);
    cands.push(base + "/gradio_api/file=" + result.path);
  }
  if (result.url) cands.push(result.url);
  return cands;
};

async function fetchGlb(base, result) {
  setStatus("3D model indiriliyor…", 85);
  for (const u of glbDownloadURLs(base, result)) {
    try {
      const blob = await (await fetch(u)).blob();
      const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
      const magic = String.fromCharCode(...head);
      if (magic === "glTF") return blob;
      log("Uyumsuz yanıt (" + magic + ") denendi: " + u.slice(-40));
    } catch (e) { log("İndirme denemesi başarısız: " + u.slice(-40)); }
  }
  return null;
}

async function tryGenerationChain(file) {
  // Zincir: yalnızca generation_all (renkli). shape_generation (beyaz) yarışa alınmıyor:
  // yerel renkli sonuçtan önce bitip beyaz modeli göstermesin diye.
  let lastErr = null;
  for (const base of SPACES) {
    const sName = base.replace("https://", "").split(".hf")[0];
    for (const fn of ["generation_all"]) {
      const textured = fn === "generation_all";
      const label = (textured ? "Renkli 3D üretiliyor" : "3D üretiliyor (yedek)") + " — " + sName;
      try {
        setStatus((textured ? "Renkli 3D deneniyor" : "Beyaz 3D deneniyor (yedek)") + "…", 25);
        log((textured ? "generation_all (renkli)" : "shape_generation (beyaz)") + " → " + sName);
        const result = await tryEndpoint(base, fn, file, label);
        const glbBlob = await fetchGlb(base, result);
        if (!glbBlob) throw new Error("Model dosyası indirilemedi");
        setStatus("Model hazır!" + (textured ? " (renkli)" : " (beyaz)"), 100);
        log("Model hazır: " + (textured ? "TEXTURELI" : "BEYAZ") + " mesh");
        return glbBlob;
      } catch (e) {
        lastErr = e;
        log("Başarısız [" + sName + " / " + fn + "]: " + e.message + " → sıradaki adıma geçiliyor");
        await new Promise(r => setTimeout(r, 800));
      }
    }
  }
  throw new Error("Hugging Face GPU kotası şu anda dolu (son hata: " + (lastErr ? lastErr.message : "?") + ")");
}

async function generate3D(file) {
  setStatus("Görsel hazırlanıyor…", 10);
  log("Yükleniyor: " + file.name);

  // 1) Yerel motoru arka planda başlat — sunucu yok, kota yok, GARANTİ sonuc budur
  const localTask = generateLocal3D(file)
    .then((glb) => ({ src: "local", glb }))
    .catch((e) => { log("Yerel motor: " + e.message); return { src: "local-err", err: e }; });

  // 2) HF AI zinciri (HD renkli): 2 tur, arada 15 sn — paralel çalışıyor
  const hfTask = (async () => {
    let lastErr = null;
    for (let a = 0; a < 2; a++) {
      try { return { src: "hf", glb: await tryGenerationChain(file) }; }
      catch (e) {
        lastErr = e;
        if (a === 0) {
          log("HF zinciri 1. tur: " + e.message + " → 15 sn sonra 2. tur (yerel motor paralel hazırlanıyor)");
          await new Promise((r) => setTimeout(r, 15_000));
        }
      }
    }
    return { src: "hf-err", err: lastErr };
  })();

  // 3) Hangi motor önce biterse onu göster
  let winner = await Promise.race([localTask, hfTask]);
  if (winner.src === "local-err") winner = await hfTask;
  else if (winner.src === "hf-err") winner = await localTask;

  if (!winner || winner.src === "hf-err" || winner.src === "local-err") {
    throw new Error("3D üretilemedi: " + ((winner && winner.err && winner.err.message) || "bilinmeyen") + " — daha sade görsel deneyin");
  }
  if (winner.src === "hf") {
    setStatus("Model hazır! (AI HD, renkli)", 100);
    log("Sonuç: Hunyuan3D AI modeli (HD kalite, renkli)");
  } else {
    setStatus("Model hazır! (yerel motor, renkli)", 100);
    log("Sonuç: tarayıcıda yerel üretim — sunucu yok, kota yok, herkes için çalışır");
  }
  return winner.glb;
}

// ---------- 3) Three.js sahne ----------
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

// Videoya gömülecek logo (sağ üst)
const logoImg = new Image();
logoImg.src = "assets/logo.png";

let renderer, scene, camera, controls, model = null, turning = false, frameId = 0, recTimer = 0;
function initScene() {
  if (scene) return;
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0f172a);
  camera = new THREE.PerspectiveCamera(45, canvas.clientWidth / canvas.clientHeight, 0.1, 100);
  camera.position.set(0, 0.4, 3.2);
  const hemi = new THREE.HemisphereLight(0xffffff, 0x333333, 1.0);
  const dir = new THREE.DirectionalLight(0xffffff, 2.4);
  dir.position.set(3, 5, 4);
  const dir2 = new THREE.DirectionalLight(0xffffff, 1.4);
  dir2.position.set(-4, 2, -3);
  scene.add(hemi, dir, dir2);
  controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 0, 0);
  controls.enableDamping = true;
}

function drawCompositeFrame() {
  if (composite.width !== canvas.width || composite.height !== canvas.height) {
    composite.width = canvas.width;
    composite.height = canvas.height;
  }
  cctx.clearRect(0, 0, composite.width, composite.height);
  cctx.drawImage(canvas, 0, 0);
  if (logoImg.complete && logoImg.naturalWidth) {
    const pad = Math.round(composite.width * 0.022);
    const lw = Math.round(composite.width * 0.16);
    const lh = Math.round(lw * (logoImg.naturalHeight / logoImg.naturalWidth));
    const chipPadX = Math.round(lh * 0.35);
    const chipPadY = Math.round(lh * 0.25);
    // Hafif yarı saydam beyaz rozet üzerinde sağ üst logo
    const cw = lw + chipPadX * 2, ch = lh + chipPadY * 2;
    const cx = composite.width - cw - pad, cy = pad;
    cctx.save();
    cctx.globalAlpha = 0.88;
    cctx.fillStyle = "#ffffff";
    cctx.beginPath();
    if (cctx.roundRect) {
      cctx.roundRect(cx, cy, cw, ch, Math.round(ch * 0.3));
    } else {
      cctx.rect(cx, cy, cw, ch);
    }
    cctx.fill();
    cctx.globalAlpha = 0.92;
    cctx.drawImage(logoImg, cx + chipPadX, cy + chipPadY, lw, lh);
    cctx.restore();
  }
}

// Süre-tabanlı 360° dönüş: kare hızından bağımsız, kayıt sonunda tam bir tur.
let spin = null; // { t0, dur } — yalnızca 360° kaydı sırasında dolu
function stepScene() {
  resize();
  if (spin && model) {
    const p = Math.min(1, (performance.now() - spin.t0) / spin.dur);
    model.rotation.y = p * Math.PI * 2;
  } else if (turning && model) {
    model.rotation.y += 0.012;
  }
  controls.update();
  renderer.render(scene, camera);
  if (recorder && recorder.state === "recording") {
    drawCompositeFrame();
  }
}

function loop() {
  frameId = requestAnimationFrame(loop);
  if (!recTimer) stepScene();
}

function resize() {
  if (!renderer) return;
  const w = canvas.clientWidth || 640, h = canvas.clientHeight || 480;
  if (canvas.width !== w * renderer.getPixelRatio() || canvas.height !== h * renderer.getPixelRatio()) {
    renderer.setSize(w, h, true);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
}
window.addEventListener("resize", resize);

function showModel(glbBlob) {
  initScene();
  resize();
  if (!frameId) loop();
  const url = URL.createObjectURL(glbBlob);
  new GLTFLoader().load(url, (gltf) => {
    resize();
    // Renk kontrolü: texture'lı mı?
    let textured = false, texInfo = "";
    gltf.scene.traverse((o) => {
      const m = o.material;
      if (m && m.map) {
        textured = true;
        if (!texInfo && m.map.image) texInfo = m.map.image.width + "x" + m.map.image.height;
      }
    });
    window.__adsup.lastModel = { textured, texInfo, size: glbBlob.size };
    log("RENK KONTROLÜ: " + (textured ? "✔ texture VAR (renkli, " + texInfo + ")" : "✖ texture YOK (beyaz/neutral mesh)"));
    if (model) scene.remove(model);
    model = gltf.scene;
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    model.position.x = -center.x; model.position.y = -center.y; model.position.z = -center.z;
    model.scale.setScalar(1.6 / maxDim);
    scene.add(model);
    turning = true;
    URL.revokeObjectURL(url);
    secViz.style.display = "block";
    secViz.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

// ---------- 4) Video kaydı ----------
let recorder = null, chunks = [];
const composite = document.createElement("canvas"); // WebGL tuvali + logo katmanı
const cctx = composite.getContext("2d");
function pickMime() {
  const cands = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4"];
  return cands.find((m) => MediaRecorder.isTypeSupported(m)) || "";
}

function startRecording() {
  // Bileşik tuvali sahne boyutuna eşle ve ilk kareyi çiz
  resize();
  composite.width = canvas.width;
  composite.height = canvas.height;
  drawCompositeFrame();
  const stream = composite.captureStream(30);
  const mime = pickMime();
  recorder = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 6_000_000 } : undefined);
  chunks = [];
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  recorder.start(250);
  if (recTimer) clearInterval(recTimer);
  recTimer = setInterval(stepScene, 33);
}

function stopRecording() {
  return new Promise((res) => {
    if (recTimer) { clearInterval(recTimer); recTimer = 0; }
    if (!recorder || recorder.state === "inactive") return res(null);
    recorder.onstop = () => {
      const mime = (recorder.mimeType || "video/webm").split(";")[0];
      const ext = mime.includes("mp4") ? "mp4" : "webm";
      const blob = new Blob(chunks, { type: mime });
      const url = URL.createObjectURL(blob);
      addVideoCard(url, ext, blob);
      res(blob);
    };
    recorder.stop();
  });
}

function addVideoCard(url, ext, blob) {
  const kb = Math.round(blob.size / 1024);
  const wrap = document.createElement("div");
  wrap.className = "vidcard";
  wrap.innerHTML = `
    <video controls src="${url}"></video>
    <div class="meta"><span>${ext.toUpperCase()} · ${kb} KB</span>
    <span style="display:inline-flex;gap:6px;flex-wrap:wrap">
      <a class="dl" href="${url}" download="adsup-3d-video.${ext}">⬇ İndir</a>
      <button class="dl" data-drive>☁ Drive'a Kaydet</button>
    </span></div>`;
  wrap.querySelector("[data-drive]").addEventListener("click", (e) => saveToDrive(blob, e.currentTarget));
  vidList.prepend(wrap);
}

// ---------- 4.5) Google Drive'a kaydet ----------
// Kullanımı: DRIVE.clientId alanına Google Cloud OAuth Web Client ID'nizi girin.
// http://console.cloud.google.com → API & Services → OAuth Client ID (Web).
// Authorized JavaScript origins:  https://bilfen.github.io  (ve yerel test için http://localhost:5500)
// Google Drive API hizmetini etkinleştirin.
// Adım 2: driveSaveTarget = "ogrenci" → öğrencinin Drive'ına; "ortak" → aşağıdaki klasöre.
// Ayar tipi isterseniz ikisini de destekliyoruz (aşağıda).
const DRIVE = {
  clientId: "",           // ← ZORUNLU: sizin OAuth Web Client ID'niz ("xxxx.apps.googleusercontent.com")
  folderId: "",           // ← İSTEĞE BAĞLI: ortak/ataca klasör ID (klasör tarifinden); boşsa "Driveım" köküne gider
  scope: "https://www.googleapis.com/auth/drive.file"
};
let driveToken = null;

function driveClientReady() {
  return typeof google !== "undefined" && google.accounts && google.accounts.oauth2;
}

function getDriveToken() {
  return new Promise((resolve, reject) => {
    if (!driveClientReady()) return reject(new Error("Google modülü yüklenemedi — internet bağlantısını kontrol edin"));
    const client = google.accounts.oauth2.initTokenClient({
      client_id: DRIVE.clientId,
      scope: DRIVE.scope,
      callback: (resp) => {
        if (resp.error) reject(new Error("Google oturumu reddedildi: " + resp.error));
        else resolve(resp.access_token);
      },
      error_callback: (err) => reject(new Error(err.message || "Google oturumu açılamadı"))
    });
    client.requestAccessToken({ prompt: "" }); // açık oturum varsa sessiz, yoksa popup açar
  });
}

async function driveUpload(token, blob, name, mime) {
  const boundary = "ADSUP" + Math.random().toString(36).slice(2);
  const meta = { name, mimeType: mime };
  if (DRIVE.folderId) meta.parents = [DRIVE.folderId];
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`,
    `--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`,
    blob,
    `\r\n--${boundary}--\r\n`
  ], { type: "multipart/related; boundary=" + boundary });
  const r = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink", {
    method: "POST",
    headers: { Authorization: "Bearer " + token },
    body
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) { driveToken = null; throw new Error("Oturum yenilenmeli (401)"); }
  if (!r.ok) throw new Error("Drive hatası: " + (j.error && j.error.message || r.status));
  return j;
}

async function saveToDrive(blob, btn) {
  const original = btn.innerHTML;
  try {
    if (!DRIVE.clientId) {
      btn.textContent = "☁ Önce ayar gerek";
      setStatus("Drive'a kaydet için öğretmenin Google Client ID ayarı gerekli (adsup3d/app.js başındaki DRIVE bölümü). Kurulum talimatı proje README'sinde.");
      await new Promise(r => setTimeout(r, 4000));
      btn.innerHTML = original;
      return;
    }
    btn.disabled = true;
    btn.textContent = "☁ Yükleniyor…";
    setStatus("Google Drive'a yükleniyor…", null);
    let token = driveToken || await getDriveToken();
    // token canlı değilse sessiz yenile
    let res;
    try { res = await driveUpload(token, blob, "adsup-3d-video.webm", blob.type || "video/webm"); }
    catch (e) {
      if (!/401|Oturum yenilenmeli/.test(e.message)) throw e;
      token = await getDriveToken();
      res = await driveUpload(token, blob, "adsup-3d-video.webm", blob.type || "video/webm");
    }
    driveToken = token;
    btn.textContent = "✔ Drive'a kaydedildi";
    setStatus("✔ Google Drive'a kaydedildi: " + res.name + " — " + (res.webViewLink || "https://drive.google.com/drive/my-drive"));
    log("Drive'a yüklendi: id=" + res.id);
  } catch (err) {
    console.error(err);
    btn.textContent = "⚠ Drive hatası";
    setStatus("Drive'a kaydetmede hata: " + err.message);
    log("Drive hatası: " + err.message);
  } finally {
    btn.disabled = false;
    if (!btn.textContent.includes("✔"))
      setTimeout(() => { btn.innerHTML = original; btn.disabled = false; }, 3500);
    else setTimeout(() => { btn.innerHTML = original; }, 3500);
  }
}

$("btnTurn").addEventListener("click", () => { turning = !turning; });
// 360° video: tam bir tur (8 sn), bitince otomatik indirilir ve listeye eklenir
const SPIN_MS = 8000;
async function record360() {
  if (!model || spin || (recorder && recorder.state === "recording")) return;
  const btn = $("btnRec5");
  btn.disabled = true;
  turning = false;
  model.rotation.y = 0;
  setStatus("🎬 360° video kaydediliyor… (" + SPIN_MS / 1000 + " sn)");
  startRecording();
  spin = { t0: performance.now(), dur: SPIN_MS };
  await new Promise((r) => setTimeout(r, SPIN_MS + 60));
  spin = null;
  const blob = await stopRecording();
  turning = true;
  if (blob) {
    const ext = blob.type.includes("mp4") ? "mp4" : "webm";
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "adsup-360-" + Date.now() + "." + ext;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setStatus("✔ 360° video indirildi (" + ext.toUpperCase() + ", " + Math.round(blob.size / 1024) + " KB)");
    log("360° video hazır ve indirildi: " + a.download);
  }
  btn.disabled = false;
}
$("btnRec5").addEventListener("click", record360);
$("btnRecManual").addEventListener("click", async () => {
  if (spin) return; // 360° kaydı sürüyorsa karuşturma
  if (!recorder || recorder.state === "inactive") { startRecording(); $("btnRecManual").textContent = "⏹ Kaydı durdur"; }
  else { await stopRecording(); $("btnRecManual").textContent = "● Kaydı başlat / durdur"; }
});

// Test / otomasyon kancası
window.__adsup = { setFile, generate3D, showModel, composite };
Object.defineProperty(window.__adsup, "lastModel", { value: null, writable: true });
Object.defineProperty(window.__adsup, "rotY", { get: () => (model ? model.rotation.y : null) });

// Set up generate button
btnOlustur.addEventListener("click", async () => {
  if (!file) return;
  btnOlustur.disabled = true;
  logEl.textContent = "";
  try {
    const glb = await generate3D(file);
    showModel(glb);
  } catch (err) {
    console.error(err);
    setStatus("Hata: " + err.message + " — Lütfen tekrar deneyin.");
    bar.style.display = "none";
  } finally {
    btnOlustur.disabled = false;
  }
});