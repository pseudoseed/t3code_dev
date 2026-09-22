import Foundation
import ObjectiveC

// UIKit rendering and the module registry are stand-ins. The runtime identifier
// and Objective-C view factory below are compiled from the installed dependency.
final class Registry: NSObject {
  let holder = ModuleHolder()
  func get(moduleHolderForName name: String) -> ModuleHolder? { holder }
}
final class ModuleHolder {
  let definition = Definition()
}
final class Definition {
  let views = ["DEFAULT_MODULE_VIEW": ViewDefinition()]
}
final class ViewDefinition {
  func createView(appContext: AppContext) -> AppleView? {
    .uikit(ExpoFabricView(appContext: appContext))
  }
}
enum AppleView {
  case uikit(ExpoFabricView)
  case swiftui(ExpoFabricView)
}
final class TestLogger {
  func warn(_ message: String) {}
}
let log = TestLogger()

func makeClass(_ context: AppContext) -> AnyClass {
  let suffix = context.appIdentifier.map { "_\($0)" } ?? ""
  return ExpoFabricView.makeViewClass(
    forAppContext: context, moduleName: "Regression",
    viewName: "DEFAULT_MODULE_VIEW", className: "ViewManagerAdapter_Regression\(suffix)"
  )!
}
func instantiate(_ type: AnyClass) -> ExpoFabricView {
  let selector = NSSelectorFromString("new")
  let method = class_getMethodImplementation(object_getClass(type), selector)!
  typealias Factory = @convention(c) (AnyClass, Selector) -> Unmanaged<AnyObject>
  return unsafeBitCast(method, to: Factory.self)(type, selector).takeRetainedValue() as! ExpoFabricView
}

@main
struct Regression {
  static func main() {
    // Match the captured failure: the incoming host registers first, then the
    // outgoing host registers late and dies before Fabric mounts the new view.
    var outgoing: AppContext? = AppContext()
    weak var released = outgoing
    let incoming = AppContext()
    let incomingClass = makeClass(incoming)
    let outgoingClass = makeClass(outgoing!)
    outgoing = nil
    precondition(released == nil, "Cached view classes must not retain a dead runtime")
    let liveView = instantiate(incomingClass)
    precondition(liveView.appContext === incoming, "New host must own its view after late old-host registration")
    precondition(ObjectIdentifier(incomingClass) != ObjectIdentifier(outgoingClass), "Overlapping hosts must not share a view factory")
    let teardownView = instantiate(outgoingClass)
    precondition(teardownView.appContext == nil, "Outgoing mounts must not borrow another runtime")
    precondition(instantiate(incomingClass).appContext === incoming, "Teardown must not affect the surviving host")
    print("passed")
  }
}
