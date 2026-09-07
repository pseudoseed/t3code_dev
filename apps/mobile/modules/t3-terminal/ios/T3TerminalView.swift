import ExpoModulesCore
import Foundation
import GhosttyKit
import QuartzCore
import UIKit

private enum GhosttyRuntime {
  private static let lock = NSLock()
  private static var initialized = false

  static func ensureInitialized() -> Bool {
    lock.lock()
    defer { lock.unlock() }

    if initialized {
      return true
    }

    let result = ghostty_init(0, nil)
    initialized = result == GHOSTTY_SUCCESS
    return initialized
  }
}

/// One delivery from JS: the slice appended since `cursor` last advanced, or a
/// full replay that replaces whatever the surface currently holds.
public struct TerminalAppend: Record {
  @Field public var reset: Bool = false
  @Field public var chunk: String = ""
  @Field public var cursor: Double = -1
  @Field public var epoch: Double = -1

  public init() {}
}

private enum TerminalAppearanceScheme: String {
  case light
  case dark

  init(value: String) {
    self = TerminalAppearanceScheme(rawValue: value) ?? .dark
  }

  var ghosttyColorScheme: ghostty_color_scheme_e {
    switch self {
    case .light:
      return GHOSTTY_COLOR_SCHEME_LIGHT
    case .dark:
      return GHOSTTY_COLOR_SCHEME_DARK
    }
  }
}

private extension UIColor {
  convenience init(hexString: String) {
    let sanitized = hexString.replacingOccurrences(of: "#", with: "")
    let value = Int(sanitized, radix: 16) ?? 0
    self.init(
      red: CGFloat((value >> 16) & 0xFF) / 255,
      green: CGFloat((value >> 8) & 0xFF) / 255,
      blue: CGFloat(value & 0xFF) / 255,
      alpha: 1
    )
  }
}

public final class T3TerminalView: ExpoView, UITextFieldDelegate, UIEditMenuInteractionDelegate {
  private static let minimumVerticalScrollStepPoints: CGFloat = 18
  private static let verticalScrollStepMultiplier: CGFloat = 1.15

  private let terminalViewport = UIView()
  private let clipboardBar = UIStackView()
  private let copyButton = UIButton(type: .system)
  private let inputField = TerminalInputField()
  private let focusTapGesture = UITapGestureRecognizer()
  private let scrollPanGesture = UIPanGestureRecognizer()
  private let pointerSelectionPan = UIPanGestureRecognizer()
  private let selectionLongPress = UILongPressGestureRecognizer()
  private lazy var selectionMenu = UIEditMenuInteraction(delegate: self)
  private var lastSelectionPoint: CGPoint = .zero
  private var lastViewportSize: CGSize = .zero
  private var lastContentScale: CGFloat = 0
  private var lastReportedGrid: (cols: Int, rows: Int)?
  private var appliedCursor: Double = -1
  private var appliedEpoch: Double = -1
  private var isSelecting = false
  private var selectionMouseReportingDisabled = false
  private var pendingVerticalScrollPoints: CGFloat = 0
  private var app: ghostty_app_t?
  private var surface: ghostty_surface_t?
  private var isCreatingSurface = false
  private var surfaceCreationFailed = false
  private var appearance = TerminalAppearanceScheme.dark
  private var backgroundColorValue = UIColor(hexString: "#24292e")

  let onInput = EventDispatcher()
  let onResize = EventDispatcher()
  let onSurfaceReady = EventDispatcher()

  var terminalKey: String = "" {
    didSet {
      accessibilityIdentifier = "t3-terminal-\(terminalKey)"
      if oldValue != terminalKey {
        resetSurface()
      }
    }
  }

  var fontSize: CGFloat = 10 {
    didSet {
      guard oldValue != fontSize else { return }
      inputField.font = UIFont.monospacedSystemFont(ofSize: max(fontSize, 13), weight: .regular)
      refreshSurface()
    }
  }

  var focusRequest: Double = 0 {
    didSet {
      guard oldValue != focusRequest else { return }
      DispatchQueue.main.async { [weak self] in
        self?.requestKeyboardFocus()
      }
    }
  }

