'use strict';

// 50 languages supported by Bima
const LANGUAGES = [
  { code: 'id',    name: 'Indonesian',            native: 'Bahasa Indonesia' },
  { code: 'en',    name: 'English',               native: 'English' },
  { code: 'jv',    name: 'Javanese',              native: 'Basa Jawa' },
  { code: 'su',    name: 'Sundanese',             native: 'Basa Sunda' },
  { code: 'ms',    name: 'Malay',                 native: 'Bahasa Melayu' },
  { code: 'ar',    name: 'Arabic',                native: 'العربية' },
  { code: 'zh',    name: 'Chinese (Simplified)',  native: '中文(简体)' },
  { code: 'zh-TW', name: 'Chinese (Traditional)', native: '中文(繁體)' },
  { code: 'ja',    name: 'Japanese',              native: '日本語' },
  { code: 'ko',    name: 'Korean',                native: '한국어' },
  { code: 'hi',    name: 'Hindi',                 native: 'हिन्दी' },
  { code: 'bn',    name: 'Bengali',               native: 'বাংলা' },
  { code: 'ur',    name: 'Urdu',                  native: 'اردو' },
  { code: 'fa',    name: 'Persian',               native: 'فارسی' },
  { code: 'tr',    name: 'Turkish',               native: 'Türkçe' },
  { code: 'vi',    name: 'Vietnamese',            native: 'Tiếng Việt' },
  { code: 'th',    name: 'Thai',                  native: 'ภาษาไทย' },
  { code: 'fil',   name: 'Filipino',              native: 'Filipino' },
  { code: 'my',    name: 'Burmese',               native: 'မြန်မာဘာသာ' },
  { code: 'km',    name: 'Khmer',                 native: 'ភាសាខ្មែរ' },
  { code: 'fr',    name: 'French',                native: 'Français' },
  { code: 'es',    name: 'Spanish',               native: 'Español' },
  { code: 'pt',    name: 'Portuguese',            native: 'Português' },
  { code: 'de',    name: 'German',                native: 'Deutsch' },
  { code: 'it',    name: 'Italian',               native: 'Italiano' },
  { code: 'nl',    name: 'Dutch',                 native: 'Nederlands' },
  { code: 'ru',    name: 'Russian',               native: 'Русский' },
  { code: 'pl',    name: 'Polish',                native: 'Polski' },
  { code: 'uk',    name: 'Ukrainian',             native: 'Українська' },
  { code: 'ro',    name: 'Romanian',              native: 'Română' },
  { code: 'cs',    name: 'Czech',                 native: 'Čeština' },
  { code: 'hu',    name: 'Hungarian',             native: 'Magyar' },
  { code: 'sv',    name: 'Swedish',               native: 'Svenska' },
  { code: 'no',    name: 'Norwegian',             native: 'Norsk' },
  { code: 'da',    name: 'Danish',                native: 'Dansk' },
  { code: 'fi',    name: 'Finnish',               native: 'Suomi' },
  { code: 'el',    name: 'Greek',                 native: 'Ελληνικά' },
  { code: 'he',    name: 'Hebrew',                native: 'עברית' },
  { code: 'sw',    name: 'Swahili',               native: 'Kiswahili' },
  { code: 'am',    name: 'Amharic',               native: 'አማርኛ' },
  { code: 'mn',    name: 'Mongolian',             native: 'Монгол' },
  { code: 'ne',    name: 'Nepali',                native: 'नेपाली' },
  { code: 'pa',    name: 'Punjabi',               native: 'ਪੰਜਾਬੀ' },
  { code: 'ta',    name: 'Tamil',                 native: 'தமிழ்' },
  { code: 'te',    name: 'Telugu',                native: 'తెలుగు' },
  { code: 'mr',    name: 'Marathi',               native: 'मराठी' },
  { code: 'gu',    name: 'Gujarati',              native: 'ગુજરાતી' },
  { code: 'kn',    name: 'Kannada',               native: 'ಕನ್ನಡ' },
  { code: 'si',    name: 'Sinhala',               native: 'සිංහල' },
  { code: 'lo',    name: 'Lao',                   native: 'ລາວ' },
];

function getLang(code) {
  return LANGUAGES.find(l => l.code === code) || LANGUAGES[0];
}

// Returns system prompt suffix for language instruction
function langInstruction(code) {
  const lang = getLang(code);
  if (code === 'id') return ''; // default, no extra instruction needed
  return `\n\nIMPORTANT: Always respond in ${lang.name} (${lang.native}).`;
}

module.exports = { LANGUAGES, getLang, langInstruction };
