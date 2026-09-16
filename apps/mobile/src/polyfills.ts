// Hermes has no Intl.Segmenter. Install grapheme support before importing the
// app: shared project contracts construct a segmenter during module loading.
import "unicode-segmenter/intl-polyfill";
