import UIKit
import XCTest
@testable import T3TerminalNative

@MainActor
final class TerminalInputTests: XCTestCase {
  func testMagicKeyboardDeleteDoesNotCrashOrBecomeForwardDelete() {
    // UIKeyCommand.inputDelete is U+0008. A dictionary containing both that
    // constant and a literal U+0008 used to abort on the first hardware key.
    XCTAssertEqual(TerminalHardwareKeyEncoder.nativeKeycode(for: UIKeyCommand.inputDelete), 0x33)
    XCTAssertEqual(TerminalHardwareKeyEncoder.fallbackSequence(input: UIKeyCommand.inputDelete, modifiers: []), "\u{7F}")
    XCTAssertEqual(TerminalHardwareKeyEncoder.nativeKeycode(for: TerminalHardwareKeyEncoder.forwardDelete), 0x75)
    XCTAssertEqual(TerminalHardwareKeyEncoder.fallbackSequence(input: TerminalHardwareKeyEncoder.forwardDelete, modifiers: []), "\u{1B}[3~")
  }

  func testDeleteRepeatedlyEmitsExactlyOneEventWithoutEditingStorage() {
    let field = TerminalInputField()
    var count = 0
    field.onDeleteBackward = { count += 1 }
    for _ in 0..<100 { field.deleteBackward() }
    XCTAssertEqual(count, 100)
    XCTAssertTrue(field.text?.isEmpty ?? true)
  }

  func testRegisteredCommandsAreUniqueAndActionable() throws {
    let field = TerminalInputField()
    let commands = field.keyCommands ?? []
    let identities = commands.map { "\($0.input ?? ""):\($0.modifierFlags.rawValue)" }
    XCTAssertEqual(Set(identities).count, commands.count)
    XCTAssertFalse(commands.isEmpty)
    for command in commands {
      XCTAssertTrue(field.canPerformAction(try XCTUnwrap(command.action), withSender: command))
    }
  }

  func testHardwareCommandDispatchAndNativeKeycodes() {
    let field = TerminalInputField()
    var received: [String] = []
    field.onHardwareKey = { input, _ in received.append(input) }
    for command in field.keyCommands ?? [] where command.modifierFlags.isEmpty {
      field.perform(command.action, with: command)
    }
    XCTAssertTrue(received.contains(UIKeyCommand.inputDelete))
    XCTAssertTrue(received.contains(UIKeyCommand.inputUpArrow))
    XCTAssertEqual(TerminalHardwareKeyEncoder.nativeKeycode(for: UIKeyCommand.inputUpArrow), 0x7E)
    XCTAssertEqual(TerminalHardwareKeyEncoder.nativeKeycode(for: "c"), 0x08)
    XCTAssertEqual(TerminalHardwareKeyEncoder.nativeKeycode(for: "z"), 0x06)
  }

  func testEditingChordsAndReturn() {
    XCTAssertEqual(TerminalHardwareKeyEncoder.editingSequence(input: UIKeyCommand.inputDelete, modifiers: .alternate), "\u{1B}\u{7F}")
    XCTAssertEqual(TerminalHardwareKeyEncoder.editingSequence(input: UIKeyCommand.inputDelete, modifiers: .command), "\u{15}")
    XCTAssertEqual(TerminalHardwareKeyEncoder.fallbackSequence(input: "c", modifiers: .control), "\u{03}")
    XCTAssertEqual(TerminalHardwareKeyEncoder.fallbackSequence(input: "\t", modifiers: .shift), "\u{1B}[Z")
    XCTAssertEqual(TerminalInputSequence.normalizingReturn("\n"), "\r")
    XCTAssertEqual(TerminalInputSequence.normalizingReturn("\r\n"), "\r")
    XCTAssertEqual(TerminalInputSequence.normalizingReturn("hello\nworld"), "hello\nworld")
  }

  func testSystemEditActionsUseTerminalInsteadOfHiddenText() {
    let field = TerminalInputField()
    var actions: [String] = []
    field.onCopy = { actions.append("copy") }
    field.onPaste = { actions.append("paste") }
    field.onSelectAll = { actions.append("selectAll") }
    field.hasTerminalSelection = { false }
    XCTAssertFalse(field.canPerformAction(#selector(UIResponderStandardEditActions.copy(_:)), withSender: nil))
    field.hasTerminalSelection = { true }
    XCTAssertTrue(field.canPerformAction(#selector(UIResponderStandardEditActions.copy(_:)), withSender: nil))
    XCTAssertFalse(field.canPerformAction(#selector(UIResponderStandardEditActions.cut(_:)), withSender: nil))
    field.copy(nil)
    field.paste(nil)
    field.selectAll(nil)
    XCTAssertEqual(actions, ["copy", "paste", "selectAll"])
    XCTAssertTrue(field.text?.isEmpty ?? true)
  }
}