  var autoFocus = true {
    didSet {
      guard oldValue != autoFocus else { return }
      if autoFocus {
        requestKeyboardFocus()
      } else {
        inputField.resignFirstResponder()
      }
    }
  }

  var appearanceScheme: String = TerminalAppearanceScheme.dark.rawValue {
    didSet {
      guard oldValue != appearanceScheme else { return }
      appearance = TerminalAppearanceScheme(value: appearanceScheme)
      refreshSurface()
    }
  }

  var themeConfig: String = "" {
    didSet {
      guard oldValue != themeConfig else { return }
      refreshSurface()
    }
  }

  var backgroundColorHex: String = "#24292e" {
    didSet {
      backgroundColorValue = UIColor(hexString: backgroundColorHex)
      applyTheme()
    }
  }

  var foregroundColorHex: String = "#d1d5da" {
    didSet { applyTheme() }
  }
  var mutedForegroundColorHex: String = "#959da5"

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)

    applyTheme()
    clipsToBounds = true
    contentScaleFactor = UIScreen.main.scale

    terminalViewport.clipsToBounds = true
    terminalViewport.contentScaleFactor = contentScaleFactor
    terminalViewport.translatesAutoresizingMaskIntoConstraints = false
    terminalViewport.isUserInteractionEnabled = true

    inputField.delegate = self
    inputField.backgroundColor = UIColor.clear
    inputField.textColor = UIColor.clear
    inputField.tintColor = UIColor.clear
    inputField.font = UIFont.monospacedSystemFont(ofSize: max(fontSize, 13), weight: .regular)
    inputField.placeholder = ""
    inputField.autocorrectionType = .no
    inputField.autocapitalizationType = .none
    inputField.spellCheckingType = .no
    inputField.smartDashesType = .no
    inputField.smartQuotesType = .no
    inputField.returnKeyType = .send
    inputField.keyboardType = .asciiCapable
    inputField.enablesReturnKeyAutomatically = false
    inputField.translatesAutoresizingMaskIntoConstraints = false
    inputField.alpha = 0.02
    inputField.isAccessibilityElement = false
    inputField.accessibilityElementsHidden = true
    inputField.addTarget(self, action: #selector(handleInputEditingDidBegin), for: .editingDidBegin)
    inputField.onDeleteBackward = { [weak self] in
      self?.handleHardwareKey(input: TerminalHardwareKeyEncoder.backspace, modifiers: [])
    }
    inputField.onCopy = { [weak self] in self?.copySelectionToPasteboard() }
    inputField.onPaste = { [weak self] in self?.pasteFromPasteboard() }
    inputField.onSelectAll = { [weak self] in self?.selectAll() }
    inputField.hasTerminalSelection = { [weak self] in
      guard let surface = self?.surface else { return false }
      return ghostty_surface_has_selection(surface)
    }
    inputField.onHardwareKey = { [weak self] input, modifiers in
      self?.handleHardwareKey(input: input, modifiers: modifiers)
    }

    focusTapGesture.addTarget(self, action: #selector(handleViewportTap))
    terminalViewport.addGestureRecognizer(focusTapGesture)
    scrollPanGesture.addTarget(self, action: #selector(handleViewportPan(_:)))
    scrollPanGesture.maximumNumberOfTouches = 1
    scrollPanGesture.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.direct.rawValue)]
    scrollPanGesture.allowedScrollTypesMask = .all
    scrollPanGesture.cancelsTouchesInView = false
    terminalViewport.addGestureRecognizer(scrollPanGesture)
    selectionLongPress.addTarget(self, action: #selector(handleSelectionLongPress(_:)))
    selectionLongPress.minimumPressDuration = 0.35
    selectionLongPress.allowableMovement = 12
    selectionLongPress.cancelsTouchesInView = false
    terminalViewport.addGestureRecognizer(selectionLongPress)
    selectionLongPress.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.direct.rawValue)]
    scrollPanGesture.require(toFail: selectionLongPress)
    focusTapGesture.require(toFail: selectionLongPress)
    pointerSelectionPan.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.indirectPointer.rawValue)]
    pointerSelectionPan.addTarget(self, action: #selector(handlePointerSelection(_:)))
    terminalViewport.addGestureRecognizer(pointerSelectionPan)
    focusTapGesture.require(toFail: pointerSelectionPan)
    terminalViewport.addInteraction(selectionMenu)

    configureClipboardBar()
    addSubview(clipboardBar)
    addSubview(terminalViewport)
    addSubview(inputField)

    NSLayoutConstraint.activate([
      terminalViewport.leadingAnchor.constraint(equalTo: leadingAnchor),
      terminalViewport.trailingAnchor.constraint(equalTo: trailingAnchor),
      clipboardBar.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
      clipboardBar.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
      clipboardBar.topAnchor.constraint(equalTo: topAnchor),
      clipboardBar.heightAnchor.constraint(greaterThanOrEqualToConstant: 44),
      terminalViewport.topAnchor.constraint(equalTo: clipboardBar.bottomAnchor),
      terminalViewport.bottomAnchor.constraint(equalTo: bottomAnchor),

      inputField.trailingAnchor.constraint(equalTo: trailingAnchor),
      inputField.topAnchor.constraint(equalTo: bottomAnchor, constant: 8),
      inputField.widthAnchor.constraint(equalToConstant: 1),
      inputField.heightAnchor.constraint(equalToConstant: 1),
    ])
  }

  deinit {
    destroySurface()
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    updateContentScale()

    let viewportSize = terminalViewport.bounds.size
    if surface == nil {
      createSurfaceIfPossible()
    }

    guard viewportSize != lastViewportSize || contentScaleFactor != lastContentScale else {
      return
    }

    lastViewportSize = viewportSize
    lastContentScale = contentScaleFactor
    resizeSurface()
  }

  public override func didMoveToWindow() {
    super.didMoveToWindow()

    guard window != nil, autoFocus else { return }
    DispatchQueue.main.async { [weak self] in
      self?.requestKeyboardFocus()
    }
  }

  public func textField(_ textField: UITextField, shouldChangeCharactersIn range: NSRange, replacementString string: String) -> Bool {
    if !string.isEmpty {
      // Some software keyboards deliver Return through this delegate instead of
      // textFieldShouldReturn, so normalize that path too.
      emitInput(TerminalInputSequence.normalizingReturn(string))
      return false
    }

    return false
  }

  public func textFieldShouldReturn(_ textField: UITextField) -> Bool {
    emitInput(TerminalInputSequence.carriageReturn)
    textField.text = ""
    return false
  }

  @objc
  private func handleViewportTap() {
    selectionMenu.dismissMenu()
    if let surface, ghostty_surface_has_selection(surface) {
      let mouseReporting = ghostty_surface_mouse_captured(surface)
      if mouseReporting { performBinding("toggle_mouse_reporting") }
      let location = focusTapGesture.location(in: terminalViewport)
      ghostty_surface_mouse_pos(surface, Double(location.x), Double(location.y), GHOSTTY_MODS_NONE)
      _ = ghostty_surface_mouse_button(surface, GHOSTTY_MOUSE_PRESS, GHOSTTY_MOUSE_LEFT, GHOSTTY_MODS_NONE)
      _ = ghostty_surface_mouse_button(surface, GHOSTTY_MOUSE_RELEASE, GHOSTTY_MOUSE_LEFT, GHOSTTY_MODS_NONE)
      if mouseReporting { performBinding("toggle_mouse_reporting") }
      redrawSurface()
    }
    requestKeyboardFocus()
  }

  @objc
  private func handleViewportPan(_ gesture: UIPanGestureRecognizer) {
    guard let surface, !isSelecting else { return }

    let location = gesture.location(in: terminalViewport)
    ghostty_surface_mouse_pos(
      surface,
      Double(location.x),
      Double(location.y),
      GHOSTTY_MODS_NONE
    )

    switch gesture.state {
    case .began:
      pendingVerticalScrollPoints = 0
      gesture.setTranslation(.zero, in: terminalViewport)
    case .changed:
      let translation = gesture.translation(in: terminalViewport)
      let stepSize = max(
        fontSize * Self.verticalScrollStepMultiplier,
        Self.minimumVerticalScrollStepPoints
      )
      let totalVerticalPoints = pendingVerticalScrollPoints + translation.y
      let verticalSteps = Int(totalVerticalPoints / stepSize)
      pendingVerticalScrollPoints = totalVerticalPoints - (CGFloat(verticalSteps) * stepSize)

      guard verticalSteps != 0 else {
        gesture.setTranslation(.zero, in: terminalViewport)
        return
      }

      ghostty_surface_mouse_scroll(surface, 0, Double(verticalSteps), 0)
      redrawSurface()
      gesture.setTranslation(.zero, in: terminalViewport)
    default:
      pendingVerticalScrollPoints = 0
      gesture.setTranslation(.zero, in: terminalViewport)
    }
  }

  @objc
  private func handleInputEditingDidBegin() {
    if let surface { ghostty_surface_set_focus(surface, true) }
    textInputModeDidChange()
  }

  public func textFieldDidEndEditing(_ textField: UITextField) {
    if let surface { ghostty_surface_set_focus(surface, false) }
  }

  private func createSurfaceIfPossible() {
    guard surface == nil, app == nil, !isCreatingSurface, !surfaceCreationFailed else { return }
    guard terminalViewport.bounds.width > 0, terminalViewport.bounds.height > 0 else { return }
    guard GhosttyRuntime.ensureInitialized() else {
      surfaceCreationFailed = true
      return
    }

    isCreatingSurface = true
    defer { isCreatingSurface = false }

    var runtimeConfig = ghostty_runtime_config_s(
      userdata: Unmanaged.passUnretained(self).toOpaque(),
      supports_selection_clipboard: false,
      wakeup_cb: { _ in },
      action_cb: { _, _, _ in false },
      read_clipboard_cb: { userdata, _, state, _, _, _ in
        guard let userdata else { return GHOSTTY_CLIPBOARD_READ_UNAVAILABLE }
        let view = Unmanaged<T3TerminalView>.fromOpaque(userdata).takeUnretainedValue()
        return view.completeClipboardRead(state: state)
      },
      confirm_read_clipboard_cb: { _, _, _, _ in },
      write_clipboard_cb: { userdata, _, contents, contentsLen, _ in
        guard let userdata else { return }
        let view = Unmanaged<T3TerminalView>.fromOpaque(userdata).takeUnretainedValue()
        view.writeClipboard(contents: contents, count: contentsLen)
      },
      close_surface_cb: { _, _ in }
    )

    guard let config = ghostty_config_new() else {
      surfaceCreationFailed = true
      return
    }
    loadThemeConfig(into: config)
    ghostty_config_finalize(config)
    defer { ghostty_config_free(config) }

    guard let createdApp = ghostty_app_new(&runtimeConfig, config) else {
      surfaceCreationFailed = true
      return
    }

    var surfaceConfig = ghostty_surface_config_new()
    surfaceConfig.platform_tag = GHOSTTY_PLATFORM_IOS
    surfaceConfig.platform.ios.uiview = Unmanaged.passUnretained(terminalViewport).toOpaque()
    surfaceConfig.userdata = Unmanaged.passUnretained(self).toOpaque()
    surfaceConfig.scale_factor = Double(contentScaleFactor)
    surfaceConfig.font_size = Float(fontSize)
    surfaceConfig.context = GHOSTTY_SURFACE_CONTEXT_WINDOW
    surfaceConfig.use_custom_io = true

    guard let createdSurface = ghostty_surface_new(createdApp, &surfaceConfig) else {
      ghostty_app_free(createdApp)
      surfaceCreationFailed = true
      return
    }

    app = createdApp
    surface = createdSurface
    ghostty_surface_set_focus(createdSurface, inputField.isFirstResponder)
    ghostty_app_set_color_scheme(createdApp, appearance.ghosttyColorScheme)
    ghostty_surface_set_color_scheme(createdSurface, appearance.ghosttyColorScheme)
    setupWriteCallback()
    resizeSurface()

    // A fresh surface holds nothing. Announcing it is what makes JS resend the
    // history, so the view never has to keep a second copy of the scrollback.
    appliedCursor = -1
    appliedEpoch = -1
    DispatchQueue.main.async { [weak self] in
      self?.onSurfaceReady([:])
    }
  }

  private func resetSurface() {
    destroySurface()
    appliedCursor = -1
    appliedEpoch = -1
    lastViewportSize = .zero
    lastContentScale = 0
    lastReportedGrid = nil
    surfaceCreationFailed = false
    setNeedsLayout()
  }

  private func refreshSurface() {
    resetSurface()
    createSurfaceIfPossible()
  }

  private func destroySurface() {
    selectionMenu.dismissMenu()
    copyButton.isEnabled = false
    isSelecting = false
    selectionMouseReportingDisabled = false
    pendingVerticalScrollPoints = 0
    if let surface {
      ghostty_surface_set_write_callback(surface, nil, nil)
      ghostty_surface_free(surface)
    }
    if let app {
      ghostty_app_free(app)
    }
    surface = nil
    app = nil
  }

  func applyAppend(_ append: TerminalAppend) {
    guard surface != nil else {
      // Nothing to write into yet. Surface creation announces itself and JS
      // answers with a replay, so dropping this delivery loses nothing.
      createSurfaceIfPossible()
      return
    }

    if append.reset {
      appliedEpoch = append.epoch
      appliedCursor = append.cursor
      // RIS clears the modes a previous session left behind; the screen and
      // scrollback have to go with them before the replay lands.
      feedData(Data("\u{1B}c\u{1B}[3J".utf8))
      feedData(Data(append.chunk.utf8))
      return
    }

    guard append.epoch == appliedEpoch, append.cursor > appliedCursor else { return }
    appliedCursor = append.cursor
    feedData(Data(append.chunk.utf8))
  }

  private func feedData(_ data: Data) {
    guard let surface, !data.isEmpty else { return }

    data.withUnsafeBytes { buffer in
      guard let pointer = buffer.baseAddress?.assumingMemoryBound(to: UInt8.self) else {
        return
      }
      ghostty_surface_feed_data(surface, pointer, buffer.count)
    }

    redrawSurface()
  }

  private func setupWriteCallback() {
    guard let surface else { return }

    let userdata = Unmanaged.passUnretained(self).toOpaque()
    ghostty_surface_set_write_callback(surface, { userdata, data, len in
      guard let userdata, let data, len > 0 else { return }
      let view = Unmanaged<T3TerminalView>.fromOpaque(userdata).takeUnretainedValue()
      let bytes = Data(bytes: data, count: len)
      guard let input = String(data: bytes, encoding: .utf8), !input.isEmpty else { return }

      DispatchQueue.main.async {
        view.onInput(["data": input])
      }
    }, userdata)
  }

  private func resizeSurface() {
    guard let surface else {
      emitEstimatedResize()
      return
    }

    let scale = contentScaleFactor
    let width = UInt32(max(floor(terminalViewport.bounds.width * scale), 1))
    let height = UInt32(max(floor(terminalViewport.bounds.height * scale), 1))

    terminalViewport.contentScaleFactor = scale
    ghostty_surface_set_content_scale(surface, Double(scale), Double(scale))
    ghostty_surface_set_size(surface, width, height)
    ghostty_surface_set_occlusion(surface, window != nil)
    configureIOSurfaceLayers()
    redrawSurface()
    emitGhosttyResize()
  }

  private func redrawSurface() {
    copyButton.isEnabled = surface.map { ghostty_surface_has_selection($0) } ?? false
    guard let surface else { return }
    ghostty_surface_refresh(surface)
    ghostty_surface_draw(surface)
    markIOSurfaceLayersForDisplay()
    emitGhosttyResize()
  }

  private func emitGhosttyResize() {
    guard let surface else {
      emitEstimatedResize()
      return
    }

    let size = ghostty_surface_size(surface)
    let cols = max(1, Int(size.columns))
    let rows = max(1, Int(size.rows))
    emitResize(cols: cols, rows: rows)
  }

  private func emitEstimatedResize() {
    guard bounds.width > 0, bounds.height > 0 else { return }

    let cellWidth = max(fontSize * 0.62, 1)
    let cellHeight = max(fontSize * 1.35, 1)
    let cols = max(20, min(400, Int(bounds.width / cellWidth)))
    let terminalHeight = max(bounds.height, 0)
    let rows = max(5, min(200, Int(terminalHeight / cellHeight)))
    emitResize(cols: cols, rows: rows)
  }

  private func emitResize(cols: Int, rows: Int) {
    guard lastReportedGrid?.cols != cols || lastReportedGrid?.rows != rows else {
      return
    }

    lastReportedGrid = (cols, rows)
    onResize([
      "cols": cols,
      "rows": rows,
    ])
  }

  private func updateContentScale() {
    let scale = window?.screen.scale ?? UIScreen.main.scale
    if contentScaleFactor != scale {
      contentScaleFactor = scale
    }
  }

  private func requestKeyboardFocus() {
    guard window != nil else { return }
    inputField.becomeFirstResponder()
    textInputModeDidChange()
  }

  private func emitInput(_ data: String) {
    guard !data.isEmpty else { return }
    onInput(["data": data])
  }

  // MARK: - Hardware keys

  private func handleHardwareKey(input: String, modifiers: UIKeyModifierFlags) {
    if TerminalHardwareKeyEncoder.isCopy(input: input, modifiers: modifiers) {
      copySelectionToPasteboard()
      return
    }
    if TerminalHardwareKeyEncoder.isPaste(input: input, modifiers: modifiers) {
      pasteFromPasteboard()
      return
    }
    if let editing = TerminalHardwareKeyEncoder.editingSequence(
      input: input,
      modifiers: modifiers
    ) {
      emitInput(editing)
      return
    }
    // Ghostty owns encoding whenever it can: it knows the modes the running
    // program set, and its output reaches JS through the surface write callback.
    // Falling back after handing it the key would risk sending the key twice,
    // so the fallback only covers what Ghostty was never given.
    if sendKeyThroughGhostty(input: input, modifiers: modifiers) {
      return
    }
    if let fallback = TerminalHardwareKeyEncoder.fallbackSequence(
      input: input,
      modifiers: modifiers
    ) {
      emitInput(fallback)
    }
  }

  /// Returns whether the key was handed to Ghostty, which happens whenever a
  /// surface exists and the key has a physical keycode.
  private func sendKeyThroughGhostty(input: String, modifiers: UIKeyModifierFlags) -> Bool {
    guard let surface, let keycode = TerminalHardwareKeyEncoder.nativeKeycode(for: input) else {
      return false
    }

    var event = ghostty_input_key_s()
    event.action = GHOSTTY_ACTION_PRESS
    event.mods = TerminalHardwareKeyEncoder.ghosttyMods(modifiers)
    event.consumed_mods = GHOSTTY_MODS_NONE
    event.keycode = keycode
    event.text = nil
    event.unshifted_codepoint = TerminalHardwareKeyEncoder.unshiftedCodepoint(for: input)
    event.composing = false

    _ = ghostty_surface_key(surface, event)
    return true
  }

  // MARK: - Selection and clipboard

  /// Clipboard actions stay reachable without a software keyboard or a gesture.
  private func configureClipboardBar() {
    clipboardBar.translatesAutoresizingMaskIntoConstraints = false
    clipboardBar.distribution = .fillEqually
    clipboardBar.tintColor = UIColor(hexString: foregroundColorHex)

    let pasteButton = UIButton(type: .system)
    pasteButton.setTitle("Paste", for: .normal)
    pasteButton.accessibilityHint = "Paste clipboard text into the terminal"
    pasteButton.addAction(UIAction { [weak self] _ in
      self?.pasteFromPasteboard()
    }, for: .touchUpInside)

    let selectButton = UIButton(type: .system)
    selectButton.setTitle("Select All", for: .normal)
    selectButton.accessibilityHint = "Select terminal output for copying"
    selectButton.addAction(UIAction { [weak self] _ in
      guard let self else { return }
      self.lastSelectionPoint = CGPoint(x: self.terminalViewport.bounds.midX, y: 0)
      self.selectAll()
    }, for: .touchUpInside)

    copyButton.setTitle("Copy", for: .normal)
    copyButton.isEnabled = false
    copyButton.accessibilityHint = "Copy selected terminal text"
    copyButton.addAction(UIAction { [weak self] _ in
      self?.copySelectionToPasteboard()
    }, for: .touchUpInside)

    for button in [pasteButton, selectButton, copyButton] {
      button.titleLabel?.font = .preferredFont(forTextStyle: .subheadline)
      button.titleLabel?.adjustsFontForContentSizeCategory = true
      clipboardBar.addArrangedSubview(button)
    }
  }

  @objc
  private func handleSelectionLongPress(_ gesture: UILongPressGestureRecognizer) {
    updateSelection(gesture, selectWord: true)
  }

  @objc
  private func handlePointerSelection(_ gesture: UIPanGestureRecognizer) {
    updateSelection(gesture, selectWord: false)
  }

  private func updateSelection(_ gesture: UIGestureRecognizer, selectWord: Bool) {
    guard let surface else { return }
    let location = gesture.location(in: terminalViewport)
    lastSelectionPoint = location
    // The embedded ABI accepts points and applies content scale itself.
    // Suspend application mouse reporting for this selection gesture. Using
    // Shift instead would extend an old selection instead of starting a new one.
    let mods = GHOSTTY_MODS_NONE
    if gesture.state == .began {
      selectionMenu.dismissMenu()
      isSelecting = true
      if ghostty_surface_mouse_captured(surface) {
        performBinding("toggle_mouse_reporting")
        selectionMouseReportingDisabled = true
      }
      // A pan recognizes after movement; start at the original pointer position.
      let translation = (gesture as? UIPanGestureRecognizer)?.translation(in: terminalViewport) ?? .zero
      ghostty_surface_mouse_pos(surface, Double(location.x - translation.x), Double(location.y - translation.y), mods)
      _ = ghostty_surface_mouse_button(surface, GHOSTTY_MOUSE_PRESS, GHOSTTY_MOUSE_LEFT, mods)
      if selectWord {
        _ = ghostty_surface_mouse_button(surface, GHOSTTY_MOUSE_RELEASE, GHOSTTY_MOUSE_LEFT, mods)
        _ = ghostty_surface_mouse_button(surface, GHOSTTY_MOUSE_PRESS, GHOSTTY_MOUSE_LEFT, mods)
      }
    }
    ghostty_surface_mouse_pos(surface, Double(location.x), Double(location.y), mods)
    switch gesture.state {
    case .ended, .cancelled, .failed:
      guard isSelecting else { return }
      _ = ghostty_surface_mouse_button(surface, GHOSTTY_MOUSE_RELEASE, GHOSTTY_MOUSE_LEFT, mods)
      isSelecting = false
      if selectionMouseReportingDisabled {
        performBinding("toggle_mouse_reporting")
        selectionMouseReportingDisabled = false
      }
      if gesture.state == .ended && (selectWord || ghostty_surface_has_selection(surface)) {
        selectionMenu.presentEditMenu(with: UIEditMenuConfiguration(identifier: nil, sourcePoint: location))
      }
    default: break
    }
    redrawSurface()
  }

  public func editMenuInteraction(
    _ interaction: UIEditMenuInteraction,
    menuFor configuration: UIEditMenuConfiguration,
    suggestedActions: [UIMenuElement]
  ) -> UIMenu? {
    var actions: [UIMenuElement] = []
    if let surface, ghostty_surface_has_selection(surface) {
      actions.append(UIAction(title: "Copy", image: UIImage(systemName: "doc.on.doc")) { [weak self] _ in
        self?.copySelectionToPasteboard()
      })
    }
    actions.append(UIAction(title: "Select All") { [weak self] _ in self?.selectAll() })
    actions.append(UIAction(title: "Paste", image: UIImage(systemName: "doc.on.clipboard")) { [weak self] _ in
      self?.pasteFromPasteboard()
    })
    return UIMenu(children: actions)
  }

  private func selectAll() {
    performBinding("select_all")
    selectionMenu.presentEditMenu(with: UIEditMenuConfiguration(identifier: nil, sourcePoint: lastSelectionPoint))
  }

  private func performBinding(_ action: String) {
    guard let surface else { return }
    _ = action.withCString { ghostty_surface_binding_action(surface, $0, UInt(action.utf8.count)) }
    redrawSurface()
  }

  private func copySelectionToPasteboard() {
    guard let surface, ghostty_surface_has_selection(surface) else { return }

    var text = ghostty_text_s()
    guard ghostty_surface_read_selection(surface, &text) else { return }
    defer { ghostty_surface_free_text(surface, &text) }

    guard let pointer = text.text, text.text_len > 0 else { return }
    let data = Data(bytes: pointer, count: Int(text.text_len))
    guard let selection = String(data: data, encoding: .utf8), !selection.isEmpty else { return }
    UIPasteboard.general.string = selection
  }

  private func pasteFromPasteboard() {
    guard let surface else { return }
    // Route through Ghostty so the paste is bracketed when the program asked for
    // it; the read callback below is what hands over the pasteboard contents.
    let action = "paste_from_clipboard"
    _ = action.withCString { pointer in
      ghostty_surface_binding_action(surface, pointer, UInt(action.utf8.count))
    }
  }

  fileprivate func completeClipboardRead(state: UnsafeMutableRawPointer?) -> ghostty_clipboard_read_result_e {
    guard let surface else { return GHOSTTY_CLIPBOARD_READ_UNAVAILABLE }
    guard let pasted = UIPasteboard.general.string, !pasted.isEmpty else {
      ghostty_surface_deny_clipboard_request(surface, state)
      return GHOSTTY_CLIPBOARD_READ_STARTED
    }

    var bytes = Array(pasted.utf8)
    let mime = "text/plain;charset=utf-8"
    mime.withCString { mimePointer in
      bytes.withUnsafeMutableBufferPointer { buffer in
        var content = ghostty_clipboard_content_s(
          mime: mimePointer,
          data: buffer.baseAddress.map { UnsafeRawPointer($0).assumingMemoryBound(to: CChar.self) },
          len: buffer.count
        )
        withUnsafePointer(to: &content) { contentPointer in
          var complete = ghostty_clipboard_complete_s(
            contents: contentPointer,
            contents_len: 1,
            available: nil,
            available_len: 0,
            confirmed: true,
            remember: false
          )
          ghostty_surface_complete_clipboard_request(surface, &complete, state)
        }
      }
    }

    return GHOSTTY_CLIPBOARD_READ_STARTED
  }

  fileprivate func writeClipboard(
    contents: UnsafePointer<ghostty_clipboard_content_s>?,
    count: Int
  ) {
    guard let contents, count > 0 else { return }

    for index in 0..<count {
      let content = contents[index]
      guard let data = content.data, content.len > 0 else { continue }
      let bytes = Data(bytes: data, count: content.len)
      guard let text = String(data: bytes, encoding: .utf8), !text.isEmpty else { continue }
      UIPasteboard.general.string = text
      return
    }
  }

  private func textInputModeDidChange() {
    guard let app else { return }
    ghostty_app_keyboard_changed(app)
  }

  private func configureIOSurfaceLayers() {
    let targetBounds = CGRect(origin: .zero, size: terminalViewport.bounds.size)
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    terminalViewport.layer.sublayers?.forEach { sublayer in
      sublayer.frame = targetBounds
      sublayer.contentsScale = contentScaleFactor
    }
    CATransaction.commit()
  }

  private func markIOSurfaceLayersForDisplay() {
    terminalViewport.layer.setNeedsDisplay()
    terminalViewport.layer.sublayers?.forEach { layer in
      layer.setNeedsDisplay()
    }
  }

  private func applyTheme() {
    backgroundColor = backgroundColorValue
    terminalViewport.backgroundColor = backgroundColorValue
    clipboardBar.tintColor = UIColor(hexString: foregroundColorHex)
  }

  private func loadThemeConfig(into config: ghostty_config_t) {
    guard let path = writeThemeConfigFile() else { return }
    path.withCString { cString in
      ghostty_config_load_file(config, cString)
    }
  }

  private func writeThemeConfigFile() -> String? {
    guard !themeConfig.isEmpty else { return nil }
    let configContents = themeConfig
    let url = URL(fileURLWithPath: NSTemporaryDirectory())
      .appendingPathComponent("t3-terminal-theme-\(appearance.rawValue).ghostty")

    do {
      if let existing = try? String(contentsOf: url, encoding: .utf8), existing == configContents {
        return url.path
      }

      try configContents.write(to: url, atomically: true, encoding: .utf8)
      return url.path
    } catch {
      return nil
    }
  }
}
