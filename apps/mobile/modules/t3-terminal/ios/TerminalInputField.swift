import UIKit

enum TerminalInputSequence {
  /// Terminal Enter is carriage return. Sending line feed instead is Ctrl+J,
  /// which raw-mode TUIs may interpret as the literal J key.
  static let carriageReturn = "\r"

  static func normalizingReturn(_ input: String) -> String {
    switch input {
    case "\n", "\r\n":
      return carriageReturn
    default:
      return input
    }
  }
}

final class TerminalInputField: UITextField {
  var onDeleteBackward: (() -> Void)?
  var onCopy: (() -> Void)?
  var onPaste: (() -> Void)?
  var onSelectAll: (() -> Void)?
  var hasTerminalSelection: (() -> Bool)?
  var onHardwareKey: ((String, UIKeyModifierFlags) -> Void)?

  private static let hardwareKeyCommands = TerminalHardwareKeyEncoder.makeKeyCommands(
    action: #selector(handleHardwareKeyCommand(_:))
  )

  override var keyCommands: [UIKeyCommand]? {
    Self.hardwareKeyCommands
  }

  override func deleteBackward() {
    onDeleteBackward?()
    // The PTY owns the editable text; there is no local document to delete from.
  }

  override func copy(_ sender: Any?) { onCopy?() }
  override func paste(_ sender: Any?) { onPaste?() }
  override func selectAll(_ sender: Any?) { onSelectAll?() }

  override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
    switch action {
    case #selector(handleHardwareKeyCommand(_:)): return true
    case #selector(copy(_:)): return hasTerminalSelection?() == true
    case #selector(paste(_:)): return UIPasteboard.general.hasStrings
    case #selector(selectAll(_:)): return true
    default: return false
    }
  }

  @objc
  private func handleHardwareKeyCommand(_ command: UIKeyCommand) {
    guard let input = command.input else { return }
    onHardwareKey?(input, command.modifierFlags)
  }
}
