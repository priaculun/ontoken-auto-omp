# omp-ontoken-auto

Native **OMP** extension yang merutekan setiap prompt ke model OnToken sesuai tingkat kesulitan. Port ini memakai API extension OMP; bukan extension Pi dan tidak mengaktifkan `/model ontoken/auto`.

## Yang dilakukan

- **Jev classification** melalui TypeSafe ketika `TYPESAFE_API_KEY` tersedia atau key ditemukan di `~/.omp/agent/secrets/typesafe_api_key`.
- **Heuristic fallback** jika classifier tidak tersedia atau gagal. Turn tetap berjalan.
- Slot model: `fast`, `work`, `solid`, `strong`, `frontier`.
- **Adaptive promotion** setelah sejumlah hasil tool pada turn yang sama; hanya boleh naik, tidak turun.
- **Failover** pada retryable provider errors; auth, billing, quota, abort, dan context overflow tidak dipindahkan secara blind.
- Redaction best-effort sebelum prompt/progress dikirim ke TypeSafe.
- State route disimpan sebagai custom session entries agar branch/resume/compaction tidak kehilangan keputusan.

OMP tetap memakai model fisik yang dipilih. Ini sengaja berbeda dari Pi `registerVirtualModel`: provider/model yang tercatat di session adalah model yang benar-benar menerima request.

## Instalasi

Instal dari repository public GitHub pada perangkat lain:

```bash
omp plugin install github:priaculun/ontoken-auto-omp
```

Atau gunakan URL Git penuh:

```bash
omp plugin install https://github.com/priaculun/ontoken-auto-omp.git
```

Restart OMP setelah instalasi. Extension akan dimuat melalui manifest `omp.extensions`.

## Instalasi lokal

Dari checkout repository ini:

```bash
# Memuat sekali tanpa mengubah konfigurasi global:
omp --extension "$PWD" --model ontoken/gpt-6.1-sol

# Mendaftarkan paket lokal untuk session berikutnya:
omp plugin link "$PWD"
```

`--extension` dan `plugin link` memuat manifest `omp.extensions`. Untuk profile bernama, direktori agent mengikuti profile OMP; extension memakai `getAgentDir()`, bukan hardcoded `~/.omp/agent`. Konfigurasi Pi tidak dibaca atau diubah.

Aktifkan saat session berjalan:

```text
/auto on
```

Status dan keputusan terakhir:

```text
/auto
/auto explain
```

Default extension **off** supaya tidak mengubah routing session yang sudah ada. `--extension` hanya memuat extension; `/auto on` mengaktifkan routing.


## Konfigurasi

Global: `~/.omp/agent/ontoken-auto.json`
Project: `<repo>/.omp/ontoken-auto.json` — project menang.
Overlay hanya perlu berisi key yang ingin diubah:

```json
{
  "enabled": true,
  "budget": "balanced",
  "slots": {
    "fast": "gpt-6-luna",
    "work": "glm-5.3-flash",
    "solid": "muse-spark-1.3",
    "strong": "claude-sonnet-5.5",
    "frontier": "claude-opus-5.5"
  },
  "adaptive": {
    "contextAware": true,
    "shortPromptChars": 800,
    "midTurn": true,
    "maxEvaluationsPerTurn": 2,
    "toolResultsPerEvaluation": 2
  },
  "failover": {
    "enabled": true,
    "chain": {
      "work": ["solid", "fast"],
      "solid": ["strong", "work"]
    }
  }
}
```

`cheap` membatasi slot router sampai `solid`; `balanced` sampai `frontier`; `quality` mempromosikan difficulty 3 ke `strong`. `/auto budget ...`, `/auto slot ...`, dan `/auto on|off` mengubah session aktif dan disimpan sebagai session entry, bukan file global. Override session menang atas file project.

Jika tidak ada model roster yang tersedia untuk budget/modalitas, extension memberi peringatan dan mempertahankan model aktif. Budget ini batas pemilihan slot, bukan spending cap atau jaminan harga. Banyak model pada catalog lokal melaporkan harga belum diketahui.

`maxThinking` dapat membatasi reasoning per slot, misalnya `{"maxThinking":{"frontier":"high"}}`. OMP tetap menerapkan minimum effort wajib dari metadata model.

## Privasi dan perilaku OMP

Saat aktif, classifier dapat mengirim prompt, konteks percakapan pendek, dan hasil tool ke TypeSafe. Redaction bukan batas keamanan. Untuk pekerjaan sensitif, set `adaptive.contextAware` dan `adaptive.midTurn` ke `false`, atau gunakan `/auto off` supaya tidak ada klasifikasi otomatis.

Router hanya mengubah **main agent**. Model subagent, advisor, dan role lain tetap mengikuti pilihan OMP. Pergantian model kehilangan cache prefix model sebelumnya. Retry/backoff tetap milik OMP; failover extension terjadi ketika event `auto_retry_start` muncul, setelah retry transport internal. Jika fallback native sudah memindahkan model, extension tidak menimpanya.

Model `fast` dipasang sebagai preferensi `compactionModel` pada model yang dirutekan, tanpa mengganti model percakapan saat compaction. OMP tetap bisa memilih fallback compaction sendiri. Extension tidak menyalin stall guard berbasis regex yang menyisipkan pesan user; stop/recovery tetap mengikuti OMP.

## Syarat

- OMP `18.9.x`.
- Provider `ontoken` dan model roster tersedia di catalog OMP.
- TypeSafe key opsional untuk routing Jev. Tanpa key, heuristic dipakai.
- Extension berjalan in-process seperti extension OMP lain; ia bukan sandbox keamanan.

## Verifikasi

```bash
bun test
```

Verifikasi pada OMP **18.9.1**:

- 9 regression tests, 33 assertions: semua lolos.
- TypeScript lolos terhadap deklarasi tipe paket OMP terpasang.
- Inference OnToken nyata: prompt sederhana → `gpt-6-luna`; prompt arsitektur sulit → `muse-spark-1.3`; keduanya menghasilkan marker jawaban yang diminta.
- Smoke HTTP lokal dengan executable OMP nyata: Jev → `work` → dua hasil tool → `frontier` → HTTP 503 → `strong` → jawaban selesai. Endpoint lokal mengontrol verdict dan error; ini bukan pengujian outage layanan OnToken nyata.
- Native RPC OMP menerima `/auto on`, `/auto budget cheap`, `/auto slot solid kimi-k3`, `/auto explain`, dan `/auto off` tanpa menjalankan inference.

Adaptasi dari [priaculun/ontoken-auto](https://github.com/priaculun/ontoken-auto). Roster mengikuti `defaults.json` sumber (`solid=muse-spark-1.3`), bukan tabel README sumber yang menyebut `kimi-k3`. Lisensi MIT sumber dipertahankan.
