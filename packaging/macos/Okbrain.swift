import AppKit
import WebKit

private struct SmokeFailure: Error {
    let message: String
}

@MainActor
final class Okbrain: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    private static let graphNodeKeys: Set<String> = [
        "id", "type", "title", "description", "tags", "resource", "bodyLen", "body",
        "status", "trust", "stale", "staleAfter", "generated", "verified", "sources",
    ]

    private var window: NSWindow!
    private var web: WKWebView!
    private var process: Process?
    private var root: URL?
    private var page = "home"
    private var readyOutput = Data()
    private let smokeTest = ProcessInfo.processInfo.arguments.contains("--smoke-test")
    private var smokeDirectory: URL?
    private var smokeStarted = false
    private var smokeConfirmations: [String] = []
    private var smokeSaved: [String: URL] = [:]
    private var smokeSaveFailure: String?
    private var saves: [ObjectIdentifier: WKDownload] = [:]
    private var saveDestinations: [ObjectIdentifier: URL] = [:]
    private var cancelledSaves = Set<ObjectIdentifier>()

    func applicationDidFinishLaunching(_ notification: Notification) {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = smokeTest ? .nonPersistent() : .default()
        web = WKWebView(frame: .zero, configuration: configuration)
        web.navigationDelegate = self
        web.uiDelegate = self
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1160, height: 780),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "okbrain"
        window.minSize = NSSize(width: 370, height: 420)
        window.contentView = web
        window.center()
        window.makeKeyAndOrderFront(nil)
        setupMenus()
        NSApp.activate(ignoringOtherApps: true)

        if smokeTest {
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            let folder = directory.appendingPathComponent("brain")
            smokeDirectory = directory
            do {
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                start(folder, remember: false)
            } catch { exit(1) }
            return
        }

        if let path = UserDefaults.standard.string(forKey: "brain-folder"),
           FileManager.default.fileExists(atPath: path) {
            start(URL(fileURLWithPath: path, isDirectory: true))
        } else {
            do {
                let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                                          appropriateFor: nil, create: true)
                let folder = support.appendingPathComponent("okbrain/Brain", isDirectory: true)
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                start(folder)
            } catch { show(error.localizedDescription) }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ notification: Notification) {
        stop()
        if let smokeDirectory { try? FileManager.default.removeItem(at: smokeDirectory) }
    }

    private func setupMenus() {
        let menu = NSMenu()
        let app = NSMenuItem()
        app.submenu = NSMenu()
        app.submenu?.addItem(withTitle: "Quit okbrain", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        menu.addItem(app)

        let file = NSMenuItem()
        file.submenu = NSMenu(title: "File")
        for (title, action, key) in [("Open Brain Folder…", #selector(openBrain), "o"),
                                     ("Personal Brain", #selector(home), "1"),
                                     ("Coding Workspace", #selector(coding), "2"),
                                     ("Add Coding Project…", #selector(openProject), ""),
                                     ("Open in Browser", #selector(browser), "b")] {
            let item = file.submenu?.addItem(withTitle: title, action: action, keyEquivalent: key)
            item?.target = self
        }
        menu.addItem(file)

        let edit = NSMenuItem()
        edit.submenu = NSMenu(title: "Edit")
        for (title, action, key) in [("Undo", "undo:", "z"), ("Cut", "cut:", "x"),
                                     ("Copy", "copy:", "c"), ("Paste", "paste:", "v"),
                                     ("Select All", "selectAll:", "a")] {
            edit.submenu?.addItem(withTitle: title, action: NSSelectorFromString(action), keyEquivalent: key)
        }
        menu.addItem(edit)
        NSApp.mainMenu = menu
    }

    @objc private func openBrain() {
        let panel = NSOpenPanel()
        panel.title = "Open a Brain Folder"
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.canCreateDirectories = true
        panel.beginSheetModal(for: window) { [weak self] response in
            if response == .OK, let folder = panel.url { self?.start(folder) }
        }
    }

    @objc private func home() { navigate("home") }
    @objc private func coding() { navigate("coding") }
    @objc private func openProject() {
        let panel = NSOpenPanel()
        panel.title = "Choose a Coding Project Folder"
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.beginSheetModal(for: window) { [weak self] response in
            guard response == .OK, let folder = panel.url,
                  let encoded = ("workspace=" + folder.path).addingPercentEncoding(withAllowedCharacters: .alphanumerics) else { return }
            self?.navigate("coding/" + encoded)
        }
    }
    @objc private func browser() {
        if let url = web.url, isLocal(url) { NSWorkspace.shared.open(url) }
    }

    private func navigate(_ fragment: String) {
        page = fragment
        if let root, let url = URL(string: "#" + fragment, relativeTo: root) { web.load(URLRequest(url: url)) }
    }

    private func stop() {
        let child = process
        process = nil
        root = nil
        readyOutput.removeAll()
        if child?.isRunning == true { child?.terminate() }
    }

    private func start(_ folder: URL, remember: Bool = true) {
        stop()
        guard let runtime = Bundle.main.url(forAuxiliaryExecutable: "okb") else {
            show("The okbrain runtime is missing from this app bundle.")
            return
        }
        let child = Process()
        child.executableURL = runtime
        child.arguments = ["--bundle", folder.path, "serve", "--desktop"]
        var environment = ProcessInfo.processInfo.environment
        if let smokeDirectory {
            environment["XDG_CONFIG_HOME"] = smokeDirectory.appendingPathComponent("config").path
            environment["XDG_DATA_HOME"] = smokeDirectory.appendingPathComponent("data").path
            environment.removeValue(forKey: "OKB_SQLITE_VEC")
        }
        if let sqlite = Bundle.main.url(forAuxiliaryExecutable: "libsqlite3.dylib") {
            environment["OKB_SQLITE_LIB"] = sqlite.path
        }
        environment["PATH"] = [environment["PATH"], "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"].compactMap { $0 }.joined(separator: ":")
        child.environment = environment
        let output = Pipe()
        child.standardOutput = output
        child.standardError = smokeTest ? FileHandle.standardError : FileHandle.nullDevice
        output.fileHandleForReading.readabilityHandler = { [weak self, weak child] handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil }
            DispatchQueue.main.async {
                guard let self, let child, self.process === child, self.root == nil, !data.isEmpty else { return }
                self.readyOutput.append(data)
                guard let end = self.readyOutput.firstIndex(of: 10) else { return }
                guard let line = String(data: self.readyOutput.prefix(upTo: end), encoding: .utf8),
                      let url = URL(string: line), url.scheme == "http", url.host == "127.0.0.1", url.port != nil else {
                    self.show("The runtime returned an invalid app address.")
                    self.stop()
                    return
                }
                self.root = url
                if remember { UserDefaults.standard.set(folder.path, forKey: "brain-folder") }
                self.window.title = "okbrain — \(folder.lastPathComponent)"
                self.navigate(self.page)
            }
        }
        child.terminationHandler = { [weak self] child in
            output.fileHandleForReading.readabilityHandler = nil
            DispatchQueue.main.async {
                guard let self, self.process === child else { return }
                self.stop()
                self.show("The local okbrain runtime stopped. Reopen your brain folder from File.")
            }
        }
        do {
            process = child
            try child.run()
        } catch {
            stop()
            show(error.localizedDescription)
        }
    }

    private func isLocal(_ url: URL) -> Bool {
        root != nil && url.scheme == root?.scheme && url.host == root?.host && url.port == root?.port
    }

    /// A file the local page generated itself, addressed as `blob:http://127.0.0.1:<port>/<id>`.
    private func isLocalBlob(_ url: URL) -> Bool {
        guard url.scheme == "blob", let origin = URL(string: String(url.absoluteString.dropFirst("blob:".count))) else { return false }
        return isLocal(origin)
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        if action.shouldPerformDownload, isLocalBlob(url) { decisionHandler(.download); return }
        if isLocal(url), action.targetFrame != nil { decisionHandler(.allow); return }
        if action.navigationType == .linkActivated, ["https", "http"].contains(url.scheme ?? "") {
            NSWorkspace.shared.open(url)
        }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = !parameters.allowsDirectories
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.beginSheetModal(for: window) { response in completionHandler(response == .OK ? panel.urls : nil) }
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        saves[ObjectIdentifier(download)] = download
        download.delegate = self
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
                  completionHandler: @escaping (URL?) -> Void) {
        let key = ObjectIdentifier(download)
        let suggested = (suggestedFilename as NSString).lastPathComponent
        let name = suggested.isEmpty || suggested == "/" ? "okbrain-export" : suggested
        if let smokeDirectory {
            // The smoke test has nobody to answer a panel. It saves beside its temporary brain.
            let folder = smokeDirectory.appendingPathComponent("saved", isDirectory: true)
            let destination = folder.appendingPathComponent(name)
            do {
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                try? FileManager.default.removeItem(at: destination)
                saveDestinations[key] = destination
                completionHandler(destination)
            } catch {
                smokeSaveFailure = error.localizedDescription
                cancelledSaves.insert(key)
                completionHandler(nil)
            }
            return
        }
        let panel = NSSavePanel()
        panel.title = "Save Export"
        panel.nameFieldStringValue = name
        panel.canCreateDirectories = true
        panel.isExtensionHidden = false
        panel.beginSheetModal(for: window) { [weak self] response in
            guard response == .OK, let destination = panel.url else {
                self?.cancelledSaves.insert(key)
                completionHandler(nil)
                return
            }
            // The panel has confirmed any replacement, and WebKit saves only to a new path.
            try? FileManager.default.removeItem(at: destination)
            self?.saveDestinations[key] = destination
            completionHandler(destination)
        }
    }

    func downloadDidFinish(_ download: WKDownload) {
        let key = ObjectIdentifier(download)
        saves.removeValue(forKey: key)
        cancelledSaves.remove(key)
        if let destination = saveDestinations.removeValue(forKey: key), smokeTest {
            smokeSaved[destination.lastPathComponent] = destination
        }
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        let key = ObjectIdentifier(download)
        saves.removeValue(forKey: key)
        saveDestinations.removeValue(forKey: key)
        let cancelled = cancelledSaves.remove(key) != nil || (error as NSError).code == NSURLErrorCancelled
        if smokeTest {
            if smokeSaveFailure == nil { smokeSaveFailure = error.localizedDescription }
            return
        }
        if !cancelled { show(error.localizedDescription, title: "Could not save the file") }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        if smokeTest {
            // Record what the page asked the owner to approve, then continue unattended.
            smokeConfirmations.append(message)
            completionHandler(true)
            return
        }
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "Continue")
        alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { response in completionHandler(response == .alertFirstButtonReturn) }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard smokeTest, !smokeStarted else { return }
        smokeStarted = true
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                try await self.smokeScript(webView, """
                    async function ready(selector) {
                        for (let i = 0; i < 80; i++) {
                            if (document.querySelector(selector)) return true;
                            await new Promise(resolve => setTimeout(resolve, 100));
                        }
                        return false;
                    }
                    if (!await ready('#h-cap') || !window.OKB_TOKEN) return 'Personal Home did not initialize.';
                    const indexed = await fetch('/api/op/index', {
                        method: 'POST', headers: { 'x-okb-token': window.OKB_TOKEN }, body: '{}',
                    });
                    if (!indexed.ok) return 'The bundled runtime could not open the local index.';
                    const vectors = await fetch('/api/op/embed', {
                        method: 'POST', headers: { 'x-okb-token': window.OKB_TOKEN, 'content-type': 'application/json' },
                        body: JSON.stringify({ provider: 'ollama', model: 'packaging-smoke', limit: 0 }),
                    });
                    if (!vectors.ok) return 'The bundled runtime could not load its sqlite-vec extension.';
                    location.hash = 'coding';
                    if (!await ready('.coding-projects form')) return 'The Coding workspace did not initialize.';
                    return true;
                    """)
                try await self.smokeGraphExport(webView)
                NSApp.terminate(nil)
            } catch let failure as SmokeFailure {
                self.show(failure.message)
            } catch { self.show(error.localizedDescription) }
        }
    }

    private func smokeScript(_ webView: WKWebView, _ body: String) async throws {
        let value = try await webView.callAsyncJavaScript(body, arguments: [:], in: nil, contentWorld: .page)
        guard value as? Bool == true else {
            throw SmokeFailure(message: (value as? String) ?? "The okbrain page did not initialize.")
        }
    }

    /// Save the graph JSON through the page and WebKit's download path, then read the saved files back.
    private func smokeGraphExport(_ webView: WKWebView) async throws {
        let publicId = "notes/smoke-public"
        let privateId = "notes/smoke-private"
        let privateTitle = "Smoke private draft"
        let privateText = "Private packaging text."
        try await smokeScript(webView, """
            async function ready(selector) {
                for (let i = 0; i < 80; i++) {
                    if (document.querySelector(selector)) return true;
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
                return false;
            }
            async function save(note) {
                const response = await fetch('/api/op/write_concept', {
                    method: 'POST', headers: { 'x-okb-token': window.OKB_TOKEN, 'content-type': 'application/json' },
                    body: JSON.stringify(note),
                });
                return response.ok;
            }
            if (!await save({ id: 'notes/smoke-public', type: 'note', title: 'Smoke public note',
                description: 'A public packaging fixture.', body: 'Read [the draft](/notes/smoke-private.md).' }))
                return 'The smoke brain could not save a public note.';
            if (!await save({ id: 'notes/smoke-private', type: 'note', title: 'Smoke private draft',
                description: 'A private packaging fixture.', body: 'Private packaging text.', private: true }))
                return 'The smoke brain could not save a private draft.';
            location.hash = 'settings';
            if (!await ready('#graph-json-export button')) return 'Settings did not offer the graph JSON export.';
            document.querySelector('#graph-json-export button').click();
            return true;
            """)
        let shared = try await smokeSavedGraph("okbrain-graph.json")
        guard shared.ids.contains(publicId), !shared.ids.contains(privateId), shared.edges == 0,
              !shared.text.contains(privateTitle), !shared.text.contains(privateText) else {
            throw SmokeFailure(message: "The default graph JSON export did not leave the private draft out.")
        }
        guard smokeConfirmations.isEmpty else {
            throw SmokeFailure(message: "The default graph JSON export asked for an approval it does not need.")
        }

        try await smokeScript(webView, """
            const form = document.querySelector('#graph-json-export');
            const button = form?.querySelector('button');
            for (let i = 0; button?.disabled && i < 80; i++) await new Promise(resolve => setTimeout(resolve, 100));
            if (!form?.elements.private || !button || button.disabled) return 'Settings did not offer the private graph JSON export.';
            form.elements.private.checked = true;
            button.click();
            return true;
            """)
        let complete = try await smokeSavedGraph("okbrain-graph-private.json")
        guard complete.ids.contains(publicId), complete.ids.contains(privateId), complete.edges == 1,
              complete.text.contains(privateText) else {
            throw SmokeFailure(message: "The approved graph JSON export did not include the private draft.")
        }
        guard smokeConfirmations == ["The graph JSON will contain private draft text. Export it?"] else {
            throw SmokeFailure(message: "The private graph JSON export did not ask for approval in the app.")
        }
    }

    private func smokeSavedGraph(_ name: String) async throws -> (ids: Set<String>, edges: Int, text: String) {
        for _ in 0..<100 {
            if let failure = smokeSaveFailure { throw SmokeFailure(message: "The app could not save \(name). " + failure) }
            if let file = smokeSaved[name] {
                let data = try Data(contentsOf: file)
                guard let text = String(data: data, encoding: .utf8),
                      let graph = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let nodes = graph["nodes"] as? [[String: Any]],
                      let edges = graph["edges"] as? [[String: Any]],
                      nodes.allSatisfy({ Set($0.keys).isSuperset(of: Okbrain.graphNodeKeys) }),
                      edges.allSatisfy({ $0["src"] is String && $0["dst"] is String }) else {
                    throw SmokeFailure(message: "The saved \(name) does not use the graph schema.")
                }
                return (Set(nodes.compactMap { $0["id"] as? String }), edges.count, text)
            }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        throw SmokeFailure(message: "The app did not save \(name).")
    }

    private func show(_ message: String, title: String = "Could not open okbrain") {
        if smokeTest {
            FileHandle.standardError.write(Data((message + "\n").utf8))
            stop()
            exit(1)
        }
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.beginSheetModal(for: window)
    }
}

@main
struct OkbrainApp {
    @MainActor static func main() {
        let app = NSApplication.shared
        let delegate = Okbrain()
        app.setActivationPolicy(.regular)
        app.delegate = delegate
        withExtendedLifetime(delegate) { app.run() }
    }
}
