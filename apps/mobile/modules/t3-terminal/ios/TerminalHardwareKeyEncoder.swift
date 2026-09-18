import GhosttyKit
import UIKit

/// Bridges hardware-keyboard combos that UITextField never surfaces through its
/// text-editing delegate (control combos, Escape, Tab, arrows, Home/End, paging)
/// into terminal input.
///
/// Capture uses UIKeyCommand with `wantsPriorityOverSystemBehavior` rather than
/// `pressesBegan`: while a text field is first responder, iPadOS routes hardware key
/// events through the text-input system, which can consume presses before they reach
/// responder press callbacks. Registered key commands are matched deterministically
/// before that happens.
///
/// Encoding itself belongs to Ghostty, which knows the modes the running program
/// set — cursor keys change meaning under DECCKM. `fallbackSequence` only covers
/// the window before a surface exists.
enum TerminalHardwareKeyEncoder {
  /// Characters that produce a control byte when combined with Ctrl.
  private static let controlInputs = "abcdefghijklmnopqrstuvwxyz@[\\]^_-? "

  // UIKit's Delete command is backward delete (including the Magic Keyboard).
  static let backspace = UIKeyCommand.inputDelete
  static let forwardDelete = "\u{7F}"

  /// Line editing chords, matching what the web client sends. Terminals encode
  /// these as modified cursor keys, which stock zsh and readline do not bind, so
  /// the readline control codes are what actually move the cursor.
  private static let wordBackward = "\u{1B}b"
  private static let wordForward = "\u{1B}f"
  private static let lineStart = "\u{01}"
  private static let lineEnd = "\u{05}"
  private static let deleteWordBackward = "\u{1B}\u{7F}"
  private static let deleteToLineStart = "\u{15}"

  private static let modifiedInputs: [String] = [
    UIKeyCommand.inputUpArrow,
    UIKeyCommand.inputDownArrow,
    UIKeyCommand.inputLeftArrow,
    UIKeyCommand.inputRightArrow,
    backspace,
  ]

  static func makeKeyCommands(action: Selector) -> [UIKeyCommand] {
    var commands: [UIKeyCommand] = []

    let bareInputs = [
      UIKeyCommand.inputEscape,
      UIKeyCommand.inputUpArrow,
      UIKeyCommand.inputDownArrow,
      UIKeyCommand.inputLeftArrow,
      UIKeyCommand.inputRightArrow,
      UIKeyCommand.inputHome,
      UIKeyCommand.inputEnd,
      UIKeyCommand.inputPageUp,
      UIKeyCommand.inputPageDown,
      backspace,
      forwardDelete,
      "\t",
    ]
    for input in bareInputs {
      commands.append(makeCommand(input: input, modifierFlags: [], action: action))
    }
    commands.append(makeCommand(input: "\t", modifierFlags: .shift, action: action))

    // Register modified editing chords before UIKit consumes them.
    let modifiers: [UIKeyModifierFlags] = [.shift, .control, .alternate, .command]
    for input in modifiedInputs {
      for modifier in modifiers {
        commands.append(makeCommand(input: input, modifierFlags: modifier, action: action))
      }
    }

    for character in controlInputs {
      commands.append(makeCommand(input: String(character), modifierFlags: .control, action: action))
      commands.append(
        makeCommand(input: String(character), modifierFlags: [.control, .shift], action: action)
      )
    }

    commands.append(makeCommand(input: "c", modifierFlags: .command, action: action))
    commands.append(makeCommand(input: "v", modifierFlags: .command, action: action))

    return commands
  }

  private static func makeCommand(
    input: String,
    modifierFlags: UIKeyModifierFlags,
    action: Selector
  ) -> UIKeyCommand {
    let command = UIKeyCommand(input: input, modifierFlags: modifierFlags, action: action)
    command.wantsPriorityOverSystemBehavior = true
    return command
  }

  static func isCopy(input: String, modifiers: UIKeyModifierFlags) -> Bool {
    input == "c" && modifiers.contains(.command) && !modifiers.contains(.control)
  }

  static func isPaste(input: String, modifiers: UIKeyModifierFlags) -> Bool {
    input == "v" && modifiers.contains(.command) && !modifiers.contains(.control)
  }

  static func editingSequence(input: String, modifiers: UIKeyModifierFlags) -> String? {
    guard !modifiers.contains(.control), !modifiers.contains(.shift) else { return nil }
    let byWord = modifiers.contains(.alternate) && !modifiers.contains(.command)
    let byLine = modifiers.contains(.command) && !modifiers.contains(.alternate)
    guard byWord || byLine else { return nil }

    switch input {
    case UIKeyCommand.inputLeftArrow:
      return byWord ? wordBackward : lineStart
    case UIKeyCommand.inputRightArrow:
      return byWord ? wordForward : lineEnd
    case backspace:
      return byWord ? deleteWordBackward : deleteToLineStart
    default:
      return nil
    }
  }

