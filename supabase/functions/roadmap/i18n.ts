import i18next from "npm:i18next@25.7.3";
import en from "../../../src/locales/en.json" with { type: "json" };

// Server calculations use the same messages, without React or browser language detection.
const i18n = i18next.createInstance();
await i18n.init({
  lng: "en",
  resources: { en: { translation: en } },
  interpolation: { escapeValue: false },
});
export default i18n;
