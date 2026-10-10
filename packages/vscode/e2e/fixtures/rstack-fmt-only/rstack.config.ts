// Rstack configuration guide: https://rstack.rs/config
//
// Formatting only: no `define.lint()`. rstack's lint shim exits the process
// when it finds no lint configuration; the editor-shipped lint worker must
// survive that and report a healthy runtime with nothing to lint (#93).
import { define } from 'rstack';

define.fmt({ singleQuote: true });