  /// The embedded iOS ABI uses Apple's virtual keycodes, NOT ghostty_input_key_e.
  /// Keep this translation at the adapter boundary (upstream input/keycodes.zig).
  private static let nativeKeycodes: [String: UInt32] = [
    UIKeyCommand.inputEscape: 0x35,
    UIKeyCommand.inputUpArrow: 0x7E,
    UIKeyCommand.inputDownArrow: 0x7D,
    UIKeyCommand.inputLeftArrow: 0x7B,
    UIKeyCommand.inputRightArrow: 0x7C,
    UIKeyCommand.inputHome: 0x73,
    UIKeyCommand.inputEnd: 0x77,
    UIKeyCommand.inputPageUp: 0x74,
    UIKeyCommand.inputPageDown: 0x79,
    backspace: 0x33,
    forwardDelete: 0x75,
    "\t": 0x30,
  ]

  private static let letterKeycodes: [UInt32] = [
    0x00, 0x0B, 0x08, 0x02, 0x0E, 0x03, 0x05, 0x04, 0x22,
    0x26, 0x28, 0x25, 0x2E, 0x2D, 0x1F, 0x23, 0x0C, 0x0F,
    0x01, 0x11, 0x20, 0x09, 0x0D, 0x07, 0x10, 0x06,
  ]

  static func nativeKeycode(for input: String) -> UInt32? {
    if let keycode = nativeKeycodes[input] { return keycode }
    guard input.unicodeScalars.count == 1,
          let scalar = input.lowercased().unicodeScalars.first,
          scalar >= "a", scalar <= "z" else { return nil }
    return letterKeycodes[Int(scalar.value - 97)]
  }

  static func ghosttyMods(_ modifiers: UIKeyModifierFlags) -> ghostty_input_mods_e {
    var raw = GHOSTTY_MODS_NONE.rawValue
    if modifiers.contains(.shift) { raw |= GHOSTTY_MODS_SHIFT.rawValue }
    if modifiers.contains(.control) { raw |= GHOSTTY_MODS_CTRL.rawValue }
    if modifiers.contains(.alternate) { raw |= GHOSTTY_MODS_ALT.rawValue }
    if modifiers.contains(.command) { raw |= GHOSTTY_MODS_SUPER.rawValue }
    if modifiers.contains(.alphaShift) { raw |= GHOSTTY_MODS_CAPS.rawValue }
    return ghostty_input_mods_e(raw)
  }

  static func unshiftedCodepoint(for input: String) -> UInt32 {
    guard input.unicodeScalars.count == 1,
          let scalar = input.lowercased().unicodeScalars.first
    else { return 0 }
    return scalar.value
  }

  /// Used only when no Ghostty surface exists yet, so mode-dependent keys fall
  /// back to their default-mode encoding.
  private static let fallbackSequences: [String: String] = [
    UIKeyCommand.inputEscape: "\u{1B}",
    UIKeyCommand.inputUpArrow: "\u{1B}[A",
    UIKeyCommand.inputDownArrow: "\u{1B}[B",
    UIKeyCommand.inputRightArrow: "\u{1B}[C",
    UIKeyCommand.inputLeftArrow: "\u{1B}[D",
    UIKeyCommand.inputHome: "\u{1B}[H",
    UIKeyCommand.inputEnd: "\u{1B}[F",
    UIKeyCommand.inputPageUp: "\u{1B}[5~",
    UIKeyCommand.inputPageDown: "\u{1B}[6~",
    forwardDelete: "\u{1B}[3~",
    backspace: "\u{7F}",
  ]

  static func fallbackSequence(input: String, modifiers: UIKeyModifierFlags) -> String? {
    if input == "\t" {
      return modifiers.contains(.shift) ? "\u{1B}[Z" : "\t"
    }
    if let sequence = fallbackSequences[input] {
      return sequence
    }

    guard modifiers.contains(.control),
          let scalar = input.lowercased().unicodeScalars.first
    else { return nil }
    return controlSequence(for: scalar)
  }

  private static func controlSequence(for scalar: Unicode.Scalar) -> String? {
    switch scalar {
    case "a"..."z":
      // Ctrl+A..Z -> 0x01..0x1A (Ctrl+C = ETX, Ctrl+Z = SUB, ...).
      return UnicodeScalar(scalar.value - 96).map(String.init)
    case " ", "@":
      return "\u{00}"
    case "[":
      return "\u{1B}"
    case "\\":
      return "\u{1C}"
    case "]":
      return "\u{1D}"
    case "^":
      return "\u{1E}"
    case "_", "-":
      return "\u{1F}"
    case "?":
      return "\u{7F}"
    default:
      return nil
    }
  }
}
