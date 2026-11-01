import Carbon

/// System-wide shortcuts via Carbon, which needs no Accessibility permission and
/// works while PowerPoint or Chrome has focus.
enum HotKeys {
    private static var handlers: [UInt32: () -> Void] = [:]
    private static var refs: [EventHotKeyRef?] = []
    private static var installed = false

    static let controlOption = UInt32(controlKey | optionKey)

    static func register(keyCode: Int, modifiers: UInt32 = controlOption, _ handler: @escaping () -> Void) {
        installIfNeeded()
        let id = UInt32(handlers.count + 1)
        handlers[id] = handler
        var ref: EventHotKeyRef?
        RegisterEventHotKey(UInt32(keyCode), modifiers, EventHotKeyID(signature: OSType(0x534F_564C), id: id),
                            GetApplicationEventTarget(), 0, &ref)
        refs.append(ref)
    }

    private static func installIfNeeded() {
        guard !installed else { return }
        installed = true
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, event, _ in
            var id = EventHotKeyID()
            GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
                              nil, MemoryLayout<EventHotKeyID>.size, nil, &id)
            HotKeys.handlers[id.id]?()
            return noErr
        }, 1, &spec, nil, nil)
    }
}
