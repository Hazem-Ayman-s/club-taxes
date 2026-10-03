/*
 * سكربت البناء لـ Vercel (بدون أي dependencies):
 *  - يقرأ إعدادات Firebase Web من Environment Variables (أو من ملف .env.local محليًا)
 *  - ينسخ ملفات الموقع إلى مجلد dist/
 *  - يكتب dist/firebase-config.js
 *
 * تنبيه: إعدادات Firebase Web (apiKey ...) ليست أسرارًا، وستكون ظاهرة لأي زائر في المتصفح.
 * نقلها إلى Environment Variables يفيد في فصل بيئات التطوير/الإنتاج وعدم تثبيتها في Git،
 * لكنه ليس حماية. الحماية الحقيقية = Firebase Authentication + Firestore Security Rules.
 */
const fs = require("fs");
const path = require("path");

const root = __dirname;
const dist = path.join(root, "dist");

// دعم .env.local للتشغيل المحلي (على Vercel تأتي القيم من Project Settings)
const envFile = path.join(root, ".env.local");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const KEYS = {
  apiKey: "FIREBASE_API_KEY",
  authDomain: "FIREBASE_AUTH_DOMAIN",
  projectId: "FIREBASE_PROJECT_ID",
  storageBucket: "FIREBASE_STORAGE_BUCKET",
  messagingSenderId: "FIREBASE_MESSAGING_SENDER_ID",
  appId: "FIREBASE_APP_ID"
};

const config = {};
const missing = [];
for (const [prop, envName] of Object.entries(KEYS)) {
  const v = (process.env[envName] || "").trim();
  if (!v) missing.push(envName); else config[prop] = v;
}
if (missing.length) {
  console.error("Missing environment variables: " + missing.join(", "));
  process.exit(1);
}

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });
for (const f of ["index.html", "style.css", "script.js"]) fs.copyFileSync(path.join(root, f), path.join(dist, f));

fs.writeFileSync(path.join(dist, "firebase-config.js"),
`/* ملف مولَّد تلقائيًا من build.js — لا تعدله يدويًا */
/* إعدادات Firebase Web عامة بطبيعتها؛ الأمان يعتمد على Authentication + Firestore Rules */
const firebaseConfig = ${JSON.stringify(config, null, 2)};

firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
const auth = firebase.auth();
`);

console.log("Build OK -> dist/");
