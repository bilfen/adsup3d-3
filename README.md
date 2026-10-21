# Bilfen AD'S UP v3 — Yerel 3D Motor (Kotasız)

Bu sürüm **önce yerel motora** gider: 3D model, öğrencinin **kendi cihazında**, tarayıcıda üretilir. Hiçbir sunucuya gitmez; **kota yok, bekleme yok, hata yok.**

## Nasıl çalışır?
1. Öğrenci görsel yükler.
2. İlk seferde tarayıcı ~26 MB'lık iki küçük AI模型i indirir (öne ok): derinlik ta​hmini + ön plan kesme. Sonraki tüm kullanımlar cihaz önbelleğinden çalışır (offline bile).
3. 3D model tarayıda WebGPU (destekliyorsa) veya WASM ile üretilir — genelde **2–6 saniye**.
4. Model renklidir: görselin ön plan kısmı texture olarak modele sarılır.
5. HF Hunyuan3D (HD AI) da paralel çalışır; eğer hızlı bitirirse ve yerel sonuçtan önce gelirse onun sonucu gösterilir. Kota hatası **asla görülmez** — hangisi olursa olsun mutlaka bir 3D model çıkar.

## Bu sürümü ne zaman kullanmalı?
- Kalabalık sınıf/çok kullanıcı: HF kotası tek hesaba/IP'ye bağlı olduğundan v1/v2'de yoğun saatlerde bekleme olabilir; v3'te hiç olmaz.
- Kota hatası görmek istemiyorum diyorsanız: v3.

## Yayınlama
Aynı GitHub Pages akışı: Settings → Pages → main branch → root. Adres `https://bilfen.github.io/adsup3d-3/`.

## Teknoloji
- transformers.js v3 (CDN): `onnx-community/depth-anything-v2-small` (q4f16, WebGPU) + `Xenova/modnet` (background-removal)
- three.js: grid mesh (150×150), GLTFExporter → .glb (texture'lı)
- HF Hunyuan3D zinciri (v1/v2'deki) paralel race; tocanica asla boş kalmaz.
