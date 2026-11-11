# thai-fts

[![CI](https://img.shields.io/github/actions/workflow/status/worakorn-prince/thai-fts/ci.yml?branch=master&label=CI)](https://github.com/worakorn-prince/thai-fts/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2022.13-brightgreen)](package.json)

**การค้นหาแบบข้อความเต็ม (full-text search) ภาษาไทยที่คำนึงถึงวรรณยุกต์ สำหรับ Node.js — ไม่มีการพึ่งพาไลบรารีอื่นตอนรันไทม์ (zero runtime dependencies)**

`thai-fts` แก้ปัญหาสองอย่างที่เสิร์ชเอนจินทั่วไปจัดการภาษาไทยได้ไม่ดี:

1. **ภาษาไทยเขียนติดกันโดยไม่มีเว้นวรรคระหว่างคำ** — ใช้ `Intl.Segmenter` (full ICU) ก่อนเป็นหลักในการตัดคำ โดยมีพจนานุกรมในตัว + การเดาแบบพยางค์เป็นทางเลือกสำรองสำหรับรันไทม์แบบ small-icu ดังนั้นเอกสารจึงถูกจัดทำดัชนีเป็นคำที่มีช่องว่างคั่น และคำค้นหาจะถูกแปลงเป็นลำดับคำแบบ phrase ที่เรียงตามลำดับ
2. **วรรณยุกต์มีความสำคัญเชิงความหมาย** — `ติดตั้ง` (install) ต่างจาก `ติดตัง` (พิมพ์วรรณยุกต์ผิด) แชนแนลแบบ strict จะคงวรรณยุกต์ไว้ให้ตรงเป๊ะ ส่วนแชนแนลแบบ loose (ทางเลือก) จะตัดเฉพาะ `่ ้ ๊ ๋ ์ ํ` แล้วช่วย "กู้คืน" ผลลัพธ์ที่ใส่วรรณยุกต์ผิด โดยจัดอันดับ**อยู่ต่ำกว่า**ผลลัพธ์แบบ strict เสมอ ไม่มีทางแซงขึ้นมา

ทุกอย่างทำงานบนบิวด์อินของ Node — `Intl.Segmenter` และ `node:sqlite` (FTS5) ไม่มีเนทีฟโมดูล ไม่มี WASM ไม่มี npm dependencies ตอนรันไทม์

```text
ตัวอย่างโค้ดและวรรณยุกต์:  ติดตั้ง ≠ ติดตัง  (strict)
                           "ติดตั้ง" loose → "ติดตัง" (ทางสำรอง)
```

## คุณสมบัติ

- ✂️ ตัดคำภาษาไทย (`Intl.Segmenter` ก่อน แล้วตามด้วยพจนานุกรม + พยางค์สำรอง)
- 🎵 นโยบายวรรณยุกต์: **strict เป็นหลัก** พร้อมแชนแนล **loose** สำรองที่เปิดได้
- 🔎 ทำดัชนี FTS5 + ค้นหาผ่าน `node:sqlite` (บิวด์อิน) พร้อม tokenizer ที่คำนึงถึงเครื่องหมายวรรณยุกต์
- 🔁 คำพ้องเสียง/ความหมายแบบทับศัพท์ ไทย↔อังกฤษ (`deploy` ↔ `ดีพลอย`)
- 📚 ช่องต่อทะเบียนพจนานุกรม (เพิ่มคำ / คำพ้อง / override ได้ตอนรันไทม์)
- 🔌 อินเทอร์เฟซเอนจินแบบ pluggable พร้อมทะเบียน (`registerEngine` / `createEngine`)
- 📦 รองรับทั้ง ESM และ CJS พร้อม type declarations ไม่มี dependencies ตอนรันไทม์ ใช้ Node ≥ 22.13.0

## ติดตั้ง

```sh
npm install thai-fts
# ต้องใช้ Node 22.13+ (node:sqlite)
```

## เริ่มต้นใช้งานอย่างรวดเร็ว

### ค้นหาข้อความเต็ม (SQLite FTS5 แบบหน่วยความจำ)

```js
import { createFts5Engine } from "thai-fts";

const engine = createFts5Engine({ memory: true });          // tone: "both"

engine.add({ id: "guide", title: "คู่มือติดตั้ง", body: "ขั้นตอนการติดตั้งโปรแกรม" });
engine.add({ id: "billing", title: "ติดตังค่าบริการ", body: "รายเดือน 49 บาท" });

engine.search("ติดตั้ง", { tone: "both" });
// [
//   { id: "guide",  rank: 1, snippet: "ขั้นตอนการติดตั้งโปรแกรม" },  // strict
//   { id: "billing", rank: 2, snippet: "ติดตังค่าบริการ" },          // loose rescue
// ]

engine.close();
```

สัญญาการทำงานของ dual-channel (ค่าเริ่มต้น `tone: "both"`):

- **strict channel** — คำนึงวรรณยุกต์ ตรงเป๊ะ: `ติดตัง` ไม่ชนกับ `ติดตั้ง` เด็ดขาด
- **loose channel** — ตัดวรรณยุกต์ (`looseForm`): คำค้นที่พิมพ์วรรณยุกต์ผิดยังเจอเอกสารที่เขียนถูกได้ แต่**จัดอันดับต่ำกว่า**ผล strict เสมอ และจะไม่ถูกนำขึ้นมาเมื่อผล strict เต็ม `limit` แล้ว

### ใช้เฉพาะส่วน core (ไม่ต้องใช้ฐานข้อมูล)

```js
import { wordTokens, segmentForIndex, looseForm, hasThai, expandSynonyms } from "thai-fts/core";

wordTokens("ติดตั้งโปรแกรม");        // ["ติดตั้ง", "โปรแกรม", …] (Intl.Segmenter)
segmentForIndex("ติดตั้ง");          // " ติด ตั้ง "  เติมช่องว่างระหว่างคำเพื่อทำดัชนี
looseForm("ติดตั้ง");                // "ติดตัง"     ตัดเครื่องหมายวรรณยุกต์ทิ้ง
hasThai("hello");                    // false
expandSynonyms("deploy");            // ["deploy", "ดีพลอย"]
```

## CLI

แพ็กเกจมาพร้อมไบนารี `thai-fts` — ผลลัพธ์แบบข้อความล้วนเหมาะกับการ pipe, `--json` ห่อผลลัพธ์เป็น `{ ok, data }`, รหัสออก `0` = สำเร็จ / `2` = ผิดพลาด

```sh
thai-fts segment "ติดตั้งโปรแกรม"            # คำที่ตัดได้ บรรทัดละหนึ่งคำ
thai-fts loose "ติดตั้ง"                    # -> ติดตัง
thai-fts synonyms deploy                   # -> ดีพลอย
thai-fts check "สวัสดี"                     # -> 1

# คำสั่ง FTS5 แชร์เอนจินเดียวต่อการเรียกใช้หนึ่งครั้ง จึงใช้ :memory: ได้แบบครบวงจร:
thai-fts index "ต้องติดตั้งโปรแกรมใหม่" --id first \
           index "ติดตังค่าบริการ" --id second \
           search "ติดตั้ง" --db :memory:
# first	1	ต้องติดตั้งโปรแกรมใหม่
# second	2	ติดตังค่าบริการ

thai-fts search "ติดตั้ง" --tone strict --db db.sqlite   # เฉพาะแชนแนล strict
thai-fts search "ติดตั้ง" --limit 5 --tone both --db db.sqlite
thai-fts --json search "ติดตั้ง" --db db.sqlite          # { ok: true, data: [...] }
```

รัน `thai-fts --help` เพื่อดูคำสั่งทั้งหมด

## สรุป API

| Subpath | เนื้อหา |
| --- | --- |
| `thai-fts` (root) | ทุกอย่างด้านล่าง บวก `createFts5Engine`, `createMemoryEngine`, `createMeilisearchEngine`, `createElasticsearchEngine` |
| `thai-fts/core` | core ภาษาไทยล้วน (ไม่ต้องใช้ DB) |
| `thai-fts/engine` | อินเทอร์เฟซเอนจินค้นหา + ทะเบียน + อะแดปเตอร์ in-memory และ HTTP แบบ reference |
| `thai-fts/fts5` | store / search / schema FTS5 บน `node:sqlite` |

### Core — `thai-fts/core`

**การตัดคำ** (`segment.ts`)

- `wordTokens(text)` → `string[]` — คำที่ตัดได้จากข้อความไทย/อังกฤษปนกัน (ตัวพิมพ์เล็กทั้งหมด)
- `segmentForIndex(text)` → `string` — เติมช่องว่างระหว่างคำในรันภาษาไทย (ทำซ้ำแล้วได้ค่าเดิม = idempotent)
- `segmentQueryChunk(chunk)` → `string[]` — คำภายในหนึ่ง chunk ที่คั่นด้วยช่องว่าง
- `hasThai(text)` → `boolean`
- `looseForm(text)` → `string` — ตัดเฉพาะเครื่องหมายระดับวรรณยุกต์ `่ ้ ๊ ๋ ์ ํ` แต่คงสระไว้ครบ
- `normalizeThaiInput(text)` → `string` — NFC + ลบ zero-width chars, idempotent (เรียกให้อัตโนมัติทุกเส้นทางตัดคำ/คำค้น)
- `setThaiSegmenter(segmenter)` — ต่อ segmenter ไทยภายนอก (เช่น wasm attacut หรือ PyThaiNLP ผ่าน RPC); ส่ง `null` เพื่อกลับสู่การจับคู่ค่าอัตโนมัติ
- `getThaiSegmenterInfo()` → `{ source: "intl" | "custom" | "dict" | "none", hasSegmenter }`

**การต่อ segmenter ภายนอก** — วัตถุใดก็ตามที่เข้ารูป `Intl.Segmenter` (มีเมธอด `.segment(text)` คืน iterable ของ `{ segment, isWordLike? }`) แทนที่ตัวตัดคำในตัวได้ ตัวอย่างรันจริง (HTTP bridge ไปบริการ PyThaiNLP ล้อคัล + สตัมพจนานุกรมแบบซิงโครนัส + การคืนค่าเดิม) อยู่ใน [`examples/segmenter-bridge.mjs`](examples/segmenter-bridge.mjs) — ไม่ถูกแพ็กใน npm แต่ใช้เป็นจุดเริ่มต้นของการต่อ attacut/PyThaiNLP ได้ทันที: `node examples/segmenter-bridge.mjs`

**คำพ้อง** (`synonyms.ts`) — คำพ้องเสียง/ความหมายแบบทับศัพท์ ไทย↔อังกฤษ

- `expandSynonyms(term)` → `string[]` — เทอมต้น + ทุกคู่เทียบเท่าที่รู้จัก
- `expandChunkSynonyms(chunk)` → `string[]` — ขยายทั้ง chunk (ฝั่งคำค้น)
- `expandIndexedText(segmented)` → `string` — เพิ่มรูปคำพ้องลงใน payload เพื่อทำดัชนี (idempotent)

**สร้างคำค้นหา** (`query.ts`) — ตัวสร้าง MATCH expression ที่ใช้กับเอนจินใดก็ได้

- `buildFtsMatch(query)` / `buildLooseFtsMatch(query)` → นิพจน์ MATCH ของ FTS5
- `buildSearchQuery(query, mode?)` → `{ mode, chunks, match, looseMatch }`
- `quoteFtsToken(token)` → token ที่ escape ให้ปลอดภัยสำหรับ FTS5

**นโยบายวรรณยุกต์** (`tone.ts`)

- `resolveToneMode(opts?)` → `"both" | "strict" | "loose"` (ค่าเริ่มต้น `both`)

**การย่อคำอังกฤษ** (`stem.ts`)

- `stemEn(word)` → `string` — อัลกอริทึม Porter stemmer คลาสสิกสำหรับคำ ASCII (คำไทยผ่านตรงไปโดยไม่เปลี่ยน; ทำซ้ำได้ค่าเดิม = idempotent) เป็น OPT-IN แบบสมมาตร: ส่ง `stem: true` ให้ store/engine เพื่อให้ทั้ง payload ในดัชนีและคำค้นถูกย่อด้วย

**พจนานุกรม** (`dictionaries.ts`) — ช่องต่อทะเบียน

- `THAI_DEFAULT_WORDS`, `THAI_DEFAULT_SYNONYMS` (ค่าเริ่มต้นสาย dev/tech ที่เปิดใช้เสมอ)
- `registerThaiDictionary({ id, words?, synonyms?, overrides? })`
- `listDictionaries()`, `clearRegisteredDictionaries()`

### Engine — `thai-fts/engine`

- `ThaiSearchEngine` — `{ add(doc), remove(id), search(query, opts?), close() }`
- `ThaiSearchDoc`, `ThaiSearchResult`, `ThaiEngineOptions`, `ThaiEngineFactory`
- `registerEngine(name, factory)`, `createEngine(name, opts?)`, `listEngines()`, `unregisterAllEngines()`
- `createMemoryEngine(opts?)` → `ThaiSearchEngine` แบบ in-memory ที่ไม่มี dependencies เลย (สำหรับเทสต์/ออฟไลน์/ข้อมูลเล็ก) ลงทะเบียนเป็น `"memory"`
- `createMeilisearchEngine({ endpoint, index, apiKey?, ... })`, `createElasticsearchEngine({ endpoint, index, apiKey?, ... })` → อะแดปเตอร์ HTTP แบบ reference ขั้นต่ำ (`add`/`remove`/`search` เป็น async — ดู `HttpSearchEngine`) ลงทะเบียนเป็น `"meilisearch"` / `"elasticsearch"`
- `HttpSearchEngine` — คอนแทรกต์เอนจินแบบ async ที่อะแดปเตอร์ HTTP อิมพลีเมนต์ (`close()` ยังเป็น sync)

### FTS5 — `thai-fts/fts5`

- `createFts5Engine({ path?, memory?, tone?, limit?, prefix?, stopwords? })` → `ThaiSearchEngine`
- `openFts5Store({ path?, memory?, prefix?, stopwords?, dictionaries? })` → `{ db, add, remove, update, rebuild, close, get, allRows }`
- `fts5Search(store, query, opts?)` → `ThaiSearchResult[]` (dual-channel พร้อม hook `filter` และ `prefix`/`offsets`/`titleWeight`)
- `FTS5_STRICT_SCHEMA`, `FTS5_LOOSE_SCHEMA` — DDL ที่คำนึงเครื่องหมาย (`unicode61 categories 'L* N* Co M*'`)

#### ฟีเจอร์ค้นหาแบบเลือกเปิด (ปิดทั้งหมดตามค่าเริ่มต้น)

**Prefix / พิมพ์ค้นหาอัตโนมัติ** — เปิด store พร้อมดัชนี prefix แล้วค้นด้วย `prefix: true` (token สุดท้ายของแต่ละ phrase ได้ `*` ต่อท้ายแบบ FTS5):

```js
const store = openFts5Store({ memory: true, prefix: [2, 3] });
fts5Search(store, "ติดตั้งโ", { prefix: true }); // คำที่พิมพ์แค่บางส่วนก็เจอ
```

**Offsets** — ใช้ `offsets: true` เพิ่ม `quote` / `start` / `end` ที่ตรวจสอบแล้วต่อ hit ในพิกัดเอกสารต้นฉบับ (`raw.slice(start, end) === quote`; ไม่เดา):

```js
const [hit] = fts5Search(store, "ติดตั้ง", { offsets: true });
// hit.quote === "ติดตั้ง", hit.start/hit.end เป็น index ของข้อความต้นฉบับ
```

**ถ่วงน้ำหนัก title** — `titleWeight: N` จัดอันดับด้วย `titleRank * N + bodyRank` ทำให้ผลลัพธ์ที่อยู่ title ชนะผลลัพธ์ที่อยู่ body ได้:

```js
fts5Search(store, "ติดตั้ง", { titleWeight: 2 });
```

**Stopwords** — เลือกเปิด (OPT-IN) และสมมาตร: `stopwords: true` (หรือส่ง `string[]` ของตัวเอง) จะตัดคำฟังก์ชันทั้งฝั่งดัชนีและฝั่งคำค้นพร้อมกัน การสลับตัวเลือกนี้เปลี่ยน payload ในดัชนี ดังนั้นฐานข้อมูลแบบไฟล์ที่มีอยู่ต้อง rebuild (`rebuild()` หรือเปิดไฟล์ใหม่):

```js
const engine = createFts5Engine({ memory: true, stopwords: true });
engine.add({ id: "x", body: "การติดตั้งโปรแกรม" });
engine.search("การติดตั้ง"); // เจอ — "การ" ถูกตัดทั้งสองฝั่ง
```

**multi-occurrence offsets** — เมื่อใช้ `offsets: true` แต่ละ hit จะได้ `occurrences: [{ quote, start, end }]` ที่ตรวจสอบแล้วสูงสุด 3 รายการ (ตามลำดับในเอกสาร แต่ละรายการ `raw.slice(start, end) === quote`) รายการแรกเท่ากับ `quote`/`start`/`end` หลัก เหมาะสำหรับการอ้างอิงงานวิชาการ/กฎหมาย:

```js
const [hit] = fts5Search(store, "ติดตั้ง", { offsets: true });
// เอกสารมี "ติดตั้ง" 3 ครั้ง → hit.occurrences.length === 3
```

**การย่อคำอังกฤษ (stemming)** — OPT-IN แบบสมมาตร: `stem: true` รัน `stemEn` (Porter คลาสสิก เฉพาะ ASCII — คำไทยไม่ถูกแตะ) ทั้งฝั่ง payload ในดัชนีและฝั่งคำค้น ทำให้ `running` ตรงกับ `run` การสลับตัวเลือกนี้เปลี่ยน payload ในดัชนี → ฐานข้อมูลไฟล์ที่มีอยู่ต้อง rebuild (หรือเพิ่มเอกสารใหม่สำหรับ memory/HTTP engine) ปิดตามค่าเริ่มต้น:

```js
const engine = createFts5Engine({ memory: true, stem: true });
engine.add({ id: "x", body: "we are running the tests" });
engine.search("run"); // เจอ — ทั้งสองฝั่งถูกย่อเป็น "run"
```

## นโยบายวรรณยุกต์

วรรณยุกต์ไทยมีความหมายในเชิงความหมาย (`ติดตั้ง` ≠ `ติดตัง` ที่พิมพ์ผิด) พฤติกรรมเริ่มต้นคือ **strict เป็นหลัก, loose ช่วยเสริม**:

1. **strict** — ดัชนีที่คงวรรณยุกต์ไว้ ตรงเป๊ะและเชื่อถือได้
2. **loose** (ต่อเมื่อผล strict ยังไม่เต็ม `limit`) — `looseForm` ของ payload เดียวกันกับที่ทำดัชนี ตัด id ซ้ำ และจัดอันดับตามหลังผล strict ทั้งหมด

`tone: "strict"` ให้การจับคู่แบบตรงทุกอย่าง `tone: "loose"` ให้การจับคู่แบบตัดวรรณยุกต์เท่านั้น `tone: "both"` (ค่าเริ่มต้น) คือการรวมสองชั้นด้านบน คำค้นภาษาไทยสั้น (1–2 ตัวอักษร) จะใช้การสแกนแบบ LIKE แทน FTS phrase และรายงาน `meta.method: "like_fallback"`

หมายเหตุ: การสแกน LIKE สำหรับคำค้นสั้น (1–2 ตัวอักษร) อ่านจากเอกสารต้นฉบับ (ไม่ใช่ช่องแบบตัดวรรณยุกต์) ดังนั้นคำค้น 1–2 ตัวอักษรที่พิมพ์วรรณยุกต์ผิดจะไม่ถูกกู้คืนในเส้นทางนี้ การกู้คืนวรรณยุกต์ที่ผิดผ่านช่องแบบ loose ใช้ได้กับคำค้นที่ยาวกว่า (3 ตัวอักษรขึ้นไป)

## พจนานุกรม

การลงทะเบียนเป็นการเพิ่มทับบนค่าเริ่มต้นสาย dev/tech ที่มีในตัว (`ติดตั้ง`, `เซิร์ฟเวอร์`, `ฐานข้อมูล`, `deploy` ↔ `ดีพลอย`, …):

```js
import { registerThaiDictionary } from "thai-fts";

registerThaiDictionary({
  id: "my-app",
  words: ["ตากลม"],                                  // บังคับให้เป็นคำเดียว
  synonyms: [["display", "จอภาพ"]],                  // ใช้ได้ทั้งสองทิศทาง
  overrides: [{ term: "โปรเจกต์", fixed: "โปรเจกต์" }],
});
```

**โมดูลอินสแตนซ์กับซับพาธ:** แต่ละซับพาธที่บิลด์ (`thai-fts`, `thai-fts/core`, …) เป็นโมดูลอินสแตนซ์แยกกัน ทะเบียนพจนานุกรมจึงเป็นแบบ per-instance กรณีใช้เอนจิน ให้ส่งพจนานุกรมผ่าน `createFts5Engine({ dictionaries: [...] })` (หรือ `openFts5Store`) — ครบในตัวเอง ไม่ต้องพึ่ง global state (แนะนำ) กรณีใช้ core โดยตรง ต้อง import `registerThaiDictionary` พร้อมกับทุกฟังก์ชันที่ใช้มัน (การตัดคำ/คำพ้อง) จาก entry/ซับพาธ **เดียวกัน** (มาจาก `"thai-fts"` ทั้งหมด หรือ `"thai-fts/core"` ทั้งหมด) เพื่อให้แชร์โมดูลอินสแตนซ์เดียวกัน

**รายการคำ seed ต่อโดเมน** — มี 3 การส่งออกพร้อมใช้ครอบคลุมคำศัพท์ที่คัดเลือกแล้ว:

- `THAI_DEFAULT_WORDS` — ชุดรวมค่าเริ่มต้น (dev/tech + ทั่วไป + ชุดย่อยกฎหมาย/วรรณกรรม, ~1.4k คำ) เปิดใช้อยู่ข้างใต้เสมอ
- `THAI_LEGAL_WORDS` — ชุดศัพท์สายกฎหมาย (ขั้นตอน, บุคคล, เอกสาร, การบังคับคดี)
- `THAI_LITERARY_WORDS` — ชุดศัพท์สายวรรณกรรม (ประเภทวรรณกรรม, ฉันทลักษณ์, อุปลักษณ์)

แอปสายกฎหมาย/วรรณกรรมโหลดเฉพาะโดเมนทับบนค่าเริ่มต้นได้ทันที:

```js
import { registerThaiDictionary, THAI_LEGAL_WORDS } from "thai-fts";
registerThaiDictionary({ id: "legal", words: THAI_LEGAL_WORDS });
```

**โหลดรายการคำจากไฟล์ (word list ต่อโดเมน)** — `loadThaiWordsFromText` แยกคำจากข้อความอิสระ (คั่นด้วยบรรทัดใหม่/เว้นวรรค), ตัดช่องว่างและตัดรายการซ้ำ ให้ใช้ไฟล์คำธรรมดาต่อโดเมน (กฎหมาย, วรรณกรรม, …) ได้ทันที:

```js
import { loadThaiWordsFromText, registerThaiDictionary } from "thai-fts";
import { readFile } from "node:fs/promises";

const words = loadThaiWordsFromText(await readFile("legal-words.txt", "utf8"));
registerThaiDictionary({ id: "legal-app", words });
```

ใช้ `words` เมื่อต้องการให้คำนั้นถูกบังคับให้เป็น **หนึ่งโทเคน** (กรณีทั่วไปสำหรับคำประสม/ชื่อเฉพาะ) และใช้ `overrides` เฉพาะเมื่อต้อง **รีแมป** คำที่ถูกตัดแล้วไปเป็นโทเคนตายตัวอื่น (`{ term, fixed }`) ส่วน `THAI_DEFAULT_WORDS` (1,368 คำ รวม seed กฎหมาย/วรรณกรรม) และ `THAI_DEFAULT_SYNONYMS` (38 คู่) ทำงานอยู่ข้างใต้เสมอ

## แผนงานอะแดปเตอร์

`ThaiSearchEngine` คือคอนแทรกต์แบบ pluggable ขั้นต่ำ และทะเบียนคือช่องต่อสำหรับแบ็กเอนด์ สิ่งที่มีอยู่ในปัจจุบัน:

- **`fts5`** และ **`memory`** — เอนจิน LOCAL ที่ทดสอบครบทั้งชุด: FTS5 reference adapter บน `node:sqlite` และ `ThaiSearchEngine` แบบ in-memory ที่ไม่มี dependencies เลย (สำหรับเทสต์/ออฟไลน์/ข้อมูลเล็ก) API แบบ synchronous รองรับ offsets ที่ตรวจสอบได้ และฟีเจอร์ opt-in ครบชุด
- **`meilisearch`** และ **`elasticsearch`** — อะแดปเตอร์ HTTP แบบ reference ขั้นต่ำ: ใช้ fetch ของ Node (≥ 18, ไม่ต้องใช้ SDK) `add`/`remove`/`search` เป็น **async** (`HttpSearchEngine`; `close()` ยังเป็น sync) ใช้แค่ header `apiKey` แบบ static (Meilisearch `Authorization: Bearer <key>`, Elasticsearch `Authorization: Basic base64(apiKey)`) ช่อง strict+loose สองช่องถูกเก็บไว้ฝั่งเซิร์ฟเวอร์ (เอกสารสองชิ้น / field token สอง field) และมารวม strict-then-loose ฝั่งไคลเอนต์ **offsets ไม่รองรับ** (ไม่มี `quote`/`start`/`end` ที่ตรวจสอบแล้ว) และ hit ไม่มี snippet ควรใช้ในฐานะจุดเริ่มต้นที่ "ทำงานกับเซิร์ฟเวอร์จริงได้" ไม่ใช่การอินทิเกรตที่ปรับแต่งแล้ว

```js
import { createMeilisearchEngine, createElasticsearchEngine } from "thai-fts";

const meili = createMeilisearchEngine({ endpoint: "http://localhost:7700", index: "docs", apiKey: "key" });
await meili.add({ id: 1, title: "คู่มือ", body: "ติดตั้งโปรแกรม" });
await meili.search("ติดตั้ง"); // ThaiSearchResult[] (async)
meili.close();

const es = createElasticsearchEngine({ endpoint: "http://localhost:9200", index: "docs" });
// พื้นผิวเดียวกัน: add / remove / search (async) / close
```

ยังเหลือในแผน: **Vector / hybrid** — ใส่ embeddings เพิ่มเป็นชั้นให้คะแนน โดยยังใช้อินเทอร์เฟซเดิม

## ไม่มี dependencies ตอนรันไทม์

- การตัดคำ: `Intl.Segmenter` (ในตัวของ Node full-icu) + พจนานุกรม/พยางค์สำรอง
- FTS: `node:sqlite` `DatabaseSync` + virtual table FTS5 (ในตัวของ Node ≥ 22.5)
- เทสต์: `node:test`; บิลด์: `tsup` (เฉพาะตอนพัฒนา)

## การพัฒนา

```sh
npm install
npm run build      # tsup -> dist/ (ESM + CJS + d.ts) สำหรับ 4 subpaths
npm test           # build + node --test (docs + CLI + core + FTS5)
npm run pack:check # npm pack --dry-run (จัดส่งเฉพาะ dist + docs + READMEs)
npx tsc --noEmit   # ตรวจชนิด
```

## Benchmarks (เบนช์มาร์ก)

```sh
npm run benchmark        # ครบชุด — การตัดคำ, ทำดัชนี, ความหน่วงของการค้นหา (~40 s)
npm run benchmark:quick  # แบบรวดเร็ว — รูปแบบผลลัพธ์เหมือนเดิม แต่ใช้ชุดข้อมูลและจำนวนรอบน้อยกว่า (~3 s)
```

ผลลัพทธิ์ที่วัดได้จะเขียนลงโฟลเดอร์ `benchmark/results/` ตัวเลขขึ้นอยู่กับเครื่องที่รัน (CPU, storage, OS) จึงควรอ่านเป็นค่าเปรียบเทียบรอบต่อรอบบนเครื่องเดียวกัน ไม่ใช่ตัวเลขการันตีสำหรับทุกเครื่อง

ตัวอย่างตัวเลขจากเครื่องเดียว (Node 26, เครื่อง dev หนึ่งเครื่อง, seeded corpus — เป็นตัวอย่าง ไม่ใช่ค่าเฉลี่ยหลายเครื่อง): full mode ตัดคำชุดข้อมูล 2.41 MiB แล้วทำดัชนีเอกสาร 3,000 ฉบับ (~840 bytes/ฉบับ) พร้อมสุ่มค้นหา 250 ครั้ง ส่วน quick mode ย่อเหลือ 0.39 MiB / 500 เอกสาร

| รายการ (full mode) | ค่าที่วัดได้ | หมายเหตุ |
| --- | --- | --- |
| การตัดคำ (`Intl.Segmenter`) | ≈ 4.26 MiB/s (235 ms) | ขอบเขตคำตาม full ICU |
| การตัดคำ (พจนานุกรม + พยางค์สำรอง) | ≈ 3.03 MiB/s (329.8 ms) | บนชุดข้อมูลนี้ **ช้ากว่า** เล็กน้อย |
| ทำดัชนี แบบ bulk `rebuild()` | ≈ 210 docs/s | ติดเพดานการแทรกของ SQLite FTS5 |
| ทำดัชนี แบบต่อเอกสาร `add()` | ≈ 309 docs/s | คอขวดเดียวกัน บวก overhead ต่อคำสั่ง |
| ค้นหา `strict` | p50 3.39 / p95 7.53 ms | |
| ค้นหา `loose` | p50 3.07 / p95 6.76 ms | |
| ค้นหา `prefix` | p50 3.35 / p95 7.47 ms | |
| ค้นหา `like_fallback` | p50 1.36 / p95 2.06 ms | ถูกที่สุด |

quick mode ให้ตัวเลขเทียบกัน: ตัดคำ 4.29 เทียบกับ 3.41 MiB/s, ทำดัชนี 1112 (`rebuild`) / 787 (`add`) docs/s, และ p50/p95 ของการค้นหา 1.72/4.19 (strict), 2.18/3.32 (loose), 1.99/4.41 (prefix), 1.45/2.30 ms (`like_fallback`)

ข้อควรระวังสองข้อที่ควรบอกตรง ๆ:

- **การทำดัชนีไม่ได้ติดคอขวดเรื่องการตัดคำไทย** — มันถูกจำกัดด้วยการแทรกเข้า SQLite FTS5 ดังนั้น throughput จึงแปรตามขนาดเอกสาร docs/s จะ *ลดลง* เมื่อเอกสารใหญ่ขึ้น ตัวเลขที่สูงกว่าใน quick mode เกิดจากเอกสารเล็กและน้อยกว่า ไม่ใช่เพราะ tokenizer เร็วขึ้น
- **throughput การตัดคำไม่ใช่ตารางแข่งขัน** — เราวัดได้ ~4.3 MiB/s บนเครื่องนี้ ส่วน Charabia เผยแพร่ ~22 MiB/s ไว้เป็นจุดอ้างอิงภายนอก ซึ่งเป็นคนละชุดข้อมูลและคนละเครื่อง — ตัวเลขทั้งหมดนี้ครอบคลุมเฉพาะ throughput กับ latency เท่านั้น `thai-fts` ไม่ได้กล่าวอ้างความเหนือกว่าด้านการจัดอันดับผลลัพธ์ (ranking) เมื่อเทียบกับ segmenter หรือ search stack ไทยอื่น

## ลิขสิทธิ์

MIT — ดู [LICENSE](LICENSE)
