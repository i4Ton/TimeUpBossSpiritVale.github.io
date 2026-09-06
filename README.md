# TimeUpBoss

เว็บจับเวลา Kill Boss เกม SpiritVale — ระบบห้องปาร์ตี้ sync realtime ผ่าน Firebase Firestore

## Flow

1. **สร้างห้อง** → ตั้งชื่อห้อง + ชื่อตัวละคร → ได้รหัส 6 ตัว + ลิงก์ `?room=XXXXXX`
2. **แชร์ลิงก์/รหัส** ให้เพื่อน → เพื่อนเปิดลิงก์ ใส่ชื่อตัวละคร → เข้าห้องเดียวกัน
3. ในห้อง: เลือก CH (1–3) + บอส → โหมดเวลา **ตามเครื่องคอม** หรือ **ใส่เวลาเอง**
4. ตารางแสดง ตายเมื่อไหร่ / เกิดอีกครั้ง / นับถอยหลังสด / สถานะ / ใครบันทึก — ทุกคนในห้องเห็นตรงกันทันที

บอสเริ่มต้น: Echo Master 8 คลาส (Berserker, Necromancer, Gunslinger, Paladin, Priest, Shinobi, Weaver, Wizard) respawn 60 นาที — แก้ได้ในห้อง (ทั้งห้องเห็นตรงกัน)

## ไฟล์

- `index.html` — หน้าเว็บ
- `styles.css` — ธีม
- `app.js` — logic + Firebase (config ฝังอยู่ในไฟล์นี้)
- `firestore.rules` — security rules ที่ต้องวางใน Firebase Console

## ตั้งค่า Firebase (ทำครั้งเดียว)

1. Firebase Console → โปรเจกต์ `timeupboss-spv` → **Firestore Database** → Create database → location `asia-southeast1`
2. **Authentication** → Get started → tab Sign-in method → **Anonymous** → Enable → Save
3. Firestore → tab **Rules** → วางเนื้อหาจาก `firestore.rules` → **Publish**
4. deploy บนโดเมนอื่น (GitHub Pages ฯลฯ): Authentication → Settings → **Authorized domains** → Add domain → `<user>.github.io`

config อยู่ใน `app.js` แล้ว ไม่ต้องแก้

rules บังคับ `request.auth != null` — แอป sign in แบบ anonymous อัตโนมัติ ผู้ใช้ไม่ต้องกรอกอะไร
คนนอกที่ไม่รู้รหัสห้อง (6 ตัว จาก 30 อักขระ ≈ 729M ชุด) เข้าไม่ถูก

## ล้างข้อมูลอัตโนมัติทุก 1 วัน

`app.js` มี `sweepOldRooms()` — ทุกครั้งที่มีคนเปิดหน้า lobby จะสแกน collection `rooms`
ห้องไหน `lastActivity` เงียบเกิน `ROOM_TTL_MS` (24 ชม.) → ลบทั้งห้อง + `records` + `members`
`lastActivity` อัปเดตตอนสร้างห้อง / บันทึกบอส / ทุก ~5 นาทีระหว่างเปิดห้องอยู่

ปรับเวลา: แก้ `ROOM_TTL_MS` ใน `app.js`

### ล้าง DB ทั้งหมดตอนนี้ (ทำเอง)

Firestore Console → ชี้ที่ collection `rooms` → เมนู ⋮ → **Delete collection**
หรือกดปุ่ม "ล้างทั้งหมด" ในแต่ละห้อง

### ทางเลือก: Firestore TTL policy (native)

Firestore → **TTL** → Create policy → collection `rooms`, field `expireAt`
ต้องเพิ่ม field `expireAt` (Timestamp) ตอนสร้างห้องเอง — TTL ลบเฉพาะ doc ห้อง ไม่ลบ subcollection
`sweepOldRooms()` ครอบคลุมกว่า แนะนำใช้อันนั้น

## รันเทส

module + CDN import ต้องเปิดผ่าน http (ไม่ใช่ดับเบิลคลิก `file://`):

```
npx serve .
```

แล้วเปิด http://localhost:3000

## Deploy ขึ้น GitHub Pages

```
git init && git add . && git commit -m "TimeUpBoss"
git branch -M main
git remote add origin https://github.com/<user>/<repo>.git
git push -u origin main
```

GitHub → repo → Settings → Pages → Source: `main` / root → Save
ได้ URL `https://<user>.github.io/<repo>/`

> ⚠️ `apiKey` ใน `app.js` เป็น public key ของ Firebase Web (เปิดเผยได้ตามปกติ) ความปลอดภัยคุมด้วย Firestore Rules — rules ปัจจุบันเปิดให้ใครก็ได้ที่รู้รหัสห้อง read/write ได้ พอสำหรับใช้กันในกลุ่ม ไม่เหมาะเก็บข้อมูลสำคัญ
