/* إعداد Firebase (نسخة compat تعمل كسكربت عادي بدون سيرفر محلي) */
const firebaseConfig = {
  apiKey: "AIzaSyAQluKYTC09w64i2Ba7IG31ErQ2Ygw7EPE",
  authDomain: "club-taxes.firebaseapp.com",
  projectId: "club-taxes",
  storageBucket: "club-taxes.firebasestorage.app",
  messagingSenderId: "216427354473",
  appId: "1:216427354473:web:6078d069aa354c7fbd45f8"
};

firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
