// SPDX-License-Identifier: Apache-2.0

import AppKit
import Carbon
import Foundation

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var launched = false
    private var workerProcess: Process?

    func applicationWillFinishLaunching(_ notification: Notification) {
        NSAppleEventManager.shared().setEventHandler(
            self,
            andSelector: #selector(handleURL(event:reply:)),
            forEventClass: AEEventClass(kInternetEventClass),
            andEventID: AEEventID(kAEGetURL)
        )
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        if let raw = CommandLine.arguments.dropFirst().first,
           raw.hasPrefix("appstrate-browser://") {
            launchWorker(raw)
            return
        }
        // Keep the delegate alive until the one-shot registration launch has
        // either received a URL or terminated. NSApplication's delegate does
        // not provide the ownership guarantee this callback needs.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [self] in
            if launched == false { NSApp.terminate(nil) }
        }
    }

    @objc private func handleURL(event: NSAppleEventDescriptor, reply: NSAppleEventDescriptor) {
        guard let raw = event.paramDescriptor(forKeyword: keyDirectObject)?.stringValue,
              raw.hasPrefix("appstrate-browser://") else {
            NSApp.terminate(nil)
            return
        }
        launchWorker(raw)
    }

    private func launchWorker(_ capability: String) {
        if launched { return }
        launched = true
        guard let worker = Bundle.main.executableURL?
            .deletingLastPathComponent()
            .appendingPathComponent("appstrate-browser-worker") else {
            NSApp.terminate(nil)
            return
        }
        let process = Process()
        process.executableURL = worker
        process.arguments = ["--capability-stdin"]
        let input = Pipe()
        let errors = Pipe()
        process.standardInput = input
        process.standardError = errors
        // Retain the delegate for the worker lifetime. The cycle is broken by
        // clearing `workerProcess` after termination.
        process.terminationHandler = { [self] completed in
            let errorData = errors.fileHandleForReading.readDataToEndOfFile()
            let detail = String(data: errorData, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            DispatchQueue.main.async {
                if completed.terminationStatus != 0 {
                    let alert = NSAlert()
                    alert.messageText = "La connexion Appstrate a échoué"
                    alert.informativeText = detail?.isEmpty == false
                        ? detail!
                        : "Le compagnon navigateur s’est arrêté de façon inattendue."
                    alert.runModal()
                }
                self.workerProcess = nil
                NSApp.terminate(nil)
            }
        }
        do {
            workerProcess = process
            try process.run()
            // `Pipe` retains both file handles in this parent process. Close
            // our copy of the write end after the child has inherited it;
            // otherwise `readDataToEndOfFile()` in the termination handler
            // never observes EOF when the worker exits and the background app
            // remains stuck forever without surfacing the worker error.
            try? errors.fileHandleForWriting.close()
            if let data = capability.data(using: .utf8) {
                input.fileHandleForWriting.write(data)
            }
            try? input.fileHandleForWriting.close()
        } catch {
            workerProcess = nil
            let alert = NSAlert()
            alert.messageText = "Impossible de lancer le compagnon Appstrate"
            alert.informativeText = error.localizedDescription
            alert.runModal()
            NSApp.terminate(nil)
        }
    }
}

@main
private enum AppstrateBrowserMain {
    static func main() {
        let application = NSApplication.shared
        let delegate = AppDelegate()
        application.delegate = delegate
        withExtendedLifetime(delegate) {
            application.run()
        }
    }
}
